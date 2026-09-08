import { fetchContractAssetBalance } from './activity';
import {
  getFeePayerSpendableXlm,
  isWalletDeployed,
  sendAssetFromContract,
} from './contractSpend';
import { requirePasskey } from './passkey';
import { sendPayment } from './sendPayment';
import { requireSigner } from './signer';
import { getSignerSecret, getWalletAddress } from './walletStore';

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
export async function spendAsset(params: {
  to: string;
  /** Whole units, as typed. */
  amount: string;
  /** Omit for native XLM. */
  asset?: { code: string; issuer: string };
  deploy: (secret: string) => Promise<unknown>;
}): Promise<string> {
  const { to, amount, asset, deploy } = params;
  const amountNumber = Number(amount);
  const stored = await getWalletAddress().catch(() => null);

  if (stored?.startsWith('C')) {
    const [contractBalance] = await Promise.all([
      fetchContractAssetBalance(stored, asset),
      getFeePayerSpendableXlm(),
    ]);

    // Prefer the contract when it can cover the amount: it is the wallet the
    // user believes they are spending from, and the fee payer is plumbing.
    if (contractBalance > 0 && amountNumber <= contractBalance) {
      if (!(await isWalletDeployed(stored))) {
        const secret = await getSignerSecret();
        if (!secret) throw new Error('No fee-payer key on this device to pay for deployment.');
        await deploy(secret);
      }
      // The passkey prompt raised inside this call IS the security gate — it
      // signs the Soroban authorization entry that __check_auth verifies on
      // chain, rather than merely proving presence.
      return sendAssetFromContract(stored, to, amount, asset);
    }
  }

  // Fee-payer path. The passkey here is a presence gate: the transaction is
  // signed by the fee-payer keypair, so the assertion proves the person is
  // there rather than authorising the transfer itself.
  await requirePasskey();
  const signer = await requireSigner();
  const result = await sendPayment(to, amount, signer, undefined, asset);
  return result.hash;
}
