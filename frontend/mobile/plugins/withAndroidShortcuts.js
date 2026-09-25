/**
 * Expo config plugin: static Android App Shortcuts for Veil's read-only actions.
 *
 * Long-pressing the launcher icon lists these, and each one opens the app on an
 * existing screen through a `veil://` link, so it goes through the same deep-link
 * resolver (`lib/deepLinks.ts`) and the same data paths as any other link. A
 * shortcut is a destination only: it cannot carry parameters beyond its URL and
 * cannot sign anything.
 *
 * The action list comes from `app.config.ts`, which mirrors
 * `lib/voice/actions.ts`; see that module for why the actions live there and
 * what an AppFunctions adapter would need.
 *
 * At prebuild this writes three things:
 *   - `res/xml/veil_shortcuts.xml`, the shortcut definitions;
 *   - one short and one long label per shortcut in `res/values/strings.xml`,
 *     because Android only accepts string resources for shortcut labels;
 *   - an `android.app.shortcuts` meta-data entry on the main activity.
 */
const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withStringsXml,
} = require('expo/config-plugins');

const RESOURCE_NAME = 'veil_shortcuts';
const META_DATA_NAME = 'android.app.shortcuts';

function labelName(id, kind) {
  return `shortcut_${id}_${kind}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function assertValid(shortcuts) {
  if (!Array.isArray(shortcuts) || shortcuts.length === 0) {
    throw new Error('withAndroidShortcuts: pass a non-empty `shortcuts` array.');
  }
  for (const s of shortcuts) {
    for (const field of ['id', 'shortLabel', 'longLabel', 'url']) {
      if (typeof s[field] !== 'string' || s[field] === '') {
        throw new Error(`withAndroidShortcuts: shortcut ${JSON.stringify(s.id)} is missing \`${field}\`.`);
      }
    }
    if (!/^[a-z][a-z0-9_]*$/.test(s.id)) {
      // The id becomes part of a resource name.
      throw new Error(`withAndroidShortcuts: id ${JSON.stringify(s.id)} must be lowercase letters, digits or _.`);
    }
  }
}

/** The contents of `res/xml/veil_shortcuts.xml`. */
function renderShortcutsXml(shortcuts, packageName) {
  const entries = shortcuts.map(
    (s) => `  <shortcut
    android:shortcutId="${escapeXml(s.id)}"
    android:enabled="true"
    android:icon="@mipmap/ic_launcher"
    android:shortcutShortLabel="@string/${labelName(s.id, 'short')}"
    android:shortcutLongLabel="@string/${labelName(s.id, 'long')}">
    <intent
      android:action="android.intent.action.VIEW"
      android:targetPackage="${escapeXml(packageName)}"
      android:data="${escapeXml(s.url)}" />
  </shortcut>`,
  );
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">',
    ...entries,
    '</shortcuts>',
    '',
  ].join('\n');
}

/** Point the main activity at the shortcuts resource, replacing any earlier entry. */
function addShortcutsMetaData(manifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  const others = (activity['meta-data'] ?? []).filter(
    (item) => item.$['android:name'] !== META_DATA_NAME,
  );
  activity['meta-data'] = [
    ...others,
    { $: { 'android:name': META_DATA_NAME, 'android:resource': `@xml/${RESOURCE_NAME}` } },
  ];
  return manifest;
}

function withAndroidShortcuts(config, { shortcuts } = {}) {
  assertValid(shortcuts);
  const packageName = config.android?.package;
  if (!packageName) {
    throw new Error('withAndroidShortcuts: android.package must be set.');
  }

  config = withAndroidManifest(config, (c) => {
    c.modResults = addShortcutsMetaData(c.modResults);
    return c;
  });

  config = withStringsXml(config, (c) => {
    const items = shortcuts.flatMap((s) => [
      AndroidConfig.Resources.buildResourceItem({ name: labelName(s.id, 'short'), value: s.shortLabel }),
      AndroidConfig.Resources.buildResourceItem({ name: labelName(s.id, 'long'), value: s.longLabel }),
    ]);
    c.modResults = AndroidConfig.Strings.setStringItem(items, c.modResults);
    return c;
  });

  config = withDangerousMod(config, [
    'android',
    (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${RESOURCE_NAME}.xml`), renderShortcutsXml(shortcuts, packageName));
      return c;
    },
  ]);

  return config;
}

module.exports = withAndroidShortcuts;
module.exports.renderShortcutsXml = renderShortcutsXml;
module.exports.addShortcutsMetaData = addShortcutsMetaData;
