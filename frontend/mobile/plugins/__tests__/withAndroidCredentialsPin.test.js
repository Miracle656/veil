const { injectCredentialsPin } = require('../withAndroidCredentialsPin');

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
