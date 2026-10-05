/**
 * The launcher shortcuts config plugin. It runs only at prebuild, where a
 * mistake produces a build with no shortcuts and no error, so the generated
 * resources are checked here instead.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../plugins/withAndroidShortcuts');

const PACKAGE = 'xyz.veil.wallet';
const SHORTCUTS = [
  { id: 'balance', shortLabel: 'Balance', longLabel: 'Show my balance', url: 'veil://dashboard' },
  { id: 'price', shortLabel: 'XLM price', longLabel: 'Show the XLM price', url: 'veil://token/XLM' },
];

type MetaData = { $: Record<string, string> };

function manifestWithMainActivity(metaData: MetaData[] = []) {
  return {
    manifest: {
      $: {},
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [
            {
              $: { 'android:name': '.MainActivity' },
              'intent-filter': [
                {
                  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
                },
              ],
              'meta-data': metaData,
            },
          ],
        },
      ],
    },
  };
}

function mainActivityMetaData(manifest: ReturnType<typeof manifestWithMainActivity>): MetaData[] {
  return (manifest.manifest.application[0].activity[0]['meta-data'] ?? []) as MetaData[];
}

describe('renderShortcutsXml', () => {
  const xml: string = plugin.renderShortcutsXml(SHORTCUTS, PACKAGE);

  it('declares one shortcut per action', () => {
    expect(xml.match(/<shortcut\b/g)).toHaveLength(SHORTCUTS.length);
    for (const s of SHORTCUTS) {
      expect(xml).toContain(`android:shortcutId="${s.id}"`);
    }
  });

  it('opens each one with a VIEW intent on its veil:// link, in this app only', () => {
    for (const s of SHORTCUTS) {
      expect(xml).toContain(`android:data="${s.url}"`);
    }
    expect(xml.match(/android:action="android.intent.action.VIEW"/g)).toHaveLength(SHORTCUTS.length);
    expect(xml.match(new RegExp(`android:targetPackage="${PACKAGE}"`, 'g'))).toHaveLength(
      SHORTCUTS.length,
    );
  });

  it('labels through string resources, which Android requires', () => {
    for (const s of SHORTCUTS) {
      expect(xml).toContain(`android:shortcutShortLabel="@string/shortcut_${s.id}_short"`);
      expect(xml).toContain(`android:shortcutLongLabel="@string/shortcut_${s.id}_long"`);
    }
  });

  it('escapes attribute values', () => {
    const escaped: string = plugin.renderShortcutsXml(
      [{ id: 'x', shortLabel: 'x', longLabel: 'x', url: 'veil://a?b=1&c="2"' }],
      PACKAGE,
    );
    expect(escaped).toContain('android:data="veil://a?b=1&amp;c=&quot;2&quot;"');
  });
});

describe('addShortcutsMetaData', () => {
  it('points the main activity at the shortcuts resource', () => {
    const manifest = plugin.addShortcutsMetaData(manifestWithMainActivity());

    expect(mainActivityMetaData(manifest)).toEqual([
      { $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/veil_shortcuts' } },
    ]);
  });

  it('is idempotent across repeated prebuilds, and leaves other meta-data alone', () => {
    const other = { $: { 'android:name': 'some.other', 'android:value': '1' } };
    let manifest = manifestWithMainActivity([other]);
    manifest = plugin.addShortcutsMetaData(manifest);
    manifest = plugin.addShortcutsMetaData(manifest);

    const names = mainActivityMetaData(manifest).map((item) => item.$['android:name']);
    expect(names).toEqual(['some.other', 'android.app.shortcuts']);
  });
});

describe('withAndroidShortcuts', () => {
  const baseConfig = { name: 'Veil', slug: 'veil', android: { package: PACKAGE } };

  it('refuses an empty shortcut list', () => {
    expect(() => plugin(baseConfig, { shortcuts: [] })).toThrow(/non-empty/);
  });

  it('refuses a shortcut with a missing field', () => {
    expect(() =>
      plugin(baseConfig, { shortcuts: [{ id: 'balance', shortLabel: 'Balance', url: 'veil://dashboard' }] }),
    ).toThrow(/longLabel/);
  });

  it('refuses an id that cannot be part of a resource name', () => {
    expect(() =>
      plugin(baseConfig, { shortcuts: [{ ...SHORTCUTS[0], id: 'My Balance' }] }),
    ).toThrow(/lowercase/);
  });

  it('refuses to run without an Android package', () => {
    expect(() => plugin({ name: 'Veil', slug: 'veil' }, { shortcuts: SHORTCUTS })).toThrow(
      /android.package/,
    );
  });
});
