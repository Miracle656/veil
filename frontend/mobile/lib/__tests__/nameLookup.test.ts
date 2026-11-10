import { isLookupCandidate, lookupName } from '../nameLookup';

const ACCOUNT = 'CC7HCLSEUZNOPL7R4SYJYXFIVUBEOP3XOSJ2LIUXSZBQ36BYDOEILWIM';

describe('lookupName', () => {
  it('reports the account a name points at', async () => {
    const resolve = jest.fn().mockResolvedValue({ account_id: ACCOUNT });

    await expect(lookupName('  jack*useveilapp.xyz ', resolve)).resolves.toEqual({
      status: 'resolved',
      name: 'jack*useveilapp.xyz',
      accountId: ACCOUNT,
    });
    expect(resolve).toHaveBeenCalledWith('jack*useveilapp.xyz');
  });

  it('tells an unregistered name apart from a name server that did not answer', async () => {
    // Different facts, different advice: one means "check the spelling", the
    // other means "try again".
    await expect(
      lookupName('nobody*useveilapp.xyz', jest.fn().mockRejectedValue(new Error('address not found'))),
    ).resolves.toEqual({ status: 'not-found', name: 'nobody*useveilapp.xyz' });

    await expect(
      lookupName('jack*useveilapp.xyz', jest.fn().mockRejectedValue(new Error('federation server unreachable'))),
    ).resolves.toEqual({ status: 'unreachable', name: 'jack*useveilapp.xyz' });
  });

  it('does not look up an address or a half-typed name', async () => {
    const resolve = jest.fn();

    await expect(lookupName(ACCOUNT, resolve)).resolves.toEqual({ status: 'idle' });
    await expect(lookupName('jack*', resolve)).resolves.toEqual({ status: 'idle' });
    await expect(lookupName('', resolve)).resolves.toEqual({ status: 'idle' });
    expect(resolve).not.toHaveBeenCalled();
    expect(isLookupCandidate(ACCOUNT)).toBe(false);
    expect(isLookupCandidate('jack*useveilapp.xyz')).toBe(true);
  });
});
