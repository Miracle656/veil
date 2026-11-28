import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkOnChainAllowance,
  createWraithBillClient,
  FilePlanStore,
  RecurringTopupRunner,
  type AllowancePayer,
} from '@veil/agent-recurring'

const MAINNET_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL?.trim() ||
  process.env.SOROBAN_RPC_URL?.trim() ||
  'https://mainnet.sorobanrpc.com'

const WRAITH_URL = (
  process.env.WRAITH_URL ||
  process.env.NEXT_PUBLIC_WRAITH_URL ||
  ''
).trim()

const PLANS_FILE_PATH =
  process.env.RECURRING_PLANS_FILE?.trim() ||
  path.join(tmpdir(), 'veil-recurring-topup-plans.json')

let _runner: RecurringTopupRunner | null = null

export function getRecurringTopupRunner(): RecurringTopupRunner {
  if (_runner) return _runner

  const payer: AllowancePayer = {
    checkAllowance: (params) => checkOnChainAllowance(MAINNET_RPC_URL, params),
    payFromAllowance: async () => {
      throw new Error(
        'Allowance payment execution requires the assistant spender runner (#1339) to be configured.',
      )
    },
  }

  _runner = new RecurringTopupRunner({
    store: new FilePlanStore(PLANS_FILE_PATH),
    wraith: createWraithBillClient(WRAITH_URL),
    payer,
  })
  return _runner
}
