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
 * Below 1100px the sidebar collapses to a top bar, because the design is
 * specified at 1440px and a 248px rail plus content does not fit a laptop
 * half-screen.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'

import { CurrencyPicker } from './CurrencyPicker'
import { NetworkSwitcher } from './NetworkSwitcher'
import { TabBar, showsTabBar } from './ui/TabBar'
import { VeilWordmark } from './ui/VeilMark'

type NavItem = {
  href: string
  label: string
  /** Typographic glyph from the design — deliberately not an emoji. */
  icon: string
  badge?: string
}

const NAV_MAIN: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: '⌂' },
  { href: '/send', label: 'Send', icon: '↗' },
  { href: '/receive', label: 'Receive', icon: '↙' },
  { href: '/swap', label: 'Swap', icon: '⇅' },
  { href: '/earn', label: 'Earn', icon: '◎' },
  { href: '/bills', label: 'Bills & airtime', icon: '▤' },
  { href: '/agent', label: 'Agent', icon: '✦' },
]

const NAV_FOOT: NavItem[] = [
  { href: '/contacts', label: 'Contacts', icon: '◫' },
  { href: '/settings/passkeys', label: 'Passkeys', icon: '⬡' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
]

/** Shorten a Stellar address for the sidebar chip: `GDKF…9QX3`. */
function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className="flex items-center justify-between rounded-xl px-[14px] py-[11px] transition-colors duration-150"
      style={{
        background: active ? 'var(--surface-md)' : 'transparent',
        border: `1px solid ${active ? 'var(--gold)' : 'transparent'}`,
        color: active ? 'var(--gold)' : 'rgba(246,247,248,0.72)',
        fontWeight: active ? 600 : 400,
      }}
    >
      <span className="flex items-center gap-3">
        <span className="text-[15px] w-[18px] text-center">{item.icon}</span>
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
  }, [])

  // `/settings` would otherwise light up for `/settings/passkeys` too, so the
  // settings root matches exactly while every other route matches by prefix.
  const isActive = (href: string) =>
    href === '/settings' ? pathname === '/settings' : pathname === href || pathname.startsWith(`${href}/`)

  const mainItems = NAV_MAIN.map((item) =>
    item.href === '/earn' && earnBadge ? { ...item, badge: earnBadge } : item,
  )

  const initial = (profileName?.trim()?.[0] ?? 'V').toUpperCase()

  return (
    <div className="veil-app-shell min-h-screen flex bg-near-black text-off-white">
      <aside className="hidden lg:flex w-[248px] shrink-0 border-r border-border-dim px-5 pt-7 pb-6 flex-col sticky top-0 h-screen">
        <div className="px-2">
          <Link href="/dashboard" aria-label="Veil home">
            <VeilWordmark />
          </Link>
        </div>

        <nav className="flex flex-col gap-[2px] mt-[34px]">
          {mainItems.map((item) => (
            <NavRow key={item.href} item={item} active={isActive(item.href)} />
          ))}

          <div className="h-px bg-border-dim mx-2 my-[14px]" />

          {NAV_FOOT.map((item) => (
            <NavRow key={item.href} item={item} active={isActive(item.href)} />
          ))}
        </nav>

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

      {/* Compact chrome for narrow viewports, where the rail does not fit. */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-30 flex items-center gap-4 px-4 h-14 bg-near-black/95 backdrop-blur border-b border-border-dim">
        <Link href="/dashboard" aria-label="Veil home">
          <VeilWordmark size={22} fontSize={16} />
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {mainItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? 'page' : undefined}
              aria-label={item.label}
              className="px-3 py-2 rounded-lg text-[15px] shrink-0"
              style={{
                color: isActive(item.href) ? 'var(--gold)' : 'rgba(246,247,248,0.6)',
                background: isActive(item.href) ? 'var(--surface-md)' : 'transparent',
              }}
            >
              {item.icon}
            </Link>
          ))}
        </nav>
      </header>

      {/* The bar is fixed, so the content column has to reserve its height or
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
