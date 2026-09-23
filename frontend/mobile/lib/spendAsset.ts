import { Horizon } from '@stellar/stellar-sdk';

import { fetchContractAssetBalance, getFeePayerAddress } from './activity';
import { getFeePayerXlm, sendAssetFromContract } from './contractSpend';
import { deployWalletIfNeeded, type DeployFn } from './deployWallet';
import { planDeposit } from './depositPlan';
import { feeBidXlm } from './fees';
import { getNetwork } from './network';
import { requirePasskey } from './passkey';
import { sendPayment } from './sendPayment';
import { requireSigner } from './signer';
import { getWalletAddress } from './walletStore';

/**
 * Send an asset, choosing the source the way the send screen does.
 *
 * A Veil wallet holds the same asset in two places — the contract's own SAC
 * balance and the fee-payer's classic trustline — and which one a transfer
 * should leave from is a real decision with real consequences. Extracted here
 * so that decision exists once: a second screen reimplementing it would drift,
 * and the failure mode of drift in money-moving code is that two buttons
 * labelled the same thing spend from different accounts.
 *
 * `deploy` is injected because it comes from the wallet provider's context and
 * this module cannot reach a hook. It is only ever called when the contract is
 * the source and is not yet on chain, since __check_auth cannot run against a
 * counterfactual address.
 */

/**
 * XLM a spending account must have above its reserve to submit one
 * transaction: the fee bid, plus room for a Soroban resource fee.
 */
function feeHeadroomXlm(): number {
  return feeBidXlm() + 0.01;
}

/**
 * The wallet as a whole holds less than the amount. Carries what it does hold,
 * so a screen can offer to send that instead.
 */
export class NotEnoughToSend extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
    readonly code: string,
  ) {
    super(`Your wallet holds ${available.toLocaleString('en-US', { maximumFractionDigits: 7 })} ${code}, less than ${requested}.`);
    this.name = 'NotEnoughToSend';
  }
}

/** The spending account cannot pay the network fee, whatever it is sending. */
export class NeedsXlmForFee extends Error {
  constructor(readonly spendingAddress: string) {
    super(
      `Your spending account needs a little XLM to pay the network fee. Send about 0.1 XLM to ${spendingAddress} and try again.`,
    );
    this.name = 'NeedsXlmForFee';
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 7 });
}

/**
 * What the spending account can send of an issued asset, or null when it has
 * no trustline for it (and so cannot hold it at all).
 */
async function spendingAssetBalance(
  feePayer: string,
  asset: { code: string; issuer: string },
): Promise<number | null> {
  const account = await new Horizon.Server(getNetwork().horizonUrl).loadAccount(feePayer);
  const line = (
    account.balances as Array<{ asset_code?: string; asset_issuer?: string; balance: string; selling_liabilities?: string }>
  ).find((b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer);
  if (!line) return null;
  return Math.max(0, Number(line.balance) - Number(line.selling_liabilities ?? '0'));
}

export async function spendAsset(params: {
  to: string;
  /** Whole units, as typed. */
  amount: string;
  /** Omit for native XLM. */
  asset?: { code: string; issuer: string };
  deploy: DeployFn;
}): Promise<string> {
  const { to, amount, asset, deploy } = params;
  const amountNumber = Number(amount);
  const code = asset?.code ?? 'XLM';

  const feePayer = await getFeePayerAddress();
  if (!feePayer) throw new Error('This device has no spending key.');
  const stored = await getWalletAddress().catch(() => null);
  const contract = stored?.startsWith('C') ? stored : null;

  // Every path below is a transaction whose source — and fee payer — is the
  // spending account, including a transfer out of the smart wallet. If it
  // cannot cover the fee bid above its reserve, the network refuses with
  // tx_insufficient_balance, which reads as "not enough USDC" to anyone
  // holding plenty. Say what is actually missing, before building anything.
  // A failed read (all zeros) is unknown, not empty: let the network decide.
  const xlm = await getFeePayerXlm();
  const xlmKnown = xlm.balance > 0 || xlm.reserve > 0;
  const freeXlm = xlmKnown ? xlm.balance - xlm.reserve : Number.POSITIVE_INFINITY;
  if (freeXlm < feeHeadroomXlm()) throw new NeedsXlmForFee(feePayer);

  const inWallet = contract ? await fetchContractAssetBalance(contract, asset) : 0;

  // Prefer the contract when it can cover the amount: it is the wallet the
  // user believes they are spending from, and the fee payer is plumbing.
  if (contract && inWallet > 0 && amountNumber <= inWallet) {
    // With the public key it was made from, resolved and checked against the
    // address — see lib/deployWallet.ts for why the SDK alone could not.
    await deployWalletIfNeeded(deploy, contract);
    // The passkey prompt raised inside this call IS the security gate — it
    // signs the Soroban authorization entry that __check_auth verifies on
    // chain, rather than merely proving presence.
    return sendAssetFromContract(contract, to, amount, asset);
  }

  const readSpending = async (): Promise<number | null> =>
    asset ? spendingAssetBalance(feePayer, asset) : (await getFeePayerXlm()).spendable;

  const inSpending = await readSpending();
  if (inSpending === null) {
    throw new Error(
      inWallet > 0
        ? `Your smart wallet holds ${fmt(inWallet)} ${code}, less than ${amount}, and your spending account can't hold ${code} yet.`
        : `This wallet has no ${code} to send.`,
    );
  }

  let passkeyShown = false;

  // Neither account covers it alone. A balance split across the two used to
  // fall through to the spending account regardless, which then failed on
  // chain with the money plainly in the wallet. Move the shortfall across
  // first — the same passkey-authorised transfer a send uses — then pay.
  if (inSpending < amountNumber) {
    const plan = planDeposit({ amount: amountNumber, inSpending, inWallet });
    if (plan.kind === 'short') {
      throw new NotEnoughToSend(plan.available, amountNumber, code);
    }
    if (plan.kind === 'move' && contract) {
      // Two transactions from the spending account now, so two fees.
      if (freeXlm < 2 * feeHeadroomXlm()) throw new NeedsXlmForFee(feePayer);
      await deployWalletIfNeeded(deploy, contract);
      await sendAssetFromContract(contract, feePayer, plan.amount, asset);
      passkeyShown = true;

      // Confirmed on Soroban; Horizon, which the payment below reads, can lag
      // a few seconds behind.
      let arrived = false;
      for (let i = 0; i < 10 && !arrived; i++) {
        arrived = ((await readSpending()) ?? 0) >= amountNumber;
        if (!arrived) await new Promise((r) => setTimeout(r, 1500));
      }
      if (!arrived) {
        throw new Error(
          `The ${code} moved into your spending account but has not shown up yet. Wait a moment and pay again; it will not be moved twice.`,
        );
      }
    }
  }

  // Fee-payer path. The passkey here is a presence gate: the transaction is
  // signed by the fee-payer keypair, so the assertion proves the person is
  // there rather than authorising the transfer itself. Skipped when the move
  // above has just asked for it.
  if (!passkeyShown) await requirePasskey();
  const signer = await requireSigner();
  const result = await sendPayment(to, amount, signer, undefined, asset);
  return result.hash;
}
