import fs from 'fs';
import path from 'path';

import {
  BRAND_NAME,
  MAKER_NAME,
  MAKER_PREFIX,
  SPLASH_BACKGROUND,
  SPLASH_FAILSAFE_MS,
  SPLASH_IMAGE_WIDTH,
  SPLASH_TIMING,
  SPLASH_TOTAL_MS,
  splashPalette,
} from '../brandSplash';

const appConfig = fs.readFileSync(path.join(__dirname, '..', '..', 'app.config.ts'), 'utf8');

describe('the opening screen matches the native splash it takes over from', () => {
  // If these drift, the mark jumps or the background flashes at hand-over.
  it('draws the mark at the width the native splash uses', () => {
    expect(appConfig).toContain(`imageWidth: ${SPLASH_IMAGE_WIDTH},`);
  });

  it('uses the native splash backgrounds', () => {
    const plugin = appConfig.slice(appConfig.indexOf("'expo-splash-screen'"));
    const block = plugin.slice(0, plugin.indexOf("'expo-secure-store'"));
    expect(block).toContain(`backgroundColor: '${SPLASH_BACKGROUND.light}'`);
    expect(block).toContain(`backgroundColor: '${SPLASH_BACKGROUND.dark}'`);
  });

  it('uses the image files the native splash uses', () => {
    const component = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'BrandSplash.tsx'), 'utf8');
    for (const file of ['splash-icon-light.png', 'splash-icon-dark.png']) {
      expect(appConfig).toContain(`./assets/images/${file}`);
      expect(component).toContain(`../assets/images/${file}`);
    }
  });
});

describe('splashPalette', () => {
  it('is dark only when the phone is dark', () => {
    expect(splashPalette('dark')).toMatchObject({ scheme: 'dark', background: '#0F0F0F' });
  });

  it.each(['light', null, undefined, 'no-preference', ''])('is light for %p, like the native splash', (scheme) => {
    expect(splashPalette(scheme)).toMatchObject({ scheme: 'light', background: '#FFFFFF' });
  });

  it('never puts text on a background of the same colour', () => {
    for (const scheme of ['light', 'dark']) {
      const p = splashPalette(scheme);
      expect(p.name.toLowerCase()).not.toBe(p.background.toLowerCase());
      expect(p.makerName.toLowerCase()).not.toBe(p.background.toLowerCase());
    }
  });
});

describe('wording and timing', () => {
  it('says Veil, from Divinity Labs', () => {
    expect(`${BRAND_NAME}, ${MAKER_PREFIX} ${MAKER_NAME}`).toBe('Veil, from Divinity Labs');
  });

  it('is over in well under two seconds', () => {
    expect(SPLASH_TOTAL_MS).toBe(SPLASH_TIMING.textIn + SPLASH_TIMING.hold + SPLASH_TIMING.out);
    expect(SPLASH_TOTAL_MS).toBeLessThanOrEqual(1500);
  });

  it('is taken down by a timer shortly after, whatever the animation does', () => {
    expect(SPLASH_FAILSAFE_MS).toBeGreaterThan(SPLASH_TOTAL_MS);
    expect(SPLASH_FAILSAFE_MS).toBeLessThanOrEqual(2000);
  });
});
