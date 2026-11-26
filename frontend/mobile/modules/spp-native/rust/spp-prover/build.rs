//! Build script: generate uniffi's Rust-side scaffolding from the UDL.
//!
//! The Kotlin side is generated at Gradle build time (see
//! `android/build.gradle.kts`); this covers the Rust half, so `cargo build`
//! and `cargo test` work without any external codegen step.

fn main() {
    uniffi::generate_scaffolding("src/spp_native.udl").expect("uniffi scaffolding generation");
}
