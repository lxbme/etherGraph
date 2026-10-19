use eg_blockscout::parse_raw_trace;
use eg_core::source::{CallFrame, CallKind, SourceError};
use eg_core::types::{Address, U256};

/// Raw trace of 0x461e681fd0ab400c16e06f617d2afa952af0b3569aef4c11ca73eed6bd9d45a3
/// (ENS ".eth" registration through the ETHRegistrarController), recorded
/// once from https://eth.blockscout.com/api/v2/transactions/{hash}/raw-trace.
const ENS: &str = include_str!("data/ens_register.json");

/// Raw trace of 0x6cba7914d5bc7893037ecad84972225fe6d18770e6c0d1b9803cf601b95cef0b,
/// recorded the same way: an ERC-4337 (EntryPoint v0.6) `handleOps` bundle
/// that succeeds while one user op's `innerHandleOp` reverts (paymaster
/// postOp: USDC `transferFrom` "ERC20: transfer amount exceeds balance").
const FAILED: &str = include_str!("data/failed_subcall.json");

fn frame<'a>(frames: &'a [CallFrame], path: &[u32]) -> &'a CallFrame {
    frames
        .iter()
        .find(|f| f.path == path)
        .unwrap_or_else(|| panic!("no frame at {path:?}"))
}

#[test]
fn ens_register_parses_17_frames() {
    let frames = parse_raw_trace(ENS).unwrap();
    assert_eq!(frames.len(), 17);
    assert!(frames.windows(2).all(|w| w[0].path < w[1].path));

    let root = &frames[0];
    assert_eq!(root.path, Vec::<u32>::new());
    assert_eq!(root.kind, CallKind::Call);
    assert_eq!(root.value, U256::from(22616028901072185u64));
    assert_eq!(root.subtraces, 6);
    assert_eq!(
        root.from,
        "0x82eb45562f991329ed2867f43fc60f0ba52c3dab"
            .parse::<Address>()
            .unwrap()
    );
    assert_eq!(root.gas, 0x36a6d);
    assert_eq!(root.gas_used, Some(0x3498d));
    assert_eq!(root.error, None);
    assert_eq!(root.output.as_ref().map(|b| &b[..]), Some(&[][..]));
    assert_eq!(&root.input[..4], &[0x74, 0x69, 0x4a, 0x2b]);

    // NameWrapper -> BaseRegistrar.register
    let reg = frame(&frames, &[3, 0]);
    assert_eq!(reg.kind, CallKind::Call);
    assert_eq!(&reg.input[..4], &[0xfc, 0xa2, 0x47, 0xac]);
    assert_eq!(
        reg.to,
        Some(
            "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85"
                .parse()
                .unwrap()
        )
    );

    let dc = frame(&frames, &[4, 0]);
    assert_eq!(dc.kind, CallKind::DelegateCall);
    assert_eq!(Some(dc.from), dc.to);

    let statics = frames
        .iter()
        .filter(|f| f.kind == CallKind::StaticCall)
        .count();
    assert!(statics >= 6, "{statics}");
}

#[test]
fn failed_subcall_has_error_and_revert_output() {
    let frames = parse_raw_trace(FAILED).unwrap();
    assert_eq!(frames.len(), 54);
    assert!(frames.windows(2).all(|w| w[0].path < w[1].path));
    assert_eq!(frames[0].error, None);

    let failed: Vec<&[u32]> = frames
        .iter()
        .filter(|f| f.error.is_some())
        .map(|f| &f.path[..])
        .collect();
    assert_eq!(
        failed,
        vec![
            &[2][..],
            &[2, 1],
            &[2, 1, 0],
            &[2, 1, 0, 0],
            &[2, 1, 0, 0, 0]
        ]
    );

    // Recorded shape: a reverted frame carries `error: "Reverted"` and still
    // has a `result` whose `output` is the revert data (`Error(string)`).
    let inner = frame(&frames, &[2]);
    assert_eq!(inner.error.as_deref(), Some("Reverted"));
    assert_eq!(inner.gas_used, Some(0x60948));
    let out = inner.output.as_ref().expect("revert data");
    assert_eq!(&out[..4], &[0x08, 0xc3, 0x79, 0xa0]);
    let reason = b"Paymaster: postOp token transfer failed";
    assert_eq!(&out[68..68 + reason.len()], reason);

    let leaf = frame(&frames, &[2, 1, 0, 0, 0]);
    assert_eq!(leaf.kind, CallKind::DelegateCall);
    let reason = b"ERC20: transfer amount exceeds balance";
    let out = leaf.output.as_ref().expect("revert data");
    assert_eq!(&out[68..68 + reason.len()], reason);
}

#[test]
fn unknown_type_and_missing_fields_are_tolerated() {
    let body = r#"[
      {"action":{"callType":"call","from":"0x1111111111111111111111111111111111111111",
                 "to":"0x2222222222222222222222222222222222222222","gas":"0x10",
                 "input":"0x","value":"0x0"},
       "result":{"gasUsed":"0x5","output":"0x"},"subtraces":2,"traceAddress":[],"type":"call"},
      {"action":{"address":"0x2222222222222222222222222222222222222222",
                 "balance":"0x255feac0590fa8",
                 "refundAddress":"0x3333333333333333333333333333333333333333"},
       "result":null,"subtraces":0,"traceAddress":[1],"type":"suicide"},
      {"action":{"callType":"call","from":"0x2222222222222222222222222222222222222222",
                 "to":"0x4444444444444444444444444444444444444444","gas":"0x8",
                 "input":"0xdeadbeef","value":"0x1"},
       "error":"Out of gas","subtraces":0,"traceAddress":[0],"type":"call"}
    ]"#;
    let frames = parse_raw_trace(body).unwrap();
    assert_eq!(frames.len(), 3);
    assert_eq!(
        frames.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
        vec![vec![], vec![0], vec![1]]
    );

    let oog = &frames[1];
    assert_eq!(oog.kind, CallKind::Call);
    assert_eq!(oog.output, None);
    assert_eq!(oog.gas_used, None);
    assert_eq!(oog.error.as_deref(), Some("Out of gas"));
    assert_eq!(oog.value, U256::from(1u64));

    let sd = &frames[2];
    assert_eq!(sd.kind, CallKind::SelfDestruct);
    assert_eq!(sd.output, None);
    assert_eq!(sd.gas_used, None);
    assert_eq!(sd.from, Address::repeat_byte(0x22));
    assert_eq!(sd.to, Some(Address::repeat_byte(0x33)));
    assert_eq!(sd.value, U256::from(0x255feac0590fa8u64));
    assert!(sd.input.is_empty());
    assert_eq!(sd.gas, 0);
}

#[test]
fn creates_take_new_address_init_and_code() {
    let body = r#"[
      {"action":{"creationMethod":"create2","from":"0x1111111111111111111111111111111111111111",
                 "gas":"0x100","init":"0x6080","value":"0x0"},
       "result":{"address":"0x5555555555555555555555555555555555555555","code":"0x6001",
                 "gasUsed":"0x50"},"subtraces":1,"traceAddress":[],"type":"create"},
      {"action":{"from":"0x5555555555555555555555555555555555555555","gas":"0x10",
                 "init":"0x60","value":"0x0"},
       "error":"Reverted","result":null,"subtraces":0,"traceAddress":[0],"type":"create"}
    ]"#;
    let frames = parse_raw_trace(body).unwrap();
    let c2 = &frames[0];
    assert_eq!(c2.kind, CallKind::Create2);
    assert_eq!(c2.to, Some(Address::repeat_byte(0x55)));
    assert_eq!(&c2.input[..], &[0x60, 0x80]);
    assert_eq!(c2.output.as_ref().map(|b| &b[..]), Some(&[0x60, 0x01][..]));
    assert_eq!(c2.gas_used, Some(0x50));

    let failed = &frames[1];
    assert_eq!(failed.kind, CallKind::Create);
    assert_eq!(failed.to, None);
    assert_eq!(failed.output, None);
    assert_eq!(failed.error.as_deref(), Some("Reverted"));
}

#[test]
fn non_array_body_is_a_parse_error() {
    for body in [
        r#"{"message":"Not found"}"#,
        "not json",
        r#"[{"type":"call"}]"#,
    ] {
        let r = parse_raw_trace(body);
        assert!(matches!(r, Err(SourceError::Parse(_))), "{body}: {r:?}");
    }
}
