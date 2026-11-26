<script setup lang="ts">
import { computed, ref } from 'vue'
import { appConfig } from '../lib/config'
import { readFeePayerSecret } from '../lib/feePayer'
import { wallet } from '../lib/wallet'

const { address, isPending, sendPayment } = wallet

const recipient = ref('')
const amount = ref('1')
const memo = ref('')
const txHash = ref('')
const localError = ref<string | null>(null)

const explorerUrl = computed(() =>
  txHash.value ? `${appConfig.explorerBaseUrl}/tx/${txHash.value}` : null,
)

async function handleSend() {
  localError.value = null
  txHash.value = ''

  const feePayerSecret = readFeePayerSecret()

  if (!address.value) {
    localError.value = 'Create a wallet first.'
    return
  }
  if (!feePayerSecret) {
    localError.value = 'No fee payer on this device. Register the wallet again.'
    return
  }
  if (!recipient.value.startsWith('G') && !recipient.value.startsWith('C')) {
    localError.value = 'Enter a Stellar address starting with G or C.'
    return
  }

  const parsed = Number(amount.value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    localError.value = 'Enter a positive amount.'
    return
  }

  try {
    // sendPayment simulates the transfer, has the passkey sign the Soroban
    // authorization entry (this is the biometric prompt), then submits and
    // polls for confirmation.
    const result = await sendPayment(
      feePayerSecret,
      recipient.value.trim(),
      BigInt(Math.round(parsed * 10_000_000)), // XLM → stroops
      undefined,                               // native XLM; pass a C… address for a token
      memo.value.trim() || undefined,
    )
    txHash.value = result.transactionHash
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <section class="panel">
    <p class="eyebrow">Send</p>
    <h2>Transfer XLM</h2>
    <p class="lede">
      Moves XLM out of the wallet contract. Your passkey authorizes the transfer;
      the fee payer only covers network fees.
    </p>

    <div class="stack">
      <label class="field">
        <span>Recipient</span>
        <input v-model="recipient" :disabled="isPending" placeholder="G… or C…" />
      </label>

      <label class="field">
        <span>Amount (XLM)</span>
        <input v-model="amount" :disabled="isPending" inputmode="decimal" placeholder="1.0" />
      </label>

      <label class="field">
        <span>Memo</span>
        <input v-model="memo" :disabled="isPending" placeholder="Optional" />
      </label>

      <button class="primary" :disabled="isPending" @click="handleSend">
        {{ isPending ? 'Waiting for your passkey…' : 'Send' }}
      </button>

      <p v-if="localError" class="notice error">{{ localError }}</p>

      <p v-if="txHash" class="notice success">
        Sent — <span class="mono break">{{ txHash }}</span>
        <a v-if="explorerUrl" :href="explorerUrl" target="_blank" rel="noreferrer">view</a>
      </p>
    </div>
  </section>
</template>
