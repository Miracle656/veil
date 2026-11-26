<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { wallet } from '$lib/wallet';

  let to = '';
  let amount = '';
  let memo = '';
  let busy = false;
  let feePayerSecret: string | null = null;
  let errorMsg: string | null = null;
  let txHash: string | null = null;

  onMount(() => {
    if (!localStorage.getItem('invisible_wallet_address')) {
      goto('/');
      return;
    }
    feePayerSecret = sessionStorage.getItem('veil_fee_payer_key');
  });

  async function handleSend() {
    errorMsg = null;
    txHash = null;

    if (!feePayerSecret) {
      errorMsg = 'No fee-payer key found on this device. Create a wallet first.';
      return;
    }

    busy = true;
    try {
      // Native XLM uses 7 decimal places (stroops).
      const amountStroops = BigInt(Math.round(Number(amount) * 10_000_000));
      const result = await wallet.sendPayment(feePayerSecret, to, amountStroops, undefined, memo || undefined);
      txHash = result.transactionHash;
      to = '';
      amount = '';
      memo = '';
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<main class="page">
  <div class="card stack">
    <div style="display: flex; justify-content: space-between; align-items: center">
      <h1 style="font-size: 1.25rem">Send</h1>
      <button
        class="secondary"
        style="width: auto; border: none; font-size: 0.8rem"
        on:click={() => goto('/dashboard')}
      >
        Back
      </button>
    </div>

    <input bind:value={to} type="text" placeholder="Recipient address (G... or C...)" disabled={busy} />
    <input bind:value={amount} type="number" min="0" step="0.0000001" placeholder="Amount (XLM)" disabled={busy} />
    <input bind:value={memo} type="text" placeholder="Memo (optional)" disabled={busy} />

    <button disabled={busy || !to || !amount} on:click={handleSend}>
      {busy ? ($wallet.isPending ? 'Confirm with passkey…' : 'Sending…') : 'Send payment'}
    </button>

    {#if txHash}
      <p class="alert success">Sent! Transaction: <span class="mono">{txHash.slice(0, 12)}…</span></p>
    {/if}

    {#if errorMsg}
      <p class="alert error">{errorMsg}</p>
    {/if}

    <p class="muted" style="text-align: center">
      Signs a Soroban authorization entry with your passkey, then submits the
      transfer paid for by the device's fee-payer key.
    </p>
  </div>
</main>
