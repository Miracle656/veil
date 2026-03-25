# Veil Demo

Minimal Next.js end-to-end testnet demo for passkey wallet registration and deployment.

## Setup Steps

1. **Install Dependencies**
   From the `demo/` folder, install required packages:
   ```bash
   npm install
   ```

2. **Environment Variables**
   Ensure `.env.local` is present in the `demo/` folder with the following variables:
   ```env
   NEXT_PUBLIC_FACTORY_ADDRESS=YOUR_FACTORY_ADDRESS
   NEXT_PUBLIC_RPC_URL=https://soroban-testnet.stellar.org
   NEXT_PUBLIC_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
   ```

3. **Start the App**
   Run the local development server:
   ```bash
   npm run dev
   ```

## Workflow

1. **Register**: Creates a new passkey credential and calculates your deterministic Invisible Wallet address.
2. **Deploy to Testnet**: Generates a random `Keypair`, automatically funds it using [Friendbot](https://friendbot.stellar.org), and submits a factory transaction to Stellar Testnet to actually deploy your wallet on-chain. Wait for the success metric and use the Stellar Expert link to view it.
3. **Sign Authority Entry**: Signs a 32-byte payload to emulate a Soroban transaction authorization using the passkey generated during registration. Raw assertions are displayed so you can verify `WebAuthnSignature` parts required by the contract.
