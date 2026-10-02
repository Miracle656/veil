import { checkReceiveReadiness, readinessMessage, usdcIssuerFor } from '../receiveReadiness';

const G = 'GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH';
const TESTNET_USDC = usdcIssuerFor('testnet');

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('checkReceiveReadiness', () => {
  it('reports ready when the account holds a USDC trustline', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        balances: [
          { asset_type: 'native', balance: '1.5000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: TESTNET_USDC,
            balance: '12.0000000',
          },
        ],
      }),
    );
    const r = await checkReceiveReadiness(G, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ state: 'ready', address: G, balance: '12.0000000' });
  });

  it('does not accept a USDC trustline from the wrong issuer', async () => {
    // Anyone can issue an asset called USDC. Matching on the code alone is how
    // a wallet ends up telling someone a fake asset arrived.
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        balances: [
          { asset_type: 'native', balance: '2.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            balance: '999.0000000',
          },
        ],
      }),
    );
    const r = await checkReceiveReadiness(G, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.state).toBe('needs-trustline');
  });

  it('reports needs-trustline for a funded account with no USDC line', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { balances: [{ asset_type: 'native', balance: '3.0000000' }] }));
    const r = await checkReceiveReadiness(G, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ state: 'needs-trustline', address: G, xlm: '3.0000000' });
  });

  it('treats a 404 as a fact about the account, not a failure', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(404, { title: 'Resource Missing' }));
    const r = await checkReceiveReadiness(G, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ state: 'needs-account', address: G });
  });

  it('reports unknown when Horizon is unreachable, never "not ready"', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('Network request failed'));
    const r = await checkReceiveReadiness(G, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.state).toBe('unknown');
    // The distinction is the whole point: an unreachable network must never be
    // rendered as "this address cannot receive".
    expect(r.state).not.toBe('needs-account');
  });

  it('reports unknown on a server error rather than guessing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(503, {}));
    const r = await checkReceiveReadiness(G, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ state: 'unknown' });
  });

  it('reports unknown when the body cannot be read', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ notBalances: true }),
    } as unknown as Response);
    const r = await checkReceiveReadiness(G, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.state).toBe('unknown');
  });
});

describe('readinessMessage', () => {
  it('never says "no assets yet" for an unreachable network', () => {
    const msg = readinessMessage({ state: 'unknown', address: G, reason: 'timed out' });
    expect(msg).toMatch(/could not check/i);
    expect(msg).toContain('timed out');
  });

  it('tells someone waiting on a payout what is actually wrong', () => {
    expect(readinessMessage({ state: 'needs-account', address: G })).toMatch(/not active/i);
    expect(readinessMessage({ state: 'needs-trustline', address: G, xlm: '0' })).toMatch(/trustline/i);
    expect(readinessMessage({ state: 'ready', address: G, balance: '0' })).toMatch(/ready/i);
  });
});
