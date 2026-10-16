import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { runAgent } from '../agent.js'
import type { LlmProvider, LlmTurn } from '../llm.js'
import {
  configureNairaServices,
  resetNairaServicesConfig,
  setCustomVerificationResolver,
  sanitizeVerification,
  sanitizeNINString,
  isValidNigerianPhone,
  normalizeNigerianPhone,
  getNairaServices,
} from '../naira.js'

function scripted(turns: LlmTurn[]): LlmProvider & { results: { id: string; content: string }[][] } {
  const results: { id: string; content: string }[][] = []
  return {
    label: 'scripted',
    results,
    start() {
      let i = 0
      return {
        async next() {
          return turns[Math.min(i++, turns.length - 1)]
        },
        addToolResults(r) {
          results.push(r)
        },
      }
    },
  }
}

const wallet = 'CWALLET1234567890'
const feePayer = 'GDROPAYER12345678901234567890123456789012345678901234567890'

describe('Naira Rails - Agent Tools', () => {
  beforeEach(() => {
    resetNairaServicesConfig()
    setCustomVerificationResolver(null)
  })

  afterEach(() => {
    resetNairaServicesConfig()
    setCustomVerificationResolver(null)
  })

  describe('Read Tools: list_naira_services', () => {
    it('returns all services with availability and amount limits', async () => {
      const llm = scripted([
        {
          text: '',
          toolCalls: [{ id: 'call_services', name: 'list_naira_services', input: {} }],
        },
        {
          text: 'Available Naira services: Airtime, Bills, and Buy with Naira.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('What naira services do you have?', wallet, [], feePayer, undefined, llm)
      expect(llm.results[0][0].id).toBe('call_services')
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.services).toHaveLength(3)
      expect(parsed.services.map((s: any) => s.id)).toEqual(['airtime', 'bills', 'buy_naira'])
      expect(parsed.services.every((s: any) => s.available)).toBe(true)
      expect(result.response).toContain('Airtime')
    })

    it('reports service down when a service is disabled', async () => {
      configureNairaServices({ airtimeAvailable: false })

      const llm = scripted([
        {
          text: '',
          toolCalls: [{ id: 'call_services', name: 'list_naira_services', input: {} }],
        },
        {
          text: 'Airtime is currently unavailable.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Can I buy airtime?', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      const airtime = parsed.services.find((s: any) => s.id === 'airtime')
      expect(airtime.available).toBe(false)
      expect(result.response).toContain('unavailable')
    })
  })

  describe('Read Tools: get_verification_status & Canary NIN stripping', () => {
    it('returns verified: true for a verified user and strips canary NIN completely', async () => {
      const CANARY_NIN = '12345678901'
      const CANARY_BVN = '98765432109'

      // Mock backend returning canary document data
      setCustomVerificationResolver(async () => {
        return {
          verified: true,
          nin: CANARY_NIN,
          bvn: CANARY_BVN,
          documentId: 'DOC-12345',
        } as any
      })

      const llm = scripted([
        {
          text: '',
          toolCalls: [{ id: 'call_verify', name: 'get_verification_status', input: {} }],
        },
        {
          text: 'You are verified to use Naira rails.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Am I verified?', wallet, [], feePayer, undefined, llm)
      const rawContent = llm.results[0][0].content
      expect(rawContent).toBe(JSON.stringify({ verified: true }))
      expect(rawContent).not.toContain(CANARY_NIN)
      expect(rawContent).not.toContain(CANARY_BVN)
      expect(rawContent).not.toContain('DOC-12345')
      expect(result.response).not.toContain(CANARY_NIN)
    })

    it('returns verified: false for an unverified user', async () => {
      setCustomVerificationResolver(async () => ({ verified: false }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [{ id: 'call_verify', name: 'get_verification_status', input: {} }],
        },
        {
          text: 'You are not verified yet. Please complete verification on the verification screen.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Am I verified?', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed).toEqual({ verified: false })
      expect(result.response).toMatch(/not verified|verification screen/i)
    })
  })

  describe('Prepare Tools: prepare_airtime', () => {
    it('prepares airtime for verified user with valid phone and amount, never completing in chat', async () => {
      setCustomVerificationResolver(async () => ({ verified: true }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_airtime',
              name: 'prepare_airtime',
              input: { phone: '08012345678', amount: 1000, network: 'mtn' },
            },
          ],
        },
        {
          text: 'I have prepared your ₦1,000 MTN airtime top-up for 08012345678. Please confirm on your screen.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy me 1,000 naira of airtime for 08012345678', wallet, [], feePayer, undefined, llm)

      expect(result.pendingTxXdr).toBeUndefined() // never signs or submits in chat
      expect(result.nairaIntent).toEqual({
        kind: 'airtime',
        phone: '08012345678',
        network: 'mtn',
        amount: 1000,
      })
      const parsedToolResult = JSON.parse(llm.results[0][0].content)
      expect(parsedToolResult.status).toBe('airtime_prepared')
      expect(parsedToolResult.phone).toBe('08012345678')
      expect(parsedToolResult.amount).toBe(1000)
    })

    it('normalizes +234 phone format properly', async () => {
      setCustomVerificationResolver(async () => ({ verified: true }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_airtime',
              name: 'prepare_airtime',
              input: { phone: '+2348012345678', amount: 500 },
            },
          ],
        },
        {
          text: 'Airtime prepared for 08012345678.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy 500 airtime for +2348012345678', wallet, [], feePayer, undefined, llm)
      expect(result.nairaIntent).toEqual({
        kind: 'airtime',
        phone: '08012345678',
        network: undefined,
        amount: 500,
      })
    })

    it('gives unverified user a clear next step pointing to verification screen rather than failing action', async () => {
      setCustomVerificationResolver(async () => ({ verified: false }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_airtime',
              name: 'prepare_airtime',
              input: { phone: '08012345678', amount: 1000 },
            },
          ],
        },
        {
          text: 'You need to verify your account first. Please visit the verification screen to complete the one-time check.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy 1000 airtime for 08012345678', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.status).toBe('verification_required')
      expect(parsed.verified).toBe(false)
      expect(parsed.next_step).toContain('verification screen')
      expect(result.nairaIntent).toEqual({ kind: 'verify' })
    })

    it('rejects an invalid or guessed phone number', async () => {
      setCustomVerificationResolver(async () => ({ verified: true }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_airtime',
              name: 'prepare_airtime',
              input: { phone: '12345', amount: 1000 },
            },
          ],
        },
        {
          text: 'Please provide a valid Nigerian phone number.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy 1000 airtime', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.error).toMatch(/valid Nigerian phone number/i)
      expect(result.nairaIntent).toBeUndefined()
    })

    it('rejects airtime when service is down before processing amount', async () => {
      configureNairaServices({ airtimeAvailable: false })

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_airtime',
              name: 'prepare_airtime',
              input: { phone: '08012345678', amount: 1000 },
            },
          ],
        },
        {
          text: 'Airtime service is currently unavailable.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy 1000 airtime for 08012345678', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.error).toMatch(/unavailable/i)
      expect(result.nairaIntent).toBeUndefined()
    })

    it('rejects amounts outside limits (below 50 or above 50,000 or fractional)', async () => {
      setCustomVerificationResolver(async () => ({ verified: true }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_airtime',
              name: 'prepare_airtime',
              input: { phone: '08012345678', amount: 10 },
            },
          ],
        },
        {
          text: 'Amount is below the minimum.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy 10 airtime for 08012345678', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.error).toMatch(/between ₦50 and ₦50,000/i)
      expect(result.nairaIntent).toBeUndefined()
    })
  })

  describe('Prepare Tools: prepare_bill', () => {
    it('prepares bill payment for verified user, landing on screen', async () => {
      setCustomVerificationResolver(async () => ({ verified: true }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_bill',
              name: 'prepare_bill',
              input: { service: 'power', customer_id: '01234567890', amount: 5000 },
            },
          ],
        },
        {
          text: 'I have prepared your ₦5,000 power bill payment. Please review and confirm on your screen.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Pay 5000 for electricity meter 01234567890', wallet, [], feePayer, undefined, llm)
      expect(result.pendingTxXdr).toBeUndefined()
      expect(result.nairaIntent).toEqual({
        kind: 'bill',
        service: 'power',
        customerId: '01234567890',
        amount: 5000,
      })
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.status).toBe('bill_prepared')
    })

    it('gives unverified user next step for bills', async () => {
      setCustomVerificationResolver(async () => ({ verified: false }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_bill',
              name: 'prepare_bill',
              input: { service: 'tv', amount: 3000 },
            },
          ],
        },
        {
          text: 'Please complete verification first.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Pay 3000 for tv', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.status).toBe('verification_required')
      expect(result.nairaIntent).toEqual({ kind: 'verify' })
    })

    it('rejects bill when service is down', async () => {
      configureNairaServices({ billsAvailable: false })

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_bill',
              name: 'prepare_bill',
              input: { service: 'power', amount: 5000 },
            },
          ],
        },
        {
          text: 'Bills service is unavailable.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Pay 5000 power', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.error).toMatch(/unavailable/i)
      expect(result.nairaIntent).toBeUndefined()
    })
  })

  describe('Prepare Tools: prepare_buy_naira', () => {
    it('prepares buy-with-naira for verified user to open onramp screen', async () => {
      setCustomVerificationResolver(async () => ({ verified: true }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_buy_naira',
              name: 'prepare_buy_naira',
              input: { amount: 20000, asset: 'USDC' },
            },
          ],
        },
        {
          text: 'Prepared your ₦20,000 USDC purchase. Check the bank account details on screen to transfer.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy 20,000 naira of USDC', wallet, [], feePayer, undefined, llm)
      expect(result.pendingTxXdr).toBeUndefined()
      expect(result.nairaIntent).toEqual({
        kind: 'buy_naira',
        amount: 20000,
        asset: 'USDC',
      })
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.status).toBe('buy_naira_prepared')
    })

    it('gives unverified user next step for buy-with-naira', async () => {
      setCustomVerificationResolver(async () => ({ verified: false }))

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_buy_naira',
              name: 'prepare_buy_naira',
              input: { amount: 10000 },
            },
          ],
        },
        {
          text: 'Please verify first.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy 10000 naira of USDC', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.status).toBe('verification_required')
      expect(result.nairaIntent).toEqual({ kind: 'verify' })
    })

    it('rejects buy-with-naira when service is down', async () => {
      configureNairaServices({ buyNairaAvailable: false })

      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_buy_naira',
              name: 'prepare_buy_naira',
              input: { amount: 10000 },
            },
          ],
        },
        {
          text: 'Buy with Naira is currently unavailable.',
          toolCalls: [],
        },
      ])

      const result = await runAgent('Buy 10000 naira of USDC', wallet, [], feePayer, undefined, llm)
      const parsed = JSON.parse(llm.results[0][0].content)
      expect(parsed.error).toMatch(/unavailable/i)
      expect(result.nairaIntent).toBeUndefined()
    })
  })

  describe('NIN Redaction & Sanitization Guarantee', () => {
    it('sanitizes any 11-digit number from agent response or error string', () => {
      const textWithNIN = 'User attempted verification with NIN 12345678901 in system.'
      expect(sanitizeNINString(textWithNIN)).toBe('User attempted verification with NIN [REDACTED] in system.')
    })

    it('sanitizeVerification returns strictly { verified: boolean }', () => {
      const maliciousPayload = {
        verified: true,
        nin: '11223344556',
        bvn: '99887766554',
        name: 'John Doe',
        rawDocument: 'passport_image_bytes',
      }
      const sanitized = sanitizeVerification(maliciousPayload)
      expect(sanitized).toEqual({ verified: true })
      expect(Object.keys(sanitized)).toEqual(['verified'])
    })
  })
})
