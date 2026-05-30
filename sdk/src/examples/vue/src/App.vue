<script setup lang="ts">
import { ref } from 'vue';
import { useInvisibleWallet } from '@veil/invisible-wallet-vue';
import { Keypair, Networks } from '@stellar/stellar-sdk';

const username = ref('');
const signerSecret = ref('');
const recipient = ref('');
const amount = ref('');
const token = ref('');
const statusMessage = ref('');

const wallet = useInvisibleWallet({
  factoryAddress: import.meta.env.VITE_FACTORY_ADDRESS || '',
  rpcUrl: import.meta.env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase: import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET,
});

const withStatus = async (label: string, fn: () => Promise<void>) => {
  statusMessage.value = `${label}...`;
  try {
    await fn();
    statusMessage.value = `${label} succeeded.`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    statusMessage.value = `${label} failed: ${message}`;
  }
};

const handleRegister = () =>
  withStatus('Register', async () => {
    const result = await wallet.register(username.value || undefined);
    statusMessage.value = `Registered: ${result.walletAddress}`;
  });

const handleLogin = () =>
  withStatus('Login', async () => {
    const result = await wallet.login();
    statusMessage.value = result
      ? `Logged in: ${result.walletAddress}`
      : 'No stored wallet found.';
  });

const handleDeploy = () =>
  withStatus('Deploy', async () => {
    if (!signerSecret.value) throw new Error('Signer secret key is required');
    const keypair = Keypair.fromSecret(signerSecret.value);
    const result = await wallet.deploy(keypair);
    statusMessage.value = result.alreadyDeployed
      ? `Already deployed at ${result.walletAddress}`
      : `Deployed at ${result.walletAddress}`;
  });

const handleSend = () =>
  withStatus('Approve (send)', async () => {
    if (!signerSecret.value) throw new Error('Signer secret key is required');
    if (!recipient.value) throw new Error('Recipient address is required');
    if (!token.value) throw new Error('Token address is required');
    if (!amount.value || isNaN(Number(amount.value))) throw new Error('Valid amount is required');
    const keypair = Keypair.fromSecret(signerSecret.value);
    await wallet.approve(keypair, recipient.value, token.value, Number(amount.value));
    statusMessage.value = `Approved ${amount.value} of token ${token.value} to ${recipient.value}`;
  });
</script>

<template>
  <div class="container">
    <h1>Veil Invisible Wallet — Vue 3 Demo</h1>

    <section class="status-bar">
      <h2>Wallet Status</h2>
      <p><strong>Address:</strong> {{ wallet.address ?? 'Not registered' }}</p>
      <p><strong>Deployed:</strong> {{ wallet.isDeployed }}</p>
      <p v-if="wallet.isPending" class="pending">Loading...</p>
      <p v-if="wallet.error" class="error">Error: {{ wallet.error }}</p>
      <p v-if="statusMessage" class="info">{{ statusMessage }}</p>
    </section>

    <section>
      <h2>Register</h2>
      <p class="hint">Creates a new passkey and derives a Stellar wallet address.</p>
      <input v-model="username" placeholder="Username (optional)" />
      <button :disabled="wallet.isPending" @click="handleRegister">Register</button>
    </section>

    <section>
      <h2>Login</h2>
      <p class="hint">Restores wallet from localStorage using your passkey.</p>
      <button :disabled="wallet.isPending" @click="handleLogin">Login</button>
    </section>

    <section>
      <h2>Deploy</h2>
      <p class="hint">Deploys the smart wallet contract on-chain.</p>
      <input v-model="signerSecret" placeholder="Signer secret key (S...)" type="password" />
      <button :disabled="wallet.isPending" @click="handleDeploy">Deploy</button>
    </section>

    <section>
      <h2>Send (Approve)</h2>
      <p class="hint">Approves a token transfer — demonstrates a signed on-chain transaction.</p>
      <input v-model="signerSecret" placeholder="Signer secret key (S...)" type="password" />
      <input v-model="recipient" placeholder="Recipient address (G...)" />
      <input v-model="token" placeholder="Token contract address (C...)" />
      <input v-model="amount" placeholder="Amount" type="number" min="0" />
      <button :disabled="wallet.isPending" @click="handleSend">Send</button>
    </section>
  </div>
</template>

<style scoped>
.container {
  max-width: 680px;
  margin: 40px auto;
  padding: 0 20px;
  font-family: sans-serif;
}

h1 {
  font-size: 1.4rem;
  margin-bottom: 24px;
}

section {
  margin-bottom: 20px;
  padding: 16px;
  border: 1px solid #ddd;
  border-radius: 8px;
}

h2 {
  font-size: 1rem;
  margin: 0 0 8px;
}

.hint {
  font-size: 0.85rem;
  color: #666;
  margin: 0 0 10px;
}

input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 0.9rem;
}

button {
  padding: 8px 18px;
  background: #5b5ef4;
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
}

button:hover:not(:disabled) {
  background: #4344d4;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.status-bar {
  background: #f9f9f9;
}

.pending {
  color: #888;
}

.error {
  color: #c0392b;
}

.info {
  color: #2980b9;
}
</style>
