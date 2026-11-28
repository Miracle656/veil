import { describe, expect, it } from '@jest/globals'
import { TOOL_REGISTRY, runAgent } from '../agent.js'
import type { LlmProvider, LlmTurn } from '../llm.js'
import { SCREENS, SCREEN_IDS, isScreenId } from '../screens.js'

/** One tool call, then a closing sentence. Same shape as the boundary tests' fake model. */
function scripted(name: string, input: Record<string, unknown>, closing = 'Done.') {
  const turns: LlmTurn[] = [
    { text: '', toolCalls: [{ id: 'c1', name, input }] },
    { text: closing, toolCalls: [] },
  ]
  const seen: string[] = []
  const llm: LlmProvider = {
    label: 'scripted',
    start() {
      let i = 0
      return {
        async next() {
          return turns[Math.min(i++, turns.length - 1)]
        },
        addToolResults(results) {
          for (const r of results) seen.push(r.content)
        },
      }
    },
  }
  return { llm, seen }
}

// Made-up, well-formed addresses.
const WALLET = 'C' + 'A'.repeat(55)
const FEE_PAYER = 'G' + 'A'.repeat(55)

describe('open_screen', () => {
  const tool = TOOL_REGISTRY.find((t) => t.name === 'open_screen')!

  it('is a prepare tool that hands off to a screen, and can do nothing on its own', () => {
    expect(tool.kind).toBe('prepare')
    expect(tool.approval).toBe('screen')
  })

  it('offers exactly the registered screens, and tells the model what each does', () => {
    const schema = tool.input_schema as { properties: { screen: { enum: string[] } } }
    expect(schema.properties.screen.enum).toEqual(SCREEN_IDS)
    for (const id of SCREEN_IDS) expect(tool.description).toContain(`${id} (${SCREENS[id].does})`)
  })

  it('never offers the screens that delete, recover or lock a wallet', () => {
    for (const forbidden of ['danger', 'delete', 'recover', 'lock', 'connect']) {
      expect(SCREEN_IDS.some((id) => id.includes(forbidden))).toBe(false)
    }
  })

  it('returns the screen and its title for a known screen', async () => {
    const { llm } = scripted('open_screen', { screen: 'airtime' }, 'You can buy airtime there.')
    const result = await runAgent('buy me airtime', WALLET, [], FEE_PAYER, undefined, llm)
    expect(result.screenIntent).toEqual({ screen: 'airtime', title: 'Airtime' })
    expect(result.pendingTxXdr).toBeUndefined()
  })

  it('refuses a screen that is not on the list, and returns no button', async () => {
    for (const bad of ['settings/danger', '/lock', '__proto__', 'toString', 42, null]) {
      const { llm, seen } = scripted('open_screen', { screen: bad })
      const result = await runAgent('x', WALLET, [], FEE_PAYER, undefined, llm)
      expect(result.screenIntent).toBeUndefined()
      expect(seen.join(' ')).toMatch(/not a wallet screen/)
    }
  })

  it('isScreenId accepts only own keys', () => {
    expect(isScreenId('airtime')).toBe(true)
    expect(isScreenId('constructor')).toBe(false)
    expect(isScreenId(undefined)).toBe(false)
  })
})
