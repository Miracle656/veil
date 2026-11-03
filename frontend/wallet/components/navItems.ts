/**
 * Navigation destination definitions for the Veil app shell.
 *
 * Kept in a separate file so that tests and any future tooling can import the
 * nav-item arrays without pulling in React hooks, Next.js router bindings, or
 * the Stellar SDK chain (walletStorage → network → @stellar/stellar-sdk).
 *
 * Every icon is a distinct lucide-react component.  No Unicode glyphs, no
 * duplicates, no font-coverage surprises.
 */
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowUpDown,
  BanknoteArrowDown,
  BanknoteArrowUp,
  Bot,
  CircleDollarSign,
  CreditCard,
  Fingerprint,
  LayoutGrid,
  House,
  Settings,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = {
  href: string
  label: string
  /** lucide-react icon component — one per destination, no duplicates. */
  Icon: LucideIcon
  badge?: string
}

/**
 * Primary navigation destinations.
 *
 * Buy with naira sits directly above Cash out: they are the two halves of the
 * naira rail and reading one without the other makes the wallet look one-way.
 */
export const NAV_MAIN: NavItem[] = [
  { href: '/dashboard', label: 'Home',           Icon: House             },
  { href: '/send',      label: 'Send',            Icon: ArrowUpRight      },
  { href: '/receive',   label: 'Receive',         Icon: ArrowDownLeft     },
  { href: '/swap',      label: 'Swap',            Icon: ArrowUpDown       },
  { href: '/buy-ngn',   label: 'Buy with naira',  Icon: BanknoteArrowDown },
  { href: '/cashout',   label: 'Cash out',        Icon: BanknoteArrowUp   },
  { href: '/earn',      label: 'Earn',            Icon: CircleDollarSign  },
  { href: '/bills',     label: 'Bills & airtime', Icon: CreditCard        },
  { href: '/dapps',     label: 'dApps',           Icon: LayoutGrid        },
  { href: '/agent',     label: 'Agent',           Icon: Bot               },
]

export const NAV_FOOT: NavItem[] = [
  { href: '/contacts',          label: 'Contacts', Icon: Users       },
  { href: '/settings/passkeys', label: 'Passkeys', Icon: Fingerprint },
  { href: '/settings',          label: 'Settings', Icon: Settings    },
]

/**
 * Only offered where the multisig contract is actually installed (#672). It
 * goes in the footer group rather than NAV_MAIN because it is an advanced,
 * occasional flow. Uses Wallet rather than the ◈ glyph that was duplicated
 * between /dapps and /multisig in the old icon-only strip.
 */
export const NAV_MULTISIG: NavItem = {
  href: '/multisig',
  label: 'Multisig',
  Icon: Wallet,
}
