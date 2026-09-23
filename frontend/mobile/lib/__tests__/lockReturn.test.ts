import { clearLockReturn, rememberLockReturn, takeLockReturn } from '../lockReturn';

describe('lockReturn', () => {
  beforeEach(() => clearLockReturn());

  it('returns nothing when the app never locked', () => {
    expect(takeLockReturn()).toBeNull();
  });

  it('gives back the route the lock covered', () => {
    rememberLockReturn('/swap');
    expect(takeLockReturn()).toBe('/swap');
  });

  it('keeps route params, so a token screen comes back to its own token', () => {
    rememberLockReturn('/token/USDC:GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH');
    expect(takeLockReturn()).toBe(
      '/token/USDC:GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH',
    );
  });

  it('forgets the route once taken, so a later cold start is not redirected', () => {
    rememberLockReturn('/cash-out');
    takeLockReturn();
    expect(takeLockReturn()).toBeNull();
  });

  it('refuses entry routes — a lock during startup must not pin the splash', () => {
    rememberLockReturn('/');
    expect(takeLockReturn()).toBeNull();
    rememberLockReturn('/index');
    expect(takeLockReturn()).toBeNull();
    rememberLockReturn('/onboarding/create');
    expect(takeLockReturn()).toBeNull();
  });

  it('refuses the lock screen itself, which would unlock into a lock', () => {
    rememberLockReturn('/lock');
    expect(takeLockReturn()).toBeNull();
  });

  it('ignores an absent path instead of storing it', () => {
    rememberLockReturn('/swap');
    rememberLockReturn(null);
    rememberLockReturn(undefined);
    expect(takeLockReturn()).toBe('/swap');
  });

  it('keeps the most recent lock, not the first', () => {
    rememberLockReturn('/swap');
    rememberLockReturn('/cash-out');
    expect(takeLockReturn()).toBe('/cash-out');
  });

  it('clears without navigating, for sign-out', () => {
    rememberLockReturn('/swap');
    clearLockReturn();
    expect(takeLockReturn()).toBeNull();
  });
});
