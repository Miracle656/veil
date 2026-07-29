<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Keypair, Horizon } from '@stellar/stellar-sdk';
  import { wallet } from '$lib/wallet';
  import { friendbotUrl, horizonUrl } from '$lib/network';

  type Step = 'idle' | 'registering' | 'funding' | 'deploying' | 'done' | 'error';

  let username = '';
  let step: Step = 'idle';
  let errorMsg: string | null = null;

  const stepLabel: Record<Step, string> = {
    idle: '',
    registering: 'Creating passkey…',
    funding: 'Funding fee-payer via Friendbot…',
    deploying: 'Deploying wallet on Stellar…',
    done: 'Done!',
    error: '',
  };

  // If a wallet already exists on this device, skip straight to the dashboard.
  onMount(() => {
    if (localStorage.getItem('invisible_wallet_address')) {
      goto('/dashboard');
    }
  });

  async function handleCreate() {
    errorMsg = null;
    try {
      // 1. Register the passkey and compute the wallet address.
      step = 'registering';
      await wallet.register(username || undefined);

      // 2. Generate + fund a fee-payer keypair (pays fees, does NOT own the wallet).
      step = 'funding';
      const feePayer = Keypair.random();
      localStorage.setItem('veil_fee_payer_secret', feePayer.secret());

      if (friendbotUrl) {
        const res = await fetch(`${friendbotUrl}?addr=${feePayer.publicKey()}`);
        if (!res.ok) throw new Error('Friendbot funding failed — try again in a moment.');
      } else {
        const horizon = new Horizon.Server(horizonUrl);
        await horizon.loadAccount(feePayer.publicKey()).catch(() => {
          throw new Error(
            `Mainnet requires a funded fee-payer. Fund ${feePayer.publicKey()} with XLM then retry.`
          );
        });
      }

      // 3. Deploy the wallet contract through the factory.
      step = 'deploying';
      await wallet.deploy(feePayer.secret());

      step = 'done';
      goto('/dashboard');
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      step = 'error';
    }
  }

  async function handleLogin() {
    errorMsg = null;
    const result = await wallet.login();
    if (result) {
      goto('/dashboard');
    } else {
      errorMsg = 'No wallet found on this device. Create one first.';
    }
  }

  $: busy = step !== 'idle' && step !== 'done' && step !== 'error';
</script>

<main class="page">
  <div class="card stack">
    <div style="text-align: center">
      <h1>Veil Wallet</h1>
      <p class="muted">Passkey-powered · SvelteKit · Stellar Testnet</p>
    </div>

    <input
      bind:value={username}
      type="text"
      placeholder="Username (optional)"
      disabled={busy}
    />

    <button disabled={busy} on:click={handleCreate}>
      {busy ? stepLabel[step] : 'Create wallet with passkey'}
    </button>

    <button class="secondary" disabled={busy} on:click={handleLogin}>
      I already have a wallet
    </button>

    {#if errorMsg}
      <p class="alert error">{errorMsg}</p>
    {/if}

    <p class="muted" style="text-align: center">
      Your key never leaves your device. Powered by WebAuthn passkeys.
    </p>
  </div>
</main>
