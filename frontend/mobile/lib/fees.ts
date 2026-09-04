import { BASE_FEE } from '@stellar/stellar-sdk';

import { getNetwork } from './network';

/**
 * Inclusion-fee bid (stroops, per operation) for building transactions.
 *
 * Mainnet surge-prices inclusion — especially the Soroban lane — and the
 * 100-stroop BASE_FEE gets rejected with txINSUFFICIENT_FEE (bitten first on
 * the factory deploy, then on the first in-app SAC transfer). Overbidding is
 * safe on Stellar: the ledger charges the effective rate, not the bid, so a
 * generous mainnet bid (0.1 XLM) costs ~nothing in practice while surviving
 * surges. Testnet keeps the minimum.
 */
export function inclusionFee(): string {
  return getNetwork().name === 'mainnet' ? '1000000' : BASE_FEE;
}
