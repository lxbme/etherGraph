use alloy_primitives::Bytes;
use alloy_sol_types::{SolCall, sol};

sol! {
    interface IERC20Meta {
        function decimals() external view returns (uint8);
        function symbol() external view returns (string);
        function name() external view returns (string);
    }
}

pub fn encode_decimals() -> Bytes {
    IERC20Meta::decimalsCall {}.abi_encode().into()
}

pub fn encode_symbol() -> Bytes {
    IERC20Meta::symbolCall {}.abi_encode().into()
}

pub fn encode_name() -> Bytes {
    IERC20Meta::nameCall {}.abi_encode().into()
}

pub fn decode_u8(ret: &[u8]) -> Option<u8> {
    // Strict: exactly one word whose upper 31 bytes are zero.
    if ret.len() != 32 || ret[..31].iter().any(|b| *b != 0) {
        return None;
    }
    Some(ret[31])
}

/// Decodes an ABI `string`; falls back to a left-aligned `bytes32` (old tokens
/// such as MKR) with trailing NULs stripped.
pub fn decode_string_or_bytes32(ret: &[u8]) -> Option<String> {
    if let Ok(s) = IERC20Meta::symbolCall::abi_decode_returns(ret) {
        return Some(s);
    }
    if ret.len() == 32 {
        let end = ret.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
        return String::from_utf8(ret[..end].to_vec()).ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_sol_types::SolValue;

    #[test]
    fn selectors() {
        assert_eq!(encode_decimals().as_ref(), [0x31, 0x3c, 0xe5, 0x67]);
        assert_eq!(encode_symbol().as_ref(), [0x95, 0xd8, 0x9b, 0x41]);
        assert_eq!(encode_name().as_ref(), [0x06, 0xfd, 0xde, 0x03]);
    }

    #[test]
    fn symbol_bytes32_mkr() {
        let mut v = b"MKR".to_vec();
        v.extend(std::iter::repeat_n(0u8, 29));
        assert_eq!(decode_string_or_bytes32(&v), Some("MKR".to_string()));
    }

    #[test]
    fn symbol_abi_string() {
        let enc = "USDT".to_string().abi_encode();
        assert_eq!(decode_string_or_bytes32(&enc), Some("USDT".to_string()));
    }

    #[test]
    fn decimals_ok_and_garbage_none() {
        let mut w = [0u8; 32];
        w[31] = 6;
        assert_eq!(decode_u8(&w), Some(6));
        assert_eq!(decode_u8(&[]), None);
        assert_eq!(decode_u8(&[0xff; 32]), None);
        assert_eq!(decode_string_or_bytes32(&[]), None);
    }
}
