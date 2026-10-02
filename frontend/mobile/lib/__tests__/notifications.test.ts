import {
  counterpartyPreposition,
  routeForNotificationResponse,
  shortenAddress,
} from '../notifications';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
}));

describe('counterpartyPreposition', () => {
  it('names the sender for money coming in', () => {
    expect(counterpartyPreposition('received')).toBe('From');
  });

  it('names the recipient for money going out', () => {
    // The bug this pins: a sent payment read "Payment sent — From GB3JS2…",
    // which labels the recipient as the sender. On a notification that line is
    // the only context there is, so it reads as money arriving from an address
    // the user does not recognise — the opposite of what happened, and
    // alarming rather than merely wrong.
    expect(counterpartyPreposition('sent')).toBe('To');
  });

  it('treats a confirmation as outgoing', () => {
    expect(counterpartyPreposition('confirmed')).toBe('To');
  });
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

describe('routeForNotificationResponse', () => {
  const withData = (data: unknown) => ({
    notification: { request: { content: { data } } },
  });

  it('returns the route a transfer notification carries', () => {
    expect(routeForNotificationResponse(withData({ route: '/transactions' }))).toBe(
      '/transactions',
    );
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
