/**
 * Expo config plugin: one version of the Android Credential Manager, for the
 * app AND for the passkey module that is compiled into it.
 *
 * react-native-passkeys declares androidx.credentials 1.3.0-alpha01 in its own
 * build.gradle. The app ships 1.6.0. Two things have to be true for passkeys to
 * work, and this plugin is responsible for both:
 *
 *   1. The APK contains 1.6.0 (the app-module pin, issue #1043).
 *      The app used to carry two passkey libraries, react-native-passkey (1.6.0)
 *      and react-native-passkeys (1.3.0-alpha01), and Gradle took the higher
 *      one. With one library left, the provider stack would have dropped to the
 *      alpha; the pin keeps what every build has run.
 *
 *   2. The passkey module is COMPILED against 1.6.0 too (the root-project force).
 *      A Gradle module compiles against the versions it declares itself, not the
 *      ones the app ends up packaging. So the module was built against the alpha
 *      and run against 1.6.0, and those two disagree about one thing: the
 *      constructor of CreatePublicKeyCredentialRequest. Kotlin calls a
 *      constructor with default arguments through a synthetic overload whose
 *      signature lists every parameter, and 1.6.0 has one parameter more. The
 *      overload the module was compiled to call does not exist in the APK:
 *
 *        java.lang.NoSuchMethodError: No direct method <init>(Ljava/lang/String;
 *        [BZLjava/lang/String;ZILkotlin/jvm/internal/DefaultConstructorMarker;)V
 *        in class Landroidx/credentials/CreatePublicKeyCredentialRequest;
 *
 *      Signing in and signing a payment go through GetCredentialRequest, whose
 *      constructor did not change, so they kept working. Creating a wallet did
 *      not: builds 20 to 27 (2026-11-04 to 2026-11-11) could not create a
 *      passkey at all. Before the consolidation, creation went through the other
 *      library, which is why the mismatch had never been reached.
 *
 * The pin alone cannot fix (2): an `implementation` line in the app module says
 * nothing about another module's compile classpath. The force is applied to
 * every configuration of every project, so compile and runtime agree.
 *
 * To move to a newer androidx.credentials, change VERSION here. Nothing else
 * decides it. `scripts/apk-dangling-refs.py` checks the built APK, and the
 * community build refuses to publish one where the two have drifted again.
 *
 * Verify by hand after a dependency change:
 *   npx expo prebuild --platform android
 *   cd android
 *   ./gradlew :react-native-passkeys:dependencyInsight \
 *     --dependency androidx.credentials:credentials --configuration releaseCompileClasspath
 *   ./gradlew :app:dependencyInsight \
 *     --dependency androidx.credentials:credentials --configuration releaseRuntimeClasspath
 * Both must say 1.6.0.
 */
const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

const VERSION = '1.6.0';

const ARTIFACTS = [
  'androidx.credentials:credentials',
  'androidx.credentials:credentials-play-services-auth',
];

const PINNED_COORDINATES = ARTIFACTS.map((artifact) => `${artifact}:${VERSION}`);

/** Marks the block this plugin appends to android/build.gradle. */
const FORCE_MARKER = '// veil:androidx-credentials-force';

/**
 * Insert the pinned `implementation` lines into the first `dependencies {`
 * block of an app build.gradle. Idempotent: if the file already carries any
 * androidx.credentials implementation line (from a previous prebuild, or a
 * hand edit), the contents are returned untouched.
 *
 * Exported separately from the plugin so it can be unit-tested without running
 * prebuild.
 */
function injectCredentialsPin(buildGradle) {
  if (buildGradle.includes('androidx.credentials:')) {
    return buildGradle;
  }

  const lines = buildGradle.split('\n');
  const index = lines.findIndex((line) => line.trim() === 'dependencies {');
  if (index === -1) {
    throw new Error(
      'withAndroidCredentialsPin: no `dependencies {` block found in android/app/build.gradle.',
    );
  }

  lines.splice(
    index + 1,
    0,
    '    // Pin the Android Credential Manager artifacts to the version the passkey',
    '    // stack resolved to before issue #1043 consolidated the JS side onto one',
    '    // library. See plugins/withAndroidCredentialsPin.js for why.',
    ...PINNED_COORDINATES.map((coordinate) => `    implementation "${coordinate}"`),
  );

  return lines.join('\n');
}

/**
 * Append a block to the ROOT build.gradle that makes every module resolve
 * androidx.credentials to the pinned version, on its compile classpath as well
 * as its runtime one. Idempotent.
 */
function injectCredentialsForce(rootBuildGradle) {
  if (rootBuildGradle.includes(FORCE_MARKER)) {
    return rootBuildGradle;
  }

  const block = [
    FORCE_MARKER,
    '// Every module compiles against the androidx.credentials the app ships.',
    '// react-native-passkeys declares an older one, and a module compiled against',
    '// a version the APK does not contain crashes when a wallet is created.',
    '// See plugins/withAndroidCredentialsPin.js.',
    'allprojects {',
    '  configurations.all {',
    '    resolutionStrategy {',
    ...PINNED_COORDINATES.map((coordinate) => `      force "${coordinate}"`),
    '    }',
    '  }',
    '}',
  ].join('\n');

  return `${rootBuildGradle.replace(/\s+$/, '')}\n\n${block}\n`;
}

module.exports = function withAndroidCredentialsPin(config) {
  const pinned = withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = injectCredentialsPin(cfg.modResults.contents);
    return cfg;
  });

  return withProjectBuildGradle(pinned, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      // Silently skipping would ship the crash this plugin exists to prevent.
      throw new Error(
        'withAndroidCredentialsPin: android/build.gradle is not Groovy, so the androidx.credentials force was not written. Port injectCredentialsForce to the Kotlin DSL.',
      );
    }
    cfg.modResults.contents = injectCredentialsForce(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.injectCredentialsPin = injectCredentialsPin;
module.exports.injectCredentialsForce = injectCredentialsForce;
module.exports.PINNED_COORDINATES = PINNED_COORDINATES;
