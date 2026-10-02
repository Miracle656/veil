import {
  friendlyHostError,
  rejectionFromBase64,
  translateNetworkError,
} from '../networkErrors';
import { isReachableResponse, reachabilityConfig } from '../reachability';

// A TransactionResult is fee (int64) + result code (int32) + ext (int32).
function txResult(code: number): string {
  const buf = Buffer.alloc(16);
  buf.writeBigInt64BE(100n, 0);
  buf.writeInt32BE(code, 8);
  buf.writeInt32BE(0, 12);
  return buf.toString('base64');
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('rejectionFromBase64', () => {
  it('explains txINSUFFICIENT_BALANCE as missing XLM, not missing USDC', () => {
    expect(rejectionFromBase64(txResult(-7))).toMatch(/XLM/);
  });

  it('names other transaction codes', () => {
    expect(rejectionFromBase64(txResult(-5))).toMatch(/stale account state/);
  });

  it('returns null for something that is not a transaction result', () => {
    expect(rejectionFromBase64('not-base64-xdr')).toBeNull();
  });
});

describe('translateNetworkError', () => {
  it('turns a raw rejected result into a sentence', () => {
    const message = translateNetworkError(`Transaction rejected: ${txResult(-7)}`);
    expect(message).not.toMatch(/AAAA/);
    expect(message).toMatch(/XLM/);
  });

  it('turns serialised Horizon codes into a sentence', () => {
    const message = translateNetworkError(
      'Payment rejected: {"transaction":"tx_failed","operations":["op_underfunded"]}',
    );
    expect(message).toBe("There isn't enough of that asset in the account to send.");
  });

  it('names a missing trustline in a simulation failure', () => {
    const raw =
      'Smart-wallet transaction failed to simulate: HostError: Error(Contract, #13)\n' +
      'Event log (newest first):\n 0: [Diagnostic Event] data:["trustline entry is missing for account", GBXE…]\n' +
      ' 1: [Diagnostic Event] topics:[fn_call, CCW67…, transfer]';
    expect(translateNetworkError(raw)).toMatch(/can't hold this asset yet/);
  });

  it('leaves messages it does not recognise untouched', () => {
    expect(translateNetworkError('Passkey cancelled. Please try again.')).toBe(
      'Passkey cancelled. Please try again.',
    );
    expect(translateNetworkError('Simulation failed: Could not unmarshal transaction')).toBe(
      'Simulation failed: Could not unmarshal transaction',
    );
  });
});

describe('friendlyHostError', () => {
  it('maps a SAC balance error on a transfer', () => {
    expect(friendlyHostError('HostError: Error(Contract, #10) … transfer')).toMatch(/isn't enough/);
  });

  it('does not guess at a contract error outside a token transfer', () => {
    expect(friendlyHostError('HostError: Error(Contract, #10) … deposit')).toBeNull();
  });
});

describe('reachability', () => {
  it('counts any HTTP answer as reachable — Horizon answers HEAD with 405', async () => {
    await expect(isReachableResponse({ status: 200 })).resolves.toBe(true);
    await expect(isReachableResponse({ status: 405 })).resolves.toBe(true);
    await expect(isReachableResponse({ status: 503 })).resolves.toBe(true);
  });

  it('checks with GET, not the HEAD request Horizon refuses', () => {
    expect(reachabilityConfig.reachabilityMethod).toBe('GET');
    expect(reachabilityConfig.useNativeReachability).toBe(false);
  });
});
