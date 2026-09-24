<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    Keypair,
    Contract,
    Account,
    TransactionBuilder,
    BASE_FEE,
    rpc as SorobanRpc,
    nativeToScVal,
    scValToNative,
  } from '@stellar/stellar-sdk';
  import { rpcUrl, networkPassphrase, nativeAssetContractId } from '$lib/network';

  let address: string | null = null;
  let xlmBalance: number | null = null;
  let loading = true;
  let copied = false;

  async function fetchBalance(walletAddress: string) {
    loading = true;
    try {
      const server = new SorobanRpc.Server(rpcUrl);
      const sac = new Contract(nativeAssetContractId());
      const dummy = new Account(Keypair.random().publicKey(), '0');

      const tx = new TransactionBuilder(dummy, { fee: BASE_FEE, networkPassphrase })
        .addOperation(sac.call('balance', nativeToScVal(walletAddress, { type: 'address' })))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!SorobanRpc.Api.isSimulationError(sim) && sim.result) {
        const stroops = scValToNative(sim.result.retval) as bigint;
        xlmBalance = Number(stroops) / 10_000_000;
      } else {
        xlmBalance = 0;
      }
    } catch {
      xlmBalance = 0;
    } finally {
      loading = false;
    }
  }

  function handleCopy() {
    if (!address) return;
    navigator.clipboard.writeText(address);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function handleLogout() {
    for (const key of [
      'invisible_wallet_address',
      'invisible_wallet_pubkey',
      'invisible_wallet_credential_id',
    ]) {
      localStorage.removeItem(key);
    }
    sessionStorage.removeItem('veil_fee_payer_key');
    goto('/');
  }

  onMount(() => {
    const stored = localStorage.getItem('invisible_wallet_address');
    if (!stored) {
      goto('/');
      return;
    }
    address = stored;
    fetchBalance(stored);
  });

  $: shortAddress = address ? `${address.slice(0, 6)}…${address.slice(-6)}` : '—';
</script>

<main class="page">
  <div class="card stack">
    <div style="display: flex; justify-content: space-between; align-items: center">
      <h1 style="font-size: 1.25rem">Dashboard</h1>
      <button
        class="secondary"
        style="width: auto; border: none; font-size: 0.8rem"
        on:click={handleLogout}
      >
        Log out
      </button>
    </div>

    <div>
      <p class="muted">Wallet address</p>
      <button
        class="secondary mono"
        style="width: auto; border: none; padding: 0; color: #818cf8"
        title={address ?? ''}
        on:click={handleCopy}
      >
        {shortAddress} {copied ? '✓' : '⎘'}
      </button>
    </div>

    <div>
      <p class="muted">XLM balance</p>
      <p style="font-size: 1.5rem; font-weight: 700; margin: 0.25rem 0">
        {#if loading}
          <span class="muted">—</span>
        {:else}
          {(xlmBalance ?? 0).toFixed(7)} <span class="muted" style="font-size: 1rem">XLM</span>
        {/if}
      </p>
      <button
        class="secondary"
        style="width: auto; border: none; padding: 0; font-size: 0.8rem"
        on:click={() => address && fetchBalance(address)}
      >
        Refresh
      </button>
    </div>

    <button on:click={() => goto('/send')}>Send payment</button>

    <p class="muted" style="text-align: center">Stellar Testnet</p>
  </div>
</main>
