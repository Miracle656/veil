import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_SCREEN_ROUTES,
  SCREEN_TITLE_MAX,
  parseScreenIntent,
  routeForScreen,
  type AssistantScreenId,
} from '../assistantScreens';

const APP_DIR = path.join(__dirname, '..', '..', 'app');

/** True when expo-router has a screen file for this route. */
function routeExists(route: string): boolean {
  const rel = route.replace(/^\//, '');
  const candidates = [
    `${rel}.tsx`,
    path.join(rel, 'index.tsx'),
    path.join('(tabs)', `${rel}.tsx`),
    path.join('(tabs)', rel, 'index.tsx'),
  ];
  return candidates.some((c) => fs.existsSync(path.join(APP_DIR, c)));
}

describe('ASSISTANT_SCREEN_ROUTES', () => {
  const entries = Object.entries(ASSISTANT_SCREEN_ROUTES) as [AssistantScreenId, string | null][];

  it.each(entries.filter(([, route]) => route !== null))('%s leads to a screen that exists (%s)', (_id, route) => {
    expect(routeExists(route as string)).toBe(true);
  });

  it('never leads to deleting the wallet, recovery, the lock screen or revealing a key', () => {
    for (const [, route] of entries) {
      if (!route) continue;
      expect(route).not.toMatch(/danger|recover|lock|reveal-secret|backup|login|create-wallet/);
    }
  });

  it('says the assistant allowance is not in this app, instead of sending people somewhere close', () => {
    expect(routeForScreen('assistant_allowance')).toBeNull();
  });
});

describe('parseScreenIntent', () => {
  it('accepts a screen this app knows', () => {
    expect(parseScreenIntent({ screen: 'airtime', title: 'Airtime' })).toEqual({ screen: 'airtime', title: 'Airtime' });
  });

  it.each([
    ['an unknown screen', { screen: 'delete_wallet', title: 'Delete' }],
    ['a route instead of an id', { screen: '/settings/danger', title: 'x' }],
    ['an inherited property name', { screen: 'constructor', title: 'x' }],
    ['a prototype key', { screen: '__proto__', title: 'x' }],
    ['a number', { screen: 3, title: 'x' }],
    ['nothing', null],
    ['a string', 'airtime'],
  ])('refuses %s', (_label, value) => {
    expect(parseScreenIntent(value)).toBeUndefined();
  });

  it('never takes the route from the reply', () => {
    const intent = parseScreenIntent({ screen: 'send', title: 'Send', href: '/settings/danger', route: '/settings/danger' });
    expect(intent).toEqual({ screen: 'send', title: 'Send' });
    expect(routeForScreen(intent!.screen)).toBe('/send');
  });

  it('cuts a long title and replaces an empty one', () => {
    expect(parseScreenIntent({ screen: 'send', title: 'x'.repeat(200) })!.title).toHaveLength(SCREEN_TITLE_MAX);
    expect(parseScreenIntent({ screen: 'send', title: '   ' })!.title).toBe('this screen');
    expect(parseScreenIntent({ screen: 'send' })!.title).toBe('this screen');
  });
});
