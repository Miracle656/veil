import { readFileSync } from 'fs'
import { join } from 'path'

import * as wallet from '../lpPositions'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mobile = require('../../../mobile/lib/lpPositions') as typeof wallet

/**
 * Web/mobile LP position parity check.
 *
 * Two clients, one wallet: mobile and web must report the exact same LP
 * positions and the exact same underlying & USD values for the same wallet.
 * `frontend/wallet/lib/lpPositions.ts` and `frontend/mobile/lib/lpPositions.ts`
 * are kept byte-identical and exercised against the same wallet test table.
 */

const WALLET_FILE = join(__dirname, '..', 'lpPositions.ts')
const MOBILE_FILE = join(__dirname, '..', '..', '..', 'mobile', 'lib', 'lpPositions.ts')

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const AQUA_ISSUER = 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'

const POOL_XLM_USDC = 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7'
const POOL_XLM_AQUA = 'aa1122334455667788990011223344556677889900112233445566778899aabb'
const POOL_UNKNOWN  = 'ff99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbb'

const POOLS_BY_ID: Record<string, wallet.HorizonLiquidityPoolRecord> = {
  [POOL_XLM_USDC]: {
    id: POOL_XLM_USDC,
    fee_bp: 30,
    total_shares: '1000.0000000',
    reserves: [
      { asset: 'native', amount: '10000.0000000' },
      { asset: `USDC:${USDC_ISSUER}`, amount: '1000.0000000' },
    ],
  },
  [POOL_XLM_AQUA]: {
    id: POOL_XLM_AQUA,
    fee_bp: 30,
    total_shares: '2000.0000000',
    reserves: [
      { asset: 'native', amount: '4000.0000000' },
      { asset: `AQUA:${AQUA_ISSUER}`, amount: '400000.0000000' },
    ],
  },
}

const PARITY_CASES: Array<{
  name: string
  balances: wallet.HorizonBalanceEntry[]
  prices: Record<string, number | null>
}> = [
  {
    name: 'held XLM/USDC position alongside plain assets',
    balances: [
      { asset_type: 'native', balance: '250.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '100.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
    ],
    prices: { XLM: 0.1, [`USDC:${USDC_ISSUER}`]: 1.0 },
  },
  {
    name: 'zero-share LP trustline only',
    balances: [
      { asset_type: 'native', balance: '50.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '0.0000000' },
    ],
    prices: { XLM: 0.1, [`USDC:${USDC_ISSUER}`]: 1.0 },
  },
  {
    name: 'unknown-pair LP position',
    balances: [
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '12.5000000' },
    ],
    prices: { XLM: 0.1 },
  },
  {
    name: 'mixed held, partial-priced, zero, and unknown-pair wallet',
    balances: [
      { asset_type: 'native', balance: '10.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_AQUA, balance: '100.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '7.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '0.0000000' },
    ],
    prices: { XLM: 0.1, [`USDC:${USDC_ISSUER}`]: 1.0 },
  },
]

describe('web and mobile LP position parity', () => {
  it('lpPositions.ts is byte-identical on web and mobile', () => {
    const webSource = readFileSync(WALLET_FILE, 'utf8').replace(/\r\n/g, '\n')
    const mobileSource = readFileSync(MOBILE_FILE, 'utf8').replace(/\r\n/g, '\n')
    expect(mobileSource).toBe(webSource)
  })

  it.each(PARITY_CASES)('reports the exact same positions and values for: $name', ({ balances, prices }) => {
    const webPositions = wallet.resolveLpPositions(balances, POOLS_BY_ID, prices)
    const mobilePositions = mobile.resolveLpPositions(balances, POOLS_BY_ID, prices)
    expect(mobilePositions).toEqual(webPositions)

    const webPlain = wallet.filterPlainAssetBalances(balances)
    const mobilePlain = mobile.filterPlainAssetBalances(balances)
    expect(mobilePlain).toEqual(webPlain)
  })
})
