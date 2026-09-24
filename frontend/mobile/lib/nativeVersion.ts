/**
 * Which build of the app is actually installed.
 *
 * This used to read `Constants.nativeApplicationVersion` / `nativeBuildVersion`
 * from expo-constants. Those were deprecated in favour of expo-application and
 * are gone from expo-constants 18 (SDK 54), so both reads came back `undefined`
 * on a real APK. Nothing failed loudly: About showed "Development build" on a
 * release build, and the update check — which compares version codes — had no
 * installed number to compare, so it announced an update even when the newest
 * published build was the one already running.
 *
 * One module so there is one place that knows where the numbers come from, and
 * one thing for tests to mock.
 */

import * as Application from 'expo-application';

/** Marketing version of the installed app ("0.1.0"), or null off-device. */
export function nativeApplicationVersion(): string | null {
  return Application.nativeApplicationVersion?.trim() || null;
}

/**
 * The build identifier of the installed app — Android's `versionCode` as a
 * string, iOS's `CFBundleVersion`. Null in Expo Go, on web, and anywhere the
 * app is not a built binary.
 */
export function nativeBuildVersion(): string | null {
  return Application.nativeBuildVersion?.trim() || null;
}
