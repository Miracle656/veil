#![no_std]
//! Stateless Soroban event transport for stealth-payment announcements.
//!
//! The indexed topics are the fixed `announce` discriminator and the
//! one-byte view tag. Neither identifies a receiver: the discriminator is
//! shared by every announcement, and the view tag is a short, independently
//! derived value. The version, ephemeral public key, and sealed note remain in
//! event data rather than becoming additional indexed identifiers.

use soroban_sdk::{contract, contractimpl, symbol_short, Bytes, BytesN, Env};

/// Version encoded in each announcement's event data.
pub const ANNOUNCEMENT_VERSION: u32 = 1;

#[contract]
pub struct StealthAnnouncer;

#[contractimpl]
impl StealthAnnouncer {
    /// Publishes an announcement without storing data or accepting funds.
    pub fn announce(
        env: Env,
        ephemeral_public_key: BytesN<32>,
        view_tag: BytesN<1>,
        sealed_note: Bytes,
    ) {
        env.events().publish(
            (symbol_short!("announce"), view_tag),
            (ANNOUNCEMENT_VERSION, ephemeral_public_key, sealed_note),
        );
    }
}

#[cfg(test)]
mod test;
