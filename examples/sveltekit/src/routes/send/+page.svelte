<script lang="ts">
	import { wallet } from '$lib/wallet';
	import { Keypair } from '@stellar/stellar-sdk';

	let recipient = $state('');
	let amount = $state('');
	let feePayerSecret = $state('');
	
	let status = $state<'idle' | 'funding' | 'signing' | 'submitting' | 'success' | 'error'>('idle');
	let txHash = $state<string | null>(null);
	let localError = $state<string | null>(null);

	let walletAddress = $derived($wallet.walletAddress);
	let isDeployed = $derived($wallet.isDeployed);

	async function handleSend() {
		localError = null;
		txHash = null;
		
		if (!recipient) {
			localError = 'Recipient address is required.';
			return;
		}
		if (!amount || parseFloat(amount) <= 0) {
			localError = 'Please enter a valid amount greater than 0.';
			return;
		}

		try {
			let feePayerKey: Keypair;
			
			if (feePayerSecret) {
				try {
					feePayerKey = Keypair.fromSecret(feePayerSecret);
				} catch (e) {
					throw new Error('Invalid fee payer secret key.');
				}
			} else {
				status = 'funding';
				// Automatically generate and fund a fee payer keypair
				feePayerKey = Keypair.random();
				const friendbotUrl = `https://friendbot.stellar.org?addr=${encodeURIComponent(feePayerKey.publicKey())}`;
				const resp = await fetch(friendbotUrl);
				if (!resp.ok) {
					throw new Error('Failed to fund auto-generated fee payer via Friendbot.');
				}
			}

			status = 'signing';
			
			// Use our SDK Svelte send helper which handles:
			// 1. Transaction creation
			// 2. Simulation to discover auth entries
			// 3. WebAuthn Passkey prompt signing
			// 4. Submitting and waiting for confirmation
			const hash = await wallet.send(recipient, amount, feePayerKey);
			
			txHash = hash;
			status = 'success';
			recipient = '';
			amount = '';
		} catch (err: any) {
			localError = err.message || String(err);
			status = 'error';
		}
	}
</script>

<div class="card">
	<h1 class="card-title">Send Assets</h1>

	{#if localError}
		<div class="alert alert-error">
			<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
				<path d="M10 18a8 8 0 100-16 8 8 0 000 16zM10 6v5M10 14h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			<span>{localError}</span>
		</div>
	{/if}

	{#if status === 'success' && txHash}
		<div class="alert alert-success">
			<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
				<path d="M10 18a8 8 0 100-16 8 8 0 000 16zM6 10l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			<div>
				<h4 style="margin: 0; font-weight: 600;">Transaction Sent Successfully!</h4>
				<p class="font-mono" style="margin: 0.25rem 0; font-size: 0.75rem; word-break: break-all; opacity: 0.9;">
					Hash: {txHash}
				</p>
				<a 
					href={`https://stellar.expert/explorer/testnet/tx/${txHash}`} 
					target="_blank" 
					rel="noreferrer"
					class="explorer-link"
				>
					View on Stellar Expert Explorer ↗
				</a>
			</div>
		</div>
	{/if}

	{#if !walletAddress}
		<div class="connect-box">
			<p>No active wallet session detected. Please register or login first.</p>
			<a href="/register" class="btn-primary">Register Wallet</a>
		</div>
	{:else if !isDeployed}
		<div class="connect-box">
			<p>Your wallet contract is registered but not yet deployed on-chain.</p>
			<a href="/register" class="btn-primary">Deploy Wallet Contract</a>
		</div>
	{:else}
		<div class="send-form">
			<!-- Recipient -->
			<div class="input-group">
				<label class="input-label" for="recipient-input">Recipient Address</label>
				<input 
					id="recipient-input"
					type="text" 
					class="input-control font-mono" 
					placeholder="G... or C..." 
					bind:value={recipient}
					disabled={status !== 'idle' && status !== 'success' && status !== 'error'}
				/>
			</div>

			<!-- Amount -->
			<div class="input-group">
				<label class="input-label" for="amount-input">Amount (XLM)</label>
				<input 
					id="amount-input"
					type="number" 
					step="0.00001" 
					min="0"
					class="input-control" 
					placeholder="0.00" 
					bind:value={amount}
					disabled={status !== 'idle' && status !== 'success' && status !== 'error'}
				/>
			</div>

			<!-- Fee Payer Secret (Optional) -->
			<div class="input-group">
				<div class="label-row">
					<label class="input-label" for="feepayer-input">Fee Payer Secret Key</label>
					<span class="label-tag">Optional</span>
				</div>
				<input 
					id="feepayer-input"
					type="password" 
					class="input-control font-mono" 
					placeholder="S... (Leave blank to auto-fund a temporary account)" 
					bind:value={feePayerSecret}
					disabled={status !== 'idle' && status !== 'success' && status !== 'error'}
				/>
			</div>

			<button 
				class="btn-primary send-btn" 
				onclick={handleSend}
				disabled={status !== 'idle' && status !== 'success' && status !== 'error'}
			>
				{#if status === 'funding'}
					<div class="spinner"></div>
					Funding Fee Payer Account...
				{:else if status === 'signing'}
					<div class="spinner"></div>
					Approve Biometric Passkey Prompt...
				{:else if status === 'submitting'}
					<div class="spinner"></div>
					Submitting to Stellar Testnet...
				{:else}
					Send Transfer
				{/if}
			</button>
		</div>
	{/if}
</div>

<style>
	.connect-box {
		text-align: center;
		padding: 2rem;
		background: rgba(255, 255, 255, 0.02);
		border: 1px dashed rgba(255, 255, 255, 0.1);
		border-radius: 16px;
	}

	.connect-box p {
		color: #9ca3af;
		margin-bottom: 1.5rem;
	}

	.send-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.label-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.label-tag {
		font-size: 0.65rem;
		background: rgba(255, 255, 255, 0.06);
		color: #9ca3af;
		padding: 0.15rem 0.4rem;
		border-radius: 4px;
		font-weight: 500;
	}

	.send-btn {
		margin-top: 1rem;
		padding: 1rem;
	}

	.explorer-link {
		color: #a5b4fc;
		font-size: 0.8rem;
		text-decoration: none;
		font-weight: 500;
	}

	.explorer-link:hover {
		color: white;
		text-decoration: underline;
	}

	.font-mono {
		font-family: 'JetBrains Mono', monospace;
	}
</style>
