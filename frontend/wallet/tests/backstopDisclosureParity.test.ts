/**
 * Backstop disclosure parity & safety gate tests (#1301).
 *
 * Acceptance criteria:
 *   - One component, used by both clients, with no copy-pasted variants
 *   - The first-loss mechanism and the 17-day queue are both stated before the first deposit
 *   - A backstop rate never appears in the same comparison as a lending or savings rate
 *   - The acknowledgement is recorded with a timestamp and the position it covered
 *   - A test asserts the disclosure renders before the deposit action is reachable
 */

import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import fs from 'fs'
import path from 'path'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import {
  BackstopDisclosure,
  BACKSTOP_DISCLOSURE_COPY,
  recordBackstopAcknowledgement,
  getBackstopAcknowledgement,
  hasAcknowledgedBackstop,
} from '@veil/backstop-disclosure'

/** `frontend/wallet/tests` → repo root. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const CANONICAL_COMPONENT = path.join(
  REPO_ROOT,
  'frontend',
  'mobile',
  'components',
  'BackstopDisclosure.tsx'
)
const WEB_BACKSTOP_PAGE = path.join(
  REPO_ROOT,
  'frontend',
  'wallet',
  'app',
  'backstop',
  'page.tsx'
)
const MOBILE_BACKSTOP_PAGE = path.join(
  REPO_ROOT,
  'frontend',
  'mobile',
  'app',
  'backstop.tsx'
)
const WEB_EARN_PAGE = path.join(
  REPO_ROOT,
  'frontend',
  'wallet',
  'app',
  'earn',
  'page.tsx'
)
const MOBILE_EARN_PAGE = path.join(
  REPO_ROOT,
  'frontend',
  'mobile',
  'app',
  '(tabs)',
  'earn.tsx'
)
const WEB_TSCONFIG = path.join(REPO_ROOT, 'frontend', 'wallet', 'tsconfig.json')
const WEB_JEST = path.join(REPO_ROOT, 'frontend', 'wallet', 'jest.config.js')

const read = (file: string) => fs.readFileSync(file, 'utf8')

describe('Backstop disclosure component parity (#1301)', () => {
  it('exists in exactly one canonical file with no copy-pasted variants', () => {
    expect(fs.existsSync(CANONICAL_COMPONENT)).toBe(true)

    // Ensure no copy-pasted component was created under frontend/wallet/components/
    const walletComponentPath = path.join(
      REPO_ROOT,
      'frontend',
      'wallet',
      'components',
      'BackstopDisclosure.tsx'
    )
    expect(fs.existsSync(walletComponentPath)).toBe(false)
  })

  it('@veil/backstop-disclosure is pinned to that exact file in the wallet tsconfig', () => {
    const tsconfig = JSON.parse(
      read(WEB_TSCONFIG).replace(/^\s*\/\/.*$/gm, '')
    ) as {
      compilerOptions?: { paths?: Record<string, string[]> }
    }
    const targets =
      tsconfig.compilerOptions?.paths?.['@veil/backstop-disclosure'] ?? []
    expect(targets).toContain('../mobile/components/BackstopDisclosure')
  })

  it('the jest moduleNameMapper resolves @veil/backstop-disclosure to the same file', () => {
    const jestConfig = read(WEB_JEST)
    expect(jestConfig).toMatch(
      /'\^@veil\/backstop-disclosure\$':\s*'<rootDir>\/\.\.\/mobile\/components\/BackstopDisclosure'/
    )
  })

  it('both web and mobile backstop entry points import the shared component', () => {
    const webCode = read(WEB_BACKSTOP_PAGE)
    const mobileCode = read(MOBILE_BACKSTOP_PAGE)

    expect(webCode).toContain("from '@veil/backstop-disclosure'")
    expect(mobileCode).toContain("from '../components/BackstopDisclosure'")
  })
})

describe('Backstop disclosure copy requirements (#1301)', () => {
  it('states what the position is in one sentence: insuring the pool and paid for it', () => {
    expect(BACKSTOP_DISCLOSURE_COPY.INSURING_POOL).toBe(
      'You are insuring this pool, and you are paid for it.'
    )
  })

  it('states what happens on loss: share value falls and cannot leave for 17 days', () => {
    expect(BACKSTOP_DISCLOSURE_COPY.LOSS_AND_QUEUE).toBe(
      'When the pool takes a loss, your share value falls, and you cannot leave for 17 days.'
    )
  })

  it('states clearly that it is not a savings account and not a deposit', () => {
    expect(BACKSTOP_DISCLOSURE_COPY.NOT_SAVINGS_OR_DEPOSIT).toBe(
      'This is not a savings account and not a deposit.'
    )
  })

  it('explains the first-loss mechanism and the 17-day queue before first deposit', () => {
    expect(BACKSTOP_DISCLOSURE_COPY.FIRST_LOSS_MECHANISM).toContain(
      "first-loss capital"
    )
    expect(BACKSTOP_DISCLOSURE_COPY.FIRST_LOSS_MECHANISM).toContain(
      "17-day queue"
    )
  })
})

describe('Rate separation: never render a backstop rate beside lending or savings (#1301)', () => {
  it('mobile earn does not render an APY or rate inside the Backstop card', () => {
    const mobileEarn = read(MOBILE_EARN_PAGE)
    // Extract the Backstop card section
    const backstopCardMatch = mobileEarn.match(/<Text[^>]*>Backstop<\/Text>[\s\S]*?<\/Card>/)
    expect(backstopCardMatch).not.toBeNull()
    const backstopCardContent = backstopCardMatch![0]

    // Ensure no APY or rate value is rendered inside this card
    expect(backstopCardContent).not.toMatch(/\d+%\s*APY|\b\d+(\.\d+)?%\b|\bAPY\b|\brate\b/i)
  })

  it('web earn does not render an APY or rate inside the Backstop card', () => {
    const webEarn = read(WEB_EARN_PAGE)
    // Extract the Backstop card section
    const backstopCardMatch = webEarn.match(
      /<span[^>]*>Backstop<\/span>[\s\S]*?<\/button>\s*<\/div>/
    )
    expect(backstopCardMatch).not.toBeNull()
    const backstopCardContent = backstopCardMatch![0]

    // Ensure no APY or rate value is rendered inside this card
    expect(backstopCardContent).not.toMatch(/\d+%\s*APY|\b\d+(\.\d+)?%\b|\bAPY\b|\b(\d+%)?\s*rate\b/i)
  })
})

describe('Acknowledgement local recording pattern (#1301, #743)', () => {
  const TEST_POOL_ID = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'

  beforeEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear()
    }
  })

  it('records acknowledgement locally with timestamp and position poolId', async () => {
    const beforeTime = new Date().toISOString()
    const ack = await recordBackstopAcknowledgement(TEST_POOL_ID)
    const afterTime = new Date().toISOString()

    expect(ack.poolId).toBe(TEST_POOL_ID)
    expect(ack.timestamp).toBeDefined()
    expect(Date.parse(ack.timestamp)).toBeGreaterThanOrEqual(Date.parse(beforeTime))
    expect(Date.parse(ack.timestamp)).toBeLessThanOrEqual(Date.parse(afterTime))

    // Check retrieval
    const retrieved = await getBackstopAcknowledgement(TEST_POOL_ID)
    expect(retrieved).toEqual(ack)

    const hasAck = await hasAcknowledgedBackstop(TEST_POOL_ID)
    expect(hasAck).toBe(true)
  })

  it('returns false for unacknowledged position', async () => {
    const hasAck = await hasAcknowledgedBackstop('unacknowledged-pool-id')
    expect(hasAck).toBe(false)
  })
})

describe('Deposit action gating (#1301)', () => {
  it('renders the disclosure with all required sentences before deposit action is reachable', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(BackstopDisclosure, {
        poolId: 'test-pool-id',
        poolName: 'Test Pool',
        children: (props: { acknowledged: boolean }) =>
          React.createElement(
            'button',
            { id: 'deposit-btn', disabled: !props.acknowledged },
            'Deposit'
          ),
      })
    )

    // Asserts all 3 core sentences and the first-loss mechanism are in the rendered markup
    expect(html).toContain(BACKSTOP_DISCLOSURE_COPY.INSURING_POOL)
    expect(html).toContain(BACKSTOP_DISCLOSURE_COPY.LOSS_AND_QUEUE)
    expect(html).toContain(BACKSTOP_DISCLOSURE_COPY.NOT_SAVINGS_OR_DEPOSIT)
    expect(html).toContain(
      BACKSTOP_DISCLOSURE_COPY.FIRST_LOSS_MECHANISM.replace(/'/g, '&#x27;')
    )

    // Asserts deposit action is disabled / unreachable before acknowledgement
    expect(html).toContain('disabled=""')
  })
})
