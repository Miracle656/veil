use soroban_sdk::{Env, String, Bytes}; pub fn convert(env: &Env, s: &String) { let mut b = [0u8; 32]; s.copy_into_slice(&mut b); }
