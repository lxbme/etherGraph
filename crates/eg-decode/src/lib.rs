//! eg-decode: transfer-event decoding, ABI decoding and token metadata helpers.
pub mod abi;
pub mod ens;
pub mod guess;
pub mod multicall;
pub mod token;
pub mod transfers;

pub use abi::{
    DecodedArg, DecodedCall, DecodedError, DecodedEvent, decode_call, decode_error, decode_event,
};
pub use ens::{
    DecodeError, ReverseResult, decode_resolve_addr, decode_reverse, dns_encode,
    encode_resolve_addr, encode_reverse, namehash, normalize,
};
pub use guess::{GuessedCall, guess_call, guess_event};
pub use multicall::{Call3, CallResult, decode_aggregate3, encode_aggregate3};
pub use token::{decode_string_or_bytes32, decode_u8, encode_decimals, encode_name, encode_symbol};
pub use transfers::decode_transfer_logs;
