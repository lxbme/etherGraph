//! `FetchTrace`: fetches a stored transaction's call trace, checks that it
//! is complete, finds the EIP-7702 delegated accounts it calls, and caches
//! it for everyone.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use chrono::Utc;
use eg_core::source::{CallFrame, CallKind, Priority, SourceError};
use eg_core::types::{AccountKind, Address, TxHash};
use eg_store::{CallTraceRow, JobRow, TxRow};
use serde::Deserialize;

use crate::events::{Audience, Event};
use crate::runner::{JobCtx, JobError, JobHandler};
use crate::trace::{tx_delegations, validate_trace};

/// Callees probed for an EIP-7702 delegation designator per transaction.
pub(crate) const MAX_DELEGATE_LOOKUPS: usize = 5;

/// EIP-7702 delegation designator: the code of a delegated account is this
/// prefix followed by the delegate's address.
const DESIGNATOR: [u8; 3] = [0xef, 0x01, 0x00];

#[derive(Deserialize)]
struct Params {
    hash: TxHash,
}

pub struct FetchTraceHandler;

fn designated(code: &[u8]) -> Option<Address> {
    let rest = code.strip_prefix(&DESIGNATOR)?;
    (rest.len() == 20).then(|| Address::from_slice(rest))
}

/// Distinct callees, in first-appearance order, of the calls that run the
/// callee's code with calldata (CALL, DELEGATECALL, CALLCODE: not a
/// STATICCALL, a creation or a self-destruct).
fn code_callees(frames: &[CallFrame]) -> Vec<Address> {
    let mut seen = HashSet::new();
    frames
        .iter()
        .filter(|f| {
            matches!(
                f.kind,
                CallKind::Call | CallKind::DelegateCall | CallKind::CallCode
            ) && !f.input.is_empty()
        })
        .filter_map(|f| f.to)
        .filter(|a| seen.insert(*a))
        .collect()
}

/// The EIP-7702 delegates of the trace's callees that are neither known
/// contracts nor set or cleared by the transaction's own authorization list
/// (which decides theirs, see [`tx_delegations`]), looking up at most
/// [`MAX_DELEGATE_LOOKUPS`] accounts' code (billed to the job's user).
///
/// The code is today's (`latest`), not the code at the transaction: Etherscan
/// serves state only for the last ~128 blocks ("historical state … is not
/// available"), so a delegation changed since then is not seen; the stored
/// delegates are shown as current ones. A lookup that fails for that account
/// is skipped; retryable errors, quota exhaustion and a rejected key
/// propagate.
async fn delegates(
    ctx: &JobCtx,
    tx: &TxRow,
    frames: &[CallFrame],
) -> Result<HashMap<Address, Address>, JobError> {
    let own = tx_delegations(tx);
    let callees: Vec<Address> = code_callees(frames)
        .into_iter()
        .filter(|a| !own.contains_key(a))
        .collect();
    let contracts: HashSet<Address> = ctx
        .store
        .accounts(&callees)
        .await?
        .into_iter()
        .filter(|a| a.kind == AccountKind::Contract)
        .map(|a| a.address)
        .collect();
    let mut found = HashMap::new();
    for addr in callees
        .into_iter()
        .filter(|a| !contracts.contains(a))
        .take(MAX_DELEGATE_LOOKUPS)
    {
        match ctx.source.code(Priority::Interactive, addr).await {
            Ok(code) => {
                if let Some(d) = designated(&code) {
                    found.insert(addr, d);
                }
            }
            Err(e) if e.is_retryable() || e.is_quota() || matches!(e, SourceError::InvalidKey) => {
                return Err(e.into());
            }
            Err(e) => tracing::warn!(account = %addr, error = %e, "code lookup failed"),
        }
    }
    Ok(found)
}

#[async_trait]
impl JobHandler for FetchTraceHandler {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let Params { hash } = serde_json::from_value(job.params.clone())
            .map_err(|e| JobError::Invalid(format!("bad fetch_trace params: {e}")))?;
        let ready = || {
            ctx.bus.publish(
                Audience::of(job.user_id),
                Event::TraceReady {
                    hash: format!("{hash:#x}"),
                },
            )
        };
        // Cached by another user's job meanwhile: nothing to fetch.
        if ctx.store.call_trace(hash).await?.is_some() {
            ready();
            return Ok(());
        }
        let tx = ctx
            .store
            .transaction(hash)
            .await?
            .ok_or_else(|| JobError::Invalid("transaction not fetched".into()))?;
        let frames = ctx
            .trace_source
            .call_trace(Priority::Interactive, hash)
            .await?
            .ok_or_else(|| JobError::Invalid("trace not available from the source yet".into()))?;
        let incomplete = |why: String| JobError::Invalid(format!("incomplete trace: {why}"));
        validate_trace(&tx, &frames).map_err(incomplete)?;
        if frames.is_empty() {
            let to: Vec<Address> = tx.to.into_iter().collect();
            if ctx
                .store
                .accounts(&to)
                .await?
                .iter()
                .any(|a| a.kind == AccountKind::Contract)
            {
                return Err(incomplete("no frames for a call to a contract".into()));
            }
        }
        let delegates = delegates(ctx, &tx, &frames).await?;
        ctx.store
            .upsert_call_trace(&CallTraceRow {
                hash,
                frames,
                delegates,
                source: ctx.trace_source.name().to_string(),
                fetched_at: Utc::now(),
            })
            .await?;
        ready();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn designator_is_prefix_and_twenty_bytes() {
        let d = Address::repeat_byte(0xde);
        let mut code = DESIGNATOR.to_vec();
        code.extend_from_slice(d.as_slice());
        assert_eq!(designated(&code), Some(d));
        assert_eq!(designated(&code[..22]), None);
        code.push(0);
        assert_eq!(designated(&code), None);
        assert_eq!(designated(&[0x60, 0x80]), None);
        assert_eq!(designated(&[]), None);
    }

    #[test]
    fn code_callees_skip_creations_and_static_calls() {
        use eg_core::types::{Bytes, U256};
        let f = |path: &[u32], kind, to: u8| CallFrame {
            path: path.to_vec(),
            kind,
            from: Address::repeat_byte(1),
            to: Some(Address::repeat_byte(to)),
            value: U256::ZERO,
            input: Bytes::from(vec![0x60, 0x80, 0x60, 0x40]),
            output: None,
            gas: 0,
            gas_used: None,
            error: None,
            subtraces: 0,
        };
        let frames = [
            f(&[], CallKind::Call, 2),
            f(&[0], CallKind::Create, 3),
            f(&[1], CallKind::Create2, 4),
            f(&[2], CallKind::StaticCall, 5),
            f(&[3], CallKind::DelegateCall, 6),
            f(&[4], CallKind::CallCode, 7),
            f(&[5], CallKind::Call, 2),
        ];
        assert_eq!(
            code_callees(&frames),
            [2, 6, 7].map(Address::repeat_byte).to_vec()
        );
    }
}
