/**
 * Where each screen the assistant can name lives in this app.
 *
 * The assistant sends back only a screen's id (packages/agent/src/screens.ts
 * on the server). The route comes from this table, never from the reply, so a
 * reply can only ever lead to one of these screens. The assistant never does
 * the thing itself: it names a screen, the app shows a button, and the person
 * does it there, where the amounts are shown and the passkey is asked for.
 *
 * `null` means the assistant knows the screen but this app does not have it.
 * The person is told so, instead of being sent somewhere that looks close.
 */
export const ASSISTANT_SCREEN_ROUTES = {
  dashboard: '/dashboard',
  activity: '/transactions',
  send: '/send',
  receive: '/receive',
  swap: '/swap',
  earn: '/earn',
  invest: '/explore',
  assets: '/assets',
  buy_naira: '/buy-ngn',
  cash_out: '/cash-out',
  airtime: '/airtime',
  identity_check: '/verify',
  anchor_deposit: '/buy',
  anchor_withdraw: '/withdraw',
  contacts: '/contacts',
  bulk_payout: '/bulk-payout',
  multisig: '/multisig',
  vault: '/vault',
  pools: '/pools',
  collectibles: '/nfts',
  veil_ians: '/veil-ians',
  names: '/names',
  dapps: '/dapps',
  private_send: '/privacy/send',
  shield: '/privacy/shield',
  unshield: '/privacy/unshield',
  // The assistant's own allowance is set up in the web wallet only, for now.
  assistant_allowance: null,
  spending_permissions: '/settings/permissions',
  passkeys: '/settings/passkeys',
  security: '/settings/security',
  spending_account: '/settings/fee-payer',
  profile: '/settings/profile',
  privacy_settings: '/settings/privacy',
  settings: '/settings',
  about: '/settings/about',
} as const satisfies Record<string, string | null>;

export type AssistantScreenId = keyof typeof ASSISTANT_SCREEN_ROUTES;

/** What the assistant named, checked: a screen this app knows, and a short title for the button. */
export type ScreenIntent = { screen: AssistantScreenId; title: string };

export const SCREEN_TITLE_MAX = 40;

/**
 * A screen hand-off from the server, or undefined when it is not one this app
 * knows. The title is the assistant's, used as text only and cut to a sane
 * length; the id must be one of this app's own.
 */
export function parseScreenIntent(value: unknown): ScreenIntent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { screen, title } = value as { screen?: unknown; title?: unknown };
  if (typeof screen !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(ASSISTANT_SCREEN_ROUTES, screen)) return undefined;
  const label = typeof title === 'string' && title.trim() ? title.trim().slice(0, SCREEN_TITLE_MAX) : 'this screen';
  return { screen: screen as AssistantScreenId, title: label };
}

/** The route for a screen, or null when it is not in this app. */
export function routeForScreen(screen: AssistantScreenId): string | null {
  return ASSISTANT_SCREEN_ROUTES[screen];
}

/** What to say when the assistant names a screen this app does not have. */
export const SCREEN_NOT_IN_APP = 'This one is in the Veil web wallet for now, at app.useveilapp.xyz.';
