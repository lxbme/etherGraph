//! The local datasets (address labels, token lists, signatures): their fixed
//! sources, the upstream check and the background update. The admin API
//! reads them in [`crate::routes::local_data`].
pub mod download;
pub mod runner;
pub mod sources;
pub mod upstream;

pub use runner::Runner;
pub use sources::SourceId;
pub use upstream::{RemoteFile, Upstream, UpstreamChecker};
