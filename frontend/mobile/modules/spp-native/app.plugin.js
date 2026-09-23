/**
 * Expo config plugin for the spp-native module.
 *
 * Listed in `app.config.ts`'s `plugins` so `expo prebuild` includes this
 * module's Android project on every config evaluation, regardless of whether
 * autolinking scans `modules/` on that path. The plugin itself needs no
 * mods — the Gradle wiring lives in the module's own build.gradle.kts and
 * expo-modules-autolinking adds it — so this forwards an unchanged config,
 * and exists so the plugin entry in app.config.ts resolves to a real file.
 */
const { withPlugins } = require('expo/config-plugins');

function withSppNative(config) {
  // No mods today. Kept as a function (not a string passthrough) so a future
  // Gradle/manifest tweak lands in one place, with the module it belongs to.
  return config;
}

module.exports = withSppNative;
