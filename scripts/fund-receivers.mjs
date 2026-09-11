#!/usr/bin/env node
/**
 * Create the classic accounts that Veil wallets need before anyone can pay them.
 *
 * Why this exists
 * ---------------
 * A brand new Veil wallet on mainnet has nothing on chain. The contract address
 * is derived but undeployed, and the classic G account has never been funded,
 * so Horizon 404s it. Nobody can pay either address:
 *
 *   - a classic payment operation cannot name a contract as its destination, so
 *     the C address is unreachable from an exchange, an employer, or any
 *     ordinary wallet;
 *   - the G address does not exist, and Stellar will not deliver to an account
 *     that has not been created.
 *
 * This script creates each G account with enough XLM to exist and to add one
 * trustline. The wallet then adds its own USDC trustline from the app, signed
 * with the user's own key, because a sponsored trustline would need the user's
 * signature in the same transaction as ours and that means a co-signing service.
 *
 * Cost per recipient: 2.5 XLM of refundable reserve once the account, its USDC
 * trustline and its two recovery data entries all exist, plus a little slack
 * for fees. Reserve is refundable (a later account merge returns it), so this
 * is a float, not a spend.
 *
 * Usage
 * -----
 *   FUNDER_SECRET=S... node scripts/fund-receivers.mjs recipients.txt
 *   FUNDER_SECRET=S... node scripts/fund-receivers.mjs --network testnet --dry-run recipients.txt
 *
 * `recipients.txt` is one G address per line. Blank lines and lines starting
 * with `#` are ignored, so you can paste from a chat and annotate it.
 *
 * The secret is read from the environment and never printed, never written to a
 * file, and never sent anywhere but the network you name.
 */

import { readFileSync } from 'node:fs';
import {
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const NETWORKS = {
  mainnet: { horizon: 'https://horizon.stellar.org', passphrase: Networks.PUBLIC },
  testnet: { horizon: 'https://horizon-testnet.stellar.org', passphrase: Networks.TESTNET },
};

/**
 * What a recoverable, payable wallet actually costs to open.
 *
 *   1.0  account base reserve
 *   0.5  the USDC trustline the wallet adds from the app
 *   1.0  two data entries holding the passkey public key, which are what let
 *        "sign in with passkey" find this wallet from a new device
 *   0.1  fee slack
 *
 * This was 1.6, which covers the first two and not the third. That funds a
 * wallet somebody can be paid into and cannot recover if they lose the phone —
 * the worst of the two failures to choose, and invisible until the phone is
 * gone. The reserve is refundable either way, so the extra XLM is float, not
 * cost.
 */
const DEFAULT_STARTING_BALANCE = '2.6';

function parseArgs(argv) {
  const args = { network: 'mainnet', dryRun: false, amount: DEFAULT_STARTING_BALANCE, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--network') args.network = argv[++i];
    else if (a === '--amount') args.amount = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (!a.startsWith('-')) args.file = a;
  }
  return args;
}

function readRecipients(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  const bad = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Take the first whitespace-separated token, so "GABC...  # Ada" works.
    const addr = line.split(/\s+/)[0];
    if (StrKey.isValidEd25519PublicKey(addr)) out.push(addr);
    else bad.push(line);
  }
  return { addresses: [...new Set(out)], bad };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const net = NETWORKS[args.network];
  if (!net) {
    console.error(`Unknown network "${args.network}". Use mainnet or testnet.`);
    process.exit(2);
  }
  if (!args.file) {
    console.error('Usage: FUNDER_SECRET=S... node scripts/fund-receivers.mjs [--network mainnet] [--amount 1.6] [--dry-run] <recipients.txt>');
    process.exit(2);
  }

  const secret = process.env.FUNDER_SECRET;
  if (!secret) {
    console.error('FUNDER_SECRET is not set. Export it in your shell; do not pass it as an argument.');
    process.exit(2);
  }

  let funder;
  try {
    funder = Keypair.fromSecret(secret.trim());
  } catch {
    console.error('FUNDER_SECRET is not a valid Stellar secret key.');
    process.exit(2);
  }

  const { addresses, bad } = readRecipients(args.file);
  for (const b of bad) console.warn(`  skipped, not a G address: ${b}`);
  if (addresses.length === 0) {
    console.error('No valid recipient addresses found.');
    process.exit(1);
  }

  const server = new Horizon.Server(net.horizon);

  // Refuse to start unless the funder can cover every recipient. Half-funding a
  // group is worse than not starting: some people get paid and some silently do
  // not, and you cannot tell which from the outside.
  let funderAccount;
  try {
    funderAccount = await server.loadAccount(funder.publicKey());
  } catch (err) {
    if (err?.response?.status === 404) {
      console.error(
        `The funder account ${funder.publicKey()} does not exist on ${args.network}. Fund it before running this.`,
      );
      process.exit(1);
    }
    throw err;
  }
  const native = funderAccount.balances.find((b) => b.asset_type === 'native');
  const available = Number(native?.balance ?? '0');
  const needed = addresses.length * Number(args.amount) + 1.5; // + funder's own reserve headroom

  console.log(`Network      ${args.network}`);
  console.log(`Funder       ${funder.publicKey()}`);
  console.log(`Balance      ${available} XLM`);
  console.log(`Recipients   ${addresses.length}`);
  console.log(`Per account  ${args.amount} XLM`);
  console.log(`Needed       ~${needed.toFixed(1)} XLM\n`);

  if (available < needed) {
    console.error(`Funder holds ${available} XLM but needs about ${needed.toFixed(1)}. Top it up first.`);
    process.exit(1);
  }

  const results = { created: [], existed: [], failed: [] };

  for (const address of addresses) {
    let exists = false;
    try {
      await server.loadAccount(address);
      exists = true;
    } catch (err) {
      if (err?.response?.status !== 404) {
        console.error(`  ${address}  could not check: ${err?.message ?? err}`);
        results.failed.push(address);
        continue;
      }
    }

    if (exists) {
      console.log(`  ${address}  already exists, skipped`);
      results.existed.push(address);
      continue;
    }

    if (args.dryRun) {
      console.log(`  ${address}  would create with ${args.amount} XLM`);
      results.created.push(address);
      continue;
    }

    try {
      // Reload each time: the sequence number moves with every submission.
      const source = await server.loadAccount(funder.publicKey());
      const tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(
          Operation.createAccount({ destination: address, startingBalance: args.amount }),
        )
        .setTimeout(60)
        .build();
      tx.sign(funder);
      const res = await server.submitTransaction(tx);
      console.log(`  ${address}  created  ${res.hash}`);
      results.created.push(address);
    } catch (err) {
      const codes = err?.response?.data?.extras?.result_codes;
      console.error(`  ${address}  FAILED  ${codes ? JSON.stringify(codes) : err?.message ?? err}`);
      results.failed.push(address);
    }
  }

  console.log(
    `\n${results.created.length} created, ${results.existed.length} already existed, ${results.failed.length} failed.`,
  );
  if (results.failed.length) {
    console.log('Re-run with the same file to retry only the failures; existing accounts are skipped.');
    process.exit(1);
  }
  console.log('Each recipient now opens the app, goes to Receive, and taps Enable USDC.');
  console.log('Opening the dashboard once writes their recovery entries on-chain.');
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
