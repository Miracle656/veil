/**
 * Expo config plugin: keep the Android Credential Manager artifacts at the
 * version Veil has always effectively resolved to.
 *
 * Background (issue #1043): the app used to depend on two passkey libraries —
 * react-native-passkey (androidx.credentials 1.6.0) and react-native-passkeys
 * (androidx.credentials 1.3.0-alpha01). Gradle silently took the highest
 * constraint, so every build actually ran the provider stack at 1.6.0 even
 * though one library was compiled against the older alpha.
 *
 * The JS side is now ONE library (react-native-passkeys), which by itself would
 * silently drop the resolved androidx.credentials artifacts down to
 * 1.3.0-alpha01 — a real, device-visible behaviour change to the passkey
 * provider on an app that holds mainnet funds, and exactly the kind of change
 * that is very hard to diagnose when it goes wrong ("no provider dependencies
 * found" was already seen once on a resolution accident). Pinning the artifacts
 * in the app module keeps the resolved tree byte-for-byte what it was before
 * the consolidation: 1.6.0.
 *
 * This touches the build graph only — no JS, no ceremony code. If a future
 * react-native-passkeys release raises its own constraint above 1.6.0, Gradle
 * resolves the higher version (a plain `implementation` constraint, not a
 * forced one), so this pin never holds the app back; delete it then, and note
 * the new resolved version in the PR.
 *
 * Verify after any dependency change with:
 *   npx expo prebuild --platform android
 *   cd android && ./gradlew :app:dependencies --configuration debugRuntimeClasspath | grep androidx.credentials
 */
const { withAppBuildGradle } = require('expo/config-plugins');

/** The exact artifacts Gradle resolved to before the passkey consolidation. */
const PINNED_COORDINATES = [
  'androidx.credentials:credentials:1.6.0',
  'androidx.credentials:credentials-play-services-auth:1.6.0',
];

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

module.exports = function withAndroidCredentialsPin(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = injectCredentialsPin(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.injectCredentialsPin = injectCredentialsPin;
