<script lang="ts">
	import { onMount } from 'svelte';
	import { wallet } from '$lib/wallet';
	import { page } from '$app/state';

	let { children } = $props();

	// Automatically try to restore session on mount
	onMount(async () => {
		try {
			await wallet.login();
		} catch (e) {
			// Ignore auto-login errors on initial load
		}
	});

	// Reactive subscription to store for status indicator
	let status = $derived($wallet.status);
	let walletAddress = $derived($wallet.walletAddress);
</script>

<svelte:head>
	<title>Veil Invisible Wallet — SvelteKit Adapter</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="true">
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
</svelte:head>

<div class="app-container">
	<!-- Dynamic Background Gradients -->
	<div class="bg-glow bg-glow-1"></div>
	<div class="bg-glow bg-glow-2"></div>

	<!-- Navigation Bar -->
	<header class="navbar">
		<div class="nav-content">
			<div class="logo">
				<span class="logo-text">VEIL</span>
				<span class="logo-badge">SVELTEKIT</span>
			</div>
			
			<nav class="nav-links">
				<a href="/register" class="nav-link" class:active={page.url.pathname === '/register'}>Register</a>
				<a href="/dashboard" class="nav-link" class:active={page.url.pathname === '/dashboard' || page.url.pathname === '/'}>Dashboard</a>
				<a href="/send" class="nav-link" class:active={page.url.pathname === '/send'}>Send</a>
			</nav>

			<div class="wallet-status-badge">
				{#if status === 'pending'}
					<span class="status-dot status-pending"></span>
					<span class="status-text">Processing</span>
				{:else if walletAddress}
					<span class="status-dot status-connected"></span>
					<span class="status-text font-mono">{walletAddress.slice(0, 5)}...{walletAddress.slice(-5)}</span>
				{:else}
					<span class="status-dot status-disconnected"></span>
					<span class="status-text">Disconnected</span>
				{/if}
			</div>
		</div>
	</header>

	<!-- Main Content Slot -->
	<main class="main-content">
		{@render children()}
	</main>

	<!-- Footer -->
	<footer class="footer">
		<p>Powered by <span>Veil Invisible Wallet SDK</span> &amp; Stellar Soroban</p>
	</footer>
</div>

<style>
	:global(html), :global(body) {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
		background-color: #0b0d19;
		color: #f3f4f6;
		font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		overflow-x: hidden;
	}

	:global(*) {
		box-sizing: border-box;
	}

	.app-container {
		position: relative;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		z-index: 1;
		background: radial-gradient(circle at 50% 0%, #151a30 0%, #0b0d19 70%);
	}

	/* Dynamic glows */
	.bg-glow {
		position: absolute;
		width: 600px;
		height: 600px;
		border-radius: 50%;
		filter: blur(160px);
		opacity: 0.15;
		z-index: -1;
		pointer-events: none;
	}

	.bg-glow-1 {
		background: #6366f1;
		top: -100px;
		left: 10%;
		animation: pulse-glow 15s infinite alternate;
	}

	.bg-glow-2 {
		background: #d946ef;
		bottom: 10%;
		right: 10%;
		animation: pulse-glow 20s infinite alternate-reverse;
	}

	@keyframes pulse-glow {
		0% { transform: scale(1) translate(0, 0); opacity: 0.12; }
		100% { transform: scale(1.2) translate(50px, 50px); opacity: 0.22; }
	}

	/* Navbar styling */
	.navbar {
		backdrop-filter: blur(20px);
		-webkit-backdrop-filter: blur(20px);
		background: rgba(13, 17, 34, 0.7);
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		position: sticky;
		top: 0;
		z-index: 100;
	}

	.nav-content {
		max-width: 1100px;
		margin: 0 auto;
		padding: 1.25rem 2rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.logo-text {
		font-size: 1.5rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		background: linear-gradient(135deg, #a5b4fc 0%, #818cf8 50%, #6366f1 100%);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
	}

	.logo-badge {
		background: rgba(99, 102, 241, 0.15);
		border: 1px solid rgba(99, 102, 241, 0.3);
		color: #a5b4fc;
		font-size: 0.65rem;
		font-weight: 700;
		padding: 0.15rem 0.5rem;
		border-radius: 4px;
		letter-spacing: 0.05em;
	}

	.nav-links {
		display: flex;
		gap: 2rem;
	}

	.nav-link {
		color: #9ca3af;
		text-decoration: none;
		font-size: 0.95rem;
		font-weight: 500;
		transition: all 0.2s ease;
		padding: 0.35rem 0;
		position: relative;
	}

	.nav-link::after {
		content: '';
		position: absolute;
		bottom: 0;
		left: 0;
		width: 0;
		height: 2px;
		background: #6366f1;
		transition: width 0.2s ease;
	}

	.nav-link:hover {
		color: #f3f4f6;
	}

	.nav-link.active {
		color: #818cf8;
		font-weight: 600;
	}

	.nav-link.active::after {
		width: 100%;
	}

	.wallet-status-badge {
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(255, 255, 255, 0.08);
		padding: 0.5rem 1rem;
		border-radius: 9999px;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.status-connected {
		background-color: #10b981;
		box-shadow: 0 0 8px #10b981;
	}

	.status-pending {
		background-color: #f59e0b;
		box-shadow: 0 0 8px #f59e0b;
		animation: pulse-status 1.5s infinite alternate;
	}

	.status-disconnected {
		background-color: #ef4444;
	}

	@keyframes pulse-status {
		0% { opacity: 0.5; }
		100% { opacity: 1; }
	}

	.font-mono {
		font-family: 'JetBrains Mono', monospace;
	}

	/* Main Content container */
	.main-content {
		flex: 1;
		max-width: 800px;
		width: 100%;
		margin: 0 auto;
		padding: 3rem 2rem;
		display: flex;
		flex-direction: column;
		justify-content: center;
	}

	/* Footer styling */
	.footer {
		text-align: center;
		padding: 2rem;
		border-top: 1px solid rgba(255, 255, 255, 0.05);
		font-size: 0.85rem;
		color: #6b7280;
	}

	.footer span {
		color: #9ca3af;
		font-weight: 500;
	}

	/* Global Svelte transition or utilities */
	:global(.card) {
		background: rgba(20, 24, 46, 0.6);
		border: 1px solid rgba(255, 255, 255, 0.08);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		border-radius: 20px;
		padding: 2.5rem;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
		transition: all 0.3s ease;
	}

	:global(.card-title) {
		font-size: 1.75rem;
		font-weight: 700;
		margin-top: 0;
		margin-bottom: 1.5rem;
		background: linear-gradient(to right, #ffffff, #9ca3af);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
	}

	:global(.btn-primary) {
		background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
		border: none;
		color: white;
		padding: 0.85rem 1.75rem;
		border-radius: 12px;
		font-weight: 600;
		font-size: 1rem;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		transition: all 0.2s ease;
		box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
	}

	:global(.btn-primary:hover:not(:disabled)) {
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4);
		background: linear-gradient(135deg, #818cf8 0%, #4f46e5 100%);
	}

	:global(.btn-primary:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}

	:global(.btn-secondary) {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		color: #e5e7eb;
		padding: 0.85rem 1.75rem;
		border-radius: 12px;
		font-weight: 600;
		font-size: 1rem;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		transition: all 0.2s ease;
	}

	:global(.btn-secondary:hover:not(:disabled)) {
		background: rgba(255, 255, 255, 0.1);
		border-color: rgba(255, 255, 255, 0.2);
		color: white;
	}

	:global(.input-group) {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	:global(.input-label) {
		font-size: 0.85rem;
		font-weight: 600;
		color: #9ca3af;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	:global(.input-control) {
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.1);
		color: white;
		padding: 0.85rem 1.25rem;
		border-radius: 12px;
		font-size: 1rem;
		outline: none;
		transition: all 0.2s ease;
		font-family: inherit;
	}

	:global(.input-control:focus) {
		border-color: #6366f1;
		box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
		background: rgba(255, 255, 255, 0.06);
	}

	:global(.input-control::placeholder) {
		color: #4b5563;
	}

	:global(.alert) {
		border-radius: 12px;
		padding: 1rem 1.25rem;
		font-size: 0.9rem;
		margin-bottom: 1.5rem;
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		line-height: 1.4;
	}

	:global(.alert-error) {
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.2);
		color: #f87171;
	}

	:global(.alert-success) {
		background: rgba(16, 185, 129, 0.1);
		border: 1px solid rgba(16, 185, 129, 0.2);
		color: #34d399;
	}

	:global(.alert-info) {
		background: rgba(99, 102, 241, 0.1);
		border: 1px solid rgba(99, 102, 241, 0.2);
		color: #a5b4fc;
	}

	/* Spinner animation */
	:global(.spinner) {
		width: 20px;
		height: 20px;
		border: 2px solid rgba(255, 255, 255, 0.2);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
