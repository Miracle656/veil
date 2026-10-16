/**
 * Tests for per-origin dApp permissions.
 *
 * `lib/permissions.ts` holds module-level state hydrated once from storage, so
 * most cases import a fresh copy — the same shape `appLock.test.ts` uses. The
 * bridge cases additionally mock `./walletConnect`, which is the point: the
 * bridge's only job is to decide, and the signing ceremony stays in
 * `signXdrPayload()`.
 */

const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
  },
}));

const mockSignXdrPayload = jest.fn(async (xdr: string) => `signed:${xdr}`);

jest.mock('../walletConnect', () => ({
  signXdrPayload: (xdr: string) => mockSignXdrPayload(xdr),
}));

type PermissionsModule = typeof import('../permissions');
type BridgeModule = typeof import('../dappBridge');

/** Import a fresh copy of lib/permissions.ts and wait for hydration. */
async function loadPermissions(): Promise<PermissionsModule> {
  jest.resetModules();
  const mod: PermissionsModule = require('../permissions');
  await mod.hydrateOriginPermissions();
  return mod;
}

/** Import a fresh bridge bound to a fresh permission store. */
async function loadBridge(): Promise<{
  bridge: BridgeModule;
  permissions: PermissionsModule;
}> {
  const permissions = await loadPermissions();
  const bridge: BridgeModule = require('../dappBridge');
  return { bridge, permissions };
}

/** A prompt that records what it was asked and answers with a fixed verdict. */
function scriptedPrompt(approve: boolean | ((request: { scope: string }) => boolean)) {
  const seen: { origin: string; scope: string }[] = [];
  return {
    seen,
    prompt: async (request: { origin: string; scope: string }) => {
      seen.push({ origin: request.origin, scope: request.scope });
      return typeof approve === 'function' ? approve(request) : approve;
    },
  };
}

beforeEach(() => {
  mockStorage.clear();
  mockSignXdrPayload.mockClear();
});

// ── Origin normalisation ──────────────────────────────────────────────────────

describe('normalizeOrigin', () => {
  it('reduces a page URL to scheme, host and non-default port', async () => {
    const { normalizeOrigin } = await loadPermissions();
    expect(normalizeOrigin('https://swap.example/trade/eth?amount=1#top')).toBe('https://swap.example');
    expect(normalizeOrigin('http://localhost:8080/app')).toBe('http://localhost:8080');
  });

  it('treats one site reached two ways as one origin', async () => {
    // The browser applies one permission boundary to both, so two grants here
    // would mean one of them could never be revoked from the list.
    const { normalizeOrigin } = await loadPermissions();
    expect(normalizeOrigin('https://Example.com:443/a')).toBe(
      normalizeOrigin('https://example.com/b')
    );
  });

  it('rejects anything that is not a web origin', async () => {
    const { normalizeOrigin } = await loadPermissions();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('data:text/html,<h1>hi')).toBeNull();
    expect(normalizeOrigin('   ')).toBeNull();
  });
});

// ── Granting ──────────────────────────────────────────────────────────────────

describe('grantOriginPermissions', () => {
  it('records a scope with the time it was granted', async () => {
    const { grantOriginPermissions, getOriginGrants, getPermissionGrantedAt } =
      await loadPermissions();

    await grantOriginPermissions('https://swap.example', ['address_disclosure'], {
      grantedAt: 1_700_000_000_000,
    });

    const grants = getOriginGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0].origin).toBe('https://swap.example');
    expect(grants[0].grants).toEqual([
      { scope: 'address_disclosure', grantedAt: 1_700_000_000_000 },
    ]);
    expect(getPermissionGrantedAt('https://swap.example', 'address_disclosure')).toBe(
      1_700_000_000_000
    );
  });

  it('keeps the two scopes separate', async () => {
    const { grantOriginPermissions, isOriginPermissionGranted } = await loadPermissions();

    await grantOriginPermissions('https://swap.example', ['address_disclosure']);

    // The bug this pins: approving "show me your address" silently approving
    // "ask me to sign" too, which is the whole reason the scopes are separate.
    expect(isOriginPermissionGranted('https://swap.example', 'address_disclosure')).toBe(true);
    expect(isOriginPermissionGranted('https://swap.example', 'transaction_signing')).toBe(false);
  });

  it('grants nothing to any other origin', async () => {
    const { grantOriginPermissions, isOriginPermissionGranted, getOriginGrants } =
      await loadPermissions();

    await grantOriginPermissions('https://swap.example', [
      'address_disclosure',
      'transaction_signing',
    ]);

    expect(isOriginPermissionGranted('https://pay.example', 'address_disclosure')).toBe(false);
    expect(isOriginPermissionGranted('https://pay.example', 'transaction_signing')).toBe(false);
    // A subdomain is a different origin: same registrable domain, different
    // party running it, and it must have to ask for itself.
    expect(isOriginPermissionGranted('https://evil.swap.example', 'transaction_signing')).toBe(
      false
    );
    expect(getOriginGrants().map((grant) => grant.origin)).toEqual(['https://swap.example']);
  });

  it('rejects an ungrantable origin and an empty scope list', async () => {
    const { grantOriginPermissions } = await loadPermissions();
    await expect(grantOriginPermissions('not a url', ['address_disclosure'])).rejects.toThrow();
    await expect(grantOriginPermissions('https://swap.example', [])).rejects.toThrow();
  });

  it('replaces rather than duplicates an existing scope', async () => {
    const { grantOriginPermissions, getOriginGrant } = await loadPermissions();

    await grantOriginPermissions('https://swap.example', ['address_disclosure'], {
      grantedAt: 1,
    });
    await grantOriginPermissions('https://swap.example', ['address_disclosure'], {
      grantedAt: 2,
    });

    expect(getOriginGrant('https://swap.example')?.grants).toEqual([
      { scope: 'address_disclosure', grantedAt: 2 },
    ]);
  });
});

// ── Revoking ──────────────────────────────────────────────────────────────────

describe('revokeOriginPermissions', () => {
  it('revokes one scope and leaves the other alone', async () => {
    const { grantOriginPermissions, revokeOriginPermissions, isOriginPermissionGranted } =
      await loadPermissions();
    await grantOriginPermissions('https://swap.example', [
      'address_disclosure',
      'transaction_signing',
    ]);

    expect(await revokeOriginPermissions('https://swap.example', 'transaction_signing')).toBe(
      true
    );

    expect(isOriginPermissionGranted('https://swap.example', 'transaction_signing')).toBe(false);
    expect(isOriginPermissionGranted('https://swap.example', 'address_disclosure')).toBe(true);
  });

  it('drops the origin entirely once its last scope goes', async () => {
    const { grantOriginPermissions, revokeOriginPermissions, getOriginGrants } =
      await loadPermissions();
    await grantOriginPermissions('https://swap.example', ['address_disclosure']);

    await revokeOriginPermissions('https://swap.example', 'address_disclosure');

    // A leftover empty record would sit in the settings list as a row with
    // nothing in it, implying a permission that no longer exists.
    expect(getOriginGrants()).toEqual([]);
  });

  it('revokes every scope for an origin when no scope is named', async () => {
    const { grantOriginPermissions, revokeOriginPermissions, isOriginPermissionGranted } =
      await loadPermissions();
    await grantOriginPermissions('https://swap.example', [
      'address_disclosure',
      'transaction_signing',
    ]);

    await revokeOriginPermissions('https://swap.example');

    expect(isOriginPermissionGranted('https://swap.example', 'address_disclosure')).toBe(false);
    expect(isOriginPermissionGranted('https://swap.example', 'transaction_signing')).toBe(false);
  });

  it('reports nothing to revoke for an unknown origin or scope', async () => {
    const { revokeOriginPermissions } = await loadPermissions();
    expect(await revokeOriginPermissions('https://pay.example')).toBe(false);
    expect(await revokeOriginPermissions('https://pay.example', 'address_disclosure')).toBe(false);
  });

  it('revokeAllOriginPermissions clears every origin', async () => {
    const { grantOriginPermissions, revokeAllOriginPermissions, getOriginGrants } =
      await loadPermissions();
    await grantOriginPermissions('https://swap.example', ['address_disclosure']);
    await grantOriginPermissions('https://pay.example', ['transaction_signing']);

    expect(await revokeAllOriginPermissions()).toBe(2);
    expect(getOriginGrants()).toEqual([]);
    expect(await revokeAllOriginPermissions()).toBe(0);
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe('persistence', () => {
  it('survives a restart', async () => {
    const first = await loadPermissions();
    await first.grantOriginPermissions('https://swap.example', ['transaction_signing'], {
      grantedAt: 1_700_000_000_000,
    });

    // A fresh import is the app relaunching: new module state, same storage.
    const second = await loadPermissions();

    expect(second.isOriginPermissionGranted('https://swap.example', 'transaction_signing')).toBe(
      true
    );
    expect(second.getPermissionGrantedAt('https://swap.example', 'transaction_signing')).toBe(
      1_700_000_000_000
    );
  });

  it('is permanent once cleared', async () => {
    const first = await loadPermissions();
    await first.grantOriginPermissions('https://swap.example', ['transaction_signing']);
    await first.revokeAllOriginPermissions();

    const second = await loadPermissions();

    expect(second.getOriginGrants()).toEqual([]);
    expect(second.isOriginPermissionGranted('https://swap.example', 'transaction_signing')).toBe(
      false
    );
  });

  it('ignores corrupt storage rather than reading it as a grant', async () => {
    mockStorage.set('veil_origin_permissions', 'not json at all');
    const { getOriginGrants, isOriginPermissionGranted } = await loadPermissions();
    expect(getOriginGrants()).toEqual([]);
    expect(isOriginPermissionGranted('https://swap.example', 'transaction_signing')).toBe(false);
  });

  it('drops entries that are not valid grants', async () => {
    // A hand-edited or half-written record must not become a permission. The
    // dangerous shape is an entry that parses but names a scope that does not
    // exist — that would be read as "allowed" by any code that only checked for
    // the presence of the origin.
    mockStorage.set(
      'veil_origin_permissions',
      JSON.stringify([
        { origin: 'https://swap.example', grants: [{ scope: 'withdraw_funds', grantedAt: 1 }] },
        { origin: 'https://pay.example', grants: [] },
        { origin: 'javascript:alert(1)', grants: [{ scope: 'address_disclosure', grantedAt: 1 }] },
        { origin: 'https://ok.example', grants: [{ scope: 'address_disclosure', grantedAt: 1 }] },
      ])
    );

    const { getOriginGrants, isOriginPermissionGranted } = await loadPermissions();

    expect(getOriginGrants().map((grant) => grant.origin)).toEqual(['https://ok.example']);
    expect(isOriginPermissionGranted('https://swap.example', 'address_disclosure' as never)).toBe(
      false
    );
  });
});

// ── The bridge ────────────────────────────────────────────────────────────────

describe('authorizeDappRequest', () => {
  it('prompts once, then stops asking', async () => {
    const { bridge, permissions } = await loadBridge();
    const { prompt, seen } = scriptedPrompt(true);

    await bridge.authorizeDappRequest({
      origin: 'https://swap.example',
      scope: 'transaction_signing',
      prompt,
    });
    await bridge.authorizeDappRequest({
      origin: 'https://swap.example',
      scope: 'transaction_signing',
      prompt,
    });

    expect(seen).toHaveLength(1);
    expect(permissions.isOriginPermissionGranted('https://swap.example', 'transaction_signing')).toBe(
      true
    );
  });

  it('stores nothing when the user declines', async () => {
    const { bridge, permissions } = await loadBridge();
    const { prompt } = scriptedPrompt(false);

    const result = await bridge.authorizeDappRequest({
      origin: 'https://swap.example',
      scope: 'transaction_signing',
      prompt,
    });

    expect(result.status).toBe('rejected');
    expect(permissions.getOriginGrants()).toEqual([]);
  });

  it('prompts again on the next call after a mid-session revoke', async () => {
    // The acceptance criterion, and the reason the bridge reads the store per
    // call: the page is still open, holding the same module instance, and the
    // next thing it asks for must go back to the user.
    const { bridge, permissions } = await loadBridge();
    const { prompt, seen } = scriptedPrompt(true);
    const request = { origin: 'https://swap.example', scope: 'transaction_signing' as const };

    await bridge.authorizeDappRequest({ ...request, prompt });
    expect(seen).toHaveLength(1);

    await permissions.revokeOriginPermissions('https://swap.example', 'transaction_signing');
    const afterRevoke = await bridge.authorizeDappRequest({ ...request, prompt });

    expect(seen).toHaveLength(2);
    expect(afterRevoke.prompted).toBe(true);
  });

  it('does not let one origin answer for another', async () => {
    const { bridge } = await loadBridge();
    const { prompt, seen } = scriptedPrompt(true);

    await bridge.authorizeDappRequest({
      origin: 'https://swap.example',
      scope: 'transaction_signing',
      prompt,
    });
    const other = await bridge.authorizeDappRequest({
      origin: 'https://pay.example',
      scope: 'transaction_signing',
      prompt,
    });

    expect(other.prompted).toBe(true);
    expect(seen.map((entry) => entry.origin)).toEqual([
      'https://swap.example',
      'https://pay.example',
    ]);
  });

  it('keeps address disclosure from unlocking signing', async () => {
    const { bridge, permissions } = await loadBridge();
    const { prompt, seen } = scriptedPrompt(true);

    await bridge.discloseAddressToOrigin(
      {
        origin: 'https://swap.example',
        scope: 'address_disclosure',
        prompt,
      },
      async () => 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ2345'
    );

    expect(permissions.isOriginPermissionGranted('https://swap.example', 'transaction_signing')).toBe(
      false
    );
    await expect(
      bridge.authorizeDappRequest({
        origin: 'https://swap.example',
        scope: 'transaction_signing',
        prompt,
      })
    ).resolves.toMatchObject({ prompted: true });
    expect(seen).toHaveLength(2);
  });
});

describe('signXdrForOrigin', () => {
  it('signs through signXdrPayload once the scope is granted', async () => {
    // The rule this pins: the bridge gates, it does not sign. If it ever built
    // its own signature, this assertion would still pass while the wallet would
    // be producing a subtly wrong one.
    const { bridge } = await loadBridge();
    const { prompt } = scriptedPrompt(true);

    const signed = await bridge.signXdrForOrigin(
      { origin: 'https://swap.example', scope: 'transaction_signing', prompt },
      'AAAA-base64-xdr'
    );

    expect(signed).toBe('signed:AAAA-base64-xdr');
    expect(mockSignXdrPayload).toHaveBeenCalledWith('AAAA-base64-xdr');
  });

  it('never reaches the signing ceremony when the user declines', async () => {
    const { bridge } = await loadBridge();
    const { prompt } = scriptedPrompt(false);

    await expect(
      bridge.signXdrForOrigin(
        { origin: 'https://swap.example', scope: 'transaction_signing', prompt },
        'AAAA-base64-xdr'
      )
    ).rejects.toBeInstanceOf(bridge.DappRequestRejected);
    expect(mockSignXdrPayload).not.toHaveBeenCalled();
  });

  it('asks again, and signs nothing, once the origin is revoked', async () => {
    const { bridge, permissions } = await loadBridge();
    const request = { origin: 'https://swap.example', scope: 'transaction_signing' as const };
    const first = scriptedPrompt(true);
    const afterRevoke = scriptedPrompt(false);

    await bridge.signXdrForOrigin({ ...request, prompt: first.prompt }, 'xdr-1');
    await permissions.revokeAllOriginPermissions();

    // The page is still open and still asking. The revoke means the next call
    // goes back to the user — who, having just revoked, says no.
    await expect(
      bridge.signXdrForOrigin({ ...request, prompt: afterRevoke.prompt }, 'xdr-2')
    ).rejects.toBeInstanceOf(bridge.DappRequestRejected);

    expect(afterRevoke.seen).toHaveLength(1);
    expect(mockSignXdrPayload).toHaveBeenCalledTimes(1);
  });
});

describe('formatGrantedAt', () => {
  it('renders the day the grant was made', async () => {
    const { formatGrantedAt } = await loadPermissions();
    expect(formatGrantedAt(Date.UTC(2026, 8, 30, 12, 0, 0))).toBe('2026-09-30');
  });

  it('says so rather than printing NaN', async () => {
    const { formatGrantedAt } = await loadPermissions();
    expect(formatGrantedAt(Number.NaN)).toBe('Unknown');
  });
});
