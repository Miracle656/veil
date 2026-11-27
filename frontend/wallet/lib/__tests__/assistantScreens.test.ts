import { existsSync } from 'fs'
import path from 'path'

import { SCREENS, SCREEN_IDS } from '../../../../packages/agent/src/screens'
import { ASSISTANT_SCREEN_ROUTES, screenButton } from '../assistantScreens'

describe('assistant screens', () => {
  it('this app has a route for every screen the assistant knows, and no others', () => {
    expect(Object.keys(ASSISTANT_SCREEN_ROUTES).sort()).toEqual([...SCREEN_IDS].sort())
  })

  it('every route is a page that exists', () => {
    for (const [id, route] of Object.entries(ASSISTANT_SCREEN_ROUTES)) {
      const file = path.join(__dirname, '..', '..', 'app', ...route.split('/').filter(Boolean), 'page.tsx')
      expect([id, existsSync(file)]).toEqual([id, true])
    }
  })

  it('never leads to deleting, recovering or locking the wallet, or to another app\'s window', () => {
    for (const route of Object.values(ASSISTANT_SCREEN_ROUTES)) {
      expect(route).not.toMatch(/danger|recover|lock|connect|^\/$/)
    }
  })

  it('makes a button from a known screen, with this app\'s own route', () => {
    expect(screenButton({ screen: 'airtime', title: 'Airtime' })).toEqual({ href: '/bills', title: 'Airtime' })
    expect(screenButton({ screen: 'assistant_allowance', title: SCREENS.assistant_allowance.title })).toEqual({
      href: '/settings/agent',
      title: 'Assistant allowance',
    })
  })

  it('ignores a route or an unknown screen sent by the server', () => {
    for (const bad of [
      { screen: '/settings/danger', title: 'x' },
      { screen: 'https://evil.example', title: 'x' },
      { screen: 'constructor', title: 'x' },
      { screen: 'airtime', href: 'https://evil.example' } as unknown,
      { title: 'no screen' },
      'airtime',
      null,
      undefined,
    ]) {
      const button = screenButton(bad)
      // The one entry with a known screen still gets this app's route, not the server's.
      if (button) expect(button.href).toBe('/bills')
      else expect(button).toBeNull()
    }
    expect(screenButton({ screen: '/settings/danger', title: 'x' })).toBeNull()
    expect(screenButton({ screen: 'constructor', title: 'x' })).toBeNull()
  })

  it('shows the title as plain text, cut short, with a fallback', () => {
    expect(screenButton({ screen: 'swap', title: 'x'.repeat(200) })!.title).toHaveLength(40)
    expect(screenButton({ screen: 'swap', title: 42 })!.title).toBe('this screen')
    expect(screenButton({ screen: 'swap', title: '   ' })!.title).toBe('this screen')
  })
})
