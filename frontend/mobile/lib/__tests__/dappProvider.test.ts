/**
 * The wire grammar of the injected provider, tested on both halves.
 *
 * `lib/dappProvider.ts` is the only place the message format is written down, so
 * these tests are what stands between a page's `postMessage` string and the code
 * that decides whether to sign. They cover the parser's rejections (a page gets
 * exactly one envelope, and anything else is not a request), the reply
 * serialiser's escaping (a reply is data handed to a function call, never code),
 * and the injected script's own boundaries.
 */
import {
  DAPP_PROVIDER_REQUEST_TYPE,
  DAPP_PROVIDER_REPLY_HOOK,
  FREIGHTER_PROVIDER_GLOBAL,
  VEIL_PROVIDER_GLOBAL,
  MAX_PROVIDER_MESSAGE_CHARS,
  MAX_PROVIDER_XDR_CHARS,
  SEP43_ERROR,
  dappProviderScript,
  errorResponse,
  parseProviderRequest,
  serializeProviderReply,
  unsupportedResponse,
  type ProviderMethod,
  type ProviderRequest,
} from '../dappProvider';

const VALID_XDR = Buffer.from('a transaction envelope, as base64').toString('base64');

function message(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: DAPP_PROVIDER_REQUEST_TYPE,
    id: 'r1-1630000000000',
    method: 'getAddress',
    params: {},
    ...overrides,
  });
}

/** Parse a message and insist it was accepted, for the shape tests. */
function accepted(data: string): ProviderRequest {
  const request = parseProviderRequest(data);
  expect(request).not.toBeNull();
  return request as ProviderRequest;
}

// ── The envelope ──────────────────────────────────────────────────────────────

describe('parseProviderRequest', () => {
  it('accepts a well-formed request and reports what it asked for', () => {
    const request = accepted(message({ method: 'signTransaction', params: { xdr: VALID_XDR } }));

    expect(request.method).toBe('signTransaction');
    expect(request.id).toBe('r1-1630000000000');
    expect(request.xdr).toBe(VALID_XDR);
    expect(request.wantsList).toBe(false);
  });

  it('ignores anything that is not a string, not JSON, or not an object', () => {
    for (const data of [42, null, undefined, {}, 'not json', '[]', '"just a string"']) {
      expect(parseProviderRequest(data)).toBeNull();
    }
  });

  it('ignores an empty or oversized payload', () => {
    expect(parseProviderRequest('')).toBeNull();
    expect(parseProviderRequest('x'.repeat(MAX_PROVIDER_MESSAGE_CHARS + 1))).toBeNull();
  });

  it('ignores the wrong envelope tag', () => {
    expect(parseProviderRequest(message({ type: 'veil:window-open' }))).toBeNull();
    expect(parseProviderRequest(message({ type: undefined }))).toBeNull();
  });

  it('ignores an id that could not be matched back to a pending call', () => {
    const badIds = ['', 'has spaces', 'a'.repeat(65), '../../etc/passwd', 'emoji-\u{1F600}'];
    for (const id of badIds) {
      expect(parseProviderRequest(message({ id }))).toBeNull();
    }
  });

  it('ignores a method outside the published interface', () => {
    for (const method of ['signAndSubmitTx', 'getSecretKey', 'eval', '']) {
      expect(parseProviderRequest(message({ method }))).toBeNull();
    }
  });

  it('accepts params being absent, since getAddress and getNetwork take nothing', () => {
    const request = accepted(`{"type":"${DAPP_PROVIDER_REQUEST_TYPE}","id":"r1","method":"getNetwork"}`);
    expect(request.method).toBe('getNetwork');
    expect(request.opts).toEqual({});
  });
});

// ── The payload ───────────────────────────────────────────────────────────────

describe('parseProviderRequest payload rules', () => {
  it('rejects an XDR that is not base64 rather than passing it down the line', () => {
    expect(parseProviderRequest(message({ method: 'signTransaction', params: { xdr: 'plain text' } }))).toBeNull();
    expect(parseProviderRequest(message({ method: 'signTransaction', params: { xdr: 'not<base64>' } }))).toBeNull();
  });

  it('rejects an XDR larger than a transaction can be', () => {
    const huge = 'A'.repeat(MAX_PROVIDER_XDR_CHARS + 4);
    expect(parseProviderRequest(message({ method: 'signTransaction', params: { xdr: huge } }))).toBeNull();
  });

  it('accepts the Freighter alias for an auth entry', () => {
    const request = accepted(message({ method: 'signAuthEntry', params: { authEntry: VALID_XDR } }));
    expect(request.xdr).toBe(VALID_XDR);
  });

  it('recognises a batch in either documented field', () => {
    const entries = [VALID_XDR, VALID_XDR];
    expect(accepted(message({ method: 'signAuthEntry', params: { authEntries: entries } })).wantsList).toBe(true);
    const viaXdrList = accepted(message({ method: 'signTransaction', params: { xdrList: entries } }));
    expect(viaXdrList.wantsList).toBe(true);
    expect(viaXdrList.xdr).toBe(entries[0]);
  });

  it('rejects a batch that is empty, too large, or has one unreadable entry', () => {
    expect(parseProviderRequest(message({ method: 'signAuthEntry', params: { authEntries: [] } }))).toBeNull();
    const eleven = Array.from({ length: 11 }, () => VALID_XDR);
    expect(parseProviderRequest(message({ method: 'signAuthEntry', params: { authEntries: eleven } }))).toBeNull();
    expect(
      parseProviderRequest(message({ method: 'signAuthEntry', params: { authEntries: [VALID_XDR, 'oops!!'] } }))
    ).toBeNull();
  });
});

// ── The options ───────────────────────────────────────────────────────────────

describe('the four options a call may carry', () => {
  it('keeps only what the interface publishes', () => {
    const request = accepted(
      message({
        method: 'signTransaction',
        params: {
          xdr: VALID_XDR,
          opts: {
            networkPassphrase: 'Test SDF Network ; September 2015',
            address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX',
            submit: false,
            submitUrl: 'https://horizon-testnet.stellar.org',
            somethingElse: 'ignored',
          },
        },
      })
    );

    expect(request.opts).toEqual({
      networkPassphrase: 'Test SDF Network ; September 2015',
      address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX',
      submit: false,
      submitUrl: 'https://horizon-testnet.stellar.org',
    });
  });

  it('reads them from opts, from options, or from the payload itself', () => {
    const asOptions = accepted(
      message({ method: 'signTransaction', params: { xdr: VALID_XDR, options: { submit: true } } })
    );
    expect(asOptions.opts.submit).toBe(true);

    const atTopLevel = accepted(
      message({ method: 'signTransaction', params: { xdr: VALID_XDR, networkPassphrase: 'some passphrase' } })
    );
    expect(atTopLevel.opts.networkPassphrase).toBe('some passphrase');
  });

  it('drops a value that is not the right type or is absurdly long', () => {
    const request = accepted(
      message({
        method: 'signTransaction',
        params: {
          xdr: VALID_XDR,
          opts: { submit: 'yes', networkPassphrase: 'x'.repeat(200), address: 42, submitUrl: 'y'.repeat(600) },
        },
      })
    );
    expect(request.opts).toEqual({});
  });
});

// ── The reply ─────────────────────────────────────────────────────────────────

describe('serializeProviderReply', () => {
  it('hands the page one call to the reply hook with one JSON string', () => {
    const script = serializeProviderReply('r1-1', { address: 'GABC' });

    expect(script.startsWith(`window.${DAPP_PROVIDER_REPLY_HOOK} &&`)).toBe(true);
    // The single argument is a JSON string the page's hook parses back.
    const embedded = script.match(/\("(.*)"\);/);
    expect(embedded).not.toBeNull();
    const unwrapped = JSON.parse((embedded as unknown as string[]) && (embedded as unknown as string[])[1].replace(/\\"/g, '"'));
    expect(unwrapped).toEqual({ id: 'r1-1', response: { address: 'GABC' } });
  });

  it('escapes a character that would end the script early inside a script tag', () => {
    const script = serializeProviderReply('r1-1', { error: { code: -1, message: '</script><b>' } });

    expect(script).not.toContain('</script>');
    expect(script).toContain('\\u003c');
  });

  it('escapes the line separators that break a JavaScript string literal', () => {
    const script = serializeProviderReply('r1-1', { error: { code: -1, message: 'a\u2028b\u2029c' } });

    expect(script).not.toContain('\u2028');
    expect(script).not.toContain('\u2029');
  });
});

describe('errorResponse', () => {
  it('writes the shape SEP-43 defines, with the code the caller chose', () => {
    expect(errorResponse(SEP43_ERROR.userRejected, 'The user rejected this request.')).toEqual({
      error: { code: -4, message: 'The user rejected this request.' },
    });
  });

  it('trims and caps the message rather than echoing a page back at itself', () => {
    const response = errorResponse(SEP43_ERROR.invalidRequest, `   ${'x'.repeat(900)}   `);

    expect((response.error as { message: string }).message.length).toBeLessThanOrEqual(500);
  });
});

describe('unsupportedResponse', () => {
  it('answers a method the interface names and Veil does not serve', () => {
    const response = unsupportedResponse('signMessage' as ProviderMethod);

    expect(response).not.toBeNull();
    expect((response as { error: { code: number } }).error.code).toBe(SEP43_ERROR.invalidRequest);
  });

  it('returns null for every method Veil does serve', () => {
    for (const method of ['getAddress', 'getNetwork', 'signTransaction', 'signAuthEntry'] as ProviderMethod[]) {
      expect(unsupportedResponse(method)).toBeNull();
    }
  });
});

// ── The injected script ───────────────────────────────────────────────────────

describe('dappProviderScript', () => {
  const origin = 'https://app.soroswap.finance';
  const script = dappProviderScript(origin);

  it('is valid JavaScript that finishes with the value the WebView wants', () => {
    // Evaluated for syntax only: `window` does not exist here, so the script
    // takes its early exit — which is itself the top-frame guard doing its job.
    expect(() => new Function(script)).not.toThrow();
    expect(script.trimEnd().endsWith('true;')).toBe(true);
  });

  it('installs under the name dApps already probe and under the wallet name', () => {
    expect(script).toContain(FREIGHTER_PROVIDER_GLOBAL);
    expect(script).toContain(VEIL_PROVIDER_GLOBAL);
    expect(script).toContain(DAPP_PROVIDER_REQUEST_TYPE);
    expect(script).toContain(DAPP_PROVIDER_REPLY_HOOK);
  });

  it('declines to install anywhere but the approved origin and frame', () => {
    expect(script).toContain(`window.location.origin !== ${JSON.stringify(origin)}`);
    expect(script).toContain('window.top !== window');
  });

  it('exposes the interface methods and nothing that could reach a key', () => {
    for (const method of [
      'getAddress',
      'getAddresses',
      'getNetwork',
      'signTransaction',
      'signAuthEntry',
      'signMessage',
      'isApproved',
      'request',
      'connect',
    ]) {
      expect(script).toContain(`${method}: function`);
    }
    expect(script).not.toMatch(/secret|seed|credentialId|privateKey|passkey/i);
  });

  it('dispatches the request names dApps ask for by string', () => {
    // `request` is Freighter's dispatcher. A page that says
    // `request({ method: 'getAddresses' })` must get addresses back, not the
    // connect gesture's answer.
    expect(script).toContain("['isApproved', 'getAddress', 'getAddresses', 'getNetwork']");
  });

  it('rejects an error answer instead of resolving it', () => {
    // A resolved `{ error }` looks like a successful call to a dApp that wrapped
    // the request in try/catch — which is all of them.
    expect(script).toContain('if (payload && payload.error) reject(payload);');
  });

  it('gives up on a request that is never answered, so a dApp does not hang', () => {
    expect(script).toContain('setTimeout');
  });

  it('installs once, so before-load and after-load injection do not double up', () => {
    expect(script).toContain('__veilDappProviderInstalled');
  });
});
