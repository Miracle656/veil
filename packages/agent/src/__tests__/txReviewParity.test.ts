import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Account, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import {
  ALLOWED_OPERATION_TYPES,
  proposalRefusal,
  reviewProposedTransaction,
} from '../txReview.js'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

function buildTx(
  source: string,
  addOps: (builder: TransactionBuilder) => TransactionBuilder,
): string {
  const builder = new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
  return addOps(builder).setTimeout(180).build().toXDR()
}

/** Extract every operation `case '<op>':` whose return literal sets `known: true`. */
function extractKnownCases(source: string): string[] {
  const fnStart = source.indexOf('function describeOperation')
  const fnBody = source.slice(fnStart, source.indexOf('\nexport function reviewProposedTransaction', fnStart))
  const known: string[] = []
  const pattern = /case '([^']+)':[\s\S]*?known:\s*(true|false)/g
  for (const match of fnBody.matchAll(pattern)) {
    if (match[2] === 'true') known.push(match[1])
  }
  return known.sort()
}

describe('server and client transaction review parity (#1315)', () => {
  const owner = Keypair.random().publicKey()
  const recipient = Keypair.random().publicKey()
  const usdc = new Asset('USDC', USDC_ISSUER)

  it('pins the exact same operation allowlist as frontend/mobile/lib/agentMessages.ts', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const serverSource = readFileSync(path.resolve(here, '../txReview.ts'), 'utf8')
    const clientSource = readFileSync(
      path.resolve(here, '../../../../frontend/mobile/lib/agentMessages.ts'),
      'utf8',
    )

    const serverKnown = extractKnownCases(serverSource)
    const clientKnown = extractKnownCases(clientSource)

    expect(serverKnown).toEqual(clientKnown)
    expect([...ALLOWED_OPERATION_TYPES].sort()).toEqual(clientKnown)
  })

  it('allows every permitted operation type and populates confirmation records', () => {
    const allowedCases = [
      buildTx(owner, (b) =>
        b.addOperation(Operation.payment({ destination: recipient, asset: Asset.native(), amount: '12.5000000' })),
      ),
      buildTx(owner, (b) =>
        b.addOperation(
          Operation.pathPaymentStrictSend({
            sendAsset: Asset.native(),
            sendAmount: '50.0000000',
            destination: owner,
            destAsset: usdc,
            destMin: '5.5000000',
            path: [],
          }),
        ),
      ),
      buildTx(owner, (b) =>
        b.addOperation(
          Operation.pathPaymentStrictReceive({
            sendAsset: Asset.native(),
            sendMax: '60.0000000',
            destination: owner,
            destAsset: usdc,
            destAmount: '6.0000000',
            path: [],
          }),
        ),
      ),
      buildTx(owner, (b) => b.addOperation(Operation.changeTrust({ asset: usdc }))),
      buildTx(owner, (b) =>
        b.addOperation(Operation.createAccount({ destination: recipient, startingBalance: '2.0000000' })),
      ),
    ]

    for (const xdr of allowedCases) {
      const review = reviewProposedTransaction(xdr, Networks.TESTNET)
      expect(review.hasUnknownOperation).toBe(false)
      expect(proposalRefusal(review, owner)).toBeNull()
    }
  })

  it('refuses disallowed operations and mismatched source accounts', () => {
    const disallowedCases = [
      buildTx(owner, (b) => b.addOperation(Operation.setOptions({ masterWeight: 0 }))),
      buildTx(owner, (b) => b.addOperation(Operation.accountMerge({ destination: recipient }))),
      buildTx(owner, (b) => b.addOperation(Operation.bumpSequence({ bumpTo: '99' }))),
      buildTx(owner, (b) => b.addOperation(Operation.manageData({ name: 'k', value: 'v' }))),
    ]

    for (const xdr of disallowedCases) {
      const review = reviewProposedTransaction(xdr, Networks.TESTNET)
      expect(review.hasUnknownOperation).toBe(true)
      expect(proposalRefusal(review, owner)).toMatch(/cannot show you/)
    }

    const wrongSourceXdr = buildTx(recipient, (b) =>
      b.addOperation(Operation.payment({ destination: owner, asset: Asset.native(), amount: '1.0000000' })),
    )
    const wrongSourceReview = reviewProposedTransaction(wrongSourceXdr, Networks.TESTNET)
    expect(proposalRefusal(wrongSourceReview, owner)).toMatch(/not this wallet's fee payer/)
  })
})
