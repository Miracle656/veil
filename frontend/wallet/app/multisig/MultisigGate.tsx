'use client'

/**
 * Reachability gate for `/multisig` (issue #672).
 *
 * The multisig WASM is installed on testnet and not on mainnet, so on mainnet
 * the deploy wizard cannot succeed — it would fail at the signature, after the
 * user has entered signers and a threshold. This component makes the route
 * unreachable there rather than merely unlinked: children are never rendered
 * on an unsupported network, so `Wizard` never mounts and no deploy handler
 * ever exists to be called.
 *
 * Why the guard is a client component rather than middleware or a server
 * redirect: the active network lives in `localStorage` (`veil_network`), which
 * only the browser can read. A server-side gate would decide from the build's
 * `NEXT_PUBLIC_NETWORK` default and get the answer wrong for exactly the user
 * this protects — one who switched to mainnet at runtime. `NetworkSwitcher`
 * resolves the same problem the same way.
 *
 * Nothing renders before mount for the usual reason: the server pass has no
 * `localStorage`, so rendering the page there and hiding it on hydration would
 * be a mismatch, and would flash the wizard.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'

import { getMultisigDeployment } from '@/lib/multisigConfig'
import { getNetwork } from '@/lib/network'

type GateState =
  | { phase: 'checking' }
  | { phase: 'allowed' }
  | { phase: 'blocked'; networkLabel: string }

export function MultisigGate({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<GateState>({ phase: 'checking' })

  useEffect(() => {
    const deployment = getMultisigDeployment()

    if (deployment.status === 'available') {
      setState({ phase: 'allowed' })
      return
    }

    // An unusable hash is a deployment mistake, not a policy decision, so say
    // so loudly instead of letting it look like the deliberate mainnet gate.
    if (deployment.status === 'invalid') {
      console.error(`[multisig] ${deployment.reason}`)
    } else {
      console.info(`[multisig] ${deployment.reason}`)
    }

    setState({ phase: 'blocked', networkLabel: getNetwork().displayName })

    // Send the user somewhere that works. `replace` keeps the dead URL out of
    // history, so Back does not bounce them into the gate again.
    router.replace('/dashboard')
  }, [router])

  if (state.phase === 'allowed') return <>{children}</>

  // The blocked branch is a redirect receipt, not a destination — it explains
  // what happened for the moment before the router lands on /dashboard, and
  // for the case where a user has JS routing stalled.
  return (
    <div className="wallet-shell">
      <main className="wallet-main" style={{ paddingTop: '3rem', paddingBottom: '3rem' }}>
        {state.phase === 'blocked' ? (
          <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border-dim)' }}>
            <h1
              style={{
                fontFamily: 'Lora, Georgia, serif',
                fontWeight: 600,
                fontStyle: 'italic',
                fontSize: '1.25rem',
                color: 'var(--off-white)',
                marginBottom: '0.5rem',
              }}
            >
              Multisig is not available on {state.networkLabel}
            </h1>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', lineHeight: 1.5 }}>
              The multisig contract has not been installed on this network, so a wallet
              cannot be deployed here. Switch to a network where it is available.
              Taking you back to your dashboard.
            </p>
          </div>
        ) : null}
      </main>
    </div>
  )
}
