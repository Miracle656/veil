<script lang="ts">
	import { wallet } from '$lib/wallet';
	import { Keypair } from '@stellar/stellar-sdk';
	import { goto } from '$app/navigation';

	let username = $state('');
	let localError = $state<string | null>(null);
	let deployHash = $state<string | null>(null);
	
	let registering = $state(false);
	let deploying = $state(false);
	let funding = $state(false);

	let walletAddress = $derived($wallet.walletAddress);
	let isDeployed = $derived($wallet.isDeployed);

	async function handleRegister() {
		localError = null;
		registering = true;
		try {
			await wallet.register(username || 'Veil Svelte User');
		} catch (err: any) {
			localError = err.message || String(err);
		} finally {
			registering = false;
		}
	}

	async function handleDeploy() {
		localError = null;
		deployHash = null;
		deploying = true;
		funding = true;
		try {
			// 1. Generate random keypair for fee payer
			const feePayer = Keypair.random();
			
			// 2. Fund fee payer via Friendbot
			const friendbotUrl = `https://friendbot.stellar.org?addr=${encodeURIComponent(feePayer.publicKey())}`;
			const resp = await fetch(friendbotUrl);
			if (!resp.ok) {
				throw new Error('Failed to fund fee payer account via Friendbot.');
			}
			funding = false;

			// 3. Call SDK deploy function which handles simulation, signature, and submission
			const result = await wallet.deploy(feePayer);
			deployHash = 'Simulated/On-Chain Deploy Success!'; // A friendly success indicator
			
			// Add a delay and redirect to dashboard
			setTimeout(() => {
				goto('/dashboard');
			}, 2000);

		} catch (err: any) {
			localError = err.message || String(err);
		} finally {
			deploying = false;
			funding = false;
		}
	}
</script>

<div class="card">
	<h1 class="card-title">Register Invisible Wallet</h1>

	{#if localError}
		<div class="alert alert-error">
			<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
				<path d="M10 18a8 8 0 100-16 8 8 0 000 16zM10 6v5M10 14h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			<span>{localError}</span>
		</div>
	{/if}

	{#if deployHash}
		<div class="alert alert-success">
			<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
				<path d="M10 18a8 8 0 100-16 8 8 0 000 16zM6 10l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			<div>
				<h4 style="margin: 0; font-weight: 600;">Deployment Successful!</h4>
				<p style="margin: 0.25rem 0 0 0; font-size: 0.8rem; opacity: 0.8;">Redirecting to Dashboard...</p>
			</div>
		</div>
	{/if}

	<div class="stages">
		<!-- Stage 1: Passkey Registration -->
		<div class="stage-card" class:active={!walletAddress}>
			<div class="stage-header">
				<span class="stage-num">1</span>
				<h3 class="stage-title">Create Passkey Credential</h3>
			</div>

			{#if !walletAddress}
				<p class="stage-desc">
					Choose a username and click register. Your browser will prompt you to create a secure, biometric passkey.
				</p>
				<div class="input-group">
					<label class="input-label" for="username-input">Username</label>
					<input 
						id="username-input"
						type="text" 
						class="input-control" 
						placeholder="e.g. Satoshi" 
						bind:value={username}
						disabled={registering}
					/>
				</div>
				<button 
					class="btn-primary" 
					onclick={handleRegister} 
					disabled={registering}
				>
					{#if registering}
						<div class="spinner"></div>
						Generating Passkey...
					{:else}
						Register Passkey
					{/if}
				</button>
			{:else}
				<div class="success-box">
					<div class="success-header">
						<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" style="color: #10b981;">
							<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
						</svg>
						<span style="font-weight: 600; color: #34d399;">Passkey Registered Successfully</span>
					</div>
					<div class="address-display">
						<span class="addr-label">WALLET ADDRESS</span>
						<span class="addr-value font-mono">{walletAddress}</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Stage 2: On-Chain Deployment -->
		<div class="stage-card" class:active={walletAddress && !isDeployed} class:disabled={!walletAddress}>
			<div class="stage-header">
				<span class="stage-num">2</span>
				<h3 class="stage-title">Deploy Contract On-Chain</h3>
			</div>

			<p class="stage-desc">
				Deploy your smart contract wallet to the Stellar Testnet. We'll fund a fee-payer account automatically via Friendbot to pay the deployment fees.
			</p>

			{#if walletAddress}
				{#if isDeployed}
					<div class="success-box">
						<div class="success-header">
							<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" style="color: #10b981;">
								<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
							</svg>
							<span style="font-weight: 600; color: #34d399;">Smart Contract Active on Testnet</span>
						</div>
					</div>
				{:else}
					<button 
						class="btn-primary" 
						onclick={handleDeploy} 
						disabled={deploying}
					>
						{#if deploying}
							<div class="spinner"></div>
							{#if funding}
								Funding Fee Payer...
							{:else}
								Deploying Contract...
							{/if}
						{:else}
							Deploy Wallet Contract
						{/if}
					</button>
				{/if}
			{:else}
				<div class="lock-indicator">
					<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" style="opacity: 0.5;">
						<path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/>
					</svg>
					<span>Complete Step 1 to unlock deployment</span>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.stages {
		display: flex;
		flex-direction: column;
		gap: 2rem;
		margin-top: 1rem;
	}

	.stage-card {
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid rgba(255, 255, 255, 0.05);
		border-radius: 16px;
		padding: 1.5rem;
		transition: all 0.3s ease;
	}

	.stage-card.active {
		background: rgba(255, 255, 255, 0.04);
		border-color: rgba(99, 102, 241, 0.2);
		box-shadow: 0 4px 20px rgba(99, 102, 241, 0.05);
	}

	.stage-card.disabled {
		opacity: 0.4;
		pointer-events: none;
	}

	.stage-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.stage-num {
		background: rgba(255, 255, 255, 0.1);
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		font-weight: 700;
		font-size: 0.85rem;
		color: #a5b4fc;
	}

	.stage-card.active .stage-num {
		background: #6366f1;
		color: white;
		box-shadow: 0 0 10px rgba(99, 102, 241, 0.5);
	}

	.stage-title {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
	}

	.stage-desc {
		margin: 0 0 1.25rem 0;
		font-size: 0.9rem;
		color: #9ca3af;
		line-height: 1.5;
	}

	.success-box {
		background: rgba(16, 185, 129, 0.06);
		border: 1px solid rgba(16, 185, 129, 0.15);
		border-radius: 12px;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.success-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
	}

	.address-display {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.addr-label {
		font-size: 0.7rem;
		font-weight: 700;
		color: #9ca3af;
		letter-spacing: 0.05em;
	}

	.addr-value {
		font-size: 0.85rem;
		color: #e5e7eb;
		word-break: break-all;
	}

	.lock-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		color: #6b7280;
	}

	.font-mono {
		font-family: 'JetBrains Mono', monospace;
	}
</style>
