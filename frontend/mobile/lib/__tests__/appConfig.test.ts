import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import config from '../../app.config';
import {
  ASSOCIATED_DOMAINS,
  DEEP_LINK_SCHEME,
  FALLBACK_ROUTE,
  SEP7_SCHEME,
  resolveDeepLink,
} from '../deepLinks';

/**
 * `app.config.ts` cannot import from `lib/deepLinks.ts` — Expo transpiles the
 * config file alone and then requires it, so a relative TypeScript import fails
 * to resolve at config-load time. These tests are what keeps the duplicated
 * constants honest: a scheme registered natively but unhandled at runtime (or
 * the reverse) is a deep link that silently does nothing.
 */

const schemes = Array.isArray(config.scheme)
  ? config.scheme
  : config.scheme
    ? [config.scheme]
    : [];

const appLinkFilter = (config.android?.intentFilters ?? []).find((filter) => filter.autoVerify);

// Expo types `data` as one entry or an array of them; normalise to an array.
const rawData = appLinkFilter?.data;
const appLinkData = rawData ? (Array.isArray(rawData) ? rawData : [rawData]) : [];

describe('app.config.ts — schemes', () => {
  it('registers the scheme the resolver handles', () => {
    expect(schemes).toContain(DEEP_LINK_SCHEME);
  });

  it('registers the SEP-7 scheme', () => {
    expect(schemes).toContain(SEP7_SCHEME);
  });

  it('registers nothing the resolver would ignore', () => {
    for (const scheme of schemes) {
      expect(resolveDeepLink(`${scheme}:pay?destination=G`)).not.toBe(FALLBACK_ROUTE);
    }
  });
});

describe('app.config.ts — associated domains', () => {
  it('declares an applinks entry per associated domain', () => {
    for (const domain of ASSOCIATED_DOMAINS) {
      expect(config.ios?.associatedDomains).toContain(`applinks:${domain}`);
    }
  });

  // Separate from applinks: iOS will not offer a passkey for a domain unless it
  // is claimed as a webcredentials service, so losing these entries breaks
  // passkey registration while leaving universal links working — a failure that
  // would otherwise only show up on a device.
  it('declares a webcredentials entry per associated domain', () => {
    for (const domain of ASSOCIATED_DOMAINS) {
      expect(config.ios?.associatedDomains).toContain(`webcredentials:${domain}`);
    }
  });

  it('claims nothing beyond those two services', () => {
    expect(config.ios?.associatedDomains).toHaveLength(ASSOCIATED_DOMAINS.length * 2);
  });

  it('verifies the same hosts on Android', () => {
    const hosts = appLinkData.map((entry) => entry.host);
    expect(new Set(hosts)).toEqual(new Set(ASSOCIATED_DOMAINS));
  });

  it('claims https links only, and marks them for verification', () => {
    expect(appLinkFilter?.autoVerify).toBe(true);
    for (const entry of appLinkData) {
      expect(entry.scheme).toBe('https');
    }
  });

  it('requires BROWSABLE so links from a browser reach the app', () => {
    expect(appLinkFilter?.category).toContain('BROWSABLE');
  });
});

describe('app.config.ts — claimed paths', () => {
  it('claims only paths the resolver routes', () => {
    // Collected rather than asserted in the loop so a failure names every
    // offending URL at once instead of stopping at the first.
    const claimedButNotRouted = appLinkData
      .map((entry) => `https://${entry.host}${entry.pathPrefix}`)
      .filter((url) => resolveDeepLink(url) === FALLBACK_ROUTE);

    expect(claimedButNotRouted).toEqual([]);
  });

  it('claims the payment-request path, which is the point of the exercise', () => {
    const prefixes = appLinkData.map((entry) => entry.pathPrefix);
    expect(prefixes).toContain('/pay');
  });
});

describe('app.config.ts — identifiers', () => {
  it('uses the same identifier on both platforms', () => {
    expect(config.ios?.bundleIdentifier).toBe(config.android?.package);
  });

  it('sets an identifier at all, without which neither link type can be claimed', () => {
    expect(config.ios?.bundleIdentifier).toBeTruthy();
  });
});

/**
 * The entitlement and the server-side file are two halves of one claim, and
 * either half alone silently does nothing.
 *
 * `associatedDomains` above is what the *app* asks for. Apple only grants it if
 * the domain serves a matching `.well-known/apple-app-site-association`, and
 * the two are declared in different repositories' worth of code with nothing
 * connecting them. The failure mode is quiet: passkey registration just falls
 * back to a non-shared credential, and the app appears to work.
 */
describe('apple-app-site-association agrees with the entitlement', () => {
    const aasa = JSON.parse(
        readFileSync(
            resolve(__dirname, '../../../wallet/public/.well-known/apple-app-site-association'),
            'utf8',
        ),
    ) as {
        applinks?: { details?: Array<{ appIDs?: string[] }> };
        webcredentials?: { apps?: string[] };
    };

    it('serves a webcredentials block, which is what actually enables passkeys', () => {
        // Claiming `webcredentials:<domain>` in the app while the domain serves
        // only `applinks` is the exact gap this test exists to catch: universal
        // links work, passkeys do not, and nothing reports an error.
        expect(aasa.webcredentials?.apps ?? []).not.toHaveLength(0);
    });

    it('names the same app ID for webcredentials as for applinks', () => {
        const appLinkIds = aasa.applinks?.details?.[0]?.appIDs ?? [];
        expect(aasa.webcredentials?.apps).toEqual(appLinkIds);
    });

    it('uses the bundle identifier the app config declares', () => {
        const bundleId = config.ios?.bundleIdentifier;
        expect(bundleId).toBeTruthy();
        for (const appId of aasa.webcredentials?.apps ?? []) {
            // appIDs are "<TEAM_ID>.<bundle identifier>".
            expect(appId.endsWith(`.${bundleId}`)).toBe(true);
        }
    });
});
