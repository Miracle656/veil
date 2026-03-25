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
  BASE_FEE,
} from "@stellar/stellar-sdk";
import * as SorobanRpc from "@stellar/stellar-sdk/rpc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SorobanServer = InstanceType<typeof SorobanRpc.Server>;

type ComputeWalletAddressFn = (
  factoryId: string,
  publicKey: Uint8Array
) => string;

// ---------------------------------------------------------------------------
// 0. Load env
// ---------------------------------------------------------------------------

const ENV_FILE = path.resolve(__dirname, "../sdk/.env.testnet");

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(ENV_FILE);

const FACTORY_ADDRESS: string = process.env["FACTORY_ADDRESS"] ?? "";
const RPC_URL: string =
  process.env["RPC_URL"] ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE: string =
  process.env["NETWORK_PASSPHRASE"] ?? "Test SDF Network ; September 2015";

if (!FACTORY_ADDRESS) {
  console.error(
    "FACTORY_ADDRESS is not set.\n" +
      "    Run scripts/deploy_factory.sh first, or export FACTORY_ADDRESS=<contract-id>."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SDK util import
// ---------------------------------------------------------------------------

let computeWalletAddress: ComputeWalletAddressFn | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const utils = require(
    path.resolve(__dirname, "../sdk/src/utils")
  ) as Record<string, unknown>;
  if (typeof utils["computeWalletAddress"] === "function") {
    computeWalletAddress = utils["computeWalletAddress"] as ComputeWalletAddressFn;
  }
} catch (_e) {
  // Falls back to deriving the address from the tx return value in Step 5.
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 0x04 prefix + 64 zero bytes — valid length for a P-256 uncompressed key. */
const MOCK_PUBLIC_KEY = new Uint8Array(65);
MOCK_PUBLIC_KEY[0] = 0x04;

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 30; // 90 seconds total

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          } else {
            resolve(body);
          }
        });
      })
      .on("error", reject);
  });
}

async function fundViaFriendbot(publicKey: string): Promise<void> {
  const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`;
  console.log(`  Requesting Friendbot funding for ${publicKey}`);
  await httpGet(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Step functions
// ---------------------------------------------------------------------------

async function step1_generateAndFundKeypair(): Promise<Keypair> {
  console.log("\n[Step 1] Generating random fee-payer keypair and funding via Friendbot...");
  const keypair = Keypair.random();
  console.log(`  Public key : ${keypair.publicKey()}`);
  await fundViaFriendbot(keypair.publicKey());
  console.log("  Friendbot funding requested.");
  return keypair;
}

async function step2_computeWalletAddress(): Promise<string | null> {
  console.log("\n[Step 2] Computing expected wallet address...");
  if (computeWalletAddress === null) {
    console.log(
      "  computeWalletAddress() not available (sdk/src/utils.ts not compiled).\n" +
        "     Will derive address from deployment tx instead."
    );
    return null;
  }
  const addr = computeWalletAddress(FACTORY_ADDRESS, MOCK_PUBLIC_KEY);
  console.log(`  Expected wallet address: ${addr}`);
  return addr;
}

async function step3_submitDeployTx(
  feePayer: Keypair,
  server: SorobanServer
): Promise<string> {
  console.log("\n[Step 3] Building and submitting factory deploy transaction...");

  let account: Awaited<ReturnType<SorobanServer["getAccount"]>> | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      account = await server.getAccount(feePayer.publicKey());
      break;
    } catch (_e) {
      console.log(`  Waiting for account on-chain (attempt ${attempt + 1}/10)...`);
      await sleep(2_000);
    }
  }
  if (account === null) {
    throw new Error("Fee-payer account never appeared on-chain after Friendbot.");
  }

  const factory = new Contract(FACTORY_ADDRESS);
  const signerScVal = nativeToScVal(Buffer.from(MOCK_PUBLIC_KEY), { type: "bytes" });

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(factory.call("deploy", signerScVal))
    .setTimeout(180)
    .build();

  console.log("  Simulating transaction...");
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
  preparedTx.sign(feePayer);

  console.log("  Submitting transaction...");
  const sendResult = await server.sendTransaction(preparedTx);
  if (sendResult.status === "ERROR") {
    throw new Error(`sendTransaction failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const txHash = sendResult.hash;
  console.log(`  Transaction hash: ${txHash}`);
  return txHash;
}

async function step4_pollForConfirmation(
  txHash: string,
  server: SorobanServer
): Promise<xdr.ScVal> {
  console.log("\n[Step 4] Polling for transaction confirmation...");

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    // Use the raw RPC response as a plain object to sidestep the
    // discriminated-union typing issue entirely. We check .status ourselves
    // and extract .returnValue via a plain property access.
    const result = await server.getTransaction(txHash) as unknown as {
      status: string;
      returnValue?: xdr.ScVal;
    };

    if (result.status === "SUCCESS") {
      console.log(`  Transaction confirmed after ${attempt} poll(s).`);
      if (result.returnValue === undefined) {
        throw new Error("Transaction succeeded but returnValue is missing.");
      }
      return result.returnValue;
    }

    if (result.status === "FAILED") {
      throw new Error(`Transaction FAILED on-chain. Hash: ${txHash}`);
    }

    console.log(`  Still pending... (attempt ${attempt}/${POLL_MAX_ATTEMPTS})`);
  }

  throw new Error(
    `Transaction not confirmed after ${POLL_MAX_ATTEMPTS} polls ` +
      `(${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s).`
  );
}

async function step5_assertContractExists(
  returnValue: xdr.ScVal,
  expectedAddress: string | null,
  server: SorobanServer
): Promise<string> {
  console.log("\n[Step 5] Asserting wallet contract exists on-chain...");

  // returnValue is xdr.ScVal — no discriminated union, no squiggles.
  let walletAddress: string;
  try {
    walletAddress = Address.fromScVal(returnValue).toString();
  } catch (_e) {
    throw new Error(
      "Could not extract wallet address: returnValue was not an scvAddress ScVal."
    );
  }

  console.log(`  Deployed wallet address: ${walletAddress}`);

  if (expectedAddress !== null && walletAddress !== expectedAddress) {
    throw new Error(
      `Address mismatch!\n  Expected : ${expectedAddress}\n  Got      : ${walletAddress}`
    );
  }
  if (expectedAddress !== null) {
    console.log("  Address matches computeWalletAddress() prediction.");
  }

  // .toScAddress() is the v12+ replacement for the removed .toBuffer()
  const contractScAddress = new Address(walletAddress).toScAddress();

  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractScAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  const ledgerEntries = await server.getLedgerEntries(ledgerKey);

  if (ledgerEntries.entries === undefined || ledgerEntries.entries.length === 0) {
    throw new Error(
      `No contract data found for wallet address ${walletAddress}. ` +
        "Contract may not have been deployed correctly."
    );
  }

  console.log("  Contract data (instance) found on-chain.");
  return walletAddress;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=======================================================");
  console.log("  Veil SDK -- Testnet Smoke Test");
  console.log("=======================================================");
  console.log(`  RPC URL            : ${RPC_URL}`);
  console.log(`  Factory Address    : ${FACTORY_ADDRESS}`);
  console.log(`  Network Passphrase : ${NETWORK_PASSPHRASE}`);

  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const startTime = Date.now();
  const elapsed = (): string => ((Date.now() - startTime) / 1000).toFixed(1) + "s";

  let txHash = "";
  let walletAddress = "";

  try {
    const feePayer        = await step1_generateAndFundKeypair();
    const expectedAddress = await step2_computeWalletAddress();
    txHash                = await step3_submitDeployTx(feePayer, server);
    const returnValue     = await step4_pollForConfirmation(txHash, server);
    walletAddress         = await step5_assertContractExists(returnValue, expectedAddress, server);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("\n=======================================================");
    console.error("  SMOKE TEST FAILED");
    console.error("=======================================================");
    console.error(`  Error   : ${message}`);
    console.error(`  Elapsed : ${elapsed()}`);
    console.error("=======================================================\n");
    process.exit(1);
    return;
  }

  console.log("\n=======================================================");
  console.log("  SMOKE TEST PASSED");
  console.log("=======================================================");
  console.log(`  Wallet address : ${walletAddress}`);
  console.log(`  Tx hash        : ${txHash}`);
  console.log(`  Elapsed        : ${elapsed()}`);
  console.log("=======================================================\n");
  process.exit(0);
}

main();