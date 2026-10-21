//! Names for calls and events no ABI covers, guessed from text signatures
//! (the local signature database). Pure: the caller looks the candidates up.

use alloy_dyn_abi::JsonAbiExt;
use alloy_json_abi::{Event, Function};

use crate::abi::{DecodedArg, DecodedCall, fmt_value};

/// A call decoded with a text signature rather than an ABI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuessedCall {
    pub call: DecodedCall,
    /// The other candidates that decode the input as cleanly, at most
    /// [`MAX_ALTERNATIVES`], shortest first.
    pub alternatives: Vec<String>,
}

/// Alternatives kept beside the chosen guess.
pub const MAX_ALTERNATIVES: usize = 5;

/// `input` decoded with the function `text` names, when its canonical
/// selector is `input`'s and its parameters decode `input[4..]` and re-encode
/// to it byte for byte. Arguments are unnamed (`""`), typed with their
/// canonical type.
fn clean_decode(text: &str, input: &[u8]) -> Option<DecodedCall> {
    let func = Function::parse(text).ok()?;
    if input.get(..4)? != func.selector().as_slice() {
        return None;
    }
    let data = input.get(4..)?;
    let values = func.abi_decode_input(data).ok()?;
    if func.abi_encode_input_raw(&values).ok()? != data {
        return None;
    }
    let args = func
        .inputs
        .iter()
        .zip(&values)
        .map(|(p, v)| DecodedArg {
            name: String::new(),
            ty: p.selector_type().into_owned(),
            value: fmt_value(v),
        })
        .collect();
    Some(DecodedCall {
        signature: func.signature(),
        name: func.name,
        args,
    })
}

/// The best of `candidates` (signature texts sharing input's selector) that decodes `input` and re-encodes to it exactly; None if none does.
///
/// Texts that do not parse are skipped, and so are texts whose canonical
/// form has another selector than `input`'s (a non-canonical text such as
/// `foo(uint)` is stored under its own hash). The shortest canonical
/// signature wins, ties broken lexicographically.
pub fn guess_call(input: &[u8], candidates: &[String]) -> Option<GuessedCall> {
    let mut clean: Vec<DecodedCall> = candidates
        .iter()
        .filter_map(|text| clean_decode(text, input))
        .collect();
    clean.sort_by(|a, b| (a.signature.len(), &a.signature).cmp(&(b.signature.len(), &b.signature)));
    clean.dedup_by(|a, b| a.signature == b.signature);
    let mut clean = clean.into_iter();
    let call = clean.next()?;
    let alternatives = clean.take(MAX_ALTERNATIVES).map(|c| c.signature).collect();
    Some(GuessedCall { call, alternatives })
}

/// An event named by its text signature: name and text only (indexed flags are unknown, args are not decoded).
pub fn guess_event(text: &str) -> Option<(String, String)> {
    let event = Event::parse(text).ok()?;
    Some((event.name, text.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_dyn_abi::{DynSolValue, JsonAbiExt};
    use alloy_json_abi::Function;
    use alloy_primitives::{Address, U256};

    fn s(x: &str) -> String {
        x.to_owned()
    }

    /// `text`'s selector followed by `values` encoded with its parameters.
    fn calldata(text: &str, values: &[DynSolValue]) -> Vec<u8> {
        let f = Function::parse(text).unwrap();
        f.abi_encode_input(values).unwrap()
    }

    fn transfer() -> Vec<u8> {
        calldata(
            "transfer(address,uint256)",
            &[
                DynSolValue::Address(Address::repeat_byte(0x11)),
                DynSolValue::Uint(U256::from(1_000u32), 256),
            ],
        )
    }

    #[test]
    fn picks_the_candidate_that_round_trips() {
        let input = transfer();
        assert_eq!(&input[..4], &[0xa9, 0x05, 0x9c, 0xbb]);
        let got = guess_call(
            &input,
            &[
                s("transfer(address,uint256)"),
                s("many_msg_babbage(bytes1)"),
            ],
        )
        .expect("transfer round-trips");
        assert_eq!(got.call.name, "transfer");
        assert_eq!(got.call.signature, "transfer(address,uint256)");
        assert_eq!(got.alternatives, Vec::<String>::new());
        let args: Vec<(&str, &str, &str)> = got
            .call
            .args
            .iter()
            .map(|a| (a.name.as_str(), a.ty.as_str(), a.value.as_str()))
            .collect();
        assert_eq!(
            args,
            vec![
                ("", "address", "0x1111111111111111111111111111111111111111"),
                ("", "uint256", "1000"),
            ]
        );
    }

    #[test]
    fn two_clean_candidates_shortest_wins_the_other_is_an_alternative() {
        // Three texts sharing the selector 0x1710409c (found by search), each
        // with one parameter that a small word round-trips.
        let input = calldata(
            "s9045733(uint256)",
            &[DynSolValue::Uint(U256::from(7u8), 256)],
        );
        let candidates = [
            s("s9045733(uint256)"),
            s("s7384280(int256)"),
            s("s2760836(int256)"),
        ];
        for c in &candidates {
            assert_eq!(Function::parse(c).unwrap().selector(), input[..4]);
        }
        let got = guess_call(&input, &candidates).expect("clean candidates");
        // Ties in length are broken lexicographically.
        assert_eq!(got.call.signature, "s2760836(int256)");
        assert_eq!(got.call.args[0].value, "7");
        assert_eq!(
            got.alternatives,
            vec![s("s7384280(int256)"), s("s9045733(uint256)")]
        );
    }

    #[test]
    fn a_text_whose_canonical_selector_differs_from_the_input_is_skipped() {
        // Stored as written, `foo(uint)` hashes to another selector than its
        // canonical form `foo(uint256)`, so a lookup by the former must not
        // name the call with the latter.
        let mut input = alloy_primitives::keccak256("foo(uint)")[..4].to_vec();
        input.extend_from_slice(&U256::from(7u8).to_be_bytes::<32>());
        assert_ne!(Function::parse("foo(uint)").unwrap().selector(), input[..4]);
        assert_eq!(guess_call(&input, &[s("foo(uint)")]), None);
        // The canonical text with the canonical selector still decodes.
        let input = calldata("foo(uint256)", &[DynSolValue::Uint(U256::from(7u8), 256)]);
        assert_eq!(
            guess_call(&input, &[s("foo(uint)")]).map(|g| g.call.signature),
            Some(s("foo(uint256)"))
        );
    }

    #[test]
    fn none_clean_is_none() {
        let input = transfer();
        assert_eq!(guess_call(&input, &[s("many_msg_babbage(bytes1)")]), None);
        // Unparseable or non-matching texts are skipped, not errors.
        assert_eq!(
            guess_call(&input, &[s("not a signature"), s("transfer(")]),
            None
        );
        assert_eq!(guess_call(&input, &[]), None);
        assert_eq!(
            guess_call(&[0xa9, 0x05], &[s("transfer(address,uint256)")]),
            None
        );
    }

    #[test]
    fn the_execute_tuple_decodes() {
        // The shape of a batch call through an EIP-7702 wallet: one
        // `((address,uint256,bytes)[],bool)` argument (synthetic addresses).
        let call = |to: u8, value: u64, data: &[u8]| {
            DynSolValue::Tuple(vec![
                DynSolValue::Address(Address::repeat_byte(to)),
                DynSolValue::Uint(U256::from(value), 256),
                DynSolValue::Bytes(data.to_vec()),
            ])
        };
        let calls = DynSolValue::Array(vec![call(0x21, 0, &transfer()), call(0x22, 5, &[])]);
        let text = "execute(((address,uint256,bytes)[],bool))";
        let input = calldata(
            text,
            &[DynSolValue::Tuple(vec![
                calls.clone(),
                DynSolValue::Bool(true),
            ])],
        );
        let got = guess_call(&input, &[s(text)]).expect("the tuple decodes");
        assert_eq!(got.call.name, "execute");
        assert_eq!(got.call.signature, text);
        assert_eq!(got.call.args.len(), 1);
        assert_eq!(got.call.args[0].name, "");
        assert_eq!(got.call.args[0].ty, "((address,uint256,bytes)[],bool)");
        assert!(
            got.call.args[0].value.ends_with(", true)"),
            "{}",
            got.call.args[0].value
        );

        // The flattened form, `execute((address,uint256,bytes)[],bool)`.
        let text = "execute((address,uint256,bytes)[],bool)";
        let input = calldata(text, &[calls, DynSolValue::Bool(false)]);
        let got = guess_call(&input, &[s(text)]).expect("the tuple array decodes");
        let types: Vec<&str> = got.call.args.iter().map(|a| a.ty.as_str()).collect();
        assert_eq!(types, vec!["(address,uint256,bytes)[]", "bool"]);
        assert_eq!(got.call.args[1].value, "false");
    }

    #[test]
    fn events_are_named_from_their_text() {
        assert_eq!(
            guess_event("Transfer(address,address,uint256)"),
            Some((s("Transfer"), s("Transfer(address,address,uint256)")))
        );
        assert_eq!(guess_event("not a signature"), None);
    }
}
