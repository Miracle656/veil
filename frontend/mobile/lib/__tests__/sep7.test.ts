import { buildSep7Memo, buildSep7PayUri, looksLikeStellarAddress, parseQrValue, parseSep7Uri } from '../sep7';

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

describe('SEP-7 memo_type handling (Issue #817)', () => {
  const HASH_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const HASH_BASE64 = Buffer.from(HASH_HEX, 'hex').toString('base64');

  it('MEMO_TEXT produces a text memo', () => {
    const uri = `web+stellar:pay?destination=${DESTINATION}&memo=hello+world&memo_type=MEMO_TEXT`;
    const parsed = parseSep7Uri(uri);
    expect(parsed?.memoType).toBe('MEMO_TEXT');
    const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType);
    expect(memo.type).toBe('text');
    expect(memo.value).toBe('hello world');
  });

  it('MEMO_ID produces an id memo', () => {
    const uri = `web+stellar:pay?destination=${DESTINATION}&memo=123456789&memo_type=MEMO_ID`;
    const parsed = parseSep7Uri(uri);
    expect(parsed?.memoType).toBe('MEMO_ID');
    const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType);
    expect(memo.type).toBe('id');
    expect(memo.value).toBe('123456789');
  });

  it('MEMO_HASH produces a hash memo from hex or base64', () => {
    const uriHex = `web+stellar:pay?destination=${DESTINATION}&memo=${HASH_HEX}&memo_type=MEMO_HASH`;
    const parsedHex = parseSep7Uri(uriHex);
    expect(parsedHex?.memoType).toBe('MEMO_HASH');
    const memoHex = buildSep7Memo(parsedHex!.memo!, parsedHex!.memoType);
    expect(memoHex.type).toBe('hash');
    expect(Buffer.from(memoHex.value as Buffer).toString('hex')).toBe(HASH_HEX);

    const uriB64 = `web+stellar:pay?destination=${DESTINATION}&memo=${encodeURIComponent(HASH_BASE64)}&memo_type=MEMO_HASH`;
    const parsedB64 = parseSep7Uri(uriB64);
    const memoB64 = buildSep7Memo(parsedB64!.memo!, parsedB64!.memoType);
    expect(memoB64.type).toBe('hash');
    expect(Buffer.from(memoB64.value as Buffer).toString('hex')).toBe(HASH_HEX);
  });

  it('MEMO_RETURN produces a return memo from hex or base64', () => {
    const uriHex = `web+stellar:pay?destination=${DESTINATION}&memo=${HASH_HEX}&memo_type=MEMO_RETURN`;
    const parsedHex = parseSep7Uri(uriHex);
    expect(parsedHex?.memoType).toBe('MEMO_RETURN');
    const memoHex = buildSep7Memo(parsedHex!.memo!, parsedHex!.memoType);
    expect(memoHex.type).toBe('return');
    expect(Buffer.from(memoHex.value as Buffer).toString('hex')).toBe(HASH_HEX);

    const uriB64 = `web+stellar:pay?destination=${DESTINATION}&memo=${encodeURIComponent(HASH_BASE64)}&memo_type=MEMO_RETURN`;
    const parsedB64 = parseSep7Uri(uriB64);
    const memoB64 = buildSep7Memo(parsedB64!.memo!, parsedB64!.memoType);
    expect(memoB64.type).toBe('return');
    expect(Buffer.from(memoB64.value as Buffer).toString('hex')).toBe(HASH_HEX);
  });

  it('refuses an unknown memo_type with a message naming it', () => {
    const uri = `web+stellar:pay?destination=${DESTINATION}&memo=123&memo_type=MEMO_UNKNOWN`;
    expect(() => parseSep7Uri(uri)).toThrow('Unknown memo_type: "MEMO_UNKNOWN"');
    expect(() => buildSep7Memo('123', 'MEMO_UNKNOWN')).toThrow('Unknown memo_type: "MEMO_UNKNOWN"');
  });

  it('defaults to text memo when memo_type is absent', () => {
    const uri = `web+stellar:pay?destination=${DESTINATION}&memo=deposit-ref`;
    const parsed = parseSep7Uri(uri);
    expect(parsed?.memoType).toBeUndefined();
    const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType);
    expect(memo.type).toBe('text');
    expect(memo.value).toBe('deposit-ref');
  });
});
