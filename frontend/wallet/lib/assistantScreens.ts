/**
 * Where each screen the assistant can name lives in this app.
 *
 * The assistant sends back only a screen's id (packages/agent/src/screens.ts).
 * The route comes from this table, never from the server's reply, so a reply
 * can only ever lead to one of these pages. A test fails if the assistant
 * knows a screen this table does not, or the other way round.
 */
export const ASSISTANT_SCREEN_ROUTES: Record<string, string> = {
  dashboard: '/dashboard',
  activity: '/activity',
  send: '/send',
  receive: '/receive',
  swap: '/swap',
  earn: '/earn',
  invest: '/invest',
  assets: '/assets',
  buy_naira: '/buy-ngn',
  cash_out: '/cashout',
  airtime: '/bills',
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
  assistant_allowance: '/settings/agent',
  spending_permissions: '/settings/allowances',
  passkeys: '/settings/passkeys',
  security: '/settings/security',
  spending_account: '/settings/fee-payer',
  profile: '/settings/profile',
  privacy_settings: '/settings/privacy',
  settings: '/settings',
  about: '/settings/about',
}

export interface ScreenButton {
  href: string
  title: string
}

/**
 * The button for a screen the assistant named, or null when the reply is not
 * one this app knows. The title is the assistant's, shown as text only and cut
 * to a sane length.
 */
export function screenButton(intent: unknown): ScreenButton | null {
  if (typeof intent !== 'object' || intent === null) return null
  const { screen, title } = intent as { screen?: unknown; title?: unknown }
  if (typeof screen !== 'string' || !Object.prototype.hasOwnProperty.call(ASSISTANT_SCREEN_ROUTES, screen)) return null
  const href = ASSISTANT_SCREEN_ROUTES[screen]
  const label = typeof title === 'string' && title.trim() ? title.trim().slice(0, 40) : 'this screen'
  return { href, title: label }
}
