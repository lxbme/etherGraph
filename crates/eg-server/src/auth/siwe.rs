//! Sign-In with Ethereum (EIP-4361), server side (D1): the server issues
//! every field of the message with a single-use nonce, rebuilds the text from
//! the stored record and requires the submitted message to equal it byte for
//! byte, so it never parses free-form EIP-4361 text.

use alloy_primitives::{Address, B256, Bytes, Signature, eip191_hash_message, hex};
use chrono::{Duration, Utc};
use eg_core::source::Priority;
use eg_store::{NoncePurpose, StoreError};
use serde::{Deserialize, Serialize};

use crate::dto::{SiweFieldsDto, rfc3339};
use crate::state::AppState;

/// The login message's statement.
pub const LOGIN_STATEMENT: &str = "Sign in to etherGraph";
/// How long an issued message (and its nonce) stays valid.
pub const MESSAGE_TTL: Duration = Duration::minutes(5);
/// Longest message accepted for verification; ours are far shorter.
pub const MAX_MESSAGE_LEN: usize = 1024;
/// Longest signature (bytes) passed to a contract wallet.
const MAX_SIGNATURE_LEN: usize = 2048;
/// `isValidSignature(bytes32,bytes)` selector and its success value (EIP-1271).
pub const EIP1271_MAGIC: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// Every field of a message except the signer's address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiweFields {
    /// `host[:port]` of the public origin.
    pub domain: String,
    pub statement: String,
    /// The public origin.
    pub uri: String,
    pub version: String,
    pub chain_id: u64,
    pub nonce: String,
    /// Millisecond-precision UTC (`toISOString` form), so a client that turns
    /// it into a `Date` prints the same text.
    pub issued_at: String,
    pub expiration_time: String,
}

/// The EIP-4361 text exactly as viem's `createSiweMessage` prints it, with the
/// address EIP-55 checksummed.
pub fn canonical_message(f: &SiweFields, address: Address) -> String {
    format!(
        "{domain} wants you to sign in with your Ethereum account:\n{address}\n\n{statement}\n\n\
         URI: {uri}\nVersion: {version}\nChain ID: {chain_id}\nNonce: {nonce}\n\
         Issued At: {issued_at}\nExpiration Time: {expiration_time}",
        domain = f.domain,
        address = address.to_checksum(None),
        statement = f.statement,
        uri = f.uri,
        version = f.version,
        chain_id = f.chain_id,
        nonce = f.nonce,
        issued_at = f.issued_at,
        expiration_time = f.expiration_time,
    )
}

/// The signer address (second line) and nonce a message claims; `None` when
/// it does not have the shape of a SIWE message.
pub fn claimed(message: &str) -> Option<(Address, &str)> {
    let mut lines = message.split('\n');
    lines.next()?;
    let addr = lines.next()?;
    let hex_ok = addr
        .strip_prefix("0x")
        .is_some_and(|h| h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit()));
    if !hex_ok {
        return None;
    }
    let nonce = lines.find_map(|l| l.strip_prefix("Nonce: "))?;
    Some((addr.parse().ok()?, nonce))
}

/// Issues a nonce for `purpose` and returns the message fields for `address`,
/// valid for [`MESSAGE_TTL`]. The nonce row stores every field but the nonce
/// itself (its key).
pub async fn issue(
    state: &AppState,
    purpose: NoncePurpose,
    user_id: Option<i64>,
    address: Address,
    statement: &str,
) -> Result<SiweFieldsDto, StoreError> {
    let now = Utc::now();
    let mut dto = SiweFieldsDto::new(
        address,
        SiweFields {
            domain: state.auth.origin.domain.clone(),
            statement: statement.to_owned(),
            uri: state.auth.origin.origin.clone(),
            version: "1".into(),
            chain_id: 1,
            nonce: String::new(),
            issued_at: rfc3339(now),
            expiration_time: rfc3339(now + MESSAGE_TTL),
        },
    );
    let mut stored = serde_json::to_value(&dto).expect("fields serialize");
    if let Some(o) = stored.as_object_mut() {
        o.remove("nonce");
    }
    // The nonce expires with the message: taking it later fails, which is
    // the message's time check.
    dto.nonce = state
        .store
        .nonce_issue(purpose, user_id, &stored, None, MESSAGE_TTL)
        .await?;
    Ok(dto)
}

/// Consumes `nonce` (see [`eg_store::Store::nonce_take`]) and returns the
/// fields it was issued with, and the user it was issued to.
pub async fn take(
    state: &AppState,
    nonce: &str,
    purpose: NoncePurpose,
) -> Result<Option<(SiweFieldsDto, Option<i64>)>, StoreError> {
    let Some(row) = state.store.nonce_take(nonce, purpose).await? else {
        return Ok(None);
    };
    let mut fields = row.fields;
    if let Some(o) = fields.as_object_mut() {
        o.insert("nonce".into(), row.nonce.into());
    }
    let dto = serde_json::from_value(fields)
        .map_err(|e| StoreError::Invalid(format!("nonce fields: {e}")))?;
    Ok(Some((dto, row.user_id)))
}

#[derive(Debug)]
pub enum VerifyError {
    /// Neither the address's key nor its contract (EIP-1271) signed the message.
    BadSignature,
    Store(StoreError),
}

impl From<StoreError> for VerifyError {
    fn from(e: StoreError) -> Self {
        VerifyError::Store(e)
    }
}

/// Checks that `address` signed `message` (EIP-191 `personal_sign`): by
/// recovering the signer of a 65-byte signature, and otherwise, only for an
/// address allowed to log in (D6), by asking the address's contract
/// (EIP-1271 `isValidSignature`) through the chain source. That call is the
/// server's, billed to no user.
pub async fn verify_signer(
    state: &AppState,
    address: Address,
    message: &str,
    signature: &str,
) -> Result<(), VerifyError> {
    let sig = signature.strip_prefix("0x").unwrap_or(signature);
    let Ok(sig) = hex::decode(sig) else {
        return Err(VerifyError::BadSignature);
    };
    if sig.is_empty() || sig.len() > MAX_SIGNATURE_LEN {
        return Err(VerifyError::BadSignature);
    }
    let recovered = Signature::from_raw(&sig)
        .ok()
        .and_then(|s| s.recover_address_from_msg(message).ok());
    if recovered == Some(address) {
        return Ok(());
    }
    if !super::may_log_in(state, address).await? {
        return Err(VerifyError::BadSignature);
    }
    let hash = eip191_hash_message(message);
    match state
        .source
        .eth_call(
            Priority::Interactive,
            address,
            is_valid_signature_call(hash, &sig),
        )
        .await
    {
        Ok(out) if out.len() >= 4 && out[..4] == EIP1271_MAGIC => Ok(()),
        Ok(_) => Err(VerifyError::BadSignature),
        Err(e) => {
            tracing::warn!(error = %e, %address, "EIP-1271 isValidSignature call failed");
            Err(VerifyError::BadSignature)
        }
    }
}

/// ABI-encoded `isValidSignature(bytes32 hash, bytes signature)`.
fn is_valid_signature_call(hash: B256, sig: &[u8]) -> Bytes {
    let word = |n: usize| {
        let mut w = [0u8; 32];
        w[24..].copy_from_slice(&(n as u64).to_be_bytes());
        w
    };
    let padded = sig.len().div_ceil(32) * 32;
    let mut data = Vec::with_capacity(4 + 32 * 3 + padded);
    data.extend_from_slice(&EIP1271_MAGIC);
    data.extend_from_slice(hash.as_slice());
    data.extend_from_slice(&word(64));
    data.extend_from_slice(&word(sig.len()));
    data.extend_from_slice(sig);
    data.resize(4 + 32 * 3 + padded, 0);
    data.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> SiweFields {
        SiweFields {
            domain: "127.0.0.1:8080".into(),
            statement: LOGIN_STATEMENT.into(),
            uri: "http://127.0.0.1:8080".into(),
            version: "1".into(),
            chain_id: 1,
            nonce: "0123456789abcdef".into(),
            issued_at: "2026-10-19T12:00:00.000Z".into(),
            expiration_time: "2026-10-19T12:05:00.000Z".into(),
        }
    }

    #[test]
    fn claimed_reads_address_and_nonce() {
        let a = Address::repeat_byte(0xab);
        let m = canonical_message(&fields(), a);
        assert_eq!(claimed(&m), Some((a, "0123456789abcdef")));
        assert_eq!(claimed("one line"), None);
        assert_eq!(claimed("x\n0x12\nNonce: 1"), None);
        assert_eq!(
            claimed(&format!("x\n{a:#x}\nno nonce line")),
            None,
            "nonce missing"
        );
    }

    #[test]
    fn is_valid_signature_encoding() {
        let hash = B256::repeat_byte(7);
        let data = is_valid_signature_call(hash, &[0xaa; 65]);
        assert_eq!(data.len(), 4 + 32 * 3 + 96);
        assert_eq!(&data[..4], &EIP1271_MAGIC);
        assert_eq!(&data[4..36], hash.as_slice());
        assert_eq!(data[67], 64);
        assert_eq!(data[99], 65);
        assert_eq!(&data[100..165], &[0xaa; 65]);
        assert!(data[165..].iter().all(|&b| b == 0));
    }
}
