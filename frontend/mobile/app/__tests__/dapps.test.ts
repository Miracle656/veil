/**
 * Mobile half of dApp discovery parity (#813).
 *
 * The mobile screen must render the one shared allow-list
 * (`frontend/shared/dapps.ts`) — the same module the web wallet's `/dapps`
 * directory reads — with no local copy of the entries, and it must stay a
 * discovery screen: entries hand off to the system browser, never to an
 * embedded WebView.
 */

import * as fs from 'fs';
import * as path from 'path';

import { DAPP_DIRECTORY, isAllowedDappOrigin, normalizeDappOrigin } from '../../../shared/dapps';

const SCREEN = path.resolve(__dirname, '..', 'dapps.tsx');

describe('dApp discovery screen', () => {
  it('renders the shared allow-list rather than a local copy', () => {
    const source = fs.readFileSync(SCREEN, 'utf8');
    expect(source).toContain("from '../../shared/dapps'");
    expect(source).toMatch(/DAPP_DIRECTORY\s*\.\s*map/);
    // An `origin:` literal here would mean the list was forked — adding a
    // dApp must stay a single edit to frontend/shared/dapps.ts.
    expect(source).not.toMatch(/origin:\s*['"]https:\/\//);
  });

  it('never embeds a browser — entries hand off outside the wallet', () => {
    const source = fs.readFileSync(SCREEN, 'utf8');
    expect(source).not.toMatch(/react-native-webview|<webview|<iframe/i);
  });
});

describe('the shared allow-list', () => {
  it('holds only canonical, allow-listed HTTPS origins', () => {
    expect(DAPP_DIRECTORY.length).toBeGreaterThan(0);

    const ids = DAPP_DIRECTORY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const entry of DAPP_DIRECTORY) {
      expect(normalizeDappOrigin(entry.origin)).toBe(entry.origin);
      expect(isAllowedDappOrigin(entry.origin)).toBe(true);
      expect(entry.name.trim()).not.toBe('');
      expect(entry.description.trim()).not.toBe('');
    }
  });

  it('refuses http, unknown and look-alike origins', () => {
    expect(isAllowedDappOrigin('http://stellarx.com')).toBe(false);
    expect(isAllowedDappOrigin('https://evil.example')).toBe(false);
    expect(isAllowedDappOrigin('https://stellarx.com.evil.example')).toBe(false);
    expect(isAllowedDappOrigin('javascript:alert(1)')).toBe(false);
  });
});
