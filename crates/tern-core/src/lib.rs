//! Tern's mail engine. The UI only ever reads from [`store::Store`], which answers in microseconds; the network
//! happens behind it in [`sync::run_account`], and everything a person does goes through the outbox so it shows at
//! once, can be undone for a few seconds, and survives being offline.

pub mod imap;
pub mod logo;
pub mod mailto;
pub mod mime;
pub mod models;
pub mod presets;
pub mod query;
#[cfg(test)]
mod scripted;
pub mod secrets;
pub mod smtp;
pub mod store;
pub mod sync;
pub mod triage;

pub use models::*;
pub use store::Store;
