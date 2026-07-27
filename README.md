[![CI](https://github.com/Miracle656/veil/actions/workflows/ci.yml/badge.svg)](https://github.com/Miracle656/veil/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-black)](https://stellar.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A passkey-powered smart wallet on the Stellar Soroban blockchain. Users authenticate with their device biometrics (Face ID, fingerprint, Windows Hello) instead of seed phrases or private keys.

## How it works

Veil combines WebAuthn (the browser passkey standard) with a Soroban custom account contract. When a user registers, a P-256 keypair is created on their device and the public key is stored in the wallet contract. To authorize a transaction, the user's device signs the Soroban authorization payload with their passkey. The contract verifies the full WebAuthn assertion on-chain — including the challenge binding and the ECDSA signature — before approving any action.



## Architecture

```mermaid
graph TD
    subgraph Browser["Browser (WebAuthn)"]
        UA["User Agent\n(Face ID / Fingerprint)"]
        SDK["invisible-wallet-sdk\n(React hook)"]
    end

    subgraph Wallet["Veil Wallet PWA (Next.js)"]
        UI["Dashboard / Send / Swap UI"]
        FP["Fee-Payer G… account\n(HKDF-derived from passkey)"]
    end

    subgraph Stellar["Stellar Network (Soroban)"]
        CONTRACT["Smart Wallet Contract C…\n(__check_auth: P-256 ECDSA verify)"]
        FACTORY["Factory Contract\n(deploy wallet instances)"]
        SAC["Native XLM SAC\n(token balances)"]
    end

    subgraph Services["Backend Services"]
        LENS["Lens\nPrice oracle (x402 gated)\nGET /price/:assetA/:assetB"]
        WRAITH["Wraith\nSAC event indexer\nGET /transfers/:address"]
        AGENT["Veil AI Agent\n(Claude + WebSocket)"]
        PG[("Postgres")]
    end

    UA -->|"biometric gesture"| SDK
    SDK -->|"passkey credential"| UA
    SDK -->|"WebAuthn signature Vec[5]"| CONTRACT
    UI -->|"sign envelope"| FP
    FP -->|"submit tx"| CONTRACT
    CONTRACT -->|"deploy"| FACTORY
    CONTRACT -->|"balance query"| SAC

    UI -->|"price fetch"| LENS
    UI -->|"transfer history"| WRAITH
    UI -->|"chat / approve tx"| AGENT
    AGENT -->|"get_price"| LENS
    AGENT -->|"get_balance"| SAC
    LENS --- PG
    WRAITH --- PG


veil/
├── contracts/
│   ├── invisible_wallet/          # Soroban smart contract (Rust)
│   │   ├── src/
│   │   │   ├── lib.rs             # Contract entry points + __check_auth
│   │   │   ├── auth.rs            # WebAuthn ES256 verification logic
│   │   │   └── storage.rs         # Signer and guardian storage
│   │   └── Cargo.toml
│   └── factory/                   # Factory contract — deploys wallet instances
│       ├── src/
│       │   ├── lib.rs             # init(wasm_hash) + deploy(pubkey, rp_id, origin)
│       │   ├── storage.rs         # WasmHash + Deployed(salt) keys
│       │   └── validation.rs      # P-256 public key validation
│       └── Cargo.toml
├── sdk/
│   ├── src/
│   │   ├── useInvisibleWallet.ts  # React hook
│   │   ├── InvisibleWalletCore.ts  # Framework-agnostic core class
│   │   ├── webauthn.ts            # WebAuthn provider interface
│   │   ├── webauthn.native.ts     # React Native implementation
│   │   ├── utils.ts               # Crypto utilities
│   │   └── index.ts               # Package exports
│   ├── svelte/
│   │   └── src/
│   │       └── index.ts           # Svelte adapter with writable store
│   └── package.json
├── packages/
│   └── agent/                     # Veil AI Agent (Node.js / TypeScript)
└── frontend/
    ├── website/                   # Next.js 14 marketing site
    ├── docs/                      # Nextra 3 documentation
    └── wallet/                    # Veil wallet app (Next.js 14)


import { useInvisibleWallet } from '@veil/invisible-wallet-sdk';
import { Networks } from '@stellar/stellar-sdk';

function App() {
  const wallet = useInvisibleWallet({
    factoryAddress: FACTORY_CONTRACT_ID,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  });

  async function setupWallet() {
    await wallet.register('alice');
    const { walletAddress } = await wallet.deploy();
    const sig = await wallet.signAuthEntry(signaturePayload);
    console.log(walletAddress);
  }

  return <button onClick={setupWallet}>Setup Wallet</button>;
}



<script lang="ts">
  import { createWallet } from '@veil/invisible-wallet-svelte';

  const wallet = createWallet({
    factoryAddress: FACTORY_CONTRACT_ID,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  });

  $: ({ status, walletAddress, isDeployed, error } = $wallet);
</script>



import { createInvisibleWallet } from 'invisible-wallet-sdk/vanilla';

const wallet = createInvisibleWallet({
  factoryAddress: FACTORY_CONTRACT_ID,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
});

async function main() {
  await wallet.register('alice');
  await wallet.deploy(feePayerKeypair);
  const sig = await wallet.signAuthEntry(signaturePayload);
  console.log(sig);
}

main();



import AsyncStorage from '@react-native-async-storage/async-storage';
import { useInvisibleWallet } from 'invisible-wallet-sdk';

const wallet = useInvisibleWallet({
  factoryAddress: 'CABC...',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpId: 'your-domain.com',
  origin: 'https://your-domain.com',
  storage: AsyncStorage,
});




**That's it!** Just copy everything above and paste it into your `README.md` file. No cutting, no editing needed - it's the complete, resolved file ready to use.
