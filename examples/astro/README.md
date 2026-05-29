# Veil Astro Integration Example

A static Astro landing page demonstrating Veil's passkey wallet running as a React island with Astro's partial hydration architecture.

## About Island Architecture

Astro's island architecture allows interactive components to be hydrated independently. This example shows how Veil's React widget can be embedded in a static landing page that remains lightweight until the user interacts with the wallet.

### How It Works

```astro
---
import '../styles/global.css';
import VeilWidget from '../components/VeilWidget.tsx';
---
<VeilWidget client:load />
```

The `client:load` directive hydrates the React component immediately after the page loads. For deferred hydration after the main thread is idle, use `client:idle`. For hydration only when the component enters the viewport, use `client:visible`.

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Environment Variables**
   Create `.env` from `.env.example`:
   ```bash
   cp .env.example .env
   ```

   Required variables:
   - `PUBLIC_FACTORY_ADDRESS`: The Veil factory contract address (deploy to testnet first)
   - `PUBLIC_RPC_URL`: Soroban RPC endpoint (defaults to testnet)
   - `PUBLIC_NETWORK_PASSPHRASE`: Stellar network passphrase

3. **Start the App**
   ```bash
   npm run dev
   ```

## Usage

- **Connect with Passkey**: Registers a new passkey credential and computes your deterministic invisible wallet address
- **Sign Auth Entry**: After registration, you can sign a test payload to verify WebAuthn assertion works

## Project Structure

```text
/
├── src/
│   ├── components/
│   │   └── VeilWidget.tsx   # React island with passkey wallet logic
│   ├── pages/
│   │   └── index.astro      # Static landing page with embedded island
│   └── styles/
│       └── global.css       # Tailwind CSS imports
├── .env.example
├── astro.config.mjs         # Astro + React integration config
├── postcss.config.mjs       # Tailwind CSS PostCSS config
├── tailwind.config.js       # Tailwind CSS config
└── package.json
```