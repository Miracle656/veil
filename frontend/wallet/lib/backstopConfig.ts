/**
 * Per-network Blend backstop configuration.
 *
 * Kept apart from `lib/backstop.ts` and `lib/backstopTx.ts` so the transaction
 * builders can resolve the contract without importing the Blend SDK. The SDK
 * pins its own `@stellar/stellar-sdk` 16, whose `@noble/*` dependencies ship
 * ESM only, which the wallet's Jest runtime cannot require — importing it in
 * the builders would make the real XDR path untestable.
 */
import { getNetwork } from './network'

/**
 * Backstop contract per network. Mainnet has been deployed since v2; testnet
 * has no Blend deployment (the same reason `lib/blend.ts` leaves its testnet
 * pool id empty), so the value is only ever what an operator configures.
 *
 * The mainnet id is the `Backstop` value recorded in the `Fixed` pool
 * `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` instance storage.
 */
const DEFAULT_BACKSTOP_IDS: Record<'mainnet' | 'testnet', string> = {
  mainnet: 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
  testnet: '',
}

export function configuredBackstopId(): string {
  const name = getNetwork().name
  // Next.js inlines NEXT_PUBLIC_* only when referenced literally.
  const perNetwork =
    name === 'mainnet'
      ? process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_MAINNET
      : process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_TESTNET

  return (
    perNetwork?.trim() ||
    process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID?.trim() ||
    DEFAULT_BACKSTOP_IDS[name === 'mainnet' ? 'mainnet' : 'testnet']
  )
}
