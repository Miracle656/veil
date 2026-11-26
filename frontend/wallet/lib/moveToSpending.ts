/**
 * The move itself: an issued asset from the `C…` wallet to the `G…` spending
 * account, approved with the passkey.
 *
 * One copy, used by the dashboard and by Send. Send needs it because a payment
 * another app asks for (Veil Connect) lands there directly: somebody whose
 * USDC is in the wallet address would otherwise be told the payment failed and
 * have to know to go to the dashboard first.
 *
 * The rules about when a move is possible are in `./moveFromWallet.ts`.
 */
import { Horizon } from '@stellar/stellar-sdk'

import { loadPayingAccount } from './horizonError'
import { needXlmMessage, receiveReadiness, type IssuedWalletAsset } from './moveFromWallet'
import { getNetwork } from './network'
import { buildSignAuthEntry, getFeePayerKeypair } from './passkeySigner'
import { spendableNativeXlm, type HorizonAccountLike } from './reserves'
import { sweepContractBalance } from './sweepContractBalance'
import { buildChangeTrustTx, type HorizonBalanceLike } from './trustlines'
import { ensureWalletDeployed, getDeploymentState } from './walletDeployment'

export const WALLET_NOT_SET_UP_MESSAGE =
  'Your wallet is not fully set up yet. Open your dashboard once, then try again.'

/**
 * Returns the hash of the transfer.
 *
 * `deploy` comes from the wallet hook. A screen without the hook leaves it
 * out, and a wallet that is not on chain yet is then refused with a sentence
 * rather than deployed from here.
 */
export async function moveAssetToSpending(
  asset: IssuedWalletAsset,
  walletAddress: string,
  deploy?: (signerSecret: string) => Promise<unknown>,
): Promise<string> {
  const network = getNetwork()
  const feePayerKp = getFeePayerKeypair()
  const horizonServer = new Horizon.Server(network.horizonUrl)
  const account = await loadPayingAccount(() => horizonServer.loadAccount(feePayerKp.publicKey()))
  const readiness = receiveReadiness(
    account.balances as unknown as HorizonBalanceLike[],
    spendableNativeXlm(account as unknown as HorizonAccountLike),
    asset,
  )
  // Said before anything is signed: the network would refuse the trustline
  // anyway, with a message nobody could act on.
  if (readiness === 'need-xlm') throw new Error(needXlmMessage(asset.code))

  if (deploy) {
    await ensureWalletDeployed(deploy, walletAddress)
  } else if ((await getDeploymentState(walletAddress)) === 'undeployed') {
    throw new Error(WALLET_NOT_SET_UP_MESSAGE)
  }

  if (readiness === 'add-trustline') {
    const trustTx = buildChangeTrustTx({
      account,
      networkPassphrase: network.networkPassphrase,
      code: asset.code,
      issuer: asset.issuer,
    })
    trustTx.sign(feePayerKp)
    await horizonServer.submitTransaction(trustTx)
  }

  return sweepContractBalance(
    walletAddress,
    feePayerKp,
    buildSignAuthEntry(),
    network.rpcUrl,
    network.networkPassphrase,
    { code: asset.code, issuer: asset.issuer },
  )
}
