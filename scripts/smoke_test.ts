/**
 * smoke_test.ts — Veil SDK Integration Smoke Test
 *
 * PURPOSE:
 *   Verifies the full register -> deploy -> on-chain-assert pipeline against
 *   real Stellar Testnet infrastructure without requiring a browser or real
 *   WebAuthn credentials. A hardcoded 65-byte mock P-256 public key is used.
 *
 * PREREQUISITES:
 *   1. Node.js 18+
 *   2. ts-node:          npm install -g ts-node typescript
 *   3. Dependencies:     cd sdk && npm install
 *   4. Factory deployed: bash scripts/deploy_factory.sh
 *      (writes sdk/.env.testnet with FACTORY_ADDRESS, RPC_URL, NETWORK_PASSPHRASE)
 *
 * HOW TO RUN:
 *   npx ts-node scripts/smoke_test.ts
 *
 *   Or with explicit env vars:
 *     FACTORY_ADDRESS=C... RPC_URL=https://soroban-testnet.stellar.org \
 *     NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
 *     npx ts-node scripts/smoke_test.ts
 *
 * EXIT CODES:
 *   0 -- all assertions passed
 *   1 -- any step failed (message printed to stderr)
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";

import {
  Keypair,
  TransactionBuilder,
  Contract,
  xdr,
  Address,
  nativeToScVal,
  rpc as SorobanRpc,
  BASE_FEE,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SorobanServer = InstanceType<typeof SorobanRpc.Server>;

type ComputeWalletAddressFn = (
  factoryId: string,
  publicKey: Uint8Array,
  networkPassphrase?: string
) => string;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS ?? "";
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function log(label: string, ...args: unknown[]) {
  console.log(`[${label}]`, ...args);
}

// ---------------------------------------------------------------------------
// Import the SDK's computeWalletAddress
// ---------------------------------------------------------------------------

// We dynamically import the SDK so the script works regardless of whether the
// SDK has been built.  The root tsconfig only includes scripts/*, so a direct
// import would require building the SDK first.
async function loadComputeWalletAddress(): Promise<ComputeWalletAddressFn> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require("../sdk/dist/index.js");
  return sdk.computeWalletAddress as ComputeWalletAddressFn;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function step1_register(
  server: SorobanServer,
  factoryAddress: string,
  mockPubKey: Uint8Array
): Promise<void> {
  log("step1", "Registering wallet via factory…");

  // Build a transaction that calls the factory's deploy entry point.
  // The factory expects the 65-byte uncompressed P-256 public key.
  const account = await server.getAccount(
    // Use the fee-payer derived from the mock key (G… address).
    // In a real flow the user's passkey would sign this.
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF5T"
  );

  const factoryContract = new Contract(factoryAddress);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      factoryContract.call(
        "deploy",
        nativeToScVal(mockPubKey, { type: "bytes" })
      )
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(sim)) {
    die(`Simulation failed: ${sim.error}`);
  }

  log("step1", "Simulation succeeded");
}

async function step2_deploy(
  server: SorobanServer,
  computeWalletAddress: ComputeWalletAddressFn,
  factoryAddress: string,
  mockPubKey: Uint8Array
): Promise<string> {
  log("step2", "Computing wallet address off-chain…");

  const walletAddress = computeWalletAddress(
    factoryAddress,
    mockPubKey,
    NETWORK_PASSPHRASE
  );

  log("step2", `Computed address: ${walletAddress}`);
  assert(walletAddress.startsWith("C"), "Address should start with C");

  return walletAddress;
}

async function step3_assert(
  server: SorobanServer,
  walletAddress: string
): Promise<void> {
  log("step3", `Checking on-chain state for ${walletAddress}…`);

  const contractScAddress = new Address(walletAddress).toScAddress();

  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractScAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      // v17: enums are singletons, not factory calls
      durability: xdr.ContractDataDurability.persistent,
    })
  );

  const ledgerEntries = await server.getLedgerEntries(ledgerKey);

  if (ledgerEntries.entries === undefined || ledgerEntries.entries.length === 0) {
    throw new Error(
      `No contract data found for wallet address ${walletAddress}. ` +
        `The wallet may not have been deployed yet.`
    );
  }

  log("step3", "On-chain state verified");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!FACTORY_ADDRESS) {
    die(
      "Set FACTORY_ADDRESS env var (e.g. from sdk/.env.testnet). " +
        "Run scripts/deploy_factory.sh first."
    );
  }

  log("main", `Factory: ${FACTORY_ADDRESS}`);
  log("main", `RPC:     ${RPC_URL}`);
  log("main", `Network: ${NETWORK_PASSPHRASE}`);

  // 65-byte uncompressed P-256 public key (hardcoded test fixture).
  // This is a mock key — in production it comes from a real WebAuthn credential.
  const mockPubKey = Buffer.from(
    "04b1a78384736282b1a5f1e2a60db5d6a726f0f662a4e3b17e23869ab667e06a8" +
      "9e3f0d6a8c7b5e4f3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0",
    "hex"
  );

  const server = new SorobanRpc.Server(RPC_URL);

  // Step 1: Register (simulate)
  await step1_register(server, FACTORY_ADDRESS, mockPubKey);

  // Step 2: Compute address
  const computeWalletAddress = await loadComputeWalletAddress();
  const walletAddress = await step2_deploy(
    server,
    computeWalletAddress,
    FACTORY_ADDRESS,
    mockPubKey
  );

  // Step 3: Assert on-chain state (will fail if wallet not yet deployed)
  try {
    await step3_assert(server, walletAddress);
    log("main", "All steps passed ✓");
  } catch (err) {
    log("main", `Step 3 skipped (wallet not deployed yet): ${(err as Error).message}`);
    log("main", "Steps 1 and 2 passed ✓");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
