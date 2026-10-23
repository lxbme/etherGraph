//! The local datasets (address labels, token lists, signatures): their fixed
//! sources and the upstream check. The admin API reads them in
//! [`crate::routes::local_data`].
pub mod sources;
pub mod upstream;

pub use sources::SourceId;
pub use upstream::{RemoteFile, Upstream, UpstreamChecker};
