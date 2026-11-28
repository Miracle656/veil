/**
 * #1200 — a navigation target must be a screen that exists.
 *
 * Airtime's Continue pushed `/verify` for months while nothing lived at that
 * path: an unverified person filled in a phone number and an amount, pressed
 * continue, and the navigator matched nothing. They had done nothing wrong and
 * the KYC step they needed was unreachable — the worst possible moment to meet
 * a dead route, at the first time they tried to spend.
 *
 * Nothing in the app or in CI noticed, because Expo builds its route tree from
 * the filesystem at runtime and a `router.push` to a missing path is an ordinary
 * string. So the check is here instead: read every route the folder actually
 * provides, read every path the screens actually navigate to, and fail if one
 * points at nothing.
 *
 * If this suite goes red, do not add a route to satisfy it — either the screen
 * is missing, or the call is aiming at the wrong path.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const APP_DIR = resolve(__dirname, '..', 'app');

/** Route segments expo-router does not turn into paths. */
function isRouteFile(name: string): boolean {
  return (
    /\.tsx?$/.test(name) &&
    !name.startsWith('_') &&
    !name.startsWith('+') &&
    !name.endsWith('.d.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.test.tsx')
  );
}

/**
 * Every route the folder provides, in the shape `router.push` is given.
 *
 * `(tabs)/dashboard.tsx` is `/dashboard` — a parenthesised segment groups
 * screens for a nested navigator without appearing in the path. `index.tsx` is
 * its directory, so `app/index.tsx` is `/`. `[id].tsx` is a dynamic segment and
 * is kept as a pattern that any single segment matches.
 */
function routePaths(dir: string, prefix: string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...routePaths(full, [...prefix, entry]));
      continue;
    }
    if (!isRouteFile(entry)) continue;

    const segments = [...prefix, entry.replace(/\.tsx?$/, '')];
    const path = segments
      // Groups are layout-only.
      .filter((s) => !/^\(.*\)$/.test(s))
      // `index` *is* its directory rather than a segment under it.
      .filter((s) => s !== 'index')
      .join('/');
    found.push(`/${path}`);
  }
  return found;
}

/** Strip a query string, and normalise a repeated slash, for matching. */
function targetPath(target: string): string {
  return target.split('?')[0].split('#')[0];
}

/** Whether a navigation target is served by one of the app's routes. */
function isRoutedBySomeScreen(routes: string[], target: string): boolean {
  const path = targetPath(target);
  if (path === '/') return routes.includes('/');
  const segments = path.split('/').filter(Boolean);
  return routes.some((route) => {
    const routeSegments = route.split('/').filter(Boolean);
    if (routeSegments.length !== segments.length) return false;
    return routeSegments.every(
      (segment, i) => segment === segments[i] || /^\[[^\]]+\]$/.test(segment),
    );
  });
}

/**
 * The call sites: the object form (`{ pathname: '/verify' }`, which is how
 * airtime pushes) and the plain-string form (`router.replace('/lock')`), plus
 * the `returnTo` params the rails hand to `/verify` so it can put them back.
 *
 * Template literals are skipped — an interpolated path cannot be checked
 * against the folder without running the app.
 */
const NAVIGATION_PATTERNS = [
  /pathname:\s*['"]([^'"]+)['"]/g,
  /router\.(?:push|replace)\(\s*['"]([^'"]+)['"]/g,
  /returnTo:\s*['"]([^'"]+)['"]/g,
];

function navigationTargets(dir: string): { file: string; target: string }[] {
  const targets: { file: string; target: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      targets.push(...navigationTargets(full));
      continue;
    }
    if (!isRouteFile(entry)) continue;
    const source = readFileSync(full, 'utf8');
    for (const pattern of NAVIGATION_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const target = match[1];
        if (target.includes('${') || !target.startsWith('/')) continue;
        targets.push({ file: entry, target });
      }
    }
  }
  return targets;
}

describe('app routes', () => {
  const routes = routePaths(APP_DIR, []);

  it('serves /verify, the one-time NIN check every naira rail sends people to', () => {
    // The failure this guards: airtime pushed `/verify` and nothing answered,
    // so an unverified person pressing Continue was sent to a route with no
    // screen behind it and could never reach KYC.
    expect(routes).toContain('/verify');
  });

  it('points every navigation target in the app at a screen that exists', () => {
    const dead = navigationTargets(APP_DIR).filter(
      ({ target }) => !isRoutedBySomeScreen(routes, target),
    );
    expect(dead).toEqual([]);
  });

  it('keeps the airtime flow able to reach verification and come back', () => {
    const airtime = readFileSync(join(APP_DIR, 'airtime.tsx'), 'utf8');
    expect(airtime).toMatch(/pathname:\s*['"]\/verify['"]/);
    expect(airtime).toMatch(/returnTo:\s*['"]\/airtime['"]/);
    expect(isRoutedBySomeScreen(routes, '/verify')).toBe(true);
    expect(isRoutedBySomeScreen(routes, '/airtime')).toBe(true);
  });
});
