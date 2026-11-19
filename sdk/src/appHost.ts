/**
 * Host the Veil app is served from, and the only host a claim link may be built
 * against. It must stay equal to `APP_HOST` in `frontend/mobile/lib/deepLinks.ts`
 * (one of `ASSOCIATED_DOMAINS`); `frontend/mobile/lib/__tests__/claimLinkHost.test.ts`
 * fails if the two drift.
 */
export const APP_HOST = 'app.useveilapp.xyz';
