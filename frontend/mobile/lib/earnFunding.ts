/**
 * Get a deposit's money into the account Blend is called from.
 *
 * Deposits run from the spending (fee-payer) account, because a Blend `submit`
 * from the smart wallet would need the pool's nested token transfer authorised
 * by `__check_auth`, which this app does not build yet. But a wallet's money
 * usually sits in the smart wallet — that is where the receive screen points —
 * so without this Earn showed a 31 XLM wallet as unable to deposit 5.
 *
 * Same approach as swap: move the shortfall from the smart wallet with the
 * passkey-authorised SAC transfer a send already uses, then deposit.
 */

import { Asset, Horizon } from '@stellar/stellar-sdk';

import { fetchContractAssetBalance, getFeePayerAddress } from './activity';
import type { EarnAsset } from './blend';
import { getFeePayerXlm, sendAssetFromContract } from './contractSpend';
import { deployWalletIfNeeded, type DeployFn } from './deployWallet';
import { planDeposit } from './depositPlan';
import { enableUsdc } from './enableUsdc';
import { getNetwork, getNetworkName } from './network';
import { usdcIssuerFor } from './receiveReadiness';
import { getWalletAddress } from './walletStore';

export interface EarnBalances {
  /** What the spending account can deposit (XLM is net of its reserve). */
  inSpending: number;
  /** What the smart wallet holds; 0 for a classic wallet. */
  inWallet: number;
  /** USDC only: whether the spending account can hold USDC yet. */
  hasTrustline: boolean;
}

function usdcAsset(): { code: string; issuer: string } {
  return { code: 'USDC', issuer: usdcIssuerFor(getNetworkName()) };
}

/** The spending account's USDC, and whether it trusts USDC at all. */
async function spendingUsdc(): Promise<{ balance: number; hasTrustline: boolean }> {
  const feePayer = await getFeePayerAddress();
  if (!feePayer) return { balance: 0, hasTrustline: false };
  const { issuer } = usdcAsset();
  try {
    const account = await new Horizon.Server(getNetwork().horizonUrl).loadAccount(feePayer);
    const line = (
      account.balances as Array<{ asset_code?: string; asset_issuer?: string; balance: string; selling_liabilities?: string }>
    ).find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
    if (!line) return { balance: 0, hasTrustline: false };
    return {
      balance: Math.max(0, Number(line.balance) - Number(line.selling_liabilities ?? '0')),
      hasTrustline: true,
    };
  } catch {
    return { balance: 0, hasTrustline: false };
  }
}

async function smartWallet(): Promise<string | null> {
  const address = await getWalletAddress().catch(() => null);
  return address?.startsWith('C') ? address : null;
}

export async function loadEarnBalances(code: EarnAsset): Promise<EarnBalances> {
  const wallet = await smartWallet();
  if (code === 'XLM') {
    const [spending, inWallet] = await Promise.all([
      getFeePayerXlm(),
      wallet ? fetchContractAssetBalance(wallet) : Promise.resolve(0),
    ]);
    return { inSpending: spending.spendable, inWallet, hasTrustline: true };
  }
  const [spending, inWallet] = await Promise.all([
    spendingUsdc(),
    wallet ? fetchContractAssetBalance(wallet, usdcAsset()) : Promise.resolve(0),
  ]);
  return { inSpending: spending.balance, inWallet, hasTrustline: spending.hasTrustline };
}

/**
 * Make sure the spending account holds `amount` of `code`, moving the
 * difference from the smart wallet when it does not. Throws with a message a
 * user can act on when the wallet as a whole is short.
 */
export async function fundDeposit(params: {
  code: EarnAsset;
  amount: number;
  deploy: DeployFn;
  onMoving?: () => void;
}): Promise<void> {
  const { code, amount } = params;
  let balances = await loadEarnBalances(code);

  // A trustline is a classic operation on the spending account, and it must
  // exist before USDC can be moved there at all.
  if (code === 'USDC' && !balances.hasTrustline) {
    await enableUsdc();
    balances = { ...balances, inSpending: 0, hasTrustline: true };
  }

  const plan = planDeposit({ amount, inSpending: balances.inSpending, inWallet: balances.inWallet });
  if (plan.kind === 'ready') return;
  if (plan.kind === 'short') {
    throw new Error(`Your wallet has ${plan.available} ${code} available to deposit.`);
  }

  const wallet = await smartWallet();
  const feePayer = await getFeePayerAddress();
  if (!wallet || !feePayer) throw new Error('This device has no smart wallet to move funds from.');

  // `__check_auth` cannot run against an undeployed contract.
  await deployWalletIfNeeded(params.deploy, wallet);

  params.onMoving?.();
  await sendAssetFromContract(wallet, feePayer, plan.amount, code === 'USDC' ? usdcAsset() : undefined);

  // Confirmed on Soroban; Horizon, which the deposit's balance checks read,
  // can lag a few seconds behind.
  for (let i = 0; i < 10; i++) {
    if ((await loadEarnBalances(code)).inSpending >= amount) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `The ${code} moved from your wallet but has not shown up yet. Wait a moment and deposit again — it will not be moved twice.`,
  );
}

/** Stellar's SAC id for an Earn asset on the active network. */
export function earnAssetContract(code: EarnAsset): string {
  const passphrase = getNetwork().networkPassphrase;
  return code === 'XLM'
    ? Asset.native().contractId(passphrase)
    : new Asset('USDC', usdcAsset().issuer).contractId(passphrase);
}
