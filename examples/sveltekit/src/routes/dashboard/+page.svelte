<script lang="ts">
	import { wallet, RPC_URL, NETWORK_PASSPHRASE } from '$lib/wallet';
	import { onMount } from 'svelte';
	import { Contract, Asset, TransactionBuilder, Account, Keypair, BASE_FEE, rpc as SorobanRpc, scValToNative, nativeToScVal } from '@stellar/stellar-sdk';

	let balance = $state<string>('0.0000');
	let localError = $state<string | null>(null);
	let loadingBalance = $state(false);
	let funding = $state(false);

	let walletAddress = $derived($wallet.walletAddress);
	let isDeployed = $derived($wallet.isDeployed);

	// Load balance when wallet address changes or on mount
	$effect(() => {
		if (walletAddress) {
			fetchBalance();
		}
	});

	async function fetchBalance() {
		if (!walletAddress) return;
		loadingBalance = true;
		localError = null;
		try {
			const server = new SorobanRpc.Server(RPC_URL);
			const sacContractId = Asset.native().contractId(NETWORK_PASSPHRASE);
			const sacContract = new Contract(sacContractId);
			
			// Build a dummy transaction to simulate checking the balance of the wallet
			const dummyKey = Keypair.random();
			const sourceAccount = new Account(dummyKey.publicKey(), '0');

			const tx = new TransactionBuilder(sourceAccount, {
				fee: BASE_FEE,
				networkPassphrase: NETWORK_PASSPHRASE,
			})
				.addOperation(
					sacContract.call(
						'balance', 
						nativeToScVal(walletAddress, { type: 'address' })
					)
				)
				.setTimeout(30)
				.build();

			const sim = await server.simulateTransaction(tx);
			if (SorobanRpc.Api.isSimulationError(sim)) {
				// If contract is not found/not deployed yet, balance is 0
				balance = '0.0000';
				return;
			}

			if (sim.result) {
				const balanceStroops = scValToNative(sim.result.retval) as bigint;
				balance = (Number(balanceStroops) / 10_000_000).toFixed(4);
			} else {
				balance = '0.0000';
			}
		} catch (err: any) {
			console.error('Error fetching balance:', err);
			// Fallback if simulation fails (e.g. before wallet contract deployment)
			balance = '0.0000';
		} finally {
			loadingBalance = false;
		}
	}

	async function handleFund() {
		if (!walletAddress) return;
		funding = true;
		localError = null;
		try {
			const friendbotUrl = `https://friendbot.stellar.org?addr=${encodeURIComponent(walletAddress)}`;
			const resp = await fetch(friendbotUrl);
			if (!resp.ok) {
				throw new Error('Friendbot funding request failed. Try again in a moment.');
			}
			// Refresh balance after funding
			await new Promise(r => setTimeout(r, 3000));
			await fetchBalance();
		} catch (err: any) {
			localError = err.message || String(err);
		} finally {
			funding = false;
		}
	}

	async function handleLogin() {
		localError = null;
		try {
			const res = await wallet.login();
			if (!res) {
				localError = 'No wallet found in localStorage. Please Register first.';
			}
		} catch (err: any) {
			localError = err.message || String(err);
		}
	}
</script>

<div class="card">
	<div class="header-row">
		<h1 class="card-title">Dashboard</h1>
		{#if walletAddress}
			<button class="btn-refresh" onclick={fetchBalance} disabled={loadingBalance} aria-label="Refresh balance">
				<svg class:spinning={loadingBalance} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
				</svg>
			</button>
		{/if}
	</div>

	{#if localError}
		<div class="alert alert-error">
			<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
				<path d="M10 18a8 8 0 100-16 8 8 0 000 16zM10 6v5M10 14h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			<span>{localError}</span>
		</div>
	{/if}

	{#if !walletAddress}
		<div class="connect-box">
			<p>No active wallet session detected in this browser.</p>
			<div class="actions">
				<a href="/register" class="btn-primary">Register New Wallet</a>
				<button class="btn-secondary" onclick={handleLogin}>Restore Session</button>
			</div>
		</div>
	{:else}
		<div class="dashboard-grid">
			<!-- Balance Card -->
			<div class="dashboard-metric-card">
				<span class="metric-label">XLM BALANCE</span>
				<div class="balance-container">
					<span class="balance-val">{balance}</span>
					<span class="balance-denom">XLM</span>
				</div>
				<button class="btn-fund btn-secondary" onclick={handleFund} disabled={funding}>
					{#if funding}
						<div class="spinner spinner-sm"></div>
						Funding...
					{:else}
						Fund Wallet (Friendbot)
					{/if}
				</button>
			</div>

			<!-- Wallet Status Card -->
			<div class="dashboard-info-card">
				<div class="info-row">
					<span class="info-label">Address</span>
					<span class="info-value font-mono break-all">{walletAddress}</span>
				</div>
				<div class="info-row">
					<span class="info-label">Deployment</span>
					<span class="info-value">
						{#if isDeployed}
							<span class="status-pill status-pill-success">Active on Testnet</span>
						{:else}
							<span class="status-pill status-pill-warn">Not Deployed</span>
						{/if}
					</span>
				</div>
				<div class="info-row">
					<span class="info-label">Network</span>
					<span class="info-value">Stellar Testnet</span>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.header-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.btn-refresh {
		background: none;
		border: none;
		color: #9ca3af;
		cursor: pointer;
		padding: 0.5rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s ease;
	}

	.btn-refresh:hover {
		background: rgba(255, 255, 255, 0.05);
		color: white;
	}

	.spinning {
		animation: spin 1s linear infinite;
	}

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

	.actions {
		display: flex;
		justify-content: center;
		gap: 1rem;
	}

	.dashboard-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1.5rem;
	}

	@media (min-width: 640px) {
		.dashboard-grid {
			grid-template-columns: 1.2fr 1.8fr;
		}
	}

	.dashboard-metric-card {
		background: linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(20, 24, 46, 0.4) 100%);
		border: 1px solid rgba(99, 102, 241, 0.15);
		border-radius: 16px;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 1rem;
	}

	.metric-label {
		font-size: 0.7rem;
		font-weight: 700;
		color: #818cf8;
		letter-spacing: 0.05em;
	}

	.balance-container {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.balance-val {
		font-size: 2.25rem;
		font-weight: 700;
		color: white;
	}

	.balance-denom {
		font-size: 1rem;
		font-weight: 600;
		color: #9ca3af;
	}

	.btn-fund {
		font-size: 0.85rem;
		padding: 0.6rem 1rem;
		width: 100%;
		border-radius: 10px;
	}

	.spinner-sm {
		width: 14px;
		height: 14px;
	}

	.dashboard-info-card {
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid rgba(255, 255, 255, 0.05);
		border-radius: 16px;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.info-row {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.info-label {
		font-size: 0.7rem;
		font-weight: 700;
		color: #6b7280;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.info-value {
		font-size: 0.95rem;
		color: #f3f4f6;
	}

	.status-pill {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.2rem 0.6rem;
		border-radius: 9999px;
		display: inline-block;
	}

	.status-pill-success {
		background: rgba(16, 185, 129, 0.15);
		color: #34d399;
		border: 1px solid rgba(16, 185, 129, 0.3);
	}

	.status-pill-warn {
		background: rgba(245, 158, 11, 0.15);
		color: #fbbf24;
		border: 1px solid rgba(245, 158, 11, 0.3);
	}

	.break-all {
		word-break: break-all;
	}

	.font-mono {
		font-family: 'JetBrains Mono', monospace;
	}
</style>
