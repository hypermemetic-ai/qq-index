#![cfg(unix)]

mod cli;
mod protocol;
mod server;

pub use cli::{USAGE, parse_config};
pub use protocol::{
    COMMIT_RECEIPT_VERSION, HEALTH_RESPONSE_VERSION, MAX_FRAME_BYTES, MUTATION_BATCH_VERSION,
    PROTOCOL_VERSION, SHUTDOWN_RESPONSE_VERSION, SOURCE_STATE_RESPONSE_VERSION_V1,
    SOURCE_STATE_VERSION_V1,
};
pub use server::{DatabaseMode, ServerConfig, ServerError, run};
