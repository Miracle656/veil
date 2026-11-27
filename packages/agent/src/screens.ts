/**
 * Every wallet screen the assistant may take the user to.
 *
 * This is how the assistant reaches the whole wallet without ever acting on
 * its own: it names a screen, the app shows a button, and the user does the
 * thing there, where the amounts are shown and the passkey is asked for.
 *
 * Deliberately not here: deleting the wallet, recovery, the lock screen and the
 * window other apps open. The assistant never sends anyone to those.
 *
 * `does` is what the model reads to choose, so it must describe what the
 * screen really does today. The app keeps its own table from id to route and a
 * test fails if the two ever disagree.
 */
export const SCREENS = {
  dashboard: { title: 'Home', does: 'Balances, what the wallet is worth, and recent activity.' },
  activity: { title: 'Activity', does: 'The full history of payments in and out.' },
  send: { title: 'Send', does: 'Send XLM or another asset to an address, a contact or a Veil name.' },
  receive: { title: 'Receive', does: 'Show the wallet address and a QR code to be paid.' },
  swap: { title: 'Swap', does: 'Exchange one asset for another at a live quote.' },
  earn: { title: 'Earn', does: 'Lend XLM or USDC on Blend for interest, and withdraw it.' },
  invest: { title: 'Invest', does: 'Browse assets such as tokenised treasuries and buy them.' },
  assets: { title: 'Assets', does: 'Add or remove the assets this wallet can hold.' },
  buy_naira: { title: 'Buy with naira', does: 'Add money by bank transfer in naira, received as XLM or USDC.' },
  cash_out: { title: 'Cash out', does: 'Send USDC to a Nigerian bank account as naira.' },
  airtime: { title: 'Airtime', does: 'Buy mobile airtime for a Nigerian phone number.' },
  identity_check: { title: 'Identity check', does: 'The one-time identity check needed before naira services.' },
  anchor_deposit: { title: 'Buy', does: 'Add money through a Stellar anchor.' },
  anchor_withdraw: { title: 'Withdraw', does: 'Withdraw through a Stellar anchor.' },
  contacts: { title: 'Contacts', does: 'Saved addresses, to send to by name.' },
  bulk_payout: { title: 'Bulk payout', does: 'Pay many addresses in one go from a list.' },
  multisig: { title: 'Multisig', does: 'Accounts that need more than one approval.' },
  vault: { title: 'Vault', does: 'A separate place to keep funds apart from everyday spending.' },
  pools: { title: 'Pools', does: 'Add to or withdraw from liquidity pools.' },
  collectibles: { title: 'Collectibles', does: 'NFTs this wallet holds.' },
  veil_ians: { title: 'Veil-ians', does: 'The Veil-ians collection: see and buy a figure.' },
  names: { title: 'Veil Names', does: 'Rent a readable name that points at this wallet, and renew it.' },
  dapps: { title: 'Apps', does: 'Stellar apps the wallet can open and connect to.' },
  private_send: { title: 'Private send', does: 'Send from the shielded balance.' },
  shield: { title: 'Shield', does: 'Move funds into the shielded balance.' },
  unshield: { title: 'Unshield', does: 'Move funds out of the shielded balance.' },
  assistant_allowance: {
    title: 'Assistant allowance',
    does: 'Give the assistant a capped USDC allowance, see what is left, stop it, and set up repeating airtime top-ups paid from it.',
  },
  spending_permissions: { title: 'Spending permissions', does: 'Every allowance this wallet has given, to lower or stop.' },
  passkeys: { title: 'Passkeys', does: 'Add another passkey or device, and see the ones registered.' },
  security: { title: 'Security', does: 'Auto-lock, recovery and other security settings.' },
  spending_account: { title: 'Spending account', does: 'The account that pays network fees: its address, balance and backup.' },
  profile: { title: 'Profile', does: 'Name and display preferences.' },
  privacy_settings: { title: 'Privacy settings', does: 'Hide amounts and other privacy preferences.' },
  settings: { title: 'Settings', does: 'All settings.' },
  about: { title: 'About', does: 'Version, network and links.' },
} as const

export type ScreenId = keyof typeof SCREENS

export const SCREEN_IDS = Object.keys(SCREENS) as ScreenId[]

export function isScreenId(value: unknown): value is ScreenId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCREENS, value)
}

/** What the app receives: which screen, and the title to put on the button. */
export interface ScreenIntent {
  screen: ScreenId
  title: string
}
