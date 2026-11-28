import { readFileSync } from 'fs';
import { join } from 'path';

import * as mobile from '../lpPositions';
import * as wallet from '../../../wallet/lib/lpPositions';

/**
 * Mobile-side mirror of `frontend/wallet/lib/__tests__/lpPositionsParity.test.ts`.
 *
 * Ensures both clients stay byte-identical and report the exact same LP
 * positions and values for the same wallet.
 */

const MOBILE_FILE = join(__dirname, '..', 'lpPositions.ts');
const WALLET_FILE = join(__dirname, '..', '..', '..', 'wallet', 'lib', 'lpPositions.ts');

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const POOL_XLM_USDC = 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7';
const POOL_UNKNOWN = 'ff99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbb';

const POOLS_BY_ID: Record<string, mobile.HorizonLiquidityPoolRecord> = {
  [POOL_XLM_USDC]: {
    id: POOL_XLM_USDC,
    fee_bp: 30,
    total_shares: '1000.0000000',
    reserves: [
      { asset: 'native', amount: '10000.0000000' },
      { asset: `USDC:${USDC_ISSUER}`, amount: '1000.0000000' },
    ],
  },
};

describe('mobile and web LP position parity', () => {
  it('lpPositions.ts is byte-identical on mobile and web', () => {
    const mobileSource = readFileSync(MOBILE_FILE, 'utf8').replace(/\r\n/g, '\n');
    const walletSource = readFileSync(WALLET_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(mobileSource).toBe(walletSource);
  });

  it('produces identical positions and values for held, zero, and unknown-pair cases', () => {
    const balances: mobile.HorizonBalanceEntry[] = [
      { asset_type: 'native', balance: '250.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '12.5000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '0.0000000' },
    ];
    const prices = { XLM: 0.1, [`USDC:${USDC_ISSUER}`]: 1.0 };

    expect(mobile.resolveLpPositions(balances, POOLS_BY_ID, prices)).toEqual(
      wallet.resolveLpPositions(balances, POOLS_BY_ID, prices),
    );
    expect(mobile.filterPlainAssetBalances(balances)).toEqual(
      wallet.filterPlainAssetBalances(balances),
    );
  });
});
