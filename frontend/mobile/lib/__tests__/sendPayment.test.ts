/**
 * Tests for the send flow's portable logic.
 *
 * The network build/submit is exercised on-device, but the pieces that decide
 * *what* happens — input validation, amount conversion, address classification,
 * and the confirmation poll's terminal-state handling — are pure and covered
 * here. The poll's clock is injected so failures and timeouts resolve instantly.
 */

import {
  isClassicAddress,
  pollForResult,
  toStroops,
  validateSend,
  type TransactionPoller,
} from '../sendPayment';
import { requireSigner, SignerUnavailableError } from '../signer';

const G_ADDR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const C_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

describe('validateSend', () => {
  it('accepts a valid classic address and positive amount', () => {
    expect(validateSend(G_ADDR, '1.5')).toEqual({});
  });

  it('accepts a contract address', () => {
    expect(validateSend(C_ADDR, '1')).toEqual({});
  });

  it('rejects a malformed recipient', () => {
    expect(validateSend('not-an-address', '1').recipient).toBeDefined();
  });

  it('rejects a zero or negative amount', () => {
    expect(validateSend(G_ADDR, '0').amount).toBeDefined();
    expect(validateSend(G_ADDR, '-2').amount).toBeDefined();
  });
});

describe('isClassicAddress', () => {
  it('is true for G… accounts and false for C… contracts', () => {
    expect(isClassicAddress(G_ADDR)).toBe(true);
    expect(isClassicAddress(C_ADDR)).toBe(false);
  });
});

describe('toStroops', () => {
  it('converts XLM to i128 stroops', () => {
    expect(toStroops('1')).toBe(10_000_000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('2.5')).toBe(25_000_000n);
  });
});

describe('pollForResult', () => {
  const noSleep = () => Promise.resolve();

  it('resolves with the hash once the network reports success', async () => {
    const statuses = ['NOT_FOUND', 'NOT_FOUND', 'SUCCESS'];
    let i = 0;
    const server: TransactionPoller = {
      getTransaction: async () => ({ status: statuses[i++] }),
    };
    await expect(pollForResult(server, 'abc', { sleep: noSleep })).resolves.toBe('abc');
    expect(i).toBe(3);
  });

  it('throws when the transaction reaches a non-success terminal status', async () => {
    const server: TransactionPoller = { getTransaction: async () => ({ status: 'FAILED' }) };
    await expect(pollForResult(server, 'abc', { sleep: noSleep })).rejects.toThrow(/failed: FAILED/i);
  });

  it('throws on timeout when it never leaves NOT_FOUND', async () => {
    const server: TransactionPoller = { getTransaction: async () => ({ status: 'NOT_FOUND' }) };
    await expect(
      pollForResult(server, 'abc', { tries: 3, sleep: noSleep }),
    ).rejects.toThrow(/timed out/i);
  });
});

describe('requireSigner', () => {
  it('fails closed while the mobile passkey module is pending', async () => {
    await expect(requireSigner()).rejects.toBeInstanceOf(SignerUnavailableError);
  });
});
