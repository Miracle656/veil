<script setup lang="ts">
import { ref } from 'vue'
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

const { logout } = useInvisibleWallet()
const { rpcUrl, networkPassphrase, nativeAssetContractId } = useNetwork()
const route = useRoute()

const address = ref<string | null>(null)
const xlmBalance = ref<number | null>(null)
const loading = ref(true)
const copied = ref(false)
const depositing = ref(false)
const banner = ref<{ kind: 'success' | 'error'; text: string } | null>(null)

async function fetchBalance(walletAddress: string) {
  loading.value = true
  try {
    const server = new SorobanRpc.Server(rpcUrl)
    const sac = new Contract(nativeAssetContractId())
    const dummy = new Account(Keypair.random().publicKey(), '0')

    const tx = new TransactionBuilder(dummy, { fee: BASE_FEE, networkPassphrase })
      .addOperation(sac.call('balance', nativeToScVal(walletAddress, { type: 'address' })))
      .setTimeout(30)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (!SorobanRpc.Api.isSimulationError(sim) && sim.result) {
      const stroops = scValToNative(sim.result.retval) as bigint
      xlmBalance.value = Number(stroops) / 10_000_000
    } else {
      xlmBalance.value = 0
    }
  } catch {
    xlmBalance.value = 0
  } finally {
    loading.value = false
  }
}

// Initiate a SEP-24 interactive deposit. The server route talks to the anchor
// and returns the interactive URL plus the anchor transaction id; we open the
// URL in a popup. When the user finishes, the anchor redirects to
// /api/sep24/callback, which lands them back here with a ?deposit=... banner.
async function startDeposit() {
  if (!address.value) return
  banner.value = null
  depositing.value = true
  try {
    const { url } = await $fetch<{ url: string; id: string }>('/api/sep24/deposit', {
      method: 'POST',
      body: { account: address.value, assetCode: 'SRT' },
    })
    window.open(url, 'veil-sep24', 'width=480,height=720')
  } catch (err) {
    banner.value = {
      kind: 'error',
      text: err instanceof Error ? err.message : 'Could not start the deposit.',
    }
  } finally {
    depositing.value = false
  }
}

function handleCopy() {
  if (!address.value) return
  navigator.clipboard.writeText(address.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

function handleLogout() {
  logout()
  navigateTo('/')
}

onMounted(() => {
  const stored = localStorage.getItem('invisible_wallet_address')
  if (!stored) {
    navigateTo('/')
    return
  }
  address.value = stored
  fetchBalance(stored)

  // Surface the result the SEP-24 callback redirected back with.
  const deposit = route.query.deposit as string | undefined
  if (deposit) {
    const done = deposit === 'completed'
    banner.value = {
      kind: done ? 'success' : 'error',
      text: done
        ? `Deposit completed (txn ${route.query.id ?? '—'}).`
        : `Deposit status: ${deposit}.`,
    }
  }
})

const shortAddress = computed(() =>
  address.value ? `${address.value.slice(0, 6)}…${address.value.slice(-6)}` : '—',
)
</script>

<template>
  <main class="page">
    <div class="card stack">
      <div style="display: flex; justify-content: space-between; align-items: center">
        <h1 style="font-size: 1.25rem">Dashboard</h1>
        <button
          class="secondary"
          style="width: auto; border: none; font-size: 0.8rem"
          @click="handleLogout"
        >
          Log out
        </button>
      </div>

      <ClientOnly>
        <p v-if="banner" class="alert" :class="banner.kind">{{ banner.text }}</p>

        <div>
          <p class="muted">Wallet address</p>
          <button
            class="secondary mono"
            style="width: auto; border: none; padding: 0; color: #818cf8"
            :title="address ?? ''"
            @click="handleCopy"
          >
            {{ shortAddress }} {{ copied ? '✓' : '⎘' }}
          </button>
        </div>

        <div>
          <p class="muted">XLM balance</p>
          <p style="font-size: 1.5rem; font-weight: 700; margin: 0.25rem 0">
            <span v-if="loading" class="muted">—</span>
            <span v-else>{{ (xlmBalance ?? 0).toFixed(7) }} <span class="muted" style="font-size: 1rem">XLM</span></span>
          </p>
          <button
            class="secondary"
            style="width: auto; border: none; padding: 0; font-size: 0.8rem"
            @click="address && fetchBalance(address)"
          >
            Refresh
          </button>
        </div>

        <button :disabled="depositing" @click="startDeposit">
          {{ depositing ? 'Opening anchor…' : 'Deposit via anchor (SEP-24)' }}
        </button>

        <template #fallback>
          <p class="muted">Loading wallet…</p>
        </template>
      </ClientOnly>

      <p class="muted" style="text-align: center">Stellar Testnet</p>
    </div>
  </main>
</template>
