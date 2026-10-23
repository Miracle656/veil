/**
 * The fee is a payment the user did not ask for, so almost every test here is
 * about refusing to charge one. A fee we cannot fully describe must not be
 * attached to a transaction, and a fee service that is down must never stop
 * someone cashing out.
 *
 * The module is loaded per test rather than imported at the top, because it
 * reads `EXPO_PUBLIC_WRAITH_URL` once at load. Setting that in `beforeEach`
 * after a static import left the base URL empty, so every call returned null
 * before reaching any logic — and since nearly every assertion here expects
 * null, the suite passed while testing nothing at all.
 */
type FetchPlatformFee = typeof import('../platformFee').fetchPlatformFee;

const DEST = 'G' + 'A'.repeat(55);
const ISSUER = 'G' + 'B'.repeat(55);

function loadWithBaseUrl(url: string | undefined): FetchPlatformFee {
  jest.resetModules();
  if (url === undefined) delete process.env.EXPO_PUBLIC_WRAITH_URL;
  else process.env.EXPO_PUBLIC_WRAITH_URL = url;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../platformFee') as typeof import('../platformFee')).fetchPlatformFee;
}

const ok = (body: unknown) => ({ ok: true, json: async () => body });

describe('fetchPlatformFee', () => {
  const realFetch = global.fetch;
  let fetchPlatformFee: FetchPlatformFee;
  beforeEach(() => {
    global.fetch = jest.fn();
    fetchPlatformFee = loadWithBaseUrl('https://wraith.test');
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  const enabled = (fees: Record<string, unknown>) => ok({ enabled: true, fees });

  it('returns the fee for the asset being sent', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      enabled({ USDC: { amount: '0.1', assetCode: 'USDC', assetIssuer: ISSUER, destination: DEST } }),
    );
    await expect(fetchPlatformFee('USDC')).resolves.toEqual({
      amount: '0.1',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      destination: DEST,
    });
  });

  it('accepts native XLM, which has no issuer', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      enabled({ XLM: { amount: '0.5', assetCode: 'XLM', assetIssuer: null, destination: DEST } }),
    );
    const fee = await fetchPlatformFee('XLM');
    expect(fee?.amount).toBe('0.5');
    expect(fee?.assetIssuer).toBeNull();
  });

  it('charges nothing for an asset with no entry', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      enabled({ USDC: { amount: '0.1', assetCode: 'USDC', assetIssuer: ISSUER, destination: DEST } }),
    );
    await expect(fetchPlatformFee('XLM')).resolves.toBeNull();
  });

  it('charges nothing when fees are switched off', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(ok({ enabled: false, fees: {} }));
    await expect(fetchPlatformFee('USDC')).resolves.toBeNull();
  });

  // The one that matters most: our billing being down must not cost someone
  // their cash-out.
  it('charges nothing when the service is unreachable', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(fetchPlatformFee('USDC')).resolves.toBeNull();
  });

  it('charges nothing when the service errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(fetchPlatformFee('USDC')).resolves.toBeNull();
  });

  it.each([
    ['a negative amount', { amount: '-1', assetCode: 'USDC', assetIssuer: ISSUER, destination: DEST }],
    ['a zero amount', { amount: '0', assetCode: 'USDC', assetIssuer: ISSUER, destination: DEST }],
    ['a non-numeric amount', { amount: 'free', assetCode: 'USDC', assetIssuer: ISSUER, destination: DEST }],
    ['more than 7 decimals', { amount: '0.123456789', assetCode: 'USDC', assetIssuer: ISSUER, destination: DEST }],
    ['a missing destination', { amount: '0.1', assetCode: 'USDC', assetIssuer: ISSUER }],
    ['a contract destination', { amount: '0.1', assetCode: 'USDC', assetIssuer: ISSUER, destination: 'C' + 'A'.repeat(55) }],
    ['a malformed destination', { amount: '0.1', assetCode: 'USDC', assetIssuer: ISSUER, destination: 'not-an-address' }],
    ['an issued asset with no issuer', { amount: '0.1', assetCode: 'USDC', assetIssuer: null, destination: DEST }],
    ['a malformed issuer', { amount: '0.1', assetCode: 'USDC', assetIssuer: 'nope', destination: DEST }],
  ])('charges nothing on %s', async (_label, entry) => {
    (global.fetch as jest.Mock).mockResolvedValue(enabled({ USDC: entry }));
    await expect(fetchPlatformFee('USDC')).resolves.toBeNull();
  });

  // A server that answers about one asset when asked about another is
  // confused, and a confused fee is not one to charge.
  it('charges nothing when the asset does not match what was asked for', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      enabled({ USDC: { amount: '0.1', assetCode: 'EURC', assetIssuer: ISSUER, destination: DEST } }),
    );
    await expect(fetchPlatformFee('USDC')).resolves.toBeNull();
  });

  // Pinned deliberately, because this was happening by accident and hiding
  // every other assertion in this file.
  it('charges nothing when no backend is configured, without calling out', async () => {
    const unconfigured = loadWithBaseUrl(undefined);
    await expect(unconfigured('USDC')).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
