//! EIP-7702 authorization list of a set-code (type 4) transaction, read from
//! the stored raw tx JSON, with each signer recovered from its signature.

use std::collections::{HashMap, HashSet};

use alloy_primitives::{Address, B256, Signature, U256, keccak256};
use alloy_rlp::{Encodable, Header};
use serde_json::Value;

/// Delegates identified automatically per transaction, besides from and to.
pub const MAX_AUTO_DELEGATES: usize = 8;
/// Entries whose signer is recovered per transaction (one signature recovery
/// each, on every read); later entries are listed without a signer.
pub const MAX_RECOVERED: usize = 64;
/// Effective delegations drawn per transaction; each adds its signer and its
/// delegate as nodes.
pub const MAX_DELEGATIONS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Authorization {
    pub chain_id: U256,
    /// The address whose code the authority delegates to; zero clears the
    /// authority's delegation.
    pub delegate: Address,
    pub nonce: U256,
    /// The recovered signer; `None` when the signature does not recover, the
    /// entry cannot be valid on mainnet (chain id other than 0 or 1, nonce
    /// of 2^64 − 1 or more) or comes after the first [`MAX_RECOVERED`].
    pub authority: Option<Address>,
}

/// The delegation a signer is left with once a transaction's authorization
/// list has been applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Delegation {
    pub authority: Address,
    /// Never zero: a cleared delegation is no delegation.
    pub delegate: Address,
}

/// EIP-7702 `MAGIC`: the prefix byte of the signed authorization message.
const MAGIC: u8 = 0x05;
/// Mainnet, the only chain this app reads; chain id 0 is valid on every chain.
const CHAIN_ID: u64 = 1;

/// The signed message: `keccak256(0x05 ‖ rlp([chain_id, address, nonce]))`.
pub fn authorization_hash(chain_id: U256, delegate: Address, nonce: U256) -> B256 {
    let header = Header {
        list: true,
        payload_length: chain_id.length() + delegate.length() + nonce.length(),
    };
    let mut buf = Vec::with_capacity(1 + header.length_with_payload());
    buf.push(MAGIC);
    header.encode(&mut buf);
    chain_id.encode(&mut buf);
    delegate.encode(&mut buf);
    nonce.encode(&mut buf);
    keccak256(&buf)
}

/// The signer of an authorization; `None` for a signature that does not
/// recover or has a high `s` (EIP-2), which EIP-7702 rejects.
pub fn recover_authority(
    chain_id: U256,
    delegate: Address,
    nonce: U256,
    signature: Signature,
) -> Option<Address> {
    if signature.normalize_s().is_some() {
        return None;
    }
    signature
        .recover_address_from_prehash(&authorization_hash(chain_id, delegate, nonce))
        .ok()
}

/// A hex quantity (`0x` prefix optional, as in `txdetail`); `None` when
/// absent or malformed.
fn quantity(entry: &Value, key: &str) -> Option<U256> {
    let s = entry.get(key)?.as_str()?;
    U256::from_str_radix(s.strip_prefix("0x").unwrap_or(s), 16).ok()
}

/// An entry with its signer recovered when `recover`.
fn entry(e: &Value, recover: bool) -> Option<Authorization> {
    let chain_id = quantity(e, "chainId")?;
    let delegate = e.get("address")?.as_str()?.parse().ok()?;
    let nonce = quantity(e, "nonce")?;
    // EIP-7702: the nonce must be below 2^64 − 1.
    let valid =
        (chain_id.is_zero() || chain_id == U256::from(CHAIN_ID)) && nonce < U256::from(u64::MAX);
    let signature = || {
        let y_parity = match quantity(e, "yParity")? {
            p if p.is_zero() => false,
            p if p == U256::from(1) => true,
            _ => return None,
        };
        Some(Signature::new(
            quantity(e, "r")?,
            quantity(e, "s")?,
            y_parity,
        ))
    };
    let authority = if valid && recover {
        signature().and_then(|sig| recover_authority(chain_id, delegate, nonce, sig))
    } else {
        None
    };
    Some(Authorization {
        chain_id,
        delegate,
        nonce,
        authority,
    })
}

/// The `authorizationList` of a raw tx in order; empty when the tx has none.
/// An entry without a readable chain id, address or nonce is left out; one
/// without a usable signature, or after the first [`MAX_RECOVERED`] entries,
/// is kept with no authority.
pub fn authorizations(raw_tx: &Value) -> Vec<Authorization> {
    let Some(list) = raw_tx.get("authorizationList").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut recovered = 0;
    list.iter()
        .filter_map(|e| {
            let a = entry(e, recovered < MAX_RECOVERED)?;
            recovered += 1;
            Some(a)
        })
        .collect()
}

/// The tx's own nonce (`nonce` of the raw tx); `None` when absent or malformed.
pub fn tx_nonce(raw_tx: &Value) -> Option<U256> {
    quantity(raw_tx, "nonce")
}

/// The delegate each recovered signer is left with after the list is applied
/// in order, zero when its delegation ends cleared, in the order of the
/// signers' first applying entries. An entry without a signer never applies.
///
/// EIP-7702 applies an entry only when its nonce equals the signer's current
/// nonce, which then increments. Only the sender's nonce is known: the list is
/// processed after the tx has used its own nonce, so the sender's chain starts
/// at `sender_nonce + 1` and is simulated. Any other signer's current nonce is
/// unknown, so its last entry wins — an approximation that also counts an
/// entry the EVM would skip for a stale nonce. The sender too falls back to
/// its last entry when `sender_nonce` is unknown.
pub fn applied_delegations(
    auths: &[Authorization],
    sender: Address,
    sender_nonce: Option<U256>,
) -> Vec<(Address, Address)> {
    let mut sender_next = sender_nonce.map(|n| n.saturating_add(U256::from(1)));
    let mut signers = Vec::new();
    let mut current = HashMap::new();
    for a in auths {
        let Some(authority) = a.authority else {
            continue;
        };
        if authority == sender
            && let Some(next) = sender_next.as_mut()
        {
            if a.nonce != *next {
                continue;
            }
            *next = next.saturating_add(U256::from(1));
        }
        if current.insert(authority, a.delegate).is_none() {
            signers.push(authority);
        }
    }
    signers
        .into_iter()
        .map(|authority| (authority, current[&authority]))
        .collect()
}

/// The delegation each recovered signer holds after the list is applied (see
/// [`applied_delegations`]); a signer whose delegation ends cleared (zero
/// delegate) has none.
pub fn effective_delegations(
    auths: &[Authorization],
    sender: Address,
    sender_nonce: Option<U256>,
) -> Vec<Delegation> {
    applied_delegations(auths, sender, sender_nonce)
        .into_iter()
        .filter(|(_, delegate)| !delegate.is_zero())
        .map(|(authority, delegate)| Delegation {
            authority,
            delegate,
        })
        .collect()
}

/// EIP-7702 delegation designator: the code of a delegated account is this
/// prefix followed by the delegate's address.
const DESIGNATOR: [u8; 3] = [0xef, 0x01, 0x00];

/// The delegate an account's `code` designates: exactly [`DESIGNATOR`] and
/// 20 address bytes; anything else designates none.
pub fn designated(code: &[u8]) -> Option<Address> {
    let rest = code.strip_prefix(&DESIGNATOR)?;
    (rest.len() == 20).then(|| Address::from_slice(rest))
}

/// The distinct delegates of `delegations`, in order.
pub fn delegates(delegations: &[Delegation]) -> Vec<Address> {
    let mut seen = HashSet::new();
    delegations
        .iter()
        .map(|d| d.delegate)
        .filter(|d| seen.insert(*d))
        .collect()
}

/// The addresses of a tx identified automatically: its sender, its recipient
/// (or the contract it created) and the first [`MAX_AUTO_DELEGATES`]
/// delegates of its drawn (first [`MAX_DELEGATIONS`]) effective delegations.
/// Everything else is identified on demand.
pub fn auto_meta_parties(
    from: Address,
    to_or_created: Option<Address>,
    delegations: &[Delegation],
) -> Vec<Address> {
    let drawn = &delegations[..delegations.len().min(MAX_DELEGATIONS)];
    std::iter::once(from)
        .chain(to_or_created)
        .chain(delegates(drawn).into_iter().take(MAX_AUTO_DELEGATES))
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use alloy_primitives::address;
    use k256::ecdsa::SigningKey;
    use serde_json::json;

    const DELEGATE: Address = address!("0x612373d7003d694220f7800eeaf8e3924c0951d3");
    const SENDER: Address = address!("0xe461dd07cbf41b8020a2e9f50255bf85bf1c4905");
    const R: &str = "0x6d3ecfb34878c8ad3edebf5c137af1156a68e7340093454d4386ccc7465d0571";
    const S: &str = "0x6d80a00a79df8879470ac42c6e89fba6c951d1aaa9601dfce50499993e391300";

    fn word(s: &str) -> U256 {
        s.parse().unwrap()
    }

    /// The single authorization of mainnet tx 0x4f85…bb8c.
    fn real_entry() -> Value {
        json!({"chainId": "0x1", "address": format!("{DELEGATE:#x}"), "nonce": "0x2",
            "yParity": "0x0", "r": R, "s": S})
    }

    pub(crate) fn key(byte: u8) -> SigningKey {
        SigningKey::from_slice(&[byte; 32]).unwrap()
    }

    /// An entry signed by `key`.
    pub(crate) fn signed(key: &SigningKey, chain_id: u64, delegate: Address, nonce: u64) -> Value {
        let hash = authorization_hash(U256::from(chain_id), delegate, U256::from(nonce));
        let (sig, recid) = key.sign_prehash_recoverable(hash.as_slice()).unwrap();
        let sig = Signature::from_signature_and_parity(sig, recid.is_y_odd());
        json!({"chainId": format!("{chain_id:#x}"), "address": format!("{delegate:#x}"),
            "nonce": format!("{nonce:#x}"), "yParity": if sig.v() { "0x1" } else { "0x0" },
            "r": format!("{:#x}", sig.r()), "s": format!("{:#x}", sig.s())})
    }

    fn list(entries: Vec<Value>) -> Value {
        json!({"type": "0x4", "authorizationList": entries})
    }

    #[test]
    fn real_mainnet_authorization_recovers_to_the_sender() {
        let sig = Signature::new(word(R), word(S), false);
        let authority = recover_authority(U256::from(1), DELEGATE, U256::from(2), sig);
        assert_eq!(authority, Some(SENDER));
        assert_eq!(
            authorizations(&list(vec![real_entry()])),
            vec![Authorization {
                chain_id: U256::from(1),
                delegate: DELEGATE,
                nonce: U256::from(2),
                authority: Some(SENDER),
            }]
        );
    }

    #[test]
    fn several_authorizations_recover_each_signer_in_order() {
        let (k1, k2) = (key(1), key(2));
        let other = Address::repeat_byte(0x44);
        let auths = authorizations(&list(vec![
            signed(&k1, 1, DELEGATE, 0),
            signed(&k2, 0, other, 7),
            signed(&k1, 1, Address::ZERO, 1),
        ]));
        let got: Vec<_> = auths
            .iter()
            .map(|a| {
                (
                    a.chain_id.to::<u64>(),
                    a.delegate,
                    a.nonce.to::<u64>(),
                    a.authority,
                )
            })
            .collect();
        let (a1, a2) = (
            Address::from_private_key(&k1),
            Address::from_private_key(&k2),
        );
        assert_ne!(a1, a2);
        assert_eq!(
            got,
            vec![
                (1, DELEGATE, 0, Some(a1)),
                // Chain id 0 is valid on every chain.
                (0, other, 7, Some(a2)),
                // A zero delegate clears the delegation; the signer still recovers.
                (1, Address::ZERO, 1, Some(a1)),
            ]
        );
    }

    #[test]
    fn unusable_signatures_keep_the_entry_without_an_authority() {
        let k = key(3);
        let mut bad_r = real_entry();
        bad_r["r"] = json!("0x0");
        let mut no_s = real_entry();
        no_s.as_object_mut().unwrap().remove("s");
        let mut bad_parity = real_entry();
        bad_parity["yParity"] = json!("0x2");
        let mut huge_parity = real_entry();
        huge_parity["yParity"] = json!(format!("{:#x}", U256::MAX));
        let mut garbage = real_entry();
        garbage["r"] = json!("not hex");
        let wrong_chain = signed(&k, 5, DELEGATE, 0);
        // A high-s twin of a valid signature recovers the same key, but EIP-7702
        // rejects it.
        let mut high_s = signed(&k, 1, DELEGATE, 0);
        let s = word(high_s["s"].as_str().unwrap());
        let n = word("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
        high_s["s"] = json!(format!("{:#x}", n - s));
        high_s["yParity"] = json!(if high_s["yParity"] == "0x0" {
            "0x1"
        } else {
            "0x0"
        });
        let mut huge_nonce = signed(&k, 1, DELEGATE, 0);
        huge_nonce["nonce"] = json!("0x10000000000000000");
        // EIP-7702 requires nonce < 2^64 − 1.
        let max_nonce = signed(&k, 1, DELEGATE, u64::MAX);

        let auths = authorizations(&list(vec![
            bad_r,
            no_s,
            bad_parity,
            huge_parity,
            garbage,
            wrong_chain,
            high_s,
            huge_nonce,
            max_nonce,
        ]));
        assert_eq!(auths.len(), 9);
        assert!(auths.iter().all(|a| a.authority.is_none()), "{auths:?}");
        assert_eq!(auths[5].chain_id, U256::from(5));
        assert_eq!(auths[7].nonce, U256::from(1u128 << 64));
    }

    #[test]
    fn entries_without_chain_address_or_nonce_are_left_out() {
        let mut no_addr = real_entry();
        no_addr.as_object_mut().unwrap().remove("address");
        let mut bad_chain = real_entry();
        bad_chain["chainId"] = json!(1);
        let mut no_nonce = real_entry();
        no_nonce.as_object_mut().unwrap().remove("nonce");
        let auths = authorizations(&list(vec![
            no_addr,
            json!("junk"),
            bad_chain,
            no_nonce,
            real_entry(),
        ]));
        assert_eq!(auths.len(), 1);
        assert_eq!(auths[0].authority, Some(SENDER));
    }

    #[test]
    fn a_tx_without_a_list_has_no_authorizations() {
        assert!(authorizations(&json!({"type": "0x2"})).is_empty());
        assert!(authorizations(&json!({"authorizationList": null})).is_empty());
        assert!(authorizations(&json!({"authorizationList": "0x"})).is_empty());
        assert!(authorizations(&json!("not an object")).is_empty());
    }

    fn auth(authority: Option<Address>, delegate: Address, nonce: u64) -> Authorization {
        Authorization {
            chain_id: U256::from(1),
            delegate,
            nonce: U256::from(nonce),
            authority,
        }
    }

    fn d(authority: Address, delegate: Address) -> Delegation {
        Delegation {
            authority,
            delegate,
        }
    }

    const X: Address = Address::repeat_byte(1);
    const Y: Address = Address::repeat_byte(2);
    const K: Address = Address::repeat_byte(0x4b);
    const J: Address = Address::repeat_byte(0x4a);

    #[test]
    fn the_sender_follows_its_nonce_chain_from_tx_nonce_plus_one() {
        let eff = |auths: &[Authorization]| effective_delegations(auths, K, Some(U256::from(1)));
        // Mainnet 0x4f85…bb8c: tx nonce 1, one entry with nonce 2 → applies.
        assert_eq!(eff(&[auth(Some(K), X, 2)]), vec![d(K, X)]);
        // The second entry repeats nonce 2, which is spent by then: X stays.
        assert_eq!(
            eff(&[auth(Some(K), X, 2), auth(Some(K), Y, 2)]),
            vec![d(K, X)]
        );
        // Consecutive nonces both apply: the later one wins.
        assert_eq!(
            eff(&[auth(Some(K), X, 2), auth(Some(K), Y, 3)]),
            vec![d(K, Y)]
        );
        // Nonce 1 is the tx's own, already used: nothing applies.
        assert_eq!(eff(&[auth(Some(K), X, 1)]), vec![]);
        // A skipped entry does not advance the nonce.
        assert_eq!(
            eff(&[auth(Some(K), X, 5), auth(Some(K), Y, 2)]),
            vec![d(K, Y)]
        );
        // An entry without a signer neither applies nor advances the nonce.
        assert_eq!(eff(&[auth(None, Y, 2), auth(Some(K), X, 2)]), vec![d(K, X)]);
    }

    #[test]
    fn an_applying_zero_delegate_clears_the_delegation() {
        let sender = |auths: &[Authorization]| effective_delegations(auths, K, Some(U256::ZERO));
        assert_eq!(
            sender(&[auth(Some(K), X, 1), auth(Some(K), Address::ZERO, 2)]),
            vec![]
        );
        // A clearing entry with a stale nonce is skipped.
        assert_eq!(
            sender(&[auth(Some(K), X, 1), auth(Some(K), Address::ZERO, 1)]),
            vec![d(K, X)]
        );
        // Another signer: the last entry wins, nonce unchecked.
        let other = effective_delegations(
            &[auth(Some(J), X, 0), auth(Some(J), Address::ZERO, 0)],
            K,
            Some(U256::ZERO),
        );
        assert_eq!(other, vec![]);
        let other = effective_delegations(
            &[auth(Some(J), Address::ZERO, 9), auth(Some(J), X, 0)],
            K,
            Some(U256::ZERO),
        );
        assert_eq!(other, vec![d(J, X)]);
    }

    #[test]
    fn other_signers_and_an_unknown_tx_nonce_keep_the_last_entry() {
        let auths = [
            auth(Some(J), X, 0),
            auth(Some(K), X, 7),
            auth(None, Y, 0),
            auth(Some(J), Y, 0),
        ];
        // K is no sender here: the last entry of each signer wins, in the
        // order of the signers' first entries.
        assert_eq!(
            effective_delegations(&auths, Address::repeat_byte(0xee), Some(U256::ZERO)),
            vec![d(J, Y), d(K, X)]
        );
        // The sender's nonce is unknown: last entry wins for it too.
        assert_eq!(
            effective_delegations(&auths, K, None),
            vec![d(J, Y), d(K, X)]
        );
        assert_eq!(
            effective_delegations(&auths, K, Some(U256::ZERO)),
            vec![d(J, Y)]
        );
    }

    #[test]
    fn tx_nonce_reads_the_raw_tx() {
        assert_eq!(tx_nonce(&json!({"nonce": "0x1"})), Some(U256::from(1)));
        assert_eq!(tx_nonce(&json!({})), None);
        assert_eq!(tx_nonce(&json!({"nonce": "junk"})), None);
    }

    #[test]
    fn delegates_are_distinct_in_order() {
        let ds = [d(K, Y), d(J, X), d(Address::repeat_byte(9), Y)];
        assert_eq!(delegates(&ds), vec![Y, X]);
    }

    #[test]
    fn a_designator_is_the_prefix_and_twenty_bytes() {
        let d = Address::repeat_byte(0xde);
        let mut code = vec![0xef, 0x01, 0x00];
        code.extend_from_slice(d.as_slice());
        assert_eq!(designated(&code), Some(d));
        // 22 and 24 bytes.
        assert_eq!(designated(&code[..22]), None);
        let mut long = code.clone();
        long.push(0);
        assert_eq!(designated(&long), None);
        // 23 bytes under another prefix.
        let mut other = code.clone();
        other[2] = 0x01;
        assert_eq!(designated(&other), None);
        assert_eq!(designated(&[0x60, 0x80]), None);
        assert_eq!(designated(&[]), None);
    }

    #[test]
    fn only_the_first_entries_are_recovered() {
        let k = key(4);
        let entries: Vec<Value> = (0..MAX_RECOVERED as u64 + 3)
            .map(|n| signed(&k, 1, DELEGATE, n))
            .collect();
        let auths = authorizations(&list(entries));
        assert_eq!(auths.len(), MAX_RECOVERED + 3);
        let me = Address::from_private_key(&k);
        assert!(
            auths[..MAX_RECOVERED]
                .iter()
                .all(|a| a.authority == Some(me))
        );
        assert!(auths[MAX_RECOVERED..].iter().all(|a| a.authority.is_none()));
        // Entries left out for a missing field do not count.
        let mut entries = vec![json!("junk"); 5];
        entries.extend((0..MAX_RECOVERED as u64).map(|n| signed(&k, 1, DELEGATE, n)));
        let auths = authorizations(&list(entries));
        assert!(auths.iter().all(|a| a.authority == Some(me)));
    }

    #[test]
    fn auto_meta_parties_cap_the_delegates() {
        let ds: Vec<Delegation> = (1u8..=10)
            .map(|b| d(Address::repeat_byte(0x80 + b), Address::repeat_byte(b)))
            .collect();
        let from = Address::repeat_byte(0xf0);
        let mut want = vec![from, DELEGATE];
        want.extend((1u8..=8).map(Address::repeat_byte));
        assert_eq!(auto_meta_parties(from, Some(DELEGATE), &ds), want);
        assert_eq!(auto_meta_parties(from, None, &[]), vec![from]);
        // Only the drawn delegations count: the first MAX_DELEGATIONS.
        let mut ds = vec![d(K, X); MAX_DELEGATIONS];
        ds.push(d(J, Y));
        assert_eq!(auto_meta_parties(from, None, &ds), vec![from, X]);
    }
}
