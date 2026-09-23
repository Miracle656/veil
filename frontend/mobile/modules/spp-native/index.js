/**
 * JS entry point for the spp-native Expo module.
 *
 * Screens never import from here directly — `lib/sppProver.ts` is the public
 * surface and adds the fallback/failure handling. Kept in place so the
 * module resolves as a normal package if Metro ever links it by name.
 */
export { SppProverModule, isSppNativeAvailable } from './src/index';
