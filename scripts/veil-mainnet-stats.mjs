#!/usr/bin/env node
/**
 * Veil mainnet usage stats: wallets, deployments, transactions, balances.
 *
 *   node scripts/veil-mainnet-stats.mjs
 *   FUNDERS=GAE6...,GXYZ... SEEDS=GABC... JSON_OUT=stats.json node scripts/veil-mainnet-stats.mjs
 *
 * Needs @stellar/stellar-sdk resolvable (e.g. run with
 * NODE_PATH=frontend/mobile/node_modules).
 *
 * How wallets are found, and what that misses:
 *
 *   The factory emits no events, and no public index lists contracts by Wasm
 *   hash, so there is no single query for "every Veil wallet". Instead:
 *     1. Candidate spending accounts = accounts created or paid XLM by the
 *        funder accounts (FUNDERS), plus any SEEDS you pass.
 *     2. A candidate is a Veil wallet if it carries the recovery entries
 *        veil:pk1 + veil:pk2 (the passkey public key), or the retired
 *        veil:wallet entry. The smart-wallet address is derived from the key
 *        exactly as the app does (computeWalletAddress).
 *   Users who funded their own spending account from an exchange, and never
 *   received anything from a funder, are not found unless passed in SEEDS.
 *   The factory's invocation count (from Stellar Expert) is printed as a
 *   cross-check on deployments.
 *
 * Read-only. Uses Horizon, Stellar Expert's public API, and the Veil RPC proxy.
 */

import { Asset, hash, Horizon, Networks, rpc, StrKey, xdr } from '@stellar/stellar-sdk';
import { writeFileSync } from 'node:fs';

const FACTORY = 'CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK';
const PASSPHRASE = Networks.PUBLIC;
const HORIZON_URL = 'https://horizon.stellar.org';
const EXPERT = 'https://api.stellar.expert/explorer/public';
const RPC_URL = process.env.RPC_URL ?? 'https://app.useveilapp.xyz/api/rpc/mainnet';
const USDC = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

// The community funder that created tester spending accounts. Add others via FUNDERS.
const DEFAULT_FUNDERS = ['GAE6BEVEA6IH4HLTGU3AEGZZWSLNCCWLKD4GLN2XHLXFFNFB24COWUJY'];

const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const FUNDERS = list(process.env.FUNDERS).length ? list(process.env.FUNDERS) : DEFAULT_FUNDERS;
const SEEDS = list(process.env.SEEDS);

const horizon = new Horizon.Server(HORIZON_URL);
const soroban = new rpc.Server(RPC_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same derivation as sdk/src/utils.ts computeWalletAddress. */
function computeWalletAddress(publicKeyBytes) {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(PASSPHRASE)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(FACTORY)),
          salt: hash(Buffer.from(publicKeyBytes)),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

async function allPages(builder) {
  const out = [];
  let page = await builder.limit(200).call();
  for (;;) {
    out.push(...page.records);
    if (page.records.length < 200) break;
    page = await page.next();
  }
  return out;
}

async function expert(path) {
  try {
    const res = await fetch(`${EXPERT}/${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Spending accounts a funder created, or sent XLM to. */
async function candidatesFrom(funder) {
  const ops = await allPages(horizon.operations().forAccount(funder).order('asc'));
  const found = new Set();
  for (const op of ops) {
    if (op.type === 'create_account' && op.funder === funder) found.add(op.account);
    if (op.type === 'payment' && op.from === funder && op.asset_type === 'native') found.add(op.to);
  }
  return found;
}

/** The smart wallet a spending account belongs to, from its recovery entries. */
function walletFromData(data) {
  const pk1 = data['veil:pk1'];
  const pk2 = data['veil:pk2'];
  if (pk1 && pk2) {
    const b1 = Buffer.from(pk1, 'base64');
    const b2 = Buffer.from(pk2, 'base64');
    if (b1.length === 32 && b2.length === 32) {
      const key = Buffer.concat([Buffer.from([0x04]), b1, b2]);
      return computeWalletAddress(key);
    }
  }
  const legacy = data['veil:wallet'];
  if (legacy) {
    const addr = Buffer.from(legacy, 'base64').toString('utf8');
    if (StrKey.isValidContract(addr)) return addr;
  }
  return null;
}

async function sacBalance(contract, asset) {
  try {
    const entry = await soroban.getSACBalance(contract, asset, PASSPHRASE);
    return Number(entry.balanceEntry?.amount ?? 0) / 1e7;
  } catch {
    return 0;
  }
}

async function main() {
  const candidates = new Set(SEEDS);
  for (const f of FUNDERS) {
    for (const a of await candidatesFrom(f)) candidates.add(a);
  }
  for (const f of FUNDERS) candidates.delete(f);
  console.log(`Candidate spending accounts: ${candidates.size} (from ${FUNDERS.length} funder(s), ${SEEDS.length} seed(s))`);

  const wallets = [];
  for (const g of candidates) {
    let account;
    try {
      account = await horizon.loadAccount(g);
    } catch {
      continue; // merged or never existed
    }
    const contract = walletFromData(account.data_attr ?? {});
    if (!contract) continue;

    const [txs, expertContract, expertAccount, cXlm, cUsdc] = await Promise.all([
      allPages(horizon.transactions().forAccount(g)),
      expert(`contract/${contract}`),
      expert(`account/${g}`),
      sacBalance(contract, Asset.native()),
      sacBalance(contract, USDC),
    ]);
    const gXlm = Number(account.balances.find((b) => b.asset_type === 'native')?.balance ?? 0);
    const gUsdc = Number(
      account.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === USDC.issuer)?.balance ?? 0,
    );

    wallets.push({
      contract,
      spending: g,
      deployed: !!expertContract?.contract,
      walletCreated: expertContract?.created ? new Date(expertContract.created * 1000).toISOString().slice(0, 10) : null,
      spendingCreated: expertAccount?.created ? new Date(expertAccount.created * 1000).toISOString().slice(0, 10) : null,
      spendingTxs: txs.length,
      spendingPayments: expertAccount?.payments ?? null,
      walletAuthorisedCalls: expertContract?.subinvocation ?? 0,
      usdc: +(gUsdc + cUsdc).toFixed(7),
      xlm: +(gXlm + cXlm).toFixed(7),
    });
    await sleep(250); // be gentle with the public APIs
  }

  const factory = await expert(`contract/${FACTORY}`);
  const sum = (k) => wallets.reduce((s, w) => s + (w[k] ?? 0), 0);

  console.log('\n══ Veil mainnet summary ══════════════════════════════');
  console.log(`Veil wallets found:              ${wallets.length}`);
  console.log(`  deployed on chain:             ${wallets.filter((w) => w.deployed).length}`);
  console.log(`  not yet deployed (no spend):   ${wallets.filter((w) => !w.deployed).length}`);
  console.log(`Factory invocations (Expert):    ${factory?.invocations ?? 'unknown'} (includes the one-time init)`);
  console.log(`Spending-account transactions:   ${sum('spendingTxs')}`);
  console.log(`Smart-wallet authorised calls:   ${sum('walletAuthorisedCalls')}`);
  console.log(`USDC held (both accounts):       ${sum('usdc').toFixed(2)}`);
  console.log(`XLM held (both accounts):        ${sum('xlm').toFixed(2)}`);
  console.log('\n══ Per wallet ════════════════════════════════════════');
  console.table(
    wallets
      .sort((a, b) => (a.spendingCreated ?? '').localeCompare(b.spendingCreated ?? ''))
      .map((w) => ({
        wallet: `${w.contract.slice(0, 6)}…${w.contract.slice(-4)}`,
        spending: `${w.spending.slice(0, 6)}…${w.spending.slice(-4)}`,
        since: w.spendingCreated,
        deployed: w.deployed,
        txs: w.spendingTxs,
        authCalls: w.walletAuthorisedCalls,
        usdc: w.usdc,
        xlm: w.xlm,
      })),
  );
  console.log('Not counted: users whose spending account was funded without any funder in FUNDERS (pass them in SEEDS).');

  if (process.env.JSON_OUT) {
    writeFileSync(process.env.JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), funders: FUNDERS, wallets }, null, 2));
    console.log(`Wrote ${process.env.JSON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
