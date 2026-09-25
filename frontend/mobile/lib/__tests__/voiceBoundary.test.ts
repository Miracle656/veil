import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  VOICE_AUTHORISATION,
  VOICE_BOUNDARY_DOC_URL,
  VOICE_DOES,
  VOICE_NEVER_DOES,
  VOICE_PLATFORM_CONSTRAINTS,
  type VoiceFact,
} from '../voice/boundary';

/**
 * The voice surface's boundary is a written record, not a convention (#846).
 *
 * These assertions are what keep it a written record. They cover the three ways
 * it can rot:
 *
 *   - the in-app page loses a claim the boundary depends on,
 *   - a constraint loses its verification date, so nobody can tell whether it
 *     is still true,
 *   - someone edits the docs page and the app page drifts apart.
 *
 * The docs page is a separate app and cannot import this module, so its prose
 * is checked here, by reading it, rather than trusted.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const DOCS_PAGE = resolve(REPO_ROOT, 'frontend/docs/pages/voice.mdx');
const DOCS_META = resolve(REPO_ROOT, 'frontend/docs/pages/_meta.ts');
const DOCS_SITEMAP = resolve(REPO_ROOT, 'frontend/docs/public/sitemap.xml');
const SETTINGS_SCREEN = resolve(REPO_ROOT, 'frontend/mobile/app/(tabs)/settings.tsx');
const VOICE_SCREEN = resolve(REPO_ROOT, 'frontend/mobile/app/settings/voice.tsx');

const ALL_FACTS: readonly VoiceFact[] = [
  ...VOICE_DOES,
  ...VOICE_NEVER_DOES,
  ...VOICE_PLATFORM_CONSTRAINTS,
];

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the boundary facts', () => {
  it('has the in-app page pointing at something to read', () => {
    expect(VOICE_DOES.length).toBeGreaterThan(0);
    expect(VOICE_NEVER_DOES.length).toBeGreaterThan(0);
  });

  it('gives every fact a stable, unique key', () => {
    const keys = ALL_FACTS.map((fact) => fact.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every fact a claim and a detail', () => {
    for (const fact of ALL_FACTS) {
      expect(fact.claim.trim().length).toBeGreaterThan(0);
      expect(fact.detail.trim().length).toBeGreaterThan(0);
    }
  });

  it('states plainly that voice never signs', () => {
    const claims = VOICE_NEVER_DOES.map((fact) => fact.claim).join(' \n ');
    expect(claims).toMatch(/never signs/i);
  });

  it('names the passkey ceremony as what does authorise a payment', () => {
    const steps = VOICE_AUTHORISATION.join(' \n ');
    expect(steps).toMatch(/passkey/i);
    expect(steps).toMatch(/__check_auth/);
    expect(steps).toMatch(/device/i);
  });

  it('records the organization-enrolment and regulated-field constraints', () => {
    const details = VOICE_PLATFORM_CONSTRAINTS.map((fact) => fact.detail).join(' \n ');
    expect(details).toMatch(/organization/i);
    expect(details).toMatch(/highly regulated/i);
  });

  it('dates every platform constraint it records', () => {
    // A platform rule without the date it was checked is worse than no rule:
    // it reads as current forever.
    const dated = /\(verified \d{4}-\d{2}-\d{2}\)/;
    for (const fact of VOICE_PLATFORM_CONSTRAINTS) {
      expect(fact.detail).toMatch(dated);
    }
  });

  it('makes no claim about what a future version will support', () => {
    const text = [...ALL_FACTS.map((fact) => `${fact.claim} ${fact.detail}`), ...VOICE_AUTHORISATION].join(
      ' \n ',
    );
    expect(text).not.toMatch(/\bwill\b|\bfuture\b|\bsoon\b|\bplanned\b|\broadmap\b/i);
  });
});

describe('the in-app page', () => {
  it('is reachable from Settings', () => {
    const settings = read(SETTINGS_SCREEN);
    expect(settings).toContain("router.push('/settings/voice')");
  });

  it('exists, and is built from the boundary facts rather than its own copy', () => {
    expect(existsSync(VOICE_SCREEN)).toBe(true);
    const screen = read(VOICE_SCREEN);
    for (const symbol of [
      'VOICE_DOES',
      'VOICE_NEVER_DOES',
      'VOICE_AUTHORISATION',
      'VOICE_PLATFORM_CONSTRAINTS',
    ]) {
      expect(screen).toContain(symbol);
    }
  });

  it('links to the full page', () => {
    expect(read(VOICE_SCREEN)).toContain('VOICE_BOUNDARY_DOC_URL');
  });
});

describe('the docs page', () => {
  it('exists and is a page, not only a link in the app', () => {
    expect(existsSync(DOCS_PAGE)).toBe(true);
  });

  it('states plainly that voice never signs', () => {
    expect(read(DOCS_PAGE)).toMatch(/voice never signs/i);
  });

  it('records the enrolment and regulated-field constraints, dated', () => {
    const page = read(DOCS_PAGE);
    expect(page).toMatch(/organization/i);
    expect(page).toMatch(/highly regulated/i);
    expect(page).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('explains why voice alone cannot authorise a payment', () => {
    const page = read(DOCS_PAGE);
    expect(page).toMatch(/passkey/i);
    expect(page).toMatch(/__check_auth/);
  });

  it('is listed in the docs navigation and the sitemap', () => {
    expect(read(DOCS_META)).toMatch(/voice:/);
    expect(read(DOCS_SITEMAP)).toContain(`${VOICE_BOUNDARY_DOC_URL}<`);
  });

  it('points at an https page', () => {
    expect(VOICE_BOUNDARY_DOC_URL.startsWith('https://')).toBe(true);
  });
});
