import { Address, xdr } from '@stellar/stellar-sdk';
import { encodeApproveArgs } from '../allowance';

const SPENDER = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD';
const TOKEN = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

describe('encodeApproveArgs', () => {
    it('encodes Some(expiry) as a bare u64, which is what Option<u64> decodes', () => {
        const [, , , expiry] = encodeApproveArgs(SPENDER, TOKEN, 1n, 1_800_000_000);
        expect(expiry.switch()).toBe(xdr.ScValType.scvU64());
        expect(expiry.u64().toString()).toBe('1800000000');
    });

    it('never wraps the expiry in a Vec (the contract rejects that)', () => {
        const [, , , expiry] = encodeApproveArgs(SPENDER, TOKEN, 1n, 0);
        expect(expiry.switch()).not.toBe(xdr.ScValType.scvVec());
        expect(expiry.switch()).toBe(xdr.ScValType.scvU64());
        expect(expiry.u64().toString()).toBe('0');
    });

    it('encodes no expiry as Void (None)', () => {
        const [, , , expiry] = encodeApproveArgs(SPENDER, TOKEN, 1n);
        expect(expiry.switch()).toBe(xdr.ScValType.scvVoid());
    });

    it('encodes spender and token as addresses and amount as an exact i128', () => {
        const big = 170_141_183_460_469_231_731_687_303_715_884_105_727n; // i128::MAX
        const [spender, token, amount] = encodeApproveArgs(SPENDER, TOKEN, big);
        expect(Address.fromScVal(spender).toString()).toBe(SPENDER);
        expect(Address.fromScVal(token).toString()).toBe(TOKEN);
        expect(amount.switch()).toBe(xdr.ScValType.scvI128());
        const parts = amount.i128();
        expect((BigInt(parts.hi().toString()) << 64n) | BigInt(parts.lo().toString())).toBe(big);
    });
});
