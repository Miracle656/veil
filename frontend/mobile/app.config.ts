import type { ExpoConfig } from 'expo/config';

/**
 * Expo config, replacing `app.json` so the deep-linking surface can carry the
 * reasoning behind it.
 *
 * The values below are duplicated from `lib/deepLinks.ts` rather than imported:
 * Expo transpiles this file on its own and then `require`s it, so a relative
 * import of a sibling TypeScript module fails to resolve at config-load time.
 * `lib/__tests__/appConfig.test.ts` asserts the two stay in agreement — the
 * config and the resolver drifting apart is exactly how deep links break
 * silently.
 *
 * Universal links additionally require the two verification files served by the
 * wallet web app from `frontend/wallet/public/.well-known/`; see
 * `frontend/mobile/README.md` for the values to fill in before a store build.
 */

/** Custom URL scheme registered by the app. Mirrors `DEEP_LINK_SCHEME`. */
const DEEP_LINK_SCHEME = 'veil';

/** Hosts claimed as universal / app links. Mirrors `ASSOCIATED_DOMAINS`. */
const ASSOCIATED_DOMAINS = ['app.veil.xyz'];

/** SEP-7 URI scheme, without the trailing colon. Mirrors `SEP7_SCHEME`. */
const SEP7_SCHEME = 'web+stellar';

const BUNDLE_IDENTIFIER = 'xyz.veil.wallet';

/**
 * Paths claimed as universal / app links. Kept narrow on purpose: every path
 * listed here stops opening in the browser once the app is installed, so the
 * marketing site and docs must keep working as web pages.
 */
const LINKED_PATHS = ['pay', 'send', 'receive', 'create-wallet'];

const config: ExpoConfig = {
  name: 'Veil',
  slug: 'veil-mobile',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  // `veil://` is the app's own scheme; `web+stellar:` is claimed so SEP-7
  // payment requests (backlog #38) open here too. Expo turns both into
  // CFBundleURLTypes on iOS and BROWSABLE intent filters on Android at prebuild.
  scheme: [DEEP_LINK_SCHEME, SEP7_SCHEME],
  userInterfaceStyle: 'automatic',
  ios: {
    icon: './assets/expo.icon',
    bundleIdentifier: BUNDLE_IDENTIFIER,
    // Two separate claims over the same hosts, and both are required:
    // `applinks:` routes https URLs into the app, while `webcredentials:` is
    // what lets iOS offer a passkey scoped to that domain as the relying party.
    // Universal links work without the second one, but passkey registration
    // and assertion do not.
    associatedDomains: ASSOCIATED_DOMAINS.flatMap((domain) => [
      `applinks:${domain}`,
      `webcredentials:${domain}`,
    ]),
  },
  android: {
    package: BUNDLE_IDENTIFIER,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    intentFilters: [
      // Verified app links. `autoVerify` makes Android fetch
      // https://app.veil.xyz/.well-known/assetlinks.json at install time; if the
      // fingerprint there does not match the installed build, links keep opening
      // in the browser rather than failing outright.
      {
        action: 'VIEW',
        autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: ASSOCIATED_DOMAINS.flatMap((host) =>
          LINKED_PATHS.map((path) => ({ scheme: 'https', host, pathPrefix: `/${path}` })),
        ),
      },
    ],
  },
  web: {
    output: 'static',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    'expo-router',
    // react-native-passkeys contains native code, so Expo Go cannot load it.
    // The dev client is what makes passkey registration testable on a device.
    'expo-dev-client',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#208AEF',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
      },
    ],
    'expo-secure-store',
    [
      'expo-camera',
      {
        cameraPermission: 'Veil uses the camera to scan WalletConnect QR codes.',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
