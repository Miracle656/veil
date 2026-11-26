//! Standalone uniffi-bindgen entry point.
//!
//! The Kotlin bindings are generated with:
//!
//! ```text
//! cargo run --bin uniffi-bindgen generate \\
//!     --library target/<target>/release/libspp_prover.so \\
//!     --language kotlin --out-dir <module>/android/src/main/java
//! ```
//!
//! Having the binary in-tree means the generation command is reproducible
//! from a plain `cargo` install — no `cargo install uniffi-bindgen` step and
//! no version drift between contributors.

fn main() {
    uniffi::uniffi_bindgen_main()
}
