package xyz.veil.wallet.spp

/**
 * The module name the JS side resolves (`requireOptionalNativeModule('SppNative')`).
 *
 * Declared as a constant so the Expo `Name(...)` in SppNativeModule and any
 * future test or tooling reference share one source. The Expo module system
 * registers the class by the Name given in `definition()`; changing one and
 * not the other makes `requireOptionalNativeModule` return null on-device —
 * a silent fallback that looks exactly like a build without the module.
 */
const val SPP_MODULE_NAME: String = "SppNative"
