import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import config from '../../app.config';
import { APP_HOST, ASSOCIATED_DOMAINS, resolveDeepLink } from '../deepLinks';
import { buildClaimLink } from '../escrow';

const BALANCE_ID = '00000000da0d57847d4c1c4b3e4e6b0b6a1d3c1d8f3a2e1b0c9d8e7f6a5b4c3d2e1f';

const UNCLAIMED_HOST = ['app', 'veil', 'xyz'].join('.');

describe('claim link host', () => {
  it('builds claim links against an associated domain', () => {
    const host = new URL(buildClaimLink(BALANCE_ID)).host;
    expect(ASSOCIATED_DOMAINS as readonly string[]).toContain(host);
    expect(host).toBe(APP_HOST);
  });

  it('refuses to build a link against an unclaimed host', () => {
    const host = new URL(buildClaimLink(BALANCE_ID)).host;
    expect(ASSOCIATED_DOMAINS as readonly string[]).toContain(host);
    expect(host).not.toBe(UNCLAIMED_HOST);
  });

  it('matches the host the sdk builds claim links with', () => {
    const src = readFileSync(resolve(__dirname, '../../../../sdk/src/appHost.ts'), 'utf8');
    expect(/APP_HOST\s*=\s*'([^']+)'/.exec(src)?.[1]).toBe(APP_HOST);
  });

  it('matches the host app.config.ts claims', () => {
    const domains = (config.ios?.associatedDomains ?? []).map((d) => d.split(':')[1]);
    expect(domains).toContain(APP_HOST);
  });

  it('opens the app for a claim url', () => {
    expect(resolveDeepLink(buildClaimLink(BALANCE_ID))).toBe(`/claim?id=${BALANCE_ID}`);
  });

  it('does not open the app for a claim url on a foreign host', () => {
    expect(resolveDeepLink(`https://${UNCLAIMED_HOST}/claim/${BALANCE_ID}`)).toBe('/');
  });
});
