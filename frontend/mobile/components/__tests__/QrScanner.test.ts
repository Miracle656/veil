import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { parseScanResult } from '../QrScanner';

const ACCOUNT = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const ISSUER = Keypair.random().publicKey();

describe('mobile QrScanner — parseScanResult', () => {
  it('parses a bare Stellar G-address', () => {
    const result = parseScanResult(ACCOUNT);
    expect(result).toEqual({ address: ACCOUNT });
  });

  it('parses a bare Stellar C-address', () => {
    const result = parseScanResult(CONTRACT);
    expect(result).toEqual({ address: CONTRACT });
  });

  it('extracts destination and memo from a SEP-7 URI', () => {
    const uri = `web+stellar:pay?destination=${ACCOUNT}&memo=deposit-999`;
    const result = parseScanResult(uri);
    expect(result).toEqual({
      address: ACCOUNT,
      details: {
        memo: 'deposit-999',
      },
    });
  });

  it('extracts all SEP-7 fields including amount, memo, asset_code, and asset_issuer', () => {
    const uri = `web+stellar:pay?destination=${ACCOUNT}&amount=100.5&asset_code=USDC&asset_issuer=${ISSUER}&memo=exchange-id-42`;
    const result = parseScanResult(uri);
    expect(result).toEqual({
      address: ACCOUNT,
      details: {
        amount: '100.5',
        memo: 'exchange-id-42',
        assetCode: 'USDC',
        assetIssuer: ISSUER,
      },
    });
  });

  it('rejects invalid or non-stellar strings', () => {
    expect(parseScanResult('')).toBeNull();
    expect(parseScanResult('https://example.com')).toBeNull();
    expect(parseScanResult('not-a-stellar-uri')).toBeNull();
  });
});
