import { showsTabBar } from '../ui/TabBar'

describe('showsTabBar', () => {
  it.each(['/dashboard', '/assets', '/swap', '/agent', '/settings'])(
    'shows the bar on the %s tab root',
    (route) => {
      expect(showsTabBar(route)).toBe(true)
    },
  )

  // The acceptance criterion names send and receive, but the rule is broader:
  // anything the user pushes into is a task to finish or back out of.
  it.each(['/send', '/receive', '/buy', '/withdraw', '/recover', '/lock'])(
    'hides the bar on the pushed flow %s',
    (route) => {
      expect(showsTabBar(route)).toBe(false)
    },
  )

  // A prefix match would light up the Settings tab here. These are pushed from
  // /settings by the same back-button pattern as /send is from the dashboard.
  it.each(['/settings/passkeys', '/settings/security', '/settings/privacy', '/settings/agent'])(
    'hides the bar on the settings subpage %s',
    (route) => {
      expect(showsTabBar(route)).toBe(false)
    },
  )

  // /token/[code] is pushed from the assets list; a prefix match on /assets
  // would be wrong here too.
  it('hides the bar on a token detail route', () => {
    expect(showsTabBar('/token/XLM')).toBe(false)
  })

  it('tolerates a trailing slash, which the router can hand back', () => {
    expect(showsTabBar('/swap/')).toBe(true)
  })

  it('does not match the root path against a tab', () => {
    expect(showsTabBar('/')).toBe(false)
  })

  // Guards against a sloppy `startsWith` regression: these are not tab roots.
  it.each(['/assets-old', '/swapping', '/settingsx'])(
    'does not match %s, which merely starts like a tab root',
    (route) => {
      expect(showsTabBar(route)).toBe(false)
    },
  )
})
