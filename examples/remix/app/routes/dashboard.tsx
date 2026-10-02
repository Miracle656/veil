import { useEffect } from 'react'
import type { LoaderFunctionArgs } from '@remix-run/node'
import { Link, useLoaderData, useNavigate, useRevalidator } from '@remix-run/react'
import {
  Keypair,
  Contract,
  Account,
  TransactionBuilder,
  BASE_FEE,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk'
import { getPublicEnv } from '~/lib/config.server'
import { resolveNetwork } from '~/lib/network'

/**
 * Server-side loader: reads the wallet's native (XLM) balance from the Soroban
 * RPC via a read-only simulation. The wallet address comes from the `?address=`
 * search param (the client appends it from localStorage on mount). This runs on
 * the server on every navigation/revalidation — no balance logic in the browser.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const address = new URL(request.url).searchParams.get('address')
  if (!address) return { address: null, balance: null as number | null }

  const net = resolveNetwork(getPublicEnv())
  try {
    const server = new SorobanRpc.Server(net.rpcUrl)
    const sac = new Contract(net.nativeAssetContractId())
    const dummy = new Account(Keypair.random().publicKey(), '0')

    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: net.networkPassphrase,
    })
      .addOperation(sac.call('balance', nativeToScVal(address, { type: 'address' })))
      .setTimeout(30)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (!SorobanRpc.Api.isSimulationError(sim) && sim.result) {
      const stroops = scValToNative(sim.result.retval) as bigint
      return { address, balance: Number(stroops) / 10_000_000 }
    }
    return { address, balance: 0 }
  } catch {
    return { address, balance: 0 }
  }
}

export default function Dashboard() {
  const { address, balance } = useLoaderData<typeof loader>()
  const navigate = useNavigate()
  const revalidator = useRevalidator()

  // On mount, pull the wallet address from localStorage and put it in the URL so
  // the loader can fetch the balance for it.
  useEffect(() => {
    const stored = localStorage.getItem('invisible_wallet_address')
    if (!stored) {
      navigate('/')
    } else if (!address) {
      navigate(`/dashboard?address=${stored}`, { replace: true })
    }
  }, [address, navigate])

  function handleLogout() {
    for (const key of [
      'invisible_wallet_address',
      'invisible_wallet_pubkey',
      'invisible_wallet_credential_id',
      'veil_fee_payer_secret',
    ]) {
      localStorage.removeItem(key)
    }
    navigate('/')
  }

  const shortAddress = address ? `${address.slice(0, 6)}…${address.slice(-6)}` : '—'

  return (
    <main className="page">
      <div className="card stack">
        <div className="row">
          <h1 style={{ fontSize: '1.25rem' }}>Dashboard</h1>
          <div className="spacer" />
          <button
            className="secondary"
            style={{ width: 'auto', border: 'none', fontSize: '0.8rem' }}
            onClick={handleLogout}
          >
            Log out
          </button>
        </div>

        <div>
          <p className="muted">Wallet address</p>
          <p className="mono" style={{ color: '#818cf8' }} title={address ?? ''}>
            {shortAddress}
          </p>
        </div>

        <div>
          <p className="muted">XLM balance (loaded server-side)</p>
          <p style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0.25rem 0' }}>
            {balance === null ? (
              <span className="muted">—</span>
            ) : (
              <>
                {balance.toFixed(7)} <span className="muted" style={{ fontSize: '1rem' }}>XLM</span>
              </>
            )}
          </p>
          <button
            className="secondary"
            style={{ width: 'auto', border: 'none', padding: 0, fontSize: '0.8rem' }}
            onClick={() => revalidator.revalidate()}
          >
            Refresh
          </button>
        </div>

        <Link to="/payment" style={{ textDecoration: 'none' }}>
          <button>Send a payment</button>
        </Link>

        <p className="muted" style={{ textAlign: 'center' }}>Stellar Testnet</p>
      </div>
    </main>
  )
}
