<script setup lang="ts">
import { computed, ref } from 'vue'
import { appConfig } from '../lib/config'
import { ensureFundedFeePayer } from '../lib/feePayer'
import { wallet } from '../lib/wallet'

const emit = defineEmits<{ done: [] }>()

// Renamed so it does not collide with this view's own validation message.
const { address, isDeployed, isPending, error: walletError, register, deploy, login } = wallet

const username = ref('Veil User')
const step = ref<'idle' | 'registering' | 'funding' | 'deploying'>('idle')
const localError = ref<string | null>(null)

const busy = computed(() => isPending.value || step.value !== 'idle')

const stepLabel = computed(() => ({
  idle:        'Create wallet with passkey',
  registering: 'Waiting for your passkey…',
  funding:     'Funding the fee payer…',
  deploying:   'Deploying the wallet contract…',
}[step.value]))

async function handleRegister() {
  localError.value = null

  if (!appConfig.factoryAddress) {
    localError.value = 'Set VITE_FACTORY_ADDRESS in .env.local before running the starter.'
    return
  }

  try {
    // 1. Create the passkey. This computes the wallet's deterministic address
    //    without touching the network — `address` becomes non-null right away.
    step.value = 'registering'
    const { publicKeyBytes } = await register(username.value.trim() || 'Veil User')

    // 2. The fee payer pays network fees; the passkey still owns the wallet.
    step.value = 'funding'
    const feePayer = await ensureFundedFeePayer()

    // 3. Deploy the wallet contract through the factory.
    step.value = 'deploying'
    await deploy(feePayer.secret(), publicKeyBytes)

    emit('done')
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err)
  } finally {
    step.value = 'idle'
  }
}

async function handleLogin() {
  localError.value = null
  const session = await login()
  if (session) {
    emit('done')
  } else if (!walletError.value) {
    localError.value = 'No wallet found on this device. Create one first.'
  }
}
</script>

<template>
  <section class="panel">
    <p class="eyebrow">Register</p>
    <h2>Create a passkey wallet</h2>
    <p class="lede">
      Register a WebAuthn credential, fund a fee payer, and deploy the wallet
      contract — three calls on the composable.
    </p>

    <div class="stack">
      <label class="field">
        <span>Display name</span>
        <input v-model="username" :disabled="busy" placeholder="Veil User" />
      </label>

      <button class="primary" :disabled="busy" @click="handleRegister">
        {{ stepLabel }}
      </button>

      <button class="secondary" :disabled="busy" @click="handleLogin">
        I already have a wallet
      </button>

      <p v-if="localError" class="notice error">{{ localError }}</p>
      <p v-else-if="walletError" class="notice error">{{ walletError }}</p>

      <p v-if="address" class="notice success">
        Wallet <span class="mono break">{{ address }}</span>
        {{ isDeployed ? 'is live on-chain.' : 'computed — deploy to put it on-chain.' }}
      </p>
    </div>
  </section>
</template>
