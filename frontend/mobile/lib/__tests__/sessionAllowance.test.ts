import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import {
  decodeSessionAllowance,
  requestSessionPublicKey,
  sessionAllowanceLedgerKey,
  sessionKeyId,
} from '../sessionAllowance';

const WALLET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function aclValue(publicKey: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('pubkey'), val: xdr.ScVal.scvBytes(Buffer.from(publicKey)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('target_contract'), val: new Address(TOKEN).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('selector'), val: xdr.ScVal.scvSymbol('transfer') }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_cap'), val: nativeToScVal(50_000_000n, { type: 'i128' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('spent'), val: nativeToScVal(12_000_000n, { type: 'i128' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('expiry'), val: xdr.ScVal.scvU64(xdr.Uint64.fromString('1900000000')) }),
  ]);
}

describe('session allowance', () => {
  it('derives a stable public storage handle and temporary ledger key', () => {
    const publicKey = Uint8Array.from({ length: 32 }, (_, i) => i);
    const id = sessionKeyId(publicKey);
    expect(id).toHaveLength(32);
    expect(Buffer.from(id).toString('hex')).toBe(
      '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
    );
    expect(sessionAllowanceLedgerKey(WALLET, id).contractData().durability().name).toBe('temporary');
  });

  it('decodes the deployed ACL fields without treating spent as the remaining cap', () => {
    const publicKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const decoded = decodeSessionAllowance(aclValue(publicKey), sessionKeyId(publicKey));
    expect(decoded.publicKey).toBe(Buffer.from(publicKey).toString('hex'));
    expect(decoded.cap).toBe(50_000_000n);
    expect(decoded.spent).toBe(12_000_000n);
    expect(decoded.selector).toBe('transfer');
  });

  it('rejects a missing public key response instead of registering an unknown key', async () => {
    await expect(
      requestSessionPublicKey(WALLET, async () => ({ ok: true, json: async () => ({}) }) as Response),
    ).rejects.toThrow('did not return a public key');
  });
});
