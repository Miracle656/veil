<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Keypair } from '@stellar/stellar-sdk'
import { appConfig } from '../lib/config'
import { readFeePayerSecret } from '../lib/feePayer'
import { wallet } from '../lib/wallet'

const { address, isDeployed, isPending, login, getBalance } = wallet

const balance = ref<bigint | null>(null)
const localError = ref<string | null>(null)

const feePayerPublicKey = computed(() => {
  const secret = readFeePayerSecret()
  return secret ? Keypair.fromSecret(secret).publicKey() : null
})

/** Contract balances are integers in stroops — 1 XLM = 10,000,000 stroops. */
const balanceXlm = computed(() =>
  balance.value === null ? null : (Number(balance.value) / 10_000_000).toFixed(7),
)

const explorerUrl = computed(() =>
  address.value ? `${appConfig.explorerBaseUrl}/contract/${address.value}` : null,
)

async function refresh() {
  localError.value = null
  try {
    // Restore the session first: it confirms the contract exists on-chain and
    // flips `isDeployed`, which getBalance needs.
    if (!address.value) await login()
    if (!address.value) return

    const result = await getBalance()
    balance.value = result.amount
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(refresh)
</script>

<template>
  <section class="panel">
    <p class="eyebrow">Dashboard</p>
    <h2>Your wallet</h2>

    <div v-if="!address" class="stack">
      <p class="lede">No wallet on this device yet — register one first.</p>
    </div>

    <div v-else class="stack">
      <div class="field">
        <span>Wallet contract</span>
        <p class="mono break">{{ address }}</p>
        <a v-if="explorerUrl" :href="explorerUrl" target="_blank" rel="noreferrer">
          View on the explorer
        </a>
      </div>

      <div class="field">
        <span>Status</span>
        <p>{{ isDeployed ? 'Deployed on-chain' : 'Not deployed yet' }}</p>
      </div>

      <div class="field">
        <span>Balance</span>
        <p class="balance">{{ balanceXlm === null ? '—' : `${balanceXlm} XLM` }}</p>
      </div>

      <div v-if="feePayerPublicKey" class="field">
        <span>Fee payer</span>
        <p class="mono break">{{ feePayerPublicKey }}</p>
      </div>

      <button class="secondary" :disabled="isPending" @click="refresh">
        {{ isPending ? 'Refreshing…' : 'Refresh balance' }}
      </button>

      <p v-if="localError" class="notice error">{{ localError }}</p>
    </div>
  </section>
</template>
