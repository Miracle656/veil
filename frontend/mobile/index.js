/**
 * App entry.
 *
 * Exists solely so the runtime shims run before expo-router does. Importing
 * them from app/_layout.tsx is too late: expo-router builds its route tree by
 * requiring every module under app/, and that happens while the layout is
 * still being resolved — so a route like (tabs)/earn.tsx, which reaches
 * @blend-capital/blend-sdk and through it the Stellar SDK, evaluated before
 * anything had installed Buffer and threw at import time. The failure did not
 * look like a missing polyfill: the route lost its default export and
 * disappeared from the navigator.
 *
 * Nothing else belongs here. Side effects first, then hand over.
 */
import './lib/polyfills';
// Defines the background payment check. Android may start the JS runtime just
// to run it, so it has to exist before any screen mounts.
import './lib/backgroundActivity';

import 'expo-router/entry';
