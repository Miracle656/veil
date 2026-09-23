/**
 * Is this the latest build, and where is the newer one?
 *
 * Testers asked for both. There was no answer before, because builds were only
 * downloadable from a GitHub Actions run, which needs a GitHub login and expires
 * after a week. The APK workflow now publishes every community build as a
 * GitHub Release tagged `mobile-v<versionCode>`, which anyone can download, and
 * this reads that list.
 *
 * The comparison is on Android's versionCode — a whole number that only ever
 * goes up — not on the marketing version (0.1.0), which stays put across builds.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const RELEASES_URL = 'https://api.github.com/repos/Miracle656/veil/releases?per_page=20';
const TAG_PREFIX = 'mobile-v';
const CACHE_KEY = 'veil_update_check';
/** GitHub allows 60 unauthenticated calls an hour per IP; this is one screen. */
const CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export type LatestBuild = {
  versionCode: number;
  /** Marketing version from the release name, when it carries one. */
  versionName: string | null;
  /** Where to download the APK. */
  url: string;
  publishedAt: string | null;
};

export type UpdateCheck =
  | { state: 'current'; installed: number; latest: LatestBuild }
  | { state: 'update'; installed: number | null; latest: LatestBuild }
  /** No answer: offline, rate limited, or a build that knows no version code. */
  | { state: 'unknown'; installed: number | null; reason: string };

/** `mobile-v7` → 7. Anything else → null, so other tags are ignored. */
export function versionCodeFromTag(tag: string): number | null {
  if (!tag.startsWith(TAG_PREFIX)) return null;
  const code = Number(tag.slice(TAG_PREFIX.length));
  return Number.isInteger(code) && code > 0 ? code : null;
}

type ReleaseJson = {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  assets?: unknown;
};

/**
 * The newest mobile release in a GitHub releases payload.
 *
 * Prefers a direct link to the APK asset, so the button downloads the file
 * rather than opening a page. Drafts are skipped; prereleases are not, because
 * community builds are published as prereleases.
 */
export function pickLatestBuild(payload: unknown): LatestBuild | null {
  if (!Array.isArray(payload)) return null;
  let best: LatestBuild | null = null;

  for (const entry of payload as ReleaseJson[]) {
    if (!entry || typeof entry !== 'object' || entry.draft === true) continue;
    const tag = typeof entry.tag_name === 'string' ? entry.tag_name : '';
    const versionCode = versionCodeFromTag(tag);
    if (versionCode === null) continue;

    const assets = Array.isArray(entry.assets) ? (entry.assets as Record<string, unknown>[]) : [];
    const apk = assets.find(
      (a) => typeof a.browser_download_url === 'string' && a.browser_download_url.endsWith('.apk'),
    );
    const url =
      (typeof apk?.browser_download_url === 'string' && apk.browser_download_url) ||
      (typeof entry.html_url === 'string' ? entry.html_url : '');
    if (!url) continue;

    const name = typeof entry.name === 'string' ? entry.name : '';
    const versionName = name.match(/\d+\.\d+\.\d+/)?.[0] ?? null;

    if (!best || versionCode > best.versionCode) {
      best = {
        versionCode,
        versionName,
        url,
        publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null,
      };
    }
  }

  return best;
}

/** The installed build number, or null where there is none (Expo Go, web). */
export function installedVersionCode(): number | null {
  const raw = Constants.nativeBuildVersion?.trim();
  const code = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(code) ? code : null;
}

/** What to tell the user, given what is installed and what is published. */
export function compareBuilds(installed: number | null, latest: LatestBuild | null): UpdateCheck {
  if (!latest) return { state: 'unknown', installed, reason: 'No published build to compare with.' };
  if (installed === null) {
    // Cannot tell — say so rather than claim either answer. A dev build has no
    // version code, and calling that "up to date" would be a guess.
    return { state: 'update', installed, latest };
  }
  return installed >= latest.versionCode
    ? { state: 'current', installed, latest }
    : { state: 'update', installed, latest };
}

type Cached = { at: number; latest: LatestBuild | null };

async function cachedLatest(): Promise<LatestBuild | null | undefined> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Cached;
    if (Date.now() - parsed.at > CACHE_MS) return undefined;
    return parsed.latest;
  } catch {
    return undefined;
  }
}

/**
 * Check for a newer build. Cached for six hours unless `force` is passed, so
 * opening the screen repeatedly does not spend GitHub's unauthenticated quota.
 */
export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  const installed = installedVersionCode();

  if (!force) {
    const cached = await cachedLatest();
    if (cached !== undefined) return compareBuilds(installed, cached);
  }

  let latest: LatestBuild | null;
  try {
    const response = await fetch(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        state: 'unknown',
        installed,
        reason:
          response.status === 403
            ? 'GitHub is rate limiting this check. Try again later.'
            : `Could not reach GitHub (${response.status}).`,
      };
    }
    latest = pickLatestBuild(await response.json());
  } catch {
    return { state: 'unknown', installed, reason: 'Could not reach GitHub to check for updates.' };
  }

  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), latest } satisfies Cached));
  } catch {
    // A cache that cannot be written only means the next check is a fresh one.
  }

  return compareBuilds(installed, latest);
}
