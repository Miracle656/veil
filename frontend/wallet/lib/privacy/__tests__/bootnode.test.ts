import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveBootnodeWithFallback,
  getBootnodeStatus,
  invalidateBootnodeCache,
} from '../bootnode';

describe('privacy bootnode fallback resolver', () => {
  const fallback = 'https://bootnode.dev-nethermind.xyz';
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = vi.fn();
    invalidateBootnodeCache(); // Clear cache before each test
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back immediately and warns if primary is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    const url = await resolveBootnodeWithFallback(null, fallback, mockFetch);
    
    expect(url).toBe(fallback);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No SPP bootnode configured')
    );
    expect(getBootnodeStatus()).toEqual({
      url: fallback,
      usingFallback: true,
      reason: expect.stringContaining('NEXT_PUBLIC_SPP_BOOTNODE_URL is unset'),
    });
  });

  it('probes the primary URL and returns it if healthy', async () => {
    const primary = 'https://bootnode.veil.app';
    mockFetch.mockResolvedValueOnce({ ok: true });

    const url = await resolveBootnodeWithFallback(primary, fallback, mockFetch);

    expect(url).toBe(primary);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://bootnode.veil.app/healthz',
      expect.objectContaining({ method: 'HEAD' })
    );
    expect(getBootnodeStatus()).toEqual({
      url: primary,
      usingFallback: false,
      reason: null,
    });
  });

  it('falls back and warns if the primary is unreachable', async () => {
    const primary = 'https://bootnode.veil.app';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    mockFetch.mockRejectedValueOnce(new Error('Network offline'));

    const url = await resolveBootnodeWithFallback(primary, fallback, mockFetch);

    expect(url).toBe(fallback);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Primary SPP bootnode (https://bootnode.veil.app) is unreachable')
    );
    expect(getBootnodeStatus()).toEqual({
      url: fallback,
      usingFallback: true,
      reason: expect.stringContaining('Primary SPP bootnode'),
    });
  });

  it('caches the resolved URL', async () => {
    const primary = 'https://bootnode.veil.app';
    mockFetch.mockResolvedValueOnce({ ok: true });

    const firstUrl = await resolveBootnodeWithFallback(primary, fallback, mockFetch);
    const secondUrl = await resolveBootnodeWithFallback(primary, fallback, mockFetch);

    expect(firstUrl).toBe(primary);
    expect(secondUrl).toBe(primary);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Second call should hit the cache
  });
});
