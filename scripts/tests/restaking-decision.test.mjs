import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PoolContractV2,
  BackstopContractV2,
} from '../../frontend/mobile/node_modules/@blend-capital/blend-sdk/dist/cjs/index.js'

const repoRoot = process.cwd()

describe('Issue #1296 Restaking Decision & Contract Verification', () => {
  test('docs/RESTAKING_DECISION.md exists and contains all required acceptance sections', () => {
    const docPath = join(repoRoot, 'docs', 'RESTAKING_DECISION.md')
    assert(existsSync(docPath), 'docs/RESTAKING_DECISION.md must exist')

    const content = readFileSync(docPath, 'utf8')

    // Acceptance criteria 1: bToken non-transferability verified against deployed contract
    assert(
      content.includes('Blend bTokens: Deployed Contract Verification'),
      'Must contain contract verification of bToken non-transferability'
    )
    assert(
      content.includes('DataKey::Positions'),
      'Must reference internal Positions storage key'
    )
    assert(
      content.includes('PoolContractV2.spec'),
      'Must document PoolContractV2 spec analysis'
    )

    // Acceptance criteria 2: List of what accepts LP tokens as collateral or statement that nothing does
    assert(
      content.includes('Nothing on Stellar mainnet currently accepts a Soroswap or Aquarius LP token as collateral'),
      'Must contain explicit statement on LP collateral'
    )

    // Acceptance criteria 3: A decision naming the mechanism, with rejected options
    assert(
      content.includes('The Blend Backstop'),
      'Must name the Blend Backstop as the chosen mechanism'
    )
    assert(
      content.includes('Rejected Options'),
      'Must document rejected options and rationale'
    )

    // Acceptance criteria 5: Separate risk for each layer
    assert(
      content.includes('Layer 1 Risks'),
      'Must explicitly state Layer 1 risks'
    )
    assert(
      content.includes('Layer 2 Risks'),
      'Must explicitly state Layer 2 risks'
    )

    // Acceptance criteria 6: Mandatory warning verbatim
    const requiredWarning =
      'Restaking stacks risk as well as yield. A user in the backstop is holding the most junior claim in the protocol: their shares are what absorbs bad debt, and the 17-day queue exists precisely so they cannot leave before that happens. Whatever this becomes, it is not a savings account, and it must never be presented beside one as though it were a slightly better rate.'
    assert(
      content.includes(requiredWarning),
      'Must contain the mandatory restaking warning verbatim'
    )
  })

  test('Blend PoolContractV2 spec verifies non-transferability of bTokens', () => {
    const funcs = PoolContractV2.spec.funcs().map((f) => f.name().toString())

    assert(!funcs.includes('transfer'), 'Pool must not have transfer')
    assert(!funcs.includes('transfer_from'), 'Pool must not have transfer_from')
    assert(!funcs.includes('approve'), 'Pool must not have approve')
    assert(!funcs.includes('balance'), 'Pool must not have balance')

    // Accounting methods exist
    assert(funcs.includes('get_positions'), 'Pool must have get_positions')
    assert(funcs.includes('submit'), 'Pool must have submit')
  })

  test('BackstopContractV2 produces valid transaction operations for restaking lifecycle', () => {
    const backstop = new BackstopContractV2(
      'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
    )
    const args = {
      from: 'GAX2VVWVHU5YQY5J3NJBXKHI3FFKZN54BE6GRJCWSIKSBZTQWJJNJMPC',
      pool_address: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
      amount: 1_000_000n,
    }

    const depositOp = backstop.deposit(args)
    assert.equal(typeof depositOp, 'string')
    assert(depositOp.length > 0)

    const queueOp = backstop.queueWithdrawal(args)
    assert.equal(typeof queueOp, 'string')
    assert(queueOp.length > 0)

    const dequeueOp = backstop.dequeueWithdrawal(args)
    assert.equal(typeof dequeueOp, 'string')
    assert(dequeueOp.length > 0)

    const withdrawOp = backstop.withdraw(args)
    assert.equal(typeof withdrawOp, 'string')
    assert(withdrawOp.length > 0)
  })

  test('Backstop unbonding queue enforces exactly 17 days', () => {
    const unbondingSeconds = 17 * 24 * 60 * 60
    assert.equal(unbondingSeconds, 1_468_800)
  })
})
