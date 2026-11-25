# Migrating to SDK v1.0.0: Retiring Secret-Bearing Signer Overloads

## Why This Changed

A Stellar secret key (`S...`) in a browser bundle, mobile app bundle, or frontend local storage is an exposed key. When SDK functions accept secret strings or `Keypair` objects directly, client applications are encouraged to store and handle raw private keys in environments where any XSS attack, malicious dependency, or bundle leak can extract them.

In SDK v0.2.0, `TransactionSigner` was introduced as a safe signing abstraction: the SDK constructs the transaction envelope XDR and delegates signing to a callback. The key can remain on an external backend service, hardware module, or isolated signing context, while the SDK verifies that the returned transaction matches the original operations before submission.

In **v1.0.0**, the deprecated secret-bearing shapes (`Keypair` and `string`) have been completely removed from `SignerInput`, `WalletConfig.sponsorSecret` has been removed, and escrow helpers require `TransactionSigner`.

---

## What Changed at a Glance

| Feature | Pre-v1.0.0 (Deprecated) | v1.0.0 (Required) |
|---|---|---|
| `SignerInput` | `TransactionSigner \| Keypair \| string` | `TransactionSigner` |
| Fee Sponsorship | `WalletConfig.sponsorSecret?: string` | `WalletConfig.sponsorSigner?: TransactionSigner` |
| Escrow Sender | `CreateEscrowOptions.senderKeypair?: Keypair` | `CreateEscrowOptions.sender: TransactionSigner` |
| Escrow Claimant | `ClaimOptions.claimantKeypair?: Keypair` | `ClaimOptions.claimant: TransactionSigner` |
| Escrow Reclaim | `ReclaimOptions.senderKeypair?: Keypair` | `ReclaimOptions.sender: TransactionSigner` |
| Keypair in Memory | Directly passed to SDK | Wrap with `createKeypairSigner(keypair)` |

---

## Migration Examples

### 1. Wallet Methods (`deploy`, `addSigner`, `approve`, `sendPayment`, etc.)

#### Before (v0.x)
```ts
// Passing a secret string or Keypair directly into SDK methods:
await wallet.deploy(secretString);

await wallet.addSigner(Keypair.fromSecret(secretString), newPublicKeyBytes);

await wallet.approve(keypair, spender, token, amount);
```

#### After (v1.0.0)

**Option A: Preferred (Server-Side / Remote Signer)**
Keep the private key on your backend. The client requests a signature over the built transaction XDR:

```ts
import type { TransactionSigner, SignTransactionContext } from 'invisible-wallet-sdk';

const remoteSigner: TransactionSigner = {
  publicKey: 'GB5W...',
  signTransaction: async (xdr: string, context: SignTransactionContext) => {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xdr, networkPassphrase: context.networkPassphrase }),
    });
    const { signedXdr } = await res.json();
    return signedXdr;
  },
};

await wallet.deploy(remoteSigner);
await wallet.addSigner(remoteSigner, newPublicKeyBytes);
await wallet.approve(remoteSigner, spender, token, amount);
```

**Option B: In-Memory Keypair (Backend / Tests / CLI)**
If you are running in a secure Node.js environment, unit tests, or server scripts where you already possess a `Keypair`, use `createKeypairSigner`:

```ts
import { Keypair } from '@stellar/stellar-sdk';
import { createKeypairSigner } from 'invisible-wallet-sdk';

const keypair = Keypair.fromSecret(secretString);
const signer = createKeypairSigner(keypair);

await wallet.deploy(signer);
await wallet.addSigner(signer, newPublicKeyBytes);
await wallet.approve(signer, spender, token, amount);
```

---

### 2. Fee Sponsorship in `WalletConfig`

#### Before (v0.x)
```ts
const config: WalletConfig = {
  factoryAddress: 'C...',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  sponsorSecret: 'SA...', // Embedded sponsor secret
};
```

#### After (v1.0.0)
```ts
import { createKeypairSigner, type WalletConfig, type TransactionSigner } from 'invisible-wallet-sdk';

const config: WalletConfig = {
  factoryAddress: 'C...',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  sponsorSigner: sponsorRemoteSigner, // or createKeypairSigner(sponsorKeypair)
};
```

---

### 3. Escrow Helpers (`createEscrow`, `claimEscrow`, `reclaimEscrow`)

#### Before (v0.x)
```ts
import { createEscrow, claimEscrow, reclaimEscrow } from 'invisible-wallet-sdk';

await createEscrow({
  senderKeypair: senderKp,
  recipientAddress: 'G...',
  amount: '10',
  asset: Asset.native(),
  claimDeadlineSeconds: 3600,
  config: escrowConfig,
});

await claimEscrow({
  claimantKeypair: claimantKp,
  balanceId,
  config: escrowConfig,
});

await reclaimEscrow({
  senderKeypair: senderKp,
  balanceId,
  config: escrowConfig,
});
```

#### After (v1.0.0)
```ts
import { createEscrow, claimEscrow, reclaimEscrow, createKeypairSigner } from 'invisible-wallet-sdk';

const senderSigner = createKeypairSigner(senderKp);
const claimantSigner = createKeypairSigner(claimantKp);

await createEscrow({
  sender: senderSigner,
  recipientAddress: 'G...',
  amount: '10',
  asset: Asset.native(),
  claimDeadlineSeconds: 3600,
  config: escrowConfig,
});

await claimEscrow({
  claimant: claimantSigner,
  balanceId,
  config: escrowConfig,
});

await reclaimEscrow({
  sender: senderSigner,
  balanceId,
  config: escrowConfig,
});
```
