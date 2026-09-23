import org.apache.tools.ant.taskdefs.condition.Os

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// The Expo module gradle plugin (applied by expo-modules-autolinking when it
// evaluates this project) supplies the SDK versions; defaults keep plain
// `gradle` runs working for IDE indexing.
val expoModulesCorePlugin = project.findProject(":expo-modules-core")
val compileSdkVersionValue = (project.findProperty("android.compileSdkVersion") ?: "35").toString().toInt()
val minSdkVersionValue = (project.findProperty("android.minSdkVersion") ?: "24").toString().toInt()
val targetSdkVersionValue = (project.findProperty("android.targetSdkVersion") ?: "34").toString().toInt()

android {
    namespace = "xyz.veil.wallet.spp"
    compileSdk = compileSdkVersionValue

    defaultConfig {
        minSdk = minSdkVersionValue
        targetSdk = targetSdkVersionValue
    }

    lint {
        abortOnError = false
    }

    sourceSets {
        getByName("main") {
            // Generated uniffi bindings land here; the cargo task below runs
            // before compilation, so the folder exists by the time Kotlin
            // compiles. If bindings are missing, the cargo task regenerates
            // them — no manual step.
            java.srcDirs("$buildDir/generated/uniffi")
        }
    }
}

dependencies {
    implementation("com.facebook.react:react-native:+")
    // Expo modules-core supplies the ExpoModule base class and the promise
    // coroutine bridge. Version comes from the app's dependency graph via
    // expo-modules-autolinking; the + keeps plain gradle runs resolvable.
    implementation("host.exp.exponent:expo-modules-core:+")
    implementation("net.java.dev.jna:jna:5.13.0@aar")
    implementation("com.sun.jna:jna:5.13.0")
}

// ── Rust ────────────────────────────────────────────────────────────────────
//
// The prover is a Rust crate compiled per-ABI with cargo-ndk and linked into
// the APK as jniLibs. Everything runs in-process, on threads Kotlin chooses,
// through the uniffi-generated FFI.
//
// Why cargo-ndk and not hand-rolled cargo invocations: it pins the correct
// linker per ABI and produces the `libspp_prover.so` naming jniLibs expects
// (lib{spp_prover}.so) in one pass, per target.
//
// Why the JNA dependency: uniffi's generated Kotlin loads the .so through
// JNA, which needs its Android helper shipped alongside.

val rustDir = file("${projectDir}/../rust")
val cargoManifest = file("${rustDir}/Cargo.toml")
val jniLibsDir = file("${buildDir}/jniLibs")
val uniffiOutDir = file("${buildDir}/generated/uniffi")

// ABIs the APK ships. arm64-v8a covers every modern device; armeabi-v7a
// keeps 2016-era phones working. x86_64 exists so emulators can run the
// benchmark screen without a physical device.
val rustTargets = listOf("arm64-v8a", "armeabi-v7a", "x86_64")

val cargoNdkAvailable = providers.exec {
    commandLine("which", "cargo")
    isIgnoreExitErrors = true
}.result.get().exitValue == 0

fun cargoNdkTaskFor(abi: String, triple: String): Exec = Exec.create().apply {
    workingDir(rustDir)
    executable("cargo")
    args(
        "ndk",
        "-t", triple,
        "-o", jniLibsDir.absolutePath,
        "--manifest-path", cargoManifest.absolutePath,
        "--",
        "build",
        "--release",
        "-p", "spp-prover",
    )
    environment(
        mapOf(
            "CARGO_TERM_COLOR" to "never",
            // Deterministic builds: embed no absolute paths.
            "RUSTFLAGS" to "--remap-path-prefix=${System.getProperty("user.home")}=~",
        )
    )
    // cargo-ndk names outputs libspp_prover.so per target folder; move them
    // into the jniLibs layout Android expects (jniLibs/<abi>/lib*.so).
    doLast {
        val soName = "libspp_prover.so"
        val produced = File(jniLibsDir, triple)
        val dest = File(jniLibsDir, abi)
        if (produced.isDirectory) {
            produced.listFiles()?.filter { it.name == soName }?.forEach { f ->
                dest.mkdirs()
                f.renameTo(File(dest, soName))
            }
            produced.deleteRecursively()
        }
    }
}

// One task per target, wired so `assemble` depends on all of them. If cargo
// is not installed (a contributor running `gradle` without the toolchain),
// the tasks degrade to a warning rather than failing the whole build — the
// JS layer detects the missing module and falls back, so the app still
// launches. CI and EAS always have cargo.
rustTargets.forEach { abi ->
    val triple = when (abi) {
        "arm64-v8a" -> "aarch64-linux-android"
        "armeabi-v7a" -> "armv7-linux-androideabi"
        else -> "x86_64-linux-android"
    }
    val taskName = "buildRust$abi"
    tasks.register(taskName, Exec::class) {
        group = "spp"
        description = "Compiles the Rust SPP prover for $abi"
        onlyIf { cargoNdkAvailable }
        doFirst {
            if (!cargoNdkAvailable) {
                logger.warn(
                    "[spp-native] cargo not found — skipping Rust build for $abi. " +
                        "The app will launch without the native prover and fall back to WASM.",
                )
            }
        }
        // Task body set up lazily so the Exec action has a live project.
        doLast { }
        commandLine(
            "cargo", "ndk",
            "-t", triple,
            "-o", jniLibsDir.absolutePath,
            "--manifest-path", cargoManifest.absolutePath,
            "--",
            "build", "--release", "-p", "spp-prover",
        )
        // cargo-ndk emits to $jniLibsDir/<triple>/libspp_prover.so; move it
        // into the jniLibs layout Android expects (jniLibs/<abi>/lib*.so).
        doLast {
            val soName = "libspp_prover.so"
            val produced = File(jniLibsDir, triple)
            val dest = File(jniLibsDir, abi)
            if (produced.isDirectory) {
                produced.listFiles()?.filter { it.name == soName }?.forEach { f ->
                    dest.mkdirs()
                    f.renameTo(File(dest, soName))
                }
                produced.deleteRecursively()
            }
        }
    }
}

// Generate the uniffi Kotlin bindings from the compiled library.
tasks.register("generateUniffiBindings", Exec::class) {
    group = "spp"
    description = "Generates Kotlin bindings from spp_native.udl"
    onlyIf { cargoNdkAvailable }
    workingDir(rustDir)
    val hostLib = file("${rustDir}/target/release/libspp_prover.so")
    doFirst {
        if (!Os.isFamily(Os.FAMILY_UNIX)) {
            throw IllegalStateException("uniffi codegen requires a Unix host (CI/EAS provide one)")
        }
    }
    commandLine(
        "cargo", "run", "--release", "-p", "spp-prover", "--bin", "uniffi-bindgen",
        "--",
        "generate",
        "--library", hostLib.absolutePath,
        "--language", "kotlin",
        "--out-dir", uniffiOutDir.absolutePath,
    )
}

// Wire the Rust tasks ahead of the Kotlin compile. `preBuild` is the earliest
// hook every android variant depends on, so the .so files and bindings exist
// before either compiles.
tasks.named("preBuild") {
    dependsOn("generateUniffiBindings")
    rustTargets.forEach { abi -> dependsOn("buildRust$abi") }
}

android {
    sourceSets {
        getByName("main") {
            jniLibs.srcDirs(jniLibsDir.absolutePath)
        }
    }
}
