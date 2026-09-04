import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Memo,
} from '@stellar/stellar-sdk'

const HorizonServer = Horizon.Server

const network = process.env.STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
const networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
const horizonUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org'

const horizon = new HorizonServer(horizonUrl)

export interface SessionKey {
  keypair: Keypair
  /** Maximum cumulative XLM allowed to be spent in this run. */
  spendCapXlm: number
  /** Amount spent so far this run. */
  spentXlm: number
}

export function createSessionKey(secret: string, spendCapXlm: number): SessionKey {
  return {
    keypair: Keypair.fromSecret(secret),
    spendCapXlm,
    spentXlm: 0,
  }
}

export interface TipResult {
  transactionHash: string
  amountXlm: number
  to: string
  memo: string
}

/**
 * Send a tip from the session key account.
 *
 * Enforces the spend cap: throws if tipping would exceed it.
 * The session key is a plain Stellar G... account (classic, not a smart wallet)
 * pre-funded on testnet. It acts as an autonomous signer with a pre-approved
 * budget — no passkey interaction needed.
 */
export async function sendTip(
  session: SessionKey,
  toAddress: string,
  amountXlm: number,
  memo: string,
): Promise<TipResult> {
  const remaining = session.spendCapXlm - session.spentXlm
  if (amountXlm > remaining) {
    throw new Error(
      `Spend cap exceeded: want ${amountXlm} XLM but only ${remaining.toFixed(2)} XLM remaining`,
    )
  }

  const account = await horizon.loadAccount(session.keypair.publicKey())

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: toAddress,
        asset: Asset.native(),
        amount: amountXlm.toFixed(7),
      }),
    )
    .addMemo(Memo.text(memo.slice(0, 28)))
    .setTimeout(180)
    .build()

  tx.sign(session.keypair)

  const result = await horizon.submitTransaction(tx)

  session.spentXlm += amountXlm

  return {
    transactionHash: result.hash,
    amountXlm,
    to: toAddress,
    memo,
  }
}
