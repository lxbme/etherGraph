//! Conversions between Rust primitives and Postgres representations.
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use bigdecimal::BigDecimal;

use crate::StoreError;

pub fn u256_to_bd(v: U256) -> BigDecimal {
    BigDecimal::from_str(&v.to_string()).expect("decimal string is always a valid BigDecimal")
}

/// Converts a `numeric(78,0)` value back to `U256`; negative, fractional or
/// out-of-range values are `StoreError::Invalid`.
pub fn bd_to_u256(v: &BigDecimal) -> Result<U256, StoreError> {
    let bad = || StoreError::Invalid(format!("{v} is not a valid U256"));
    if v.sign() == bigdecimal::num_bigint::Sign::Minus || !v.is_integer() {
        return Err(bad());
    }
    U256::from_str_radix(&v.with_scale(0).to_string(), 10).map_err(|_| bad())
}

pub fn addr_to_bytes(a: Address) -> Vec<u8> {
    a.as_slice().to_vec()
}

/// Panics-free: input of the wrong length yields the zero-padded/truncated
/// right-aligned 20 bytes (columns are always written with 20 bytes).
pub fn bytes_to_addr(b: &[u8]) -> Address {
    let mut out = [0u8; 20];
    let n = b.len().min(20);
    out[20 - n..].copy_from_slice(&b[b.len() - n..]);
    Address::from(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u256_roundtrip() {
        for v in [U256::ZERO, U256::from(12345u64), U256::MAX] {
            assert_eq!(bd_to_u256(&u256_to_bd(v)).unwrap(), v);
        }
    }

    #[test]
    fn bd_to_u256_rejects_invalid() {
        let over = u256_to_bd(U256::MAX) + BigDecimal::from(1);
        for s in ["-1", "1.5"] {
            assert!(matches!(
                bd_to_u256(&BigDecimal::from_str(s).unwrap()),
                Err(StoreError::Invalid(_))
            ));
        }
        assert!(matches!(bd_to_u256(&over), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn addr_roundtrip() {
        let a = Address::repeat_byte(0xab);
        assert_eq!(bytes_to_addr(&addr_to_bytes(a)), a);
    }
}
