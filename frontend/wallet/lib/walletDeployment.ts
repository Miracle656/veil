/**
 * Deploy-on-first-use for the web wallet.
 *
 * A Veil wallet address is a pure function of the factory, the network and the
 * passkey's public key, so it exists — and can receive — before the contract
 * does. Creation therefore no longer deploys. It used to, which on mainnet meant
 * a brand new user was told to fund a signer account they had never heard of
 * before they could have a wallet at all. Mobile never had that wall because it
 * already worked this way; the web now matches it.
 *
 * What genuinely needs the contract on chain is anything `__check_auth` has to
 * answer: spending the contract's own balance, signing for a dApp, and changing
 * signers. Those call `ensureWalletDeployed` first. Sending from the spending
 * (fee-payer) account does not touch the contract and needs none of this.
 */

import { Horizon, rpc as SorobanRpc, xdr } from '@stellar/stellar-sdk'

import { getNetwork } from './network'
import { peekFeePayerKeypair } from './feePayer'

export type DeploymentState = 'deployed' | 'undeployed' | 'unknown'

/**
 * The wallet contract cannot be set up yet because the account that pays for
 * it holds no XLM. Carries the spending address so the UI can show where to
 * send it, which is the whole of what the user needs to know.
 */
export class WalletNotActivatedError extends Error {
  constructor(readonly spendingAddress: string | null) {
    super(
      spendingAddress
        ? `Your wallet isn't set up on-chain yet. The one-time setup is paid in XLM from your spending address — send a little XLM to ${spendingAddress}, then try again.`
        : "Your wallet isn't set up on-chain yet, and this browser has no spending key to pay for it. Unlock the wallet again, then retry.",
    )
    this.name = 'WalletNotActivatedError'
  }
}

/**
 * Whether the wallet contract exists on chain.
 *
 * `unknown` is its own answer on purpose. Collapsing an unreachable RPC into
 * `undeployed` would show a working, deployed wallet as "not set up yet" for as
 * long as the network blinked.
 */
export async function getDeploymentState(address: string | null): Promise<DeploymentState> {
  if (!address || !address.startsWith('C')) return 'unknown'
  try {
    const server = new SorobanRpc.Server(getNetwork().rpcUrl)
    await server.getContractData(
      address,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      SorobanRpc.Durability.Persistent,
    )
    return 'deployed'
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
    return message.includes('not found') || message.includes('404') ? 'undeployed' : 'unknown'
  }
}

/**
 * Deploy the wallet contract if it is not already on chain.
 *
 * `deploy` comes from the wallet hook, which a plain module cannot reach. It is
 * idempotent at the SDK level (an already-deployed wallet resolves rather than
 * throws), so calling this when the state is merely `unknown` is safe.
 */
export async function ensureWalletDeployed(
  deploy: (signerSecret: string) => Promise<unknown>,
  address: string | null,
): Promise<void> {
  if (!address) throw new Error('No wallet address in this session. Unlock the wallet again.')
  if ((await getDeploymentState(address)) === 'deployed') return

  const feePayer = peekFeePayerKeypair()
  if (!feePayer) throw new WalletNotActivatedError(null)

  // Check for XLM before asking the network to run the deploy, so the failure
  // is a sentence about what to do rather than a simulation error.
  try {
    await new Horizon.Server(getNetwork().horizonUrl).loadAccount(feePayer.publicKey())
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 404) throw new WalletNotActivatedError(feePayer.publicKey())
    throw err
  }

  try {
    await deploy(feePayer.secret())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/insufficient|underfunded|balance|txInsufficientFee/i.test(message)) {
      throw new WalletNotActivatedError(feePayer.publicKey())
    }
    throw err
  }
}
