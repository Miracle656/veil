/**
 * The opening screen: the Veil mark, the name under it, and "from Divinity
 * Labs" at the foot.
 *
 * It is drawn by the app, on top of everything, the moment the native splash
 * is released. The native splash can only show one centred image, so it shows
 * the mark alone; this screen draws the same image at the same size in the
 * same place on the same background, so the mark does not move. The name and
 * the maker's line fade in around it, then the whole screen fades away to
 * the app, which has been starting up underneath all along.
 *
 * It never holds the app back: it sits over the app, it does not gate it, and
 * a timer removes it whatever happens to the animation.
 */

/** Width the native splash draws its image at. Must equal `imageWidth` in app.config.ts. */
export const SPLASH_IMAGE_WIDTH = 260;

/** Must equal the expo-splash-screen backgrounds in app.config.ts. */
export const SPLASH_BACKGROUND = { light: '#FFFFFF', dark: '#0F0F0F' } as const;

export const BRAND_NAME = 'Veil';
export const MAKER_PREFIX = 'from';
export const MAKER_NAME = 'Divinity Labs';

/** How long each part takes, in milliseconds. */
export const SPLASH_TIMING = {
  /** The name and the maker's line fading in. */
  textIn: 320,
  /** Everything held still. */
  hold: 780,
  /** The whole screen fading away. */
  out: 260,
} as const;

/** From first frame to gone. */
export const SPLASH_TOTAL_MS = SPLASH_TIMING.textIn + SPLASH_TIMING.hold + SPLASH_TIMING.out;

/**
 * The screen is taken down this long after it appears even if no animation
 * ever reports finishing. A brand screen must not be able to trap anyone.
 */
export const SPLASH_FAILSAFE_MS = SPLASH_TOTAL_MS + 400;

export interface SplashPalette {
  scheme: 'light' | 'dark';
  background: string;
  /** The name under the mark. */
  name: string;
  /** "from". */
  makerPrefix: string;
  /** "Divinity Labs". */
  makerName: string;
}

/**
 * Colours for the opening screen. It follows the PHONE's light or dark
 * setting, not the choice made inside Veil, because that is what the native
 * splash underneath follows and the two have to match.
 */
export function splashPalette(osScheme: string | null | undefined): SplashPalette {
  if (osScheme === 'dark') {
    return {
      scheme: 'dark',
      background: SPLASH_BACKGROUND.dark,
      name: '#F6F7F8',
      makerPrefix: 'rgba(246,247,248,0.55)',
      makerName: '#F6F7F8',
    };
  }
  // Light is the base, as in app.config.ts: anything that is not "dark" is light.
  return {
    scheme: 'light',
    background: SPLASH_BACKGROUND.light,
    name: '#0F0F0F',
    makerPrefix: 'rgba(15,15,15,0.55)',
    makerName: '#0F0F0F',
  };
}
