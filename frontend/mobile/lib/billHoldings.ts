/**
 * What the wallet can spend on a bill, per asset.
 *
 * XLM is the reserve-aware spendable figure (balance minus the account's
 * actual reserve, liabilities and a fee buffer), never the raw balance. The
 * smart wallet's XLM has no reserve to hold back, so it is added as is.
 * Zero on any failure: an unreadable balance must not look affordable.
 */

import { fetchContractAssetBalance, getFeePayerAddress } from './activity';
import { getAssetIssuer } from './assets';
import { getFeePayerXlm } from './contractSpend';
import { spendingAssetBalance } from './spendAsset';
import { getWalletAddress } from './walletStore';
import type { FundingHoldings } from './billFundingAsset';

export async function getBillHoldings(): Promise<FundingHoldings> {
  const issuer = getAssetIssuer('USDC', 'mainnet');
  const asset = issuer ? { code: 'USDC', issuer } : null;

  const stored = await getWalletAddress().catch(() => null);
  const contract = stored?.startsWith('C') ? stored : null;
  const feePayer = await getFeePayerAddress().catch(() => null);

  const [contractXlm, contractUsdc, spendableXlm, spendingUsdc] = await Promise.all([
    contract ? fetchContractAssetBalance(contract).catch(() => 0) : 0,
    contract && asset ? fetchContractAssetBalance(contract, asset).catch(() => 0) : 0,
    getFeePayerXlm().then((x) => x.spendable).catch(() => 0),
    feePayer && asset ? spendingAssetBalance(feePayer, asset).catch(() => null) : null,
  ]);

  return {
    xlm: Math.max(0, contractXlm + spendableXlm),
    usdc: Math.max(0, contractUsdc + (spendingUsdc ?? 0)),
  };
}
