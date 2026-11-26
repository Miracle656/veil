'use client'

/**
 * The bottom tab bar from the redesign: five destinations, always reachable.
 *
 * Only the tab roots get it. A pushed flow — send, receive, a settings
 * subpage, a token detail — is a task the user is meant to finish or back out
 * of, and a tab bar under it invites them to abandon it half-done.
 *
 * Narrow viewports only: above `lg` the shell already carries a persistent
 * sidebar with these five plus everything else, and a second nav bar pinned to
 * the bottom of a 1440px window is not what the design asks for.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowUpDown, Coins, House, Settings, Sparkles, type LucideIcon } from 'lucide-react'

type Tab = {
  href: string
  label: string
  Icon: LucideIcon
}

const TABS: Tab[] = [
  { href: '/dashboard', label: 'Home',     Icon: House },
  { href: '/assets',    label: 'Assets',   Icon: Coins },
  { href: '/swap',      label: 'Swap',     Icon: ArrowUpDown },
  { href: '/agent',     label: 'Agent',    Icon: Sparkles },
  { href: '/settings',  label: 'Settings', Icon: Settings },
]

/**
 * Whether `pathname` is one of the tab roots.
 *
 * Matched exactly rather than by prefix: `/settings/passkeys` is reached by
 * pushing from `/settings`, so it is a pushed flow by the same rule that
 * excludes `/send`, and `/token/XLM` must not light up a tab either.
 */
export function showsTabBar(pathname: string): boolean {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return TABS.some((tab) => tab.href === trimmed)
}

export function TabBar() {
  const pathname = usePathname() ?? ''
  if (!showsTabBar(pathname)) return null

  return (
    <nav
      aria-label="Primary"
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 flex items-stretch border-t border-border-dim bg-near-black/95 backdrop-blur"
      // The inset reads 0 until the document opts into `viewport-fit=cover`;
      // the floor keeps the row off the very edge of a device without one.
      style={{ paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}
    >
      {TABS.map(({ href, label, Icon }) => {
        const active = pathname === href
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className="flex-1 flex flex-col items-center gap-[3px] pt-[10px] pb-[6px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold"
            style={{ color: active ? 'var(--gold)' : 'rgba(246,247,248,0.55)' }}
          >
            {/* The link's accessible name is the visible label below it, so the
                glyph is decorative to a screen reader. */}
            <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
            <span
              className="text-[10.5px] leading-none"
              style={{ fontWeight: active ? 600 : 500, letterSpacing: '0.01em' }}
            >
              {label}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
