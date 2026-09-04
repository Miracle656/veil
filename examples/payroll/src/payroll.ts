import * as fs from "fs";
import * as path from "path";
import {
  Keypair,
  TransactionBuilder,
  Asset,
  Networks,
  Operation,
  BASE_FEE,
  rpc as SorobanRpc,
  Horizon,
  nativeToScVal,
  Contract,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PayPayment = {
  to: string;
  amount: string;
  memo?: string;
};

type PayrollConfig = {
  network?: string;
  rpcUrl?: string;
  sourceSecret: string;
  token?: string;
  payments: PayPayment[];
};

type CliArgs = {
  dryRun: boolean;
  file: string;
};

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let dryRun = false;
  let file = "payroll.json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--file" && i + 1 < args.length) {
      file = args[i + 1];
      i++;
    }
  }

  return { dryRun, file };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(config: PayrollConfig): void {
  if (!config.sourceSecret) {
    throw new Error("sourceSecret is required in payroll.json");
  }
  if (!config.payments || config.payments.length === 0) {
    throw new Error("payments array must contain at least one payment");
  }
  for (const p of config.payments) {
    if (!p.to || !p.amount) {
      throw new Error(`Each payment must have 'to' and 'amount': ${JSON.stringify(p)}`);
    }
    if (isNaN(parseFloat(p.amount)) || parseFloat(p.amount) <= 0) {
      throw new Error(`Invalid amount: ${p.amount}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Build transaction
// ---------------------------------------------------------------------------

function buildTransaction(
  config: PayrollConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceAccount: any
) {
  const networkPassphrase = config.network ?? Networks.TESTNET;
  const token = config.token ?? "native";

  const txBuilder = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  for (const payment of config.payments) {
    if (token === "native") {
      txBuilder.addOperation(
        Operation.payment({
          destination: payment.to,
          asset: Asset.native(),
          amount: payment.amount,
        })
      );
    } else {
      const tokenContract = new Contract(token);
      const amountI128 = nativeToScVal(
        BigInt(Math.round(parseFloat(payment.amount) * 1e7)),
        { type: "i128" }
      );
      txBuilder.addOperation(
        tokenContract.call(
          "transfer",
          nativeToScVal(sourceAccount.accountId(), { type: "address" }),
          nativeToScVal(payment.to, { type: "address" }),
          amountI128
        )
      );
    }
  }

  const hasMemo = config.payments.some((p) => p.memo);
  if (hasMemo) {
    txBuilder.addMemo({ type: "text", value: "Payroll batch" } as any);
  }

  return txBuilder.setTimeout(30).build();
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

async function simulateTransaction(
  server: SorobanRpc.Server,
  tx: ReturnType<TransactionBuilder["build"]>
) {
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  return sim;
}

// ---------------------------------------------------------------------------
// submit + poll
// ---------------------------------------------------------------------------

async function submitAndWait(
  server: SorobanRpc.Server,
  tx: ReturnType<TransactionBuilder["build"]>,
  signerKeypair: Keypair
): Promise<string> {
  const assembled = SorobanRpc.assembleTransaction(tx, await simulateTransaction(server, tx)).build();
  assembled.sign(signerKeypair);

  const sendResult = await server.sendTransaction(assembled);
  if (sendResult.status === "ERROR") {
    throw new Error(
      `Transaction rejected: ${sendResult.errorResult?.toXDR("base64") ?? "unknown error"}`
    );
  }

  const txHash = sendResult.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const txResult = await server.getTransaction(txHash);
    if (txResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return txHash;
    }
    if (txResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction FAILED on-chain. Hash: ${txHash}`);
    }
  }

  throw new Error(`Transaction not confirmed after 30s. Hash: ${txHash}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dryRun, file } = parseArgs();
  const configPath = path.resolve(file);

  if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  const config: PayrollConfig = JSON.parse(
    fs.readFileSync(configPath, "utf-8")
  );
  validateConfig(config);

  const networkPassphrase = config.network ?? Networks.TESTNET;
  const rpcUrl = config.rpcUrl ?? "https://soroban-testnet.stellar.org";
  const sourceKeypair = Keypair.fromSecret(config.sourceSecret);
  const server = new SorobanRpc.Server(rpcUrl);
  const horizonUrl = rpcUrl.replace("soroban-", "");
  const horizon = new Horizon.Server(horizonUrl);

  const sourceAccount = await horizon.loadAccount(sourceKeypair.publicKey());
  const tx = buildTransaction(config, sourceAccount);

  console.log(`\\nPayroll run: ${config.payments.length} employee(s)`);
  console.log(`Network     : ${networkPassphrase}`);
  console.log(`RPC         : ${rpcUrl}`);
  console.log(
    `Total XLM   : ${config.payments.reduce((s, p) => s + parseFloat(p.amount), 0).toFixed(7)}`
  );

  if (dryRun) {
    console.log("\\nMode        : DRY RUN — simulating only, no submission\\n");
    const sim = await simulateTransaction(server, tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      console.error(`Simulation failed: ${sim.error}`);
      process.exit(1);
    }
    console.log("Simulation succeeded. Transaction is valid.");
    console.log("Remove --dry-run to submit for real.");
    process.exit(0);
  }

  console.log("\\nMode        : LIVE — submitting transaction\\n");
  const txHash = await submitAndWait(server, tx, sourceKeypair);
  console.log(`\\nPayroll batch submitted successfully.`);
  console.log(`Tx hash: ${txHash}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(
    `\\nPayroll run failed: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
