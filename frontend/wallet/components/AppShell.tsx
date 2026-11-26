'use client'
import { walletLocal } from '@/lib/walletStorage'

/**
 * The desktop app shell from the `Veil Web` design: a fixed 248px sidebar
 * beside a scrolling content column.
 *
 * The wallet previously had no shared chrome — every route painted its own
 * header and there was no persistent navigation — so this is additive. A page
 * adopts it by wrapping its content; nothing about its data or signing code
 * changes.
 *
 * Below lg the sidebar collapses. A hamburger button in the header opens a
 * full-height slide-in drawer that lists every destination with a lucide icon
 * and its text label — the same information the sidebar shows, revealed on
 * demand. The drawer traps focus, closes on Escape and backdrop click, and
 * restores focus to the trigger that opened it.
 *
 * The bottom TabBar handles the five most-frequent destinations with visible
 * labels; the drawer handles everything else. There is no longer an icon-only
 * overflow strip hiding destinations off the right edge of the screen.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { Menu, X } from 'lucide-react'

import { isMultisigAvailable } from '@/lib/multisigConfig'

import { CurrencyPicker } from './CurrencyPicker'
import { NetworkSwitcher } from './NetworkSwitcher'
import { NAV_MAIN, NAV_FOOT, NAV_MULTISIG, type NavItem } from './navItems'
import { TabBar, showsTabBar } from './ui/TabBar'
import { VeilWordmark } from './ui/VeilMark'

/** Shorten a Stellar address for the sidebar chip: `GDKF…9QX3`. */
function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr
}

function NavRow({
  item,
  active,
  onClick,
}: {
  item: NavItem
  active: boolean
  onClick?: () => void
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className="flex items-center justify-between rounded-xl px-[14px] py-[11px] transition-colors duration-150"
      style={{
        background: active ? 'var(--surface-md)' : 'transparent',
        border: `1px solid ${active ? 'var(--gold)' : 'transparent'}`,
        color: active ? 'var(--gold)' : 'rgba(246,247,248,0.72)',
        fontWeight: active ? 600 : 400,
      }}
    >
      <span className="flex items-center gap-3">
        {/* The link's accessible name is the visible text label, so the icon is
            decorative to a screen reader — same convention as TabBar. */}
        <item.Icon size={18} strokeWidth={1.5} aria-hidden="true" />
        <span className="text-sm whitespace-nowrap">{item.label}</span>
      </span>
      {item.badge ? (
        <span className="font-mono text-[11px] text-teal bg-[rgba(0,167,181,0.1)] rounded-pill px-2 py-[2px] whitespace-nowrap">
          {item.badge}
        </span>
      ) : null}
    </Link>
  )
}

/**
 * Slide-in navigation drawer for narrow viewports.
 *
 * Accessibility contract (WAI-ARIA dialog pattern):
 *   • The trigger sets aria-expanded and aria-controls pointing at this panel.
 *   • When open, focus moves into the panel and is trapped there.
 *   • Escape closes the drawer and returns focus to the trigger.
 *   • Clicking the backdrop closes the drawer and returns focus to the trigger.
 *   • The panel has role="dialog" aria-modal="true" aria-label="Navigation".
 */
function NavDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Move focus into the panel when it opens.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const first = panel.querySelector<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    first?.focus()
  }, [open])

  // Close on Escape; trap Tab/Shift-Tab inside the panel.
  useEffect(() => {
    if (!open) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      if (e.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)

      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  return (
    <>
      {/* Backdrop — click closes the drawer. */}
      {open && (
        <div
          aria-hidden="true"
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        id="nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="lg:hidden fixed inset-y-0 left-0 z-50 w-[280px] flex flex-col bg-near-black border-r border-border-dim px-5 pt-7 pb-6 transition-transform duration-300 ease-in-out"
        style={{ transform: open ? 'translateX(0)' : 'translateX(-100%)' }}
        // `inert` removes all descendants from the tab order when the drawer is
        // closed, without hiding the panel from the DOM (which would break the
        // CSS transition). Broadly supported as of Chrome 102 / Firefox 112.
        // @ts-expect-error — inert is not yet in React's HTML attribute types.
        inert={open ? undefined : ''}
      >
        <div className="flex items-center justify-between px-2 mb-[34px]">
          <Link href="/dashboard" aria-label="Veil home" onClick={onClose}>
            <VeilWordmark />
          </Link>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            className="rounded-lg p-2 transition-colors duration-150 text-off-white/70 hover:text-off-white hover:bg-surface-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold"
          >
            <X size={20} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable so long lists do not clip on short screens. */}
        <div className="flex-1 overflow-y-auto -mx-5 px-5">{children}</div>
      </div>
    </>
  )
}

export function AppShell({
  children,
  /** APY badge shown against Earn; omitted until a real rate is known. */
  earnBadge,
}: {
  children: ReactNode
  earnBadge?: string
}) {
  const pathname = usePathname() ?? ''
  const [profileName, setProfileName] = useState<string | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [showMultisig, setShowMultisig] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // The hamburger button — used to restore focus when the drawer closes.
  const triggerRef = useRef<HTMLButtonElement>(null)

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    triggerRef.current?.focus()
  }, [])

  // Read on the client only: these live in localStorage, and touching them
  // during render would break hydration.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('veil_user_profile')
      if (raw) {
        const parsed = JSON.parse(raw) as { name?: string }
        if (parsed?.name) setProfileName(parsed.name)
      }
    } catch {
      // A malformed profile is not worth failing navigation over.
    }
    setAddress(walletLocal.getItem('veil_signer_public_key'))
    // The active network comes from localStorage too, so this has to wait for
    // mount like the rest — starting false means the server pass and the first
    // client render agree, and the entry appears only where /multisig works.
    setShowMultisig(isMultisigAvailable())
  }, [])

  // Close the drawer whenever the route changes (the user navigated).
  useEffect(() => {
    setDrawerOpen(false)
  }, [pathname])

  // `/settings` would otherwise light up for `/settings/passkeys` too, so the
  // settings root matches exactly while every other route matches by prefix.
  const isActive = (href: string) =>
    href === '/settings'
      ? pathname === '/settings'
      : pathname === href || pathname.startsWith(`${href}/`)

  const mainItems = NAV_MAIN.map((item) =>
    item.href === '/earn' && earnBadge ? { ...item, badge: earnBadge } : item,
  )

  const footItems = showMultisig ? [NAV_MULTISIG, ...NAV_FOOT] : NAV_FOOT

  const initial = (profileName?.trim()?.[0] ?? 'V').toUpperCase()

  // The nav tree is shared between the desktop sidebar and the mobile drawer.
  const navContent = (onLinkClick?: () => void) => (
    <nav className="flex flex-col gap-[2px]">
      {mainItems.map((item) => (
        <NavRow
          key={item.href}
          item={item}
          active={isActive(item.href)}
          onClick={onLinkClick}
        />
      ))}

      <div className="h-px bg-border-dim mx-2 my-[14px]" />

      {footItems.map((item) => (
        <NavRow
          key={item.href}
          item={item}
          active={isActive(item.href)}
          onClick={onLinkClick}
        />
      ))}
    </nav>
  )

  return (
    <div className="veil-app-shell min-h-screen flex bg-near-black text-off-white">
      {/* ── Desktop sidebar (lg and above) ───────────────────────────────── */}
      <aside className="hidden lg:flex w-[248px] shrink-0 border-r border-border-dim px-5 pt-7 pb-6 flex-col sticky top-0 h-screen">
        <div className="px-2">
          <Link href="/dashboard" aria-label="Veil home">
            <VeilWordmark />
          </Link>
        </div>

        <div className="mt-[34px]">{navContent()}</div>

        <div className="flex-1" />

        <div className="bg-surface border border-border-dim rounded-2xl px-4 py-[14px] flex flex-col gap-[10px]">
          <div className="flex items-center gap-[10px]">
            <div className="w-[30px] h-[30px] rounded-full bg-surface-md border border-border-dim flex items-center justify-center text-xs text-gold font-bold shrink-0">
              {initial}
            </div>
            <div className="flex flex-col gap-px min-w-0">
              <div className="text-[13px] font-semibold whitespace-nowrap truncate">
                {profileName ?? 'Your wallet'}
              </div>
              {address ? (
                <div className="font-mono text-[11px] text-[rgba(246,247,248,0.45)] whitespace-nowrap">
                  {shortAddress(address)}
                </div>
              ) : null}
            </div>
          </div>
          <NetworkSwitcher />
          <CurrencyPicker />
        </div>
      </aside>

      {/* ── Narrow-screen header (below lg) ──────────────────────────────── */}
      {/*
        A single hamburger button replaces the old icon-only overflow strip.
        No destinations are hidden off-screen; the drawer lists them all.
        The bottom TabBar already covers the five most-frequent destinations
        with visible labels.
      */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-30 flex items-center justify-between px-4 h-14 bg-near-black/95 backdrop-blur border-b border-border-dim">
        <Link href="/dashboard" aria-label="Veil home">
          <VeilWordmark size={22} fontSize={16} />
        </Link>

        <button
          ref={triggerRef}
          type="button"
          id="nav-drawer-trigger"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls="nav-drawer"
          onClick={openDrawer}
          className="rounded-lg p-2 transition-colors duration-150 text-off-white/70 hover:text-off-white hover:bg-surface-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold"
        >
          <Menu size={22} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      {/* ── Slide-in nav drawer (narrow viewports only) ──────────────────── */}
      <NavDrawer open={drawerOpen} onClose={closeDrawer}>
        {navContent(closeDrawer)}
      </NavDrawer>

      {/* The header is fixed, so the content column has to reserve its height or
          the last row of every tab route sits underneath it. */}
      <main
        className={`flex-1 min-w-0 px-9 pt-7 pb-10 max-lg:pt-20 max-lg:px-5 flex flex-col${
          showsTabBar(pathname) ? ' max-lg:pb-[calc(72px+env(safe-area-inset-bottom))]' : ''
        }`}
      >
        {children}
      </main>

      <TabBar />
    </div>
  )
}
