/**
 * #1200 — `/verify`'s `returnTo` check, tested on its own.
 *
 * The route-existence suite proves the app has a `/verify` screen; it says
 * nothing about where that screen sends people afterwards, and it passes on
 * a `main` whose `returnTo` handling is the raw param. `inAppPath` is the
 * whole of that handling: the param arrives from navigation, which a deep
 * link controls, so whatever it accepts is where a verified person is sent
 * next. These are the shapes it has to refuse, and the five it has to allow.
 *
 * The screen module is imported for the one helper, so its rendering
 * dependencies are mocked away — the same treatment the other screen suites
 * give theirs.
 */

import { inAppPath } from '../app/verify';

jest.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../components/icons', () => ({
  CheckIcon: () => null,
  InfoIcon: () => null,
  LockIcon: () => null,
}));
jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({ networkName: 'mainnet' }),
}));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../lib/onramp', () => ({
  getCustomerRef: jest.fn(async () => null),
  loadVerifyDetails: jest.fn(async () => null),
  provisionCustomer: jest.fn(),
  saveVerifyDetails: jest.fn(async () => undefined),
  setNairaKycMismatch: jest.fn(async () => undefined),
  setNairaVerified: jest.fn(async () => undefined),
  submitKyc: jest.fn(),
}));

describe('inAppPath', () => {
  // The five rails that push `/verify`, each passing its own path as a
  // literal. These are the only values a real sender can produce.
  it.each(['/airtime', '/betting', '/buy-ngn', '/cabletv', '/electricity'])(
    'accepts %s, a rail that sends people to /verify',
    (path) => {
      expect(inAppPath(path)).toBe(path);
    },
  );

  it('rejects a protocol-relative path, which the navigator resolves off-app', () => {
    expect(inAppPath('//evil.example')).toBeNull();
    expect(inAppPath('//evil.example/airtime')).toBeNull();
  });

  it('rejects a full URL', () => {
    expect(inAppPath('https://evil.example/airtime')).toBeNull();
    expect(inAppPath('http://evil.example')).toBeNull();
  });

  it('rejects a path with a backslash, which some resolvers read as a separator', () => {
    expect(inAppPath('/\\evil.example')).toBeNull();
    expect(inAppPath('/airtime\\@evil.example')).toBeNull();
    expect(inAppPath('\\\\evil.example')).toBeNull();
  });

  it('rejects an array whole, even one holding a good path', () => {
    // A repeated param is how a deep link parks a second value behind a
    // checked first one, and no sender produces an array — so there is no
    // first element worth trusting.
    expect(inAppPath(['/airtime'])).toBeNull();
    expect(inAppPath(['//evil.example'])).toBeNull();
    expect(inAppPath([])).toBeNull();
  });

  it('rejects in-app paths no rail returns to', () => {
    // Plain in-app paths, every one of them a real screen — and none of them
    // a place verification can have interrupted, so none of them is a place
    // it may send anyone. `/dashboard` included: it is the fallback the
    // screen applies itself when the param is dropped, not a sender.
    expect(inAppPath('/dashboard')).toBeNull();
    expect(inAppPath('/settings')).toBeNull();
    expect(inAppPath('/send')).toBeNull();
    expect(inAppPath('/verify')).toBeNull();
  });

  it('rejects near-misses of a listed path', () => {
    expect(inAppPath('/airtime/')).toBeNull();
    expect(inAppPath('/AIRTIME')).toBeNull();
    expect(inAppPath('/airtime?next=/send')).toBeNull();
  });

  it('rejects a missing or relative value', () => {
    expect(inAppPath(undefined)).toBeNull();
    expect(inAppPath('')).toBeNull();
    expect(inAppPath('airtime')).toBeNull();
  });
});
