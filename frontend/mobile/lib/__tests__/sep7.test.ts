import { buildSep7PayUri, looksLikeStellarAddress, parseQrValue, parseSep7Uri } from '../sep7';

const DESTINATION = 'GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('parseSep7Uri', () => {
  it('parses a destination-only pay URI', () => {
    expect(parseSep7Uri(`web+stellar:pay?destination=${DESTINATION}`)).toEqual({
      destination: DESTINATION,
      amount: undefined,
      assetCode: undefined,
      assetIssuer: undefined,
      memo: undefined,
    });
  });

  it('parses every supported field', () => {
    const uri =
      `web+stellar:pay?destination=${DESTINATION}` +
      `&amount=12.5&asset_code=USDC&asset_issuer=${ISSUER}&memo=invoice-42`;

    expect(parseSep7Uri(uri)).toEqual({
      destination: DESTINATION,
      amount: '12.5',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'invoice-42',
    });
  });

  it('is case-insensitive about the scheme', () => {
    expect(parseSep7Uri(`WEB+STELLAR:pay?destination=${DESTINATION}`)?.destination).toBe(
      DESTINATION,
    );
  });

  it('rejects a non-pay operation', () => {
    expect(parseSep7Uri('web+stellar:tx?xdr=AAAA')).toBeNull();
  });

  it('rejects a URI that is not SEP-7 at all', () => {
    expect(parseSep7Uri('https://example.com/pay?destination=G')).toBeNull();
    expect(parseSep7Uri('veil://pay?to=G')).toBeNull();
  });

  it('treats blank parameters as absent rather than empty strings', () => {
    expect(parseSep7Uri(`web+stellar:pay?destination=${DESTINATION}&memo=`)?.memo).toBeUndefined();
  });
});

describe('looksLikeStellarAddress', () => {
  it('accepts 56-character G and C addresses', () => {
    expect(looksLikeStellarAddress(DESTINATION)).toBe(true);
    expect(looksLikeStellarAddress(`C${DESTINATION.slice(1)}`)).toBe(true);
  });

  it('rejects the wrong length or prefix', () => {
    expect(looksLikeStellarAddress(DESTINATION.slice(0, 55))).toBe(false);
    expect(looksLikeStellarAddress(`S${DESTINATION.slice(1)}`)).toBe(false);
    expect(looksLikeStellarAddress('')).toBe(false);
  });
});

describe('parseQrValue', () => {
  it('accepts a bare address as a destination', () => {
    expect(parseQrValue(`  ${DESTINATION}  `)).toEqual({ destination: DESTINATION });
  });

  it('accepts a SEP-7 pay URI', () => {
    expect(parseQrValue(`web+stellar:pay?destination=${DESTINATION}&amount=3`)).toMatchObject({
      destination: DESTINATION,
      amount: '3',
    });
  });

  it('returns null for anything else', () => {
    expect(parseQrValue('')).toBeNull();
    expect(parseQrValue('just some text')).toBeNull();
  });
});

describe('buildSep7PayUri', () => {
  it('round-trips through the parser', () => {
    const uri = buildSep7PayUri({
      destination: DESTINATION,
      amount: '12.5',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'invoice-42',
    });

    expect(parseSep7Uri(uri)).toEqual({
      destination: DESTINATION,
      amount: '12.5',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'invoice-42',
    });
  });

  it('omits fields that were not supplied', () => {
    expect(buildSep7PayUri({ destination: DESTINATION })).toBe(
      `web+stellar:pay?destination=${DESTINATION}`,
    );
  });

  it('percent-encodes a memo containing separators', () => {
    const uri = buildSep7PayUri({ destination: DESTINATION, memo: 'a&b=c d' });

    expect(uri).toContain('memo=a%26b%3Dc+d');
    expect(parseSep7Uri(uri)?.memo).toBe('a&b=c d');
  });
});
