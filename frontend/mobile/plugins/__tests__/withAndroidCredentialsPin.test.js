const withAndroidCredentialsPin = require('../withAndroidCredentialsPin');

const { injectCredentialsPin, injectCredentialsForce } = withAndroidCredentialsPin;

const TEMPLATE = [
  'android {',
  '    namespace "xyz.veil.wallet"',
  '}',
  '',
  'dependencies {',
  '    implementation platform("org.jetbrains.kotlin:kotlin-bom")',
  '    implementation "com.facebook.react:react-native:+"',
  '}',
  '',
  'apply from: file("../../../node_modules/expo/scripts/gradle-project-dirs.gradle")',
].join('\n');

describe('withAndroidCredentialsPin', () => {
  it('pins both androidx.credentials artifacts inside the dependencies block', () => {
    const result = injectCredentialsPin(TEMPLATE);

    expect(result).toContain('implementation "androidx.credentials:credentials:1.6.0"');
    expect(result).toContain(
      'implementation "androidx.credentials:credentials-play-services-auth:1.6.0"',
    );

    // The pin must live inside `dependencies { … }`, not in the android block.
    const depsStart = result.indexOf('dependencies {');
    const depsEnd = result.indexOf('}', result.indexOf('react-native:+'));
    const pinStart = result.indexOf('androidx.credentials');
    expect(pinStart).toBeGreaterThan(depsStart);
    expect(pinStart).toBeLessThan(depsEnd);
  });

  it('is idempotent — a re-prebuild does not double the pin', () => {
    const once = injectCredentialsPin(TEMPLATE);
    const twice = injectCredentialsPin(once);

    expect(twice).toBe(once);
    expect(twice.match(/androidx\.credentials:credentials-play-services-auth/g)).toHaveLength(1);
  });

  it('leaves a build.gradle that already declares androidx.credentials alone', () => {
    const withExisting = TEMPLATE.replace(
      'dependencies {',
      'dependencies {\n    implementation "androidx.credentials:credentials-play-services-auth:1.6.0"',
    );

    expect(injectCredentialsPin(withExisting)).toBe(withExisting);
  });

  it('fails loudly when the gradle file has no dependencies block', () => {
    expect(() => injectCredentialsPin('android {\n    namespace "x"\n}\n')).toThrow(
      /no `dependencies \{` block/,
    );
  });
});

// android/build.gradle as Expo SDK 54's template generates it.
const ROOT_TEMPLATE = [
  '// Top-level build file where you can add configuration options common to all sub-projects/modules.',
  '',
  'buildscript {',
  '  repositories {',
  '    google()',
  '    mavenCentral()',
  '  }',
  '  dependencies {',
  "    classpath('com.android.tools.build:gradle')",
  "    classpath('com.facebook.react:react-native-gradle-plugin')",
  "    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')",
  '  }',
  '}',
  '',
  'allprojects {',
  '  repositories {',
  '    google()',
  '    mavenCentral()',
  "    maven { url 'https://www.jitpack.io' }",
  '  }',
  '}',
  '',
  'apply plugin: "expo-root-project"',
  'apply plugin: "com.facebook.react.rootproject"',
  '',
].join('\n');

// Builds 20 to 27 could not create a wallet: react-native-passkeys was compiled
// against the androidx.credentials it declares (1.3.0-alpha01) and run against
// the one the app pins (1.6.0). The app-module pin cannot reach another
// module's compile classpath; only a force on every project does.
describe('withAndroidCredentialsPin: the passkey module compiles against what ships', () => {
  it('forces both artifacts for every configuration of every project', () => {
    const result = injectCredentialsForce(ROOT_TEMPLATE);

    const block = result.slice(result.indexOf('// veil:androidx-credentials-force'));
    expect(block).toMatch(/allprojects \{\s+configurations\.all \{\s+resolutionStrategy \{/);
    expect(block).toContain('force "androidx.credentials:credentials:1.6.0"');
    expect(block).toContain('force "androidx.credentials:credentials-play-services-auth:1.6.0"');
  });

  it('forces exactly the version the app module pins', () => {
    const forced = [...injectCredentialsForce(ROOT_TEMPLATE).matchAll(/force "([^"]+)"/g)].map(
      (m) => m[1],
    );
    const pinned = [
      ...injectCredentialsPin('dependencies {\n}').matchAll(/implementation "([^"]+)"/g),
    ].map((m) => m[1]);

    expect(forced).toEqual(pinned);
    expect(forced).toEqual(withAndroidCredentialsPin.PINNED_COORDINATES);
  });

  it('appends after the template and leaves it intact', () => {
    const result = injectCredentialsForce(ROOT_TEMPLATE);

    expect(result.startsWith(ROOT_TEMPLATE.trimEnd())).toBe(true);
    expect(result.indexOf('veil:androidx-credentials-force')).toBeGreaterThan(
      result.indexOf('apply plugin: "com.facebook.react.rootproject"'),
    );
    expect(result.endsWith('}\n')).toBe(true);
  });

  it('is idempotent', () => {
    const once = injectCredentialsForce(ROOT_TEMPLATE);

    expect(injectCredentialsForce(once)).toBe(once);
  });

  it('registers both the app-module pin and the root-project force', () => {
    const config = withAndroidCredentialsPin({ name: 'veil', slug: 'veil' });

    expect(typeof config.mods.android.appBuildGradle).toBe('function');
    expect(typeof config.mods.android.projectBuildGradle).toBe('function');
  });
});
