use alloy_primitives::{Address, Bytes};
use alloy_sol_types::{SolCall, sol};

use crate::ens::DecodeError;

sol! {
    interface IMulticall3 {
        struct Call3 {
            address target;
            bool allowFailure;
            bytes callData;
        }
        struct Result {
            bool success;
            bytes returnData;
        }
        function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call3 {
    pub target: Address,
    pub allow_failure: bool,
    pub call_data: Bytes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallResult {
    pub success: bool,
    pub return_data: Bytes,
}

pub fn encode_aggregate3(calls: &[Call3]) -> Bytes {
    let calls = calls
        .iter()
        .map(|c| IMulticall3::Call3 {
            target: c.target,
            allowFailure: c.allow_failure,
            callData: c.call_data.clone(),
        })
        .collect();
    IMulticall3::aggregate3Call { calls }.abi_encode().into()
}

pub fn decode_aggregate3(ret: &[u8]) -> Result<Vec<CallResult>, DecodeError> {
    let results = IMulticall3::aggregate3Call::abi_decode_returns(ret)
        .map_err(|e| DecodeError::Abi(e.to_string()))?;
    Ok(results
        .into_iter()
        .map(|r| CallResult {
            success: r.success,
            return_data: r.returnData,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;

    #[test]
    fn aggregate3_roundtrip() {
        let results = vec![
            IMulticall3::Result {
                success: true,
                returnData: vec![1, 2, 3].into(),
            },
            IMulticall3::Result {
                success: false,
                returnData: Bytes::new(),
            },
        ];
        let ret = IMulticall3::aggregate3Call::abi_encode_returns(&results);
        let out = decode_aggregate3(&ret).unwrap();
        assert_eq!(
            out,
            vec![
                CallResult {
                    success: true,
                    return_data: vec![1, 2, 3].into()
                },
                CallResult {
                    success: false,
                    return_data: Bytes::new()
                },
            ]
        );
        assert!(decode_aggregate3(&[1, 2, 3]).is_err());
    }

    #[test]
    fn aggregate3_encode_decodes_back() {
        let calls = vec![Call3 {
            target: address!("cA11bde05977b3631167028862bE2a173976CA11"),
            allow_failure: true,
            call_data: vec![0xde, 0xad].into(),
        }];
        let enc = encode_aggregate3(&calls);
        let dec = IMulticall3::aggregate3Call::abi_decode(&enc).unwrap();
        assert_eq!(dec.calls.len(), 1);
        assert_eq!(dec.calls[0].target, calls[0].target);
        assert!(dec.calls[0].allowFailure);
        assert_eq!(dec.calls[0].callData, calls[0].call_data);
    }
}
