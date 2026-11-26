#!/usr/bin/env node
/**
 * Verify the recovery breadcrumbs on a fee-payer account (#1177).
 *
 * Recovery on a fresh device depends on two manage-data entries existing on
 * the PRF-derived fee-payer G-account (frontend/mobile/lib/walletBreadcrumbs.ts):
 *
 *   veil:pk1 — passkey public key bytes 1..32  (after the 0x04 prefix)
 *   veil:pk2 — passkey public key bytes 33..64
 *
 * This script asserts their SHAPE, not merely their presence: both entries
 * exist, each is exactly 32 bytes, the reassembled 0x04-prefixed key is a
 * real point on P-256, and the wallet C-address derives from it (the same
 * HashIdPreimage derivation the factory and SDK use). An entry with the
 * wrong contents is as useless as a missing one, and either fails loudly
 * (exit 1 plus a ::error:: annotation for CI).
 *
 * Modes:
 *   node scripts/verify-breadcrumbs.mjs
 *       Testnet self-check, no arguments, no manual steps (CI mode): creates
 *       a throwaway P-256 key and a friendbot-funded burner fee payer, writes
 *       the breadcrumbs exactly as the app does, then verifies them.
 *   node scripts/verify-breadcrumbs.mjs --account G... [--expect-wallet C...]
 *       Verify an EXISTING account, read-only. No key material needed.
 *   node scripts/verify-breadcrumbs.mjs --network mainnet --account G... [--expect-wallet C...]
 *       The deliberate mainnet run. Read-only by construction: mainnet mode
 *       refuses to run without --account and never writes or funds anything.
 *
 * No secret key is ever printed; the burner secret in self-check mode lives
 * and dies in process memory.
 */

import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import {
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  xdr,
} from '@stellar/stellar-sdk';

const CRUMB_PK1 = 'veil:pk1';
const CRUMB_PK2 = 'veil:pk2';
const CRUMB_WALLET_LEGACY = 'veil:wallet';

const NETWORKS = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
    factoryContractId: 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA',
    friendbotUrl: 'https://friendbot.stellar.org',
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: Networks.PUBLIC,
    factoryContractId: 'CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK',
    friendbotUrl: null,
  },
};

// ── P-256 curve equation: y² ≡ x³ − 3x + b (mod p). A 64-byte blob that is
// not a curve point is not a public key, however well it decodes.
const P256_P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function isOnP256(xBytes, yBytes) {
  const x = BigInt('0x' + Buffer.from(xBytes).toString('hex'));
  const y = BigInt('0x' + Buffer.from(yBytes).toString('hex'));
  if (x <= 0n || x >= P256_P || y <= 0n || y >= P256_P) return false;
  const mod = (n) => ((n % P256_P) + P256_P) % P256_P;
  return mod(y * y) === mod(x * x * x - 3n * x + P256_B);
}

/** The factory's address derivation: SHA-256(key) as salt, HashIdPreimage::ContractId. */
function deriveWalletAddress(factoryId, publicKey65, passphrase) {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(factoryId)),
          salt: hash(Buffer.from(publicKey65)),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

function fail(message) {
  console.error(`::error title=breadcrumb verification::${message}`);
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { network: 'testnet', account: null, expectWallet: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--network') args.network = argv[++i];
    else if (argv[i] === '--account') args.account = argv[++i];
    else if (argv[i] === '--expect-wallet') args.expectWallet = argv[++i];
    else fail(`unknown argument "${argv[i]}"`);
  }
  if (!(args.network in NETWORKS)) fail(`--network must be testnet or mainnet, got "${args.network}"`);
  if (args.network === 'mainnet' && !args.account) {
    fail('mainnet runs are deliberate and read-only: pass --account G... to name what to verify');
  }
  if (args.account && !StrKey.isValidEd25519PublicKey(args.account)) {
    fail(`--account must be a Stellar public key (G...), got "${args.account}"`);
  }
  if (args.expectWallet && !StrKey.isValidContract(args.expectWallet)) {
    fail(`--expect-wallet must be a contract address (C...), got "${args.expectWallet}"`);
  }
  return args;
}

/** A throwaway uncompressed P-256 public key. The private half is discarded:
 *  the check needs a realistic key shape, never a usable signer. */
function throwawayP256PublicKey() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const key = Buffer.alloc(65);
  key[0] = 0x04;
  Buffer.from(jwk.x, 'base64url').copy(key, 1);
  Buffer.from(jwk.y, 'base64url').copy(key, 33);
  return key;
}

/** Testnet-only fixture: burner fee payer + the exact write the app performs. */
async function createFixture(net) {
  const burner = Keypair.random();
  console.log(`self-check fixture: burner fee payer ${burner.publicKey()} (secret never printed)`);

  const friendbot = await fetch(`${net.friendbotUrl}?addr=${encodeURIComponent(burner.publicKey())}`);
  if (!friendbot.ok) fail(`friendbot funding failed: HTTP ${friendbot.status}`);

  const publicKey65 = throwawayP256PublicKey();
  const server = new Horizon.Server(net.horizonUrl);
  const account = await server.loadAccount(burner.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(Operation.manageData({ name: CRUMB_PK1, value: publicKey65.subarray(1, 33) }))
    .addOperation(Operation.manageData({ name: CRUMB_PK2, value: publicKey65.subarray(33, 65) }))
    .setTimeout(60)
    .build();
  tx.sign(burner);
  await server.submitTransaction(tx);
  console.log('breadcrumbs written the way lib/walletBreadcrumbs.ts writes them');

  return { account: burner.publicKey(), expectWallet: deriveWalletAddress(net.factoryContractId, publicKey65, net.passphrase) };
}

async function verify(net, accountId, expectWallet) {
  const server = new Horizon.Server(net.horizonUrl);
  let account;
  try {
    account = await server.loadAccount(accountId);
  } catch (err) {
    fail(`could not load ${accountId}: ${err?.response?.status ?? err}`);
  }
  const data = account.data_attr ?? {};

  // Presence, by name.
  for (const name of [CRUMB_PK1, CRUMB_PK2]) {
    if (!(name in data)) fail(`data entry "${name}" is missing on ${accountId} — recovery from a fresh device would fail`);
  }

  // Shape: exactly 32 bytes each.
  const b1 = Buffer.from(data[CRUMB_PK1], 'base64');
  const b2 = Buffer.from(data[CRUMB_PK2], 'base64');
  if (b1.length !== 32) fail(`"${CRUMB_PK1}" is ${b1.length} bytes, expected exactly 32`);
  if (b2.length !== 32) fail(`"${CRUMB_PK2}" is ${b2.length} bytes, expected exactly 32`);

  // Shape: the halves reassemble into a genuine P-256 point.
  if (!isOnP256(b1, b2)) {
    fail(`"${CRUMB_PK1}"+"${CRUMB_PK2}" do not form a point on P-256 — the stored key is corrupt, recovery would reconstruct garbage`);
  }

  // Shape: the wallet address derives from the key, exactly as login does.
  const publicKey65 = Buffer.concat([Buffer.from([0x04]), b1, b2]);
  const derived = deriveWalletAddress(net.factoryContractId, publicKey65, net.passphrase);
  console.log(`derived wallet address: ${derived}`);
  if (expectWallet && derived !== expectWallet) {
    fail(`derived wallet ${derived} does not match expected ${expectWallet} — these breadcrumbs recover a different wallet`);
  }

  // The retired third entry is informational: harmless to recovery, but it is
  // 0.5 XLM of the user's reserve the app is supposed to have reclaimed.
  if (CRUMB_WALLET_LEGACY in data) {
    console.log(`::warning title=breadcrumb verification::legacy "${CRUMB_WALLET_LEGACY}" entry still present on ${accountId} (0.5 XLM of reclaimable reserve)`);
  }

  console.log(`OK: ${accountId} carries well-formed recovery breadcrumbs (${CRUMB_PK1}, ${CRUMB_PK2})`);
}

const args = parseArgs(process.argv);
const net = NETWORKS[args.network];

let target = { account: args.account, expectWallet: args.expectWallet };
if (!target.account) {
  // No account named: testnet CI mode, self-contained.
  target = await createFixture(net);
}
await verify(net, target.account, target.expectWallet);
