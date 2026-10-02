import {
  buildWcError,
  buildWcResult,
  extractRequestXdr,
  getChainId,
  getRequestId,
  isUserRejection,
  isWalletConnectUri,
  normalizeWalletConnectUri,
  parseWalletConnectRequest,
  parseWalletConnectSession,
} from '../walletConnectHelpers';

describe('normalizeWalletConnectUri', () => {
  const uri = 'wc:7f6e5d@2?relay-protocol=irn&symKey=abc123';

  it('accepts a plain pairing URI', () => {
    expect(normalizeWalletConnectUri(uri)).toBe(uri);
  });

  it('trims whitespace introduced by clipboards and scanners', () => {
    expect(normalizeWalletConnectUri(`  ${uri}\n`)).toBe(uri);
  });

  it('accepts an uppercase scheme', () => {
    expect(normalizeWalletConnectUri('WC:abc@2')).toBe('WC:abc@2');
  });

  it('extracts a URI wrapped in a deep link', () => {
    expect(normalizeWalletConnectUri(`https://example.com/wc?uri=${encodeURIComponent(uri)}`)).toBe(
      uri
    );
  });

  it('rejects a payload with no wc: URI in it', () => {
    expect(() => normalizeWalletConnectUri('https://example.com')).toThrow(
      /must start with "wc:"/
    );
    expect(() => normalizeWalletConnectUri('')).toThrow();
  });

  it('reports validity without throwing', () => {
    expect(isWalletConnectUri(uri)).toBe(true);
    expect(isWalletConnectUri('not-a-uri')).toBe(false);
  });
});

describe('getChainId', () => {
  it('maps the network name to a CAIP-2 chain id', () => {
    expect(getChainId('testnet')).toBe('stellar:testnet');
    expect(getChainId('mainnet')).toBe('stellar:pubnet');
  });
});

describe('parseWalletConnectSession', () => {
  it('reads the account and chain id out of the namespaces', () => {
    const session = parseWalletConnectSession(
      {
        topic: 'topic-1',
        namespaces: {
          stellar: { accounts: ['stellar:pubnet:CABC'] },
        },
        peer: { metadata: { name: 'Test dApp' } },
      },
      'stellar:testnet'
    );

    expect(session).toEqual({
      topic: 'topic-1',
      chainId: 'stellar:pubnet',
      account: 'stellar:pubnet:CABC',
      peer: { name: 'Test dApp' },
    });
  });

  it('falls back to the active chain id when no account is present', () => {
    const session = parseWalletConnectSession({ topic: 'topic-2' }, 'stellar:testnet');
    expect(session.chainId).toBe('stellar:testnet');
    expect(session.account).toBe('');
    expect(session.peer).toBeNull();
  });
});

describe('extractRequestXdr', () => {
  it('reads the XDR from every shape dApps send', () => {
    expect(extractRequestXdr('AAAA')).toBe('AAAA');
    expect(extractRequestXdr(['AAAA'])).toBe('AAAA');
    expect(extractRequestXdr([{ xdr: 'AAAA' }])).toBe('AAAA');
    expect(extractRequestXdr([{ transaction: 'AAAA' }])).toBe('AAAA');
    expect(extractRequestXdr({ xdr: 'AAAA' })).toBe('AAAA');
    expect(extractRequestXdr({ transaction: 'AAAA' })).toBe('AAAA');
    expect(extractRequestXdr({ tx: 'AAAA' })).toBe('AAAA');
  });

  it('returns null when there is no XDR to find', () => {
    expect(extractRequestXdr(undefined)).toBeNull();
    expect(extractRequestXdr({})).toBeNull();
    expect(extractRequestXdr([{ nope: 1 }])).toBeNull();
    expect(extractRequestXdr({ xdr: 42 })).toBeNull();
  });
});

describe('parseWalletConnectRequest', () => {
  it('flattens a session_request event', () => {
    const request = parseWalletConnectRequest({
      id: 17,
      topic: 'topic-1',
      params: {
        chainId: 'stellar:testnet',
        request: { method: 'stellar_signXDR', params: { xdr: 'AAAA' } },
      },
    });

    expect(request).toMatchObject({
      id: 17,
      topic: 'topic-1',
      method: 'stellar_signXDR',
      chainId: 'stellar:testnet',
      params: { xdr: 'AAAA' },
    });
  });

  it('falls back to the nested id and tolerates missing fields', () => {
    expect(getRequestId({ params: { request: { id: 9 } } })).toBe(9);
    expect(parseWalletConnectRequest({})).toMatchObject({
      id: 0,
      topic: '',
      method: '',
      chainId: null,
    });
  });
});

describe('JSON-RPC envelopes', () => {
  it('builds result and error responses', () => {
    expect(buildWcResult(1, { signedXDR: 'AAAA' })).toEqual({
      id: 1,
      jsonrpc: '2.0',
      result: { signedXDR: 'AAAA' },
    });
    expect(buildWcError(1, 4001, 'User rejected')).toEqual({
      id: 1,
      jsonrpc: '2.0',
      error: { code: 4001, message: 'User rejected' },
    });
  });
});

describe('isUserRejection', () => {
  it('recognises a decline rather than a failure', () => {
    expect(isUserRejection(new Error('USER_REJECTED'))).toBe(true);
    expect(isUserRejection(new Error('NotAllowedError: the request was denied'))).toBe(true);
    expect(isUserRejection(new Error('The operation was cancelled.'))).toBe(true);
  });

  it('treats genuine failures as failures', () => {
    expect(isUserRejection(new Error('Simulation failed: trap'))).toBe(false);
    expect(isUserRejection('network unreachable')).toBe(false);
  });
});
