<script setup lang="ts">
import { ref } from 'vue'
import { Keypair, Horizon } from '@stellar/stellar-sdk'

type Step = 'idle' | 'registering' | 'funding' | 'deploying' | 'done' | 'error'

const { register, deploy } = useInvisibleWallet()
const { friendbotUrl, horizonUrl } = useNetwork()

const username = ref('')
const step = ref<Step>('idle')
const errorMsg = ref<string | null>(null)

const stepLabel: Record<Step, string> = {
  idle: '',
  registering: 'Creating passkey…',
  funding: 'Funding fee-payer via Friendbot…',
  deploying: 'Deploying wallet on Stellar…',
  done: 'Done!',
  error: '',
}

// If a wallet already exists on this device, skip straight to the dashboard.
onMounted(() => {
  if (localStorage.getItem('invisible_wallet_address')) {
    navigateTo('/dashboard')
  }
})

async function handleCreate() {
  errorMsg.value = null
  try {
    // 1. Register the passkey and compute the wallet address.
    step.value = 'registering'
    await register(username.value || undefined)

    // 2. Generate + fund a fee-payer keypair (pays fees, does NOT own the wallet).
    step.value = 'funding'
    const feePayer = Keypair.random()
    localStorage.setItem('veil_fee_payer_secret', feePayer.secret())

    if (friendbotUrl) {
      const res = await fetch(`${friendbotUrl}?addr=${feePayer.publicKey()}`)
      if (!res.ok) throw new Error('Friendbot funding failed — try again in a moment.')
    } else {
      const horizon = new Horizon.Server(horizonUrl)
      await horizon.loadAccount(feePayer.publicKey()).catch(() => {
        throw new Error(
          `Mainnet requires a funded fee-payer. Fund ${feePayer.publicKey()} with XLM then retry.`,
        )
      })
    }

    // 3. Deploy the wallet contract through the factory.
    step.value = 'deploying'
    await deploy(feePayer.secret())

    step.value = 'done'
    navigateTo('/dashboard')
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
    step.value = 'error'
  }
}

function handleLogin() {
  errorMsg.value = null
  if (localStorage.getItem('invisible_wallet_address')) {
    navigateTo('/dashboard')
  } else {
    errorMsg.value = 'No wallet found on this device. Create one first.'
  }
}

const busy = computed(() => step.value !== 'idle' && step.value !== 'done' && step.value !== 'error')
</script>

<template>
  <main class="page">
    <div class="card stack">
      <div style="text-align: center">
        <h1>Veil Wallet</h1>
        <p class="muted">Passkey-powered · Nuxt 3 · Stellar Testnet</p>
      </div>

      <ClientOnly>
        <input
          v-model="username"
          type="text"
          placeholder="Username (optional)"
          :disabled="busy"
        />

        <button :disabled="busy" @click="handleCreate">
          {{ busy ? stepLabel[step] : 'Create wallet with passkey' }}
        </button>

        <button class="secondary" :disabled="busy" @click="handleLogin">
          I already have a wallet
        </button>

        <p v-if="errorMsg" class="alert error">{{ errorMsg }}</p>

        <template #fallback>
          <p class="muted">Loading wallet…</p>
        </template>
      </ClientOnly>

      <p class="muted" style="text-align: center">
        Your key never leaves your device. Powered by WebAuthn passkeys.
      </p>
    </div>
  </main>
</template>
