/**
 * Issue #1283 spike — "how does someone with no wallet claim money from a link?"
 *
 * Proves the chosen mechanism (claimable balance to an ephemeral claimant,
 * sponsored account creation at claim time) end to end on testnet:
 *
 *   1. The sender funds a claimable balance naming an EPHEMERAL claimant
 *      (a throwaway keypair whose secret is the link's bearer credential)
 *      plus the sender's reclaim claimant gated behind a deadline.
 *   2. The "recipient" is a brand-new passkey wallet that exists NOWHERE:
 *      the spike derives its counterfactual C… address exactly the way
 *      sdk/src/utils.ts computeWalletAddress() does (factory + SHA-256 of a
 *      65-byte P-256 key) and asserts the address holds nothing anywhere.
 *   3. The sponsor (Veil, server-side — the SPONSOR_SECRET_KEY role from
 *      frontend/wallet/app/api/sponsor-trustline/route.ts) creates the
 *      ephemeral account under CAP-33 sponsorship.
 *   3. One transaction, signed only with the ephemeral secret from the link
 *      and fee-bumped by the sponsor, then:
 *        - claims the balance,
 *        - moves the money into the recipient's (undeployed) C… wallet via
 *          the native SAC transfer,
 *        - seeds the recipient's PRF-derived fee-payer G… account (here
 *          simulated with a random G… — Node cannot run a WebAuthn PRF),
 *        - merges itself back into the sponsor, releasing the borrowed
 *          base reserve. Nothing is stranded.
 *   4. Submits real transactions from the SEEDED FEE PAYER: the product-
 *      shaped wallet deploy (factory.deploy) and a classic payment, both
 *      fee-paid out of the fee payer's own spendable seed — proving the
 *      seed actually buys gas (a 1 XLM seed would be all reserve: minimum
 *      balance is two base reserves = 1 XLM, zero spendable, nothing to
 *      pay a fee with). The deploy is observed to be blocked on testnet by
 *      the stale factory contract (see the OBSERVED note in main()); the
 *      payment proves the spendable XLM is real money the fee payer moves.
 *   5. Verifies the recipient wallet's balance, measures exactly what the
 *      sponsor paid per claim in XLM, and demonstrates reclaim after the
 *      deadline on a second, never-claimed link.
 *
 * Every signing here is classic-key signing (sender, ephemeral, sponsor).
 * The recipient's passkey ceremony belongs to the standard create-wallet
 * flow and is out of scope for a Node spike — see docs/LINK_CLAIM_SPIKE.md
 * for how the real client signs nothing beyond what register() already does.
 *
 * Run: node scripts/spikes/link-claim-spike.mjs
 */

import {
  Account,
  Keypair,
  Asset,
  Contract,
  Address,
  Claimant,
  Horizon,
  Operation,
  StrKey,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const RPC_URL = 'https://soroban-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot-testnet.stellar.org';

// The wallet factory the frontends derive passkey wallet addresses from
// (frontend/wallet NEXT_PUBLIC_FACTORY_CONTRACT_ID, testnet).
const FACTORY_ID = 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA';

const NATIVE_SAC = Asset.native().contractId(NETWORK_PASSPHRASE);
const LINK_AMOUNT_XLM = '25';   // XLM the sender puts in the link
// XLM carved out for the recipient's fee payer. MUST exceed the account
// minimum balance — two base reserves = 1 XLM, all locked. An account
// created with exactly 1 XLM has zero spendable and cannot pay a fee.
// 2 XLM = 1 XLM locked reserve + 1 XLM spendable gas.
const FEE_PAYER_SEED_XLM = '2';
const LINK_AMOUNT_STROOPS = BigInt(Math.round(parseFloat(LINK_AMOUNT_XLM) * 1e7));
const SEED_STROOPS = BigInt(Math.round(parseFloat(FEE_PAYER_SEED_XLM) * 1e7));
const CLAIM_DEADLINE_SECONDS = 90; // short so the reclaim demo finishes quickly

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The sandbox this spike is developed in drops connections intermittently
// (ETIMEDOUT); retry plain fetches a few times so a flake doesn't kill a run.
const fetchRetry = async (url, tries = 10) => {
  for (let i = 1; ; i++) {
    try { return await fetch(url); }
    catch (e) {
      if (i >= tries) throw e;
      console.log(`  (fetch attempt ${i} failed: ${e.cause?.code ?? e.message} — retrying)`);
      await sleep(1500);
    }
  }
};

const server = new Horizon.Server(HORIZON_URL);
const rpc = new SorobanRpc.Server(RPC_URL);
// The sandbox this spike is developed in drops connections intermittently
// (ETIMEDOUT on connect) — retry network-level failures on both SDK clients
// so a flake doesn't kill a mid-run ledger state. Errors WITH a response
// (real protocol answers) are never retried.
for (const client of [server.httpClient, rpc.httpClient]) {
  client.interceptors.response.use(undefined, async (err) => {
    const cfg = err.config ?? {};
    cfg.__retries ??= 0;
    if (err.response || cfg.__retries >= 10) throw err;
    cfg.__retries += 1;
    let host = '';
    try { host = new URL(cfg.url, cfg.baseURL).host; } catch { /* unparseable */ }
    console.log(`  (network flake: retrying ${cfg.method} ${host} — attempt ${cfg.__retries})`);
    await sleep(3000);
    return client.request(cfg);
  });
}
const sha256 = (b) => createHash('sha256').update(b).digest();
const nativeBalance = async (account) =>
  parseFloat((await server.accounts().accountId(account).call()).balances
    .find((b) => b.asset_type === 'native').balance);

async function fundWithFriendbot(label, keypair) {
  const res = await fetchRetry(`${FRIENDBOT}?addr=${keypair.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot failed for ${label}: ${res.status}`);
  // The faucet is eventually consistent — poll until Horizon knows the account.
  for (let i = 1; i <= 15; i++) {
    try { return await nativeBalance(keypair.publicKey()); } catch { /* not yet */ }
    await sleep(1000);
  }
  throw new Error(`account for ${label} never appeared on Horizon`);
}

/**
 * Same derivation as sdk/src/utils.ts computeWalletAddress(): the factory
 * deploys with salt = SHA-256(65-byte P-256 public key), so the wallet
 * address is knowable — and fundable — before the passkey ever exists.
 */
function computeWalletAddress(factoryId, publicKeyBytes) {
  const salt = sha256(Buffer.from(publicKeyBytes));
  const networkId = sha256(Buffer.from(NETWORK_PASSPHRASE));
  const factoryHash = StrKey.decodeContract(factoryId);
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: xdr.ScAddress.scAddressTypeContract(factoryHash),
          salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(sha256(preimage.toXDR()));
}

/** Native-token balance of a C… address, read straight out of the SAC. */
async function sacBalance(probeKeypair, contractAddress) {
  const probeAccount = new Account(probeKeypair.publicKey(), '0');
  const tx = new TransactionBuilder(probeAccount, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(NATIVE_SAC).call('balance', new Address(contractAddress).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`balance sim failed: ${sim.error}`);
  // balance() is read-only; the simulated result is the i128 balance in stroops.
  return BigInt(scValToNative(sim.result.retval).toString());
}

async function main() {
  const t0 = Date.now();
  console.log('═'.repeat(72));
  console.log('Payment-link claim spike — testnet');
  console.log('═'.repeat(72));

  let claimCharged = 0n, transferCharged = 0n, mergeCharged = 0n, bracketCharged = 0n;
  let feePayerFees = 0n; // what the fee payer itself paid: deploy attempt + payment fee + 0.1 XLM moved

  // ── Cast the actors ────────────────────────────────────────────────────
  const sponsor = Keypair.random(); // Veil's SPONSOR_SECRET_KEY role (server-only)
  const sender = Keypair.random();  // the person putting money in a link
  const sponsorStart = await fundWithFriendbot('sponsor', sponsor);
  const senderStart = await fundWithFriendbot('sender', sender);
  console.log(`sponsor ${sponsor.publicKey()} · funded ${sponsorStart} XLM`);
  console.log(`sender  ${sender.publicKey()} · funded ${senderStart} XLM`);

  // The ephemeral claimant: a throwaway keypair whose secret IS the link.
  const ephemeral = Keypair.random();

  // The recipient: a passkey wallet that exists nowhere yet. Derive the
  // counterfactual address exactly as the SDK does, from a REAL generated
  // P-256 key — the factory validates the key on-curve at deploy time
  // (contracts/factory/src/validation.rs), so a throwaway byte string will
  // not do. Node has no WebAuthn PRF, so the fee-payer G… stays random.
  const { publicKey: p256Pub } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'],
  );
  const p256Key = new Uint8Array(await crypto.subtle.exportKey('raw', p256Pub));
  const recipientWallet = computeWalletAddress(FACTORY_ID, p256Key);
  // The recipient's fee-payer G… account is PRF-derived from the same passkey
  // (ADR 0003). Simulated here with a random key — the derivation lives
  // behind a WebAuthn PRF that Node cannot evaluate.
  const recipientFeePayer = Keypair.random();
  console.log(`link    secret=${ephemeral.secret()} (bearer credential, lives in the link fragment)`);
  console.log(`wallet  ${recipientWallet} (counterfactual C…, never deployed)`);
  console.log(`feepay  ${recipientFeePayer.publicKey()} (PRF-derived in product, random here)`);

  // ── 0. Prove the recipient did not exist ───────────────────────────────
  try {
    await nativeBalance(recipientFeePayer.publicKey());
    throw new Error('recipient fee payer unexpectedly exists before the claim');
  } catch (e) {
    if (!/not found|404/i.test(String(e))) throw e;
  }
  let walletDeployedBefore = false;
  try {
    await rpc.getContractData(recipientWallet, xdr.ScVal.scvLedgerKeyContractInstance());
    walletDeployedBefore = true;
  } catch { /* no contract instance on-ledger — expected */ }
  if (walletDeployedBefore) throw new Error('recipient wallet unexpectedly deployed before the claim');
  const balanceBeforeClaim = await sacBalance(sponsor, recipientWallet);
  if (balanceBeforeClaim !== 0n) throw new Error('recipient wallet unexpectedly funded');
  console.log('recipient verified absent: no G… account, zero SAC balance, wallet not deployed');

  // ── 1. Sender funds the link ───────────────────────────────────────────
  const deadline = Math.floor(Date.now() / 1000) + CLAIM_DEADLINE_SECONDS;
  const claimants = [
    new Claimant(ephemeral.publicKey(), Claimant.predicateUnconditional()),
    new Claimant(sender.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(deadline.toString()))),
  ];
  const senderAccount = await server.loadAccount(sender.publicKey());
  const createTx = new TransactionBuilder(senderAccount, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.createClaimableBalance({
      asset: Asset.native(),
      amount: LINK_AMOUNT_XLM,
      claimants,
    }))
    .setTimeout(180)
    .build();
  createTx.sign(sender);
  const created = await server.submitTransaction(createTx);
  // Horizon (post-protocol-23) no longer puts balance_id on the operation
  // record — look the balance up by its unconditional claimant instead.
  const cbs = await server.claimableBalances().claimant(ephemeral.publicKey()).call();
  const balanceId = cbs.records?.[0]?.id;
  if (!balanceId) throw new Error('no claimable balance found for the ephemeral claimant');
  console.log(`link created: ${balanceId} · ${LINK_AMOUNT_XLM} XLM · sender reclaim from ${new Date(deadline * 1000).toISOString()}`);

  // ── 2. Sponsor creates the ephemeral account (CAP-33) ──────────────────
  const sponsorAccount = await server.loadAccount(sponsor.publicKey());
  const createAccountTx = new TransactionBuilder(sponsorAccount, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: ephemeral.publicKey() }))
    // CAP-33 shape (mirrors the sponsor-trustline route): begin has the
    // sponsor as source, createAccount funds FROM the sponsor, and the
    // closing endSponsoring carries the SPONSORED account as its source —
    // co-signed by the ephemeral secret that came from the link.
    .addOperation(Operation.createAccount({ destination: ephemeral.publicKey(), startingBalance: '0' }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: ephemeral.publicKey() }))
    .setTimeout(180)
    .build();
  console.log('sponsor: create ephemeral account under CAP-33 sponsorship');
  createAccountTx.sign(sponsor);
  createAccountTx.sign(ephemeral);
  try {
    const bracketRes = await server.submitTransaction(createAccountTx);
    bracketCharged = BigInt(bracketRes.fee_charged);
    console.log(`  bracket charged ${bracketCharged} stroops`);
  } catch (e) {
    console.error('bracket envelope:', createAccountTx.toXDR());
    console.error('fee:', createAccountTx.fee, 'ops:', createAccountTx.operations.length);
    throw e;
  }

  // ── 3. The claim, as three ephemeral-sourced transactions ──────────────
  // The inner txs carry only the ephemeral's signature (the bearer secret
  // from the link); the sponsor fee-bumps each one, so the LINK amount
  // arrives intact and the recipient's wallet never touches fees. In
  // product the client builds+signs these locally and a server route
  // validates each (balance id, destinations, merge target, fee bound)
  // before fee-bumping — the same discipline as the sponsor-trustline route.
  // Soroban RPC only simulates single-operation transactions, so the SAC
  // invoke travels alone; the classic ops stay classic.
  const ephemeralAccount = await server.loadAccount(ephemeral.publicKey());
  let seq = BigInt(ephemeralAccount.sequence);
  const ephemeralBuilder = () => {
    const acct = new Account(ephemeral.publicKey(), seq.toString());
    seq += 1n;
    return acct;
  };

  // 3a. claim the balance + seed the fee payer (classic ops only)
  const claimUnsigned = new TransactionBuilder(ephemeralBuilder(), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .addOperation(Operation.createAccount({
      destination: recipientFeePayer.publicKey(),
      // Creates the PRF-derived fee-payer G… account with seed XLM of
      // balance. The account minimum — two base reserves = 1 XLM — is
      // part of that and is locked from day one; only the remainder is
      // spendable gas. A 1 XLM seed would leave zero spendable.
      startingBalance: FEE_PAYER_SEED_XLM,
    }))
    .setTimeout(180)
    .build();
  claimUnsigned.sign(ephemeral);
  const claimBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor, (BigInt(BASE_FEE) * 2n).toString(), claimUnsigned, NETWORK_PASSPHRASE,
  );
  claimBump.sign(sponsor);
  const claimBumpCost = BigInt(claimBump.fee); // declared (envelope) fee
  const sponsorBeforeTx = await nativeBalance(sponsor.publicKey());
  try {
    const claimed = await server.submitTransaction(claimBump);
    claimCharged = BigInt(claimed.fee_charged);
    console.log(`3a claim+seed  : ${claimed.hash} (fee-bumped by sponsor, charged ${claimCharged} stroops)`);
  } catch (e) {
    console.error('claim inner fee:', claimUnsigned.fee, 'ops:', claimUnsigned.operations.length,
      'signatures:', claimUnsigned.signatures.length);
    console.error('claim inner envelope:', claimUnsigned.toXDR());
    throw e;
  }

  // 3b. SAC transfer into the recipient's (still undeployed) C… wallet.
  // Assemble with real Soroban resource fees — the invoke costs
  // instructions/memory beyond the inclusion fee.
  const transferUnsigned = new TransactionBuilder(ephemeralBuilder(), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      new Contract(NATIVE_SAC).call(
        'transfer',
        new Address(ephemeral.publicKey()).toScVal(),
        new Address(recipientWallet).toScVal(),
        nativeToScVal(LINK_AMOUNT_STROOPS - SEED_STROOPS, { type: 'i128' }),
      ),
    )
    .setTimeout(180)
    .build();
  const sim = await rpc.simulateTransaction(transferUnsigned);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`claim sim failed: ${sim.error}`);
  const transferInner = SorobanRpc.assembleTransaction(transferUnsigned, sim).build();
  transferInner.sign(ephemeral);
  const transferBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor, (BigInt(transferInner.fee) * 2n).toString(), transferInner, NETWORK_PASSPHRASE,
  );
  transferBump.sign(sponsor);
  const transferBumpCost = BigInt(transferBump.fee);
  const transferred = await server.submitTransaction(transferBump);
  transferCharged = BigInt(transferred.fee_charged);
  console.log(`3b SAC transfer: ${transferred.hash} (fee-bumped by sponsor, charged ${transferCharged} stroops)`);

  // 3c. merge the ephemeral account back into the sponsor, releasing the
  // borrowed base reserve — nothing stranded.
  const mergeUnsigned = new TransactionBuilder(ephemeralBuilder(), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.accountMerge({ destination: sponsor.publicKey() }))
    .setTimeout(180)
    .build();
  mergeUnsigned.sign(ephemeral);
  const mergeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor, (BigInt(BASE_FEE) * 2n).toString(), mergeUnsigned, NETWORK_PASSPHRASE,
  );
  mergeBump.sign(sponsor);
  const mergeBumpCost = BigInt(mergeBump.fee);
  const merged = await server.submitTransaction(mergeBump);
  mergeCharged = BigInt(merged.fee_charged);
  console.log(`3c merge       : ${merged.hash} (fee-bumped by sponsor, charged ${mergeCharged} stroops)`);
  const sponsorAfterTx = await nativeBalance(sponsor.publicKey());
  const claimSponsorCost = sponsorBeforeTx - sponsorAfterTx;
  console.log(`  sponsor net cost: ${claimSponsorCost.toFixed(7)} XLM (includes reserve released back by the merge)`);

  // ── 4. One real transaction from the seeded fee payer ─────────────────
  // This is the step that makes "the fee payer can transact" more than an
  // assertion about balances: a 1 XLM seed would be ENTIRELY reserve (the
  // account minimum is two base reserves = 1 XLM) with zero spendable, so
  // no fee could ever be paid.
  //
  // The product-shaped proof would be the wallet deploy itself
  // (factory.deploy — no Soroban auth needed, no passkey ceremony; the
  // same shape as sdk/src/core.ts deploy(), whose source account is also
  // the fee payer). OBSERVED on testnet (2026-11-26/27, deterministic
  // across four runs and four fresh keys, valid and invalid keys alike):
  // the deployed testnet factory CAUK4… traps on EVERY `deploy` call —
  // (WasmVm, InvalidAction) / "VM call trapped: UnreachableCodeReached" —
  // even for an off-curve key that should return a clean
  // FactoryError::InvalidPublicKey. The simulation below cannot succeed,
  // so there is no resource envelope to submit with and the deploy cannot
  // be sent on testnet today. The repo already records the testnet factory
  // as stale relative to expected-hashes.json (docs/SCF_STRATEGY.md,
  // "known gaps" #1); this is that gap biting, not a conclusion about the
  // claim design. Mainnet's factory verifies.
  const feePayerAccount = await server.loadAccount(recipientFeePayer.publicKey());
  const deployTx = new TransactionBuilder(feePayerAccount, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(FACTORY_ID).call(
      'deploy',
      nativeToScVal(p256Key, { type: 'bytes' }),
      nativeToScVal('veil.xyz', { type: 'string' }),
      nativeToScVal('https://app.veil.xyz', { type: 'string' }),
    ))
    .setTimeout(30)
    .build();
  try {
    const sim = await rpc.simulateTransaction(deployTx);
    console.log(`4  wallet deploy via the testnet factory: ${SorobanRpc.Api.isSimulationError(sim) ? `simulation fails deterministically — ${sim.error}` : 'simulated fine (factory has been fixed since 2026-11-27 — re-run to submit)'}`);
  } catch (e) {
    console.log(`4  wallet deploy simulation: ${e.message}`);
  }

  // The submitted proof instead: a plain classic transaction FROM the fee
  // payer, paying its own fee and 0.1 XLM out of the spendable seed. This
  // is the minimum the claim flow needs from the fee payer even before the
  // wallet deploys — a fee-payer that can actually pay fees.
  const payUnsigned = new TransactionBuilder(await server.loadAccount(recipientFeePayer.publicKey()),
    { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({
      destination: sponsor.publicKey(),
      asset: Asset.native(),
      amount: '0.1',
    }))
    .setTimeout(30)
    .build();
  payUnsigned.sign(recipientFeePayer);
  const payRes = await server.submitTransaction(payUnsigned);
  if (!payRes.successful) throw new Error(`fee-payer payment failed: ${payRes.hash}`);
  const payCharged = BigInt(payRes.fee_charged);
  feePayerFees += payCharged + 1_000_000n; // fee + the 0.1 XLM payment
  console.log(`4b fee-payer payment: ${payRes.hash} (0.1 XLM to the sponsor, charged ${payCharged} stroops) — the spendable seed is real`);

  // ── 5. Confirm the recipient's balance ─────────────────────────────────
  // expected wallet balance: link amount minus the fee-payer seed. The
  // createAccount startingBalance includes the account minimum — two base
  // reserves = 1 XLM, locked — so the seed must clear that minimum with
  // real spendable gas on top.
  const expectedWallet = LINK_AMOUNT_STROOPS - SEED_STROOPS;
  const walletBalance = await sacBalance(sponsor, recipientWallet);
  console.log(`recipient wallet balance: ${walletBalance} stroops (expected ${expectedWallet})`);
  if (walletBalance !== expectedWallet) throw new Error('recipient wallet balance mismatch');
  const feePayerXlm = await nativeBalance(recipientFeePayer.publicKey());
  const feePayerStroops = BigInt(Math.round(feePayerXlm * 1e7));
  const MIN_BALANCE_STROOPS = 10_000_000n; // two base reserves of 0.5 XLM
  const expectedFeePayer = SEED_STROOPS - feePayerFees;
  if (feePayerStroops !== expectedFeePayer) {
    throw new Error(`fee payer balance mismatch: ${feePayerStroops} vs expected ${expectedFeePayer}`);
  }
  if (feePayerStroops - MIN_BALANCE_STROOPS <= 0n) {
    throw new Error('fee payer has no spendable balance above the reserve');
  }
  console.log(`recipient fee payer: ${feePayerXlm} XLM total · ${Number(feePayerStroops - MIN_BALANCE_STROOPS) / 1e7} XLM spendable above the 1 XLM reserve (seed ${FEE_PAYER_SEED_XLM} − 1 XLM reserve − 0.1 XLM payment − ${(Number(feePayerFees - 1_000_000n) / 1e7).toFixed(7)} XLM fees)`);
  try {
    await nativeBalance(ephemeral.publicKey());
    throw new Error('ephemeral account should have been merged away');
  } catch (e) {
    if (!/not found|404/i.test(String(e))) throw e;
  }
  console.log('ephemeral account merged away — nothing stranded');

  // ── 6. Reclaim + expiry on a second, never-claimed link ────────────────
  const reclaimDeadline = Math.floor(Date.now() / 1000) + 15;
  const claimants2 = [
    new Claimant(ephemeral.publicKey(), Claimant.predicateUnconditional()),
    new Claimant(sender.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(reclaimDeadline.toString()))),
  ];
  const senderAccount2 = await server.loadAccount(sender.publicKey());
  const createTx2 = new TransactionBuilder(senderAccount2, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.createClaimableBalance({ asset: Asset.native(), amount: '5', claimants: claimants2 }))
    .setTimeout(180)
    .build();
  createTx2.sign(sender);
  await server.submitTransaction(createTx2);
  const cbs2 = await server.claimableBalances().claimant(sender.publicKey()).call();
  const second = cbs2.records?.find((r) => r.amount === '5.0000000');
  const secondBalanceId = second?.id;
  if (!secondBalanceId) throw new Error('no 5-XLM claimable balance found for the sender');
  console.log(`second link ${secondBalanceId} left unclaimed (expiry ${new Date(reclaimDeadline * 1000).toISOString()})`);
  console.log('waiting out the deadline…');
  await new Promise((r) => setTimeout(r, 17_000));
  const senderAccount3 = await server.loadAccount(sender.publicKey());
  const reclaimTx = new TransactionBuilder(senderAccount3, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.claimClaimableBalance({ balanceId: secondBalanceId }))
    .setTimeout(180)
    .build();
  reclaimTx.sign(sender);
  const reclaimed = await server.submitTransaction(reclaimTx);
  console.log(`sender reclaimed the expired link (${reclaimed.hash}) — reclaim + expiry proven`);

  // ── 7. The cost ledger ─────────────────────────────────────────────────
  const senderEnd = await nativeBalance(sender.publicKey());
  // Sponsor cost is measured at the end of the claim (before the fee
  // payer's 0.1 XLM payment lands in the sponsor's account, which would
  // otherwise read as negative cost).
  const sponsorNet = sponsorStart - sponsorAfterTx; // fees for both sponsor txs + transient reserve (returned)
  // Sender paid its own link-creation fees; the claimed 25 left for good,
  // the reclaimed 5 came back.
  const senderFees = senderStart - senderEnd - parseFloat(LINK_AMOUNT_XLM);
  console.log('─'.repeat(72));
  console.log(`SPONSOR net cost per claim : ${sponsorNet.toFixed(7)} XLM (${Math.round(sponsorNet * 1e7)} stroops)`);
  console.log(`  · bracket (create ephemeral)      : ${bracketCharged} stroops charged`);
  console.log(`  · claim+seed fee-bump             : ${claimCharged} stroops charged`);
  console.log(`  · SAC transfer fee-bump           : ${transferCharged} stroops charged (2 × ${transferInner.fee} inner: inclusion + resource fee)`);
  console.log(`  · merge fee-bump                  : ${mergeCharged} stroops charged`);
  console.log(`fee payer's own spend        : ${(Number(feePayerFees - 1_000_000n) / 1e7).toFixed(7)} XLM fees + 0.1 XLM payment, from its spendable seed (not Veil's cost)`);
  console.log(`SENDER cost for 2 links    : ${senderFees.toFixed(7)} XLM (both link amounts settled: 25 claimed, 5 reclaimed)`);
  console.log(`elapsed                    : ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('═'.repeat(72));
}

main().catch((e) => {
  console.error('SPIKE FAILED:', e?.message ?? e);
  if (e?.cause) console.error('cause:', e.cause?.message ?? e.cause?.code ?? e.cause);
  const codes = e?.response?.data?.extras?.result_codes ?? e?.extras?.result_codes;
  if (codes) console.error('result_codes:', JSON.stringify(codes, null, 2));
  if (process.env.SPIKE_DEBUG) console.error(e);
  process.exit(1);
});
