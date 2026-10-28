/**
 * Narrow-screen navigation — AppShell drawer.
 *
 * Verifies that every destination exposed to narrow-viewport users:
 *   1. Is present in NAV_MAIN / NAV_FOOT / NAV_MULTISIG.
 *   2. Has a non-empty visible text label (the accessible name).
 *   3. Has a unique href (no destination is listed twice under the same path).
 *   4. Has a distinct lucide-react Icon (no two destinations share a glyph).
 *   5. Has no Unicode-character icon string (the old, broken approach).
 *
 * This test does not mount the component (Next.js router hooks make that
 * unnecessarily heavy in Jest). The exported nav-item arrays are pure data;
 * testing them directly is both faster and more precise than DOM assertions
 * about a rendered component.
 *
 * A separate test file should cover the WAI-ARIA drawer behaviour (focus
 * trapping, Escape to close, aria-expanded) with @testing-library/react once
 * the Next.js router can be stubbed cleanly in the Jest environment.
 */
import { NAV_MAIN, NAV_FOOT, NAV_MULTISIG } from '../navItems'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every nav item that can appear in the drawer on a narrow screen. */
function allDrawerItems() {
  // NAV_MULTISIG is conditionally prepended to NAV_FOOT at runtime; test the
  // full set so no item is exempted from the coverage checks.
  return [...NAV_MAIN, NAV_MULTISIG, ...NAV_FOOT]
}

// ---------------------------------------------------------------------------
// 1. Every destination is present and identifiable
// ---------------------------------------------------------------------------

describe('NAV_MAIN', () => {
  const expectedDestinations = [
    '/dashboard',
    '/send',
    '/receive',
    '/swap',
    '/buy-ngn',
    '/cashout',
    '/earn',
    '/bills',
    '/dapps',
    '/agent',
  ]

  it.each(expectedDestinations)(
    'contains a destination for %s',
    (href) => {
      expect(NAV_MAIN.some((item) => item.href === href)).toBe(true)
    },
  )

  it('has exactly ten primary destinations', () => {
    expect(NAV_MAIN).toHaveLength(10)
  })
})

describe('NAV_FOOT', () => {
  const expectedDestinations = ['/contacts', '/settings/passkeys', '/settings']

  it.each(expectedDestinations)(
    'contains a destination for %s',
    (href) => {
      expect(NAV_FOOT.some((item) => item.href === href)).toBe(true)
    },
  )
})

describe('NAV_MULTISIG', () => {
  it('points to /multisig', () => {
    expect(NAV_MULTISIG.href).toBe('/multisig')
  })
})

// ---------------------------------------------------------------------------
// 2. Every item has a non-empty visible label (the accessible name)
// ---------------------------------------------------------------------------

describe('visible labels', () => {
  it.each(allDrawerItems())(
    '$href has a non-empty label',
    ({ label }) => {
      expect(typeof label).toBe('string')
      expect(label.trim().length).toBeGreaterThan(0)
    },
  )
})

// ---------------------------------------------------------------------------
// 3. No two items share the same href
// ---------------------------------------------------------------------------

describe('href uniqueness', () => {
  it('has no duplicate hrefs across NAV_MAIN, NAV_MULTISIG and NAV_FOOT', () => {
    const hrefs = allDrawerItems().map((item) => item.href)
    const unique = new Set(hrefs)
    expect(unique.size).toBe(hrefs.length)
  })
})

// ---------------------------------------------------------------------------
// 4. No two items share the same Icon component
// ---------------------------------------------------------------------------

describe('icon uniqueness', () => {
  it('has no duplicate Icon components across all drawer items', () => {
    const items = allDrawerItems()
    const icons = items.map((item) => item.Icon)
    const unique = new Set(icons)
    if (unique.size !== icons.length) {
      // Produce a human-readable failure message naming the duplicates.
      const seen = new Map<unknown, string>()
      const dupes: string[] = []
      for (const item of items) {
        const prev = seen.get(item.Icon)
        if (prev !== undefined) {
          dupes.push(`${item.Icon.displayName ?? item.Icon.name} shared by ${prev} and ${item.href}`)
        } else {
          seen.set(item.Icon, item.href)
        }
      }
      throw new Error(`Duplicate icons:\n${dupes.join('\n')}`)
    }
    expect(unique.size).toBe(icons.length)
  })
})

// ---------------------------------------------------------------------------
// 5. No item uses a Unicode-character icon string (the old broken approach)
// ---------------------------------------------------------------------------

describe('no Unicode glyph icons', () => {
  it.each(allDrawerItems())(
    '$href Icon is not a Unicode glyph string (old broken approach)',
    ({ Icon }) => {
      // The old approach used Unicode strings like '⌂', '↗', etc.  A lucide-react
      // icon is a React component — a function or a forwardRef object, never a
      // string — so this assertion catches any regression back to glyph icons.
      expect(typeof Icon).not.toBe('string')
    },
  )
})

// ---------------------------------------------------------------------------
// 6. Icon components are callable (basic lucide-react shape check)
// ---------------------------------------------------------------------------

describe('Icon shape', () => {
  it.each(allDrawerItems())(
    '$href Icon has a displayName (lucide-react export)',
    ({ Icon, label }) => {
      // All lucide-react exports carry a displayName matching the export name
      // (e.g. House.displayName === 'House'). Checking this protects against
      // accidentally importing a non-lucide object.
      const name: string | undefined = (Icon as { displayName?: string }).displayName
      expect(typeof name).toBe('string')
      expect((name ?? '').length).toBeGreaterThan(0)
      // Soft documentation: which label maps to which icon name.
      // This does not assert a specific mapping — the label is the truth,
      // and the icon choice is design — but it prints in --verbose output
      // so a reviewer can scan the pairing at a glance.
      void label
    },
  )
})
