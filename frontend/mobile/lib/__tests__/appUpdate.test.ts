jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));
// The installed build number comes from expo-application. It used to be read
// off expo-constants, which no longer carries it, so every check ran with no
// installed version at all.
const mockBuildVersion = jest.fn<string | null, []>();
jest.mock('expo-application', () => ({
  __esModule: true,
  get nativeApplicationVersion() {
    return '0.1.0';
  },
  get nativeBuildVersion() {
    return mockBuildVersion();
  },
}));

import {
  compareBuilds,
  installedVersionCode,
  pickLatestBuild,
  versionCodeFromTag,
  type LatestBuild,
} from '../appUpdate';

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Veil Android ${tag}`,
  html_url: `https://github.com/Miracle656/veil/releases/tag/${tag}`,
  published_at: '2026-09-18T10:00:00Z',
  assets: [{ browser_download_url: `https://github.com/Miracle656/veil/releases/download/${tag}/veil.apk` }],
  ...extra,
});

describe('versionCodeFromTag', () => {
  it('reads the build number from a mobile tag', () => {
    expect(versionCodeFromTag('mobile-v7')).toBe(7);
  });

  it('ignores tags that are not mobile builds', () => {
    expect(versionCodeFromTag('v0.1.0')).toBeNull();
    expect(versionCodeFromTag('mobile-vlatest')).toBeNull();
  });
});

describe('pickLatestBuild', () => {
  it('takes the highest build number, not the first listed', () => {
    const latest = pickLatestBuild([release('mobile-v5'), release('mobile-v9'), release('mobile-v7')]);
    expect(latest?.versionCode).toBe(9);
  });

  it('links straight to the APK so the button downloads the file', () => {
    expect(pickLatestBuild([release('mobile-v7')])?.url).toMatch(/\.apk$/);
  });

  it('falls back to the release page when no APK is attached', () => {
    const latest = pickLatestBuild([release('mobile-v7', { assets: [] })]);
    expect(latest?.url).toMatch(/releases\/tag\/mobile-v7$/);
  });

  it('skips drafts and unrelated releases', () => {
    expect(pickLatestBuild([release('mobile-v8', { draft: true }), release('sdk-v2')])).toBeNull();
    expect(pickLatestBuild('not a list')).toBeNull();
  });
});

describe('compareBuilds', () => {
  const latest: LatestBuild = {
    versionCode: 7,
    versionName: '0.1.0',
    url: 'https://example.test/veil.apk',
    publishedAt: null,
  };

  it('says up to date when the installed build is the published one', () => {
    expect(compareBuilds(7, latest).state).toBe('current');
  });

  it('counts a build newer than the release as up to date', () => {
    expect(compareBuilds(8, latest).state).toBe('current');
  });

  it('offers the update when the installed build is older', () => {
    expect(compareBuilds(6, latest)).toEqual({ state: 'update', installed: 6, latest });
  });

  it('claims neither answer without knowing the installed build, but keeps the release', () => {
    // Not `update`: that told every user a newer build existed, which was wrong
    // whenever the newest published build was the one they were running.
    const result = compareBuilds(null, latest);
    expect(result.state).toBe('unknown');
    expect(result.state === 'unknown' && result.latest).toBe(latest);
  });

  it('says unknown when nothing is published to compare with', () => {
    expect(compareBuilds(7, null).state).toBe('unknown');
  });
});

describe('installedVersionCode', () => {
  it('reads the build number the native app reports', () => {
    mockBuildVersion.mockReturnValue('10');
    expect(installedVersionCode()).toBe(10);
  });

  it('is null when there is no native build to ask', () => {
    mockBuildVersion.mockReturnValue(null);
    expect(installedVersionCode()).toBeNull();
  });

  it('ignores a build identifier that is not a whole number', () => {
    mockBuildVersion.mockReturnValue('1.0.0');
    expect(installedVersionCode()).toBeNull();
  });
});
