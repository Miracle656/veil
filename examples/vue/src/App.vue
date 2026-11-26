<script setup lang="ts">
import { ref } from 'vue'
import DashboardView from './views/DashboardView.vue'
import RegisterView from './views/RegisterView.vue'
import SendView from './views/SendView.vue'
import { wallet } from './lib/wallet'

type Tab = 'register' | 'dashboard' | 'send'

const tabs: { id: Tab; label: string }[] = [
  { id: 'register',  label: 'Register' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'send',      label: 'Send' },
]

// A real app would reach for vue-router here; a plain ref keeps the starter's
// focus on the wallet composable.
const tab = ref<Tab>('register')

// `address` is a ref straight off the composable, so the header updates itself
// the moment register() or login() resolves — no manual wiring.
const { address, isPending } = wallet
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Veil</p>
        <h1>Vite + Vue 3 starter</h1>
      </div>
      <nav class="nav">
        <button
          v-for="item in tabs"
          :key="item.id"
          :class="{ active: tab === item.id }"
          @click="tab = item.id"
        >
          {{ item.label }}
        </button>
      </nav>
    </header>

    <p class="status">
      <template v-if="address">
        Signed in as <span class="mono break">{{ address }}</span>
      </template>
      <template v-else>No wallet yet</template>
      <span v-if="isPending" class="pending"> · working…</span>
    </p>

    <main class="content">
      <RegisterView v-if="tab === 'register'" @done="tab = 'dashboard'" />
      <DashboardView v-else-if="tab === 'dashboard'" />
      <SendView v-else />
    </main>

    <footer class="footer">
      Passkey wallet starter · <code>invisible-wallet-sdk/vue</code>
    </footer>
  </div>
</template>
