import {
  assertSafePushBody,
  fireTransferNotification,
  routeForNotificationResponse,
  shortenAddress,
} from '../notifications';
import * as Notifications from 'expo-notifications';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
}));
jest.mock('../notificationPrefs', () => ({
  hydrateNotifPrefs: jest.fn().mockResolvedValue(undefined),
  getNotifIncoming: jest.fn().mockReturnValue(true),
  getNotifOutgoing: jest.fn().mockReturnValue(true),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('shortenAddress', () => {
  it('keeps both ends so the address stays checkable', () => {
    const address = 'GB3JS2ABCDEFGHIJKLMNOPQRSTUVWXYZ234567WCKUZW';
    const short = shortenAddress(address);

    expect(short.startsWith(address.slice(0, 6))).toBe(true);
    expect(short.endsWith(address.slice(-6))).toBe(true);
    expect(short.length).toBeLessThan(address.length);
  });

  it('leaves a short value alone rather than mangling it', () => {
    expect(shortenAddress('GABC')).toBe('GABC');
  });
});

describe('assertSafePushBody', () => {
  it('accepts only generic payment text', () => {
    expect(assertSafePushBody('A payment arrived.')).toBe('A payment arrived.');
  });

  it('rejects the natural amount-and-address notification', () => {
    expect(() =>
      assertSafePushBody(
        'Your 5.00 USDC arrived from GAE6BEVEA6IH4HLTGU3AEGZZWSLNCCWLKD4GLN2XHLXFFNFB24COWUJY'
      )
    ).toThrow(/Refusing to send/);
  });

  it('rejects a Stellar address', () => {
    expect(() => assertSafePushBody(`Payment from G${'A'.repeat(55)}.`)).toThrow(
      /Refusing to send/
    );
  });

  it('rejects a contract id', () => {
    expect(() => assertSafePushBody(`Contract C${'A'.repeat(55)} confirmed.`)).toThrow(
      /Refusing to send/
    );
  });

  it('rejects a transaction hash', () => {
    expect(() => assertSafePushBody(`Transaction ${'a'.repeat(64)} confirmed.`)).toThrow(
      /Refusing to send/
    );
  });

  it('rejects an 11-digit identifier without storing a NIN fixture', () => {
    const digits = Array.from({ length: 11 }, (_, i) => String(i % 10)).join('');
    expect(() => assertSafePushBody(`Payment for ${digits}.`)).toThrow(/Refusing to send/);
  });

  it('rejects personal names and other unapproved dynamic text', () => {
    expect(() => assertSafePushBody('Payment received for Jane Doe.')).toThrow(/Refusing to send/);
  });

  it('rejects a decimal amount', () => {
    expect(() => assertSafePushBody('Received 5.00 USDC.')).toThrow(/Refusing to send/);
  });
});

describe('fireTransferNotification', () => {
  it('sends only generic text and an event type/id for local lookup', async () => {
    await fireTransferNotification({ type: 'received', eventId: '123' });

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          body: 'A payment arrived.',
          data: {
            route: '/transactions',
            eventType: 'received',
            eventId: '123',
          },
        }),
      })
    );
  });

  it('refuses an unsafe event id before scheduling a notification', async () => {
    await expect(
      fireTransferNotification({ type: 'received', eventId: 'a'.repeat(64) })
    ).rejects.toThrow(/safe activity event id/);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('routeForNotificationResponse', () => {
  const withData = (data: unknown) => ({
    notification: { request: { content: { data } } },
  });

  it('returns the route a transfer notification carries', () => {
    expect(routeForNotificationResponse(withData({ route: '/transactions' }))).toBe(
      '/transactions'
    );
  });

  it('carries only an event type and safe id for local lookup', () => {
    expect(
      routeForNotificationResponse(
        withData({ route: '/transactions', eventType: 'received', eventId: 'w-42' })
      )
    ).toBe('/transactions?eventId=w-42&eventType=received');
  });

  it('returns null when there is no data, so a tap is a no-op not a crash', () => {
    expect(routeForNotificationResponse(withData(undefined))).toBeNull();
    expect(routeForNotificationResponse({})).toBeNull();
    expect(routeForNotificationResponse(null)).toBeNull();
  });

  it('ignores a route that is not an in-app path', () => {
    // Refuses anything that is not a leading-slash route, so a malformed or
    // injected payload cannot send the user somewhere unexpected.
    expect(routeForNotificationResponse(withData({ route: 'https://evil.example' }))).toBeNull();
    expect(routeForNotificationResponse(withData({ route: 42 }))).toBeNull();
  });
});
