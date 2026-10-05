/**
 * Tests for `lib/sppProver.ts`.
 *
 * The important behaviour is the failure surface: a binary without the
 * native module must degrade to typed "unavailable" errors, never import
 * crashes. Every case runs with the module mocked at the boundary
 * (`modules/spp-native/src`), so no test depends on a real binary.
 */

const mockLoad = jest.fn();
jest.mock('../../modules/spp-native/src', () => ({
  loadSppNativeModule: () => mockLoad(),
}));

import {
  SppProverError,
  isSppNativeAvailable,
  proveTransaction,
  syncSppState,
  verifyProof,
} from '../sppProver';

const FAKE_PROOF = new Uint8Array([1, 2, 3]);
const FAKE_INPUTS = new Uint8Array([4, 5, 6]);

function makeModule(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    prove: jest.fn(async () => ({ proof: FAKE_PROOF, publicInputs: FAKE_INPUTS, nativeMs: 12 })),
    verify: jest.fn(async () => true),
    syncTo: jest.fn(async (_c: unknown, to: number) => ({
      scannedHeight: to,
      commitmentRoot: new Uint8Array(32),
      noteCount: 1,
    })),
    ...overrides,
  };
}

beforeEach(() => {
  mockLoad.mockReset();
});

describe('isSppNativeAvailable', () => {
  it('is false when the binary has no module', () => {
    mockLoad.mockReturnValue(null);
    expect(isSppNativeAvailable()).toBe(false);
  });

  it('is true when the module loads', () => {
    mockLoad.mockReturnValue(makeModule());
    expect(isSppNativeAvailable()).toBe(true);
  });
});

describe('proveTransaction', () => {
  const request = {
    transaction: { anchor: new Uint8Array(32), inputs: [], outputs: [], fee: 0, expiryLedger: 0 },
    notes: [],
    merklePaths: [],
    changeNote: { noteKey: new Uint8Array(32), rho: new Uint8Array(32), commitment: new Uint8Array(32) },
    blinding: new Uint8Array(32),
  };

  it('passes the request through and returns the result', async () => {
    const mod = makeModule();
    mockLoad.mockReturnValue(mod);

    const result = await proveTransaction(request);

    expect(mod.prove).toHaveBeenCalledWith(request);
    expect(result.nativeMs).toBe(12);
  });

  it('throws E_UNAVAILABLE without the module, instead of crashing', async () => {
    mockLoad.mockReturnValue(null);

    await expect(proveTransaction(request)).rejects.toMatchObject({
      name: 'SppProverError',
      code: 'E_UNAVAILABLE',
    });
  });

  it('rethrows native rejections with their code intact', async () => {
    const mod = makeModule({
      prove: jest.fn(async () => {
        throw { code: 'invalid_transaction', message: 'invalid_transaction: anchor must be 32 bytes' };
      }),
    });
    mockLoad.mockReturnValue(mod);

    await expect(proveTransaction(request)).rejects.toBeInstanceOf(SppProverError);
    await expect(proveTransaction(request)).rejects.toMatchObject({ code: 'invalid_transaction' });
  });

  it('surfaces E_BAD_REQUEST for malformed calls as a typed error', async () => {
    const mod = makeModule({
      prove: jest.fn(async () => {
        throw { code: 'E_BAD_REQUEST', message: "field 'transaction' must be an object" };
      }),
    });
    mockLoad.mockReturnValue(mod);

    await expect(proveTransaction(request)).rejects.toMatchObject({ code: 'E_BAD_REQUEST' });
  });
});

describe('verifyProof', () => {
  it('returns the native verdict', async () => {
    mockLoad.mockReturnValue(makeModule({ verify: jest.fn(async () => false) }));
    await expect(verifyProof(FAKE_PROOF, FAKE_INPUTS)).resolves.toBe(false);
  });

  it('throws E_UNAVAILABLE without the module', async () => {
    mockLoad.mockReturnValue(null);
    await expect(verifyProof(FAKE_PROOF, FAKE_INPUTS)).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
    });
  });
});

describe('syncSppState', () => {
  const checkpoint = {
    scannedHeight: 100,
    commitmentRoot: new Uint8Array(32),
    noteCount: 0,
  };

  it('forwards the checkpoint and height', async () => {
    const mod = makeModule();
    mockLoad.mockReturnValue(mod);

    const next = await syncSppState(checkpoint, 150, [new Uint8Array(32)]);

    expect(mod.syncTo).toHaveBeenCalledWith(checkpoint, 150, [new Uint8Array(32)]);
    expect(next.scannedHeight).toBe(150);
  });

  it('surfaces invalid_sync rejections', async () => {
    mockLoad.mockReturnValue(
      makeModule({
        syncTo: jest.fn(async () => {
          throw { code: 'invalid_sync', message: 'invalid_sync: cannot sync backwards' };
        }),
      })
    );

    await expect(syncSppState(checkpoint, 90, [])).rejects.toMatchObject({ code: 'invalid_sync' });
  });
});
