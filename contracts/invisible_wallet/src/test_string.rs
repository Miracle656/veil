#![no_std]
use soroban_sdk::{Env, String, Bytes};

pub fn check_string_to_bytes(env: Env, s: String) {
    // How to get bytes?
    // Try 1:
    let bytes1 = s.to_buffer::<128>(); // if it has to_buffer
    
}
