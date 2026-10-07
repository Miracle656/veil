import {
  getBootnodeStatus,
  invalidateBootnodeCache,
  resolveBootnodeWithFallback,
} from '../bootnode';

describe('mobile privacy bootnode fallback', () => {
  const primary = 'https://bootnode.veil.app';
  const fallback = 'https://bootnode.dev-nethermind.xyz';

  beforeEach(() => {
    invalidateBootnodeCache();
    jest.restoreAllMocks();
  });

  it('uses the primary archive while its health endpoint is available', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });

    await expect(resolveBootnodeWithFallback(primary, fallback, fetchImpl)).resolves.toBe(primary);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${primary}/healthz`,
      expect.objectContaining({ method: 'HEAD' }),
    );
    expect(getBootnodeStatus()).toMatchObject({ usingFallback: false, url: primary });
  });

  it('falls back to Nethermind and exposes a user-readable warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));

    await expect(resolveBootnodeWithFallback(primary, fallback, fetchImpl)).resolves.toBe(fallback);
    expect(getBootnodeStatus()).toMatchObject({
      usingFallback: true,
      url: fallback,
      reason: expect.stringContaining('Using Nethermind'),
    });
    expect(warn).toHaveBeenCalled();
  });
});
