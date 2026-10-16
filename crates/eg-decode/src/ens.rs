use alloy_primitives::{Address, B256, Bytes, U256, keccak256};
use alloy_sol_types::{SolCall, SolError, sol};

use crate::multicall::CallResult;

sol! {
    interface IUniversalResolver {
        function reverse(bytes lookupAddress, uint256 coinType) external view returns (string, address, address);
        function resolve(bytes name, bytes data) external view returns (bytes, address);
        error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);
    }
    interface IAddrResolver {
        function addr(bytes32 node) external view returns (address);
    }
}

#[derive(thiserror::Error, Debug)]
pub enum DecodeError {
    #[error("invalid ENS name: {0}")]
    InvalidName(String),
    #[error("abi decode error: {0}")]
    Abi(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReverseResult {
    Name(String),
    NoName,
    Offchain,
}

pub fn normalize(name: &str) -> Result<String, DecodeError> {
    let input = name.trim();
    let invalid = || DecodeError::InvalidName(input.to_string());
    if input.is_empty() {
        return Err(invalid());
    }
    let out = ens_normalize_rs::normalize(input).map_err(|_| invalid())?;
    if out.is_empty() || out.split('.').any(str::is_empty) {
        return Err(invalid());
    }
    Ok(out)
}

pub fn namehash(normalized: &str) -> B256 {
    let mut node = B256::ZERO;
    if normalized.is_empty() {
        return node;
    }
    for label in normalized.rsplit('.') {
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(node.as_slice());
        buf[32..].copy_from_slice(keccak256(label.as_bytes()).as_slice());
        node = keccak256(buf);
    }
    node
}

pub fn dns_encode(normalized: &str) -> Result<Bytes, DecodeError> {
    let mut out = Vec::new();
    if !normalized.is_empty() {
        for label in normalized.split('.') {
            if label.is_empty() || label.len() > 63 {
                return Err(DecodeError::InvalidName(normalized.to_string()));
            }
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }
    }
    out.push(0);
    Ok(out.into())
}

pub fn encode_reverse(addr: Address) -> Bytes {
    IUniversalResolver::reverseCall {
        lookupAddress: Bytes::copy_from_slice(addr.as_slice()),
        coinType: U256::from(60u64),
    }
    .abi_encode()
    .into()
}

pub fn decode_reverse(r: &CallResult) -> ReverseResult {
    if r.success {
        return match IUniversalResolver::reverseCall::abi_decode_returns(&r.return_data) {
            Ok(ret) if !ret._0.is_empty() => ReverseResult::Name(ret._0),
            _ => ReverseResult::NoName,
        };
    }
    if r.return_data
        .starts_with(&IUniversalResolver::OffchainLookup::SELECTOR)
    {
        ReverseResult::Offchain
    } else {
        ReverseResult::NoName
    }
}

pub fn encode_resolve_addr(normalized: &str) -> Result<Bytes, DecodeError> {
    let name = dns_encode(normalized)?;
    let data = IAddrResolver::addrCall {
        node: namehash(normalized),
    }
    .abi_encode();
    Ok(IUniversalResolver::resolveCall {
        name,
        data: data.into(),
    }
    .abi_encode()
    .into())
}

/// `Ok(None)` when the name resolves to the zero address; `Err` when `ret` is
/// not a well-formed `resolve` + `addr` return value.
pub fn decode_resolve_addr(ret: &[u8]) -> Result<Option<Address>, DecodeError> {
    let abi = |e: alloy_sol_types::Error| DecodeError::Abi(e.to_string());
    let outer = IUniversalResolver::resolveCall::abi_decode_returns(ret).map_err(abi)?;
    let addr = IAddrResolver::addrCall::abi_decode_returns(&outer._0).map_err(abi)?;
    Ok((!addr.is_zero()).then_some(addr))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256};
    use alloy_sol_types::SolValue;

    #[test]
    fn namehash_vectors() {
        assert_eq!(namehash(""), B256::ZERO);
        assert_eq!(
            namehash("eth"),
            b256!("93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae")
        );
        assert_eq!(
            namehash("vitalik.eth"),
            b256!("ee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835")
        );
    }

    #[test]
    fn normalize_lowercases() {
        assert_eq!(normalize("Vitalik.ETH").unwrap(), "vitalik.eth");
        assert_eq!(normalize("  vitalik.eth ").unwrap(), "vitalik.eth");
    }

    #[test]
    fn normalize_rejects_invalid() {
        for bad in ["a..eth", ".eth", "a.eth.", "a b.eth", ""] {
            assert!(
                matches!(normalize(bad), Err(DecodeError::InvalidName(_))),
                "{bad:?} -> {:?}",
                normalize(bad)
            );
        }
    }

    #[test]
    fn normalize_drops_ignored_chars() {
        assert_eq!(normalize("a\u{200b}b.eth").unwrap(), "ab.eth");
    }

    #[test]
    fn dns_encode_vector() {
        let mut want = vec![7];
        want.extend_from_slice(b"vitalik");
        want.push(3);
        want.extend_from_slice(b"eth");
        want.push(0);
        assert_eq!(dns_encode("vitalik.eth").unwrap().to_vec(), want);
        assert_eq!(dns_encode("").unwrap().to_vec(), vec![0]);
        let long = format!("{}.eth", "a".repeat(64));
        assert!(matches!(
            dns_encode(&long),
            Err(DecodeError::InvalidName(_))
        ));
        assert!(dns_encode(&format!("{}.eth", "a".repeat(63))).is_ok());
    }

    #[test]
    fn encode_reverse_layout() {
        let a = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        let data = encode_reverse(a);
        let dec = IUniversalResolver::reverseCall::abi_decode(&data).unwrap();
        assert_eq!(dec.lookupAddress.to_vec(), a.as_slice().to_vec());
        assert_eq!(dec.coinType, alloy_primitives::U256::from(60));
    }

    #[test]
    fn reverse_name_and_empty() {
        let a = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        let ok = ("vitalik.eth".to_string(), a, a).abi_encode_params();
        let r = CallResult {
            success: true,
            return_data: ok.into(),
        };
        assert_eq!(
            decode_reverse(&r),
            ReverseResult::Name("vitalik.eth".into())
        );
        let empty = (String::new(), a, a).abi_encode_params();
        let r = CallResult {
            success: true,
            return_data: empty.into(),
        };
        assert_eq!(decode_reverse(&r), ReverseResult::NoName);
        let garbage = CallResult {
            success: true,
            return_data: vec![1].into(),
        };
        assert_eq!(decode_reverse(&garbage), ReverseResult::NoName);
    }

    #[test]
    fn reverse_offchain_detected() {
        let err = IUniversalResolver::OffchainLookup {
            sender: Address::ZERO,
            urls: vec!["https://x".to_string()],
            callData: vec![1].into(),
            callbackFunction: [1, 2, 3, 4].into(),
            extraData: vec![2].into(),
        };
        let r = CallResult {
            success: false,
            return_data: err.abi_encode().into(),
        };
        assert_eq!(decode_reverse(&r), ReverseResult::Offchain);
    }

    #[test]
    fn reverse_mismatch_is_noname() {
        let r = CallResult {
            success: false,
            return_data: vec![0x12, 0x34, 0x56, 0x78, 0].into(),
        };
        assert_eq!(decode_reverse(&r), ReverseResult::NoName);
        let r = CallResult {
            success: false,
            return_data: Bytes::new(),
        };
        assert_eq!(decode_reverse(&r), ReverseResult::NoName);
    }

    #[test]
    fn encode_resolve_addr_layout() {
        let data = encode_resolve_addr("vitalik.eth").unwrap();
        let dec = IUniversalResolver::resolveCall::abi_decode(&data).unwrap();
        assert_eq!(dec.name, dns_encode("vitalik.eth").unwrap());
        let inner = IAddrResolver::addrCall::abi_decode(&dec.data).unwrap();
        assert_eq!(inner.node, namehash("vitalik.eth"));
    }

    #[test]
    fn resolve_addr_roundtrip_and_zero() {
        let a = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        let inner: Bytes = IAddrResolver::addrCall::abi_encode_returns(&a).into();
        let ret = (inner, Address::ZERO).abi_encode_params();
        assert_eq!(decode_resolve_addr(&ret).unwrap(), Some(a));
        let inner: Bytes = IAddrResolver::addrCall::abi_encode_returns(&Address::ZERO).into();
        let ret = (inner, Address::ZERO).abi_encode_params();
        assert_eq!(decode_resolve_addr(&ret).unwrap(), None);
        assert!(matches!(
            decode_resolve_addr(&[1, 2]),
            Err(DecodeError::Abi(_))
        ));
        // Well-formed outer tuple whose inner bytes are not an address return.
        let ret = (Bytes::from(vec![7u8; 3]), Address::ZERO).abi_encode_params();
        assert!(matches!(
            decode_resolve_addr(&ret),
            Err(DecodeError::Abi(_))
        ));
    }
}
