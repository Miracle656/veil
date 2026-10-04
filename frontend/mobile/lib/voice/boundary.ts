/**
 * The boundary around Veil's voice surface, in one place.
 *
 * Once a wallet talks, users form beliefs about what it can do, and those
 * beliefs harden. This module is the written-down answer: what the read-only
 * surface does, what it will never do, who actually authorises a payment, and
 * which platform rules constrain anything built on top. The in-app screen
 * (`app/settings/voice.tsx`) renders it; the long-form version is
 * `frontend/docs/pages/voice.mdx`.
 *
 * Two rules for editing this file:
 *
 *   1. Nothing here describes a future version. Every claim is phrased in the
 *      present tense about what is true today. If a fact stops being true, the
 *      code and this list change together — or the screen is lying.
 *   2. The `detail` on a platform constraint carries the date it was verified,
 *      because platform rules move and a stale constraint is worse than none.
 *
 * This module is data only: it imports nothing, holds nothing, and can never
 * reach the signer (see `lib/__tests__/voiceCannotSign.test.ts`).
 */

export type VoiceFact = {
  /** Stable key, so the UI can render a list without index-based keys. */
  key: string;
  /** The claim, in plain language, one line. */
  claim: string;
  /** The detail behind the claim. */
  detail: string;
};

/** What the assistant can do today: read, and open. Nothing else. */
export const VOICE_DOES: readonly VoiceFact[] = [
  {
    key: 'balance',
    claim: 'Read your balance out loud',
    detail:
      'Through the same balance path the dashboard uses, and only when you have not hidden amounts.',
  },
  {
    key: 'price',
    claim: 'Read the price of an asset',
    detail: 'XLM today, through the same price path the token screen uses.',
  },
  {
    key: 'open',
    claim: 'Open a read-only screen',
    detail:
      'A launcher shortcut or an assistant phrase can open your dashboard or a token page. It cannot choose what the screen shows.',
  },
];

/** What no voice or assistant path does, and what keeps it that way. */
export const VOICE_NEVER_DOES: readonly VoiceFact[] = [
  {
    key: 'sign',
    claim: 'Voice never signs anything',
    detail:
      'No intent may reach the transaction signer, and a test fails if one ever can.',
  },
  {
    key: 'keys',
    claim: 'Voice never holds or reads key material',
    detail:
      'No seed, passkey credential, private key or fee-payer secret is reachable from the voice path.',
  },
  {
    key: 'authorise',
    claim: 'Voice never authorises a payment',
    detail:
      'Anyone in the room can say the words, and voices are cloned, so the words cannot be the approval. Money moves only after the on-device passkey ceremony below.',
  },
  {
    key: 'write',
    claim: 'Voice never writes to the network',
    detail: 'Everything the assistant can do reads. Nothing it runs submits a transaction.',
  },
];

/**
 * What actually authorises a payment, step by step. This is the half of the
 * boundary that people leave out, and the reason voice is safe to ship
 * read-only rather than a limitation to apologise for.
 */
export const VOICE_AUTHORISATION: readonly string[] = [
  'You approve the payment on this device, with your fingerprint, face or device PIN.',
  'That gesture produces a WebAuthn passkey assertion.',
  'Your wallet contract verifies the assertion on-chain (__check_auth) before any value moves.',
  'Nothing spoken, and nobody speaking, can produce that assertion.',
];

/**
 * Platform constraints, each carrying the date it was verified. These are the
 * facts a contributor needs before designing anything that moves money by
 * voice, and the reason this surface ships read-only.
 */
export const VOICE_PLATFORM_CONSTRAINTS: readonly VoiceFact[] = [
  {
    key: 'apple-enrolment',
    claim: 'Apple requires organization enrolment',
    detail:
      '(verified 2026-09-24) A self-custody wallet app is submitted from an Apple Developer organization account, not an individual one. Organization enrolment is a business verification step with a queue, so it belongs at the start of any plan involving payments by voice rather than at submission.',
  },
  {
    key: 'apple-regulated',
    claim: 'Apple treats crypto as a highly regulated field',
    detail:
      '(verified 2026-09-24) Apps in a highly regulated field face additional App Review scrutiny. Expect the review to ask for the money-movement story and be able to answer it; do not assume a routine review.',
  },
  {
    key: 'android-appfunctions',
    claim: 'Android AppFunctions is not shippable yet',
    detail:
      '(verified 2026-09-24) Android 16 can expose an app to an assistant as an on-device MCP server, but the Gemini integration is a private preview for trusted testers, so it cannot be tested or shipped. Android App Shortcuts are what ship today.',
  },
];

/** The page that carries this same boundary on the docs site. */
export const VOICE_BOUNDARY_DOC_URL = 'https://docs.useveilapp.xyz/voice';
