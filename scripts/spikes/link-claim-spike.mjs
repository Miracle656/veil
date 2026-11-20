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
 *   4. One transaction, signed only with the ephemeral secret from the link
 *      and fee-bumped by the sponsor, then:
 *        - claims the balance,
 *        - moves the money into the recipient's (undeployed) C… wallet via
 *          the native SAC transfer,
 *        - seeds the recipient's PRF-derived fee-payer G… account (here
 *          simulated with a random G… — Node cannot run a WebAuthn PRF),
 *        - merges itself back into the sponsor, releasing the borrowed
 *          base reserve. Nothing is stranded.
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
import { createHash, randomBytes } from 'node:crypto';

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const RPC_URL = 'https://soroban-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot-testnet.stellar.org';

// The wallet factory the frontends derive passkey wallet addresses from
// (frontend/wallet NEXT_PUBLIC_FACTORY_CONTRACT_ID, testnet).
const FACTORY_ID = 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA';

const NATIVE_SAC = Asset.native().contractId(NETWORK_PASSPHRASE);
const LINK_AMOUNT_XLM = '25';   // XLM the sender puts in the link
const FEE_PAYER_SEED_XLM = '1'; // XLM carved out for the recipient's fee payer
const LINK_AMOUNT_STROOPS = BigInt(Math.round(parseFloat(LINK_AMOUNT_XLM) * 1e7));
const SEED_STROOPS = BigInt(Math.round(parseFloat(FEE_PAYER_SEED_XLM) * 1e7));
const CLAIM_DEADLINE_SECONDS = 90; // short so the reclaim demo finishes quickly

const server = new Horizon.Server(HORIZON_URL);
const rpc = new SorobanRpc.Server(RPC_URL);
const sha256 = (b) => createHash('sha256').update(b).digest();
const nativeBalance = async (account) =>
  parseFloat((await server.accounts().accountId(account).call()).balances
    .find((b) => b.asset_type === 'native').balance);

async function fundWithFriendbot(label, keypair) {
  const res = await fetch(`${FRIENDBOT}?addr=${keypair.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot failed for ${label}: ${res.status}`);
  // The faucet is eventually consistent — poll until Horizon knows the account.
  for (let i = 1; i <= 15; i++) {
    try { return await nativeBalance(keypair.publicKey()); } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
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
  // counterfactual address exactly as the SDK does, from a synthetic
  // 65-byte P-256 public key (Node has no WebAuthn; the product flow runs
  // the standard create-wallet screen to mint this credential).
  const p256Key = Buffer.concat([Buffer.from([0x04]), randomBytes(64)]);
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
      // spendable balance; the 0.5 XLM base reserve is also paid by the
      // ephemeral out of the link amount (documented in the cost table).
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

  // ── 4. Confirm the recipient's balance ─────────────────────────────────
  // expected wallet balance: link amount minus the fee-payer seed. The
  // createAccount startingBalance INCLUDES the 0.5 XLM base reserve (0.5 of
  // it is spendable gas for the fee payer, 0.5 locked forever).
  const expectedWallet = LINK_AMOUNT_STROOPS - SEED_STROOPS;
  const walletBalance = await sacBalance(sponsor, recipientWallet);
  console.log(`recipient wallet balance: ${walletBalance} stroops (expected ${expectedWallet})`);
  if (walletBalance !== expectedWallet) throw new Error('recipient wallet balance mismatch');
  const feePayerXlm = await nativeBalance(recipientFeePayer.publicKey());
  if (feePayerXlm < parseFloat(FEE_PAYER_SEED_XLM)) throw new Error('fee payer not seeded');
  console.log(`recipient fee payer funded: ${feePayerXlm} XLM`);
  try {
    await nativeBalance(ephemeral.publicKey());
    throw new Error('ephemeral account should have been merged away');
  } catch (e) {
    if (!/not found|404/i.test(String(e))) throw e;
  }
  console.log('ephemeral account merged away — nothing stranded');

  // ── 5. Reclaim + expiry on a second, never-claimed link ────────────────
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

  // ── 6. The cost ledger ─────────────────────────────────────────────────
  const sponsorEnd = await nativeBalance(sponsor.publicKey());
  const senderEnd = await nativeBalance(sender.publicKey());
  const sponsorNet = sponsorStart - sponsorEnd; // fees for both sponsor txs + transient reserve (returned)
  // Sender paid its own link-creation fees; the claimed 25 left for good,
  // the reclaimed 5 came back.
  const senderFees = senderStart - senderEnd - parseFloat(LINK_AMOUNT_XLM);
  console.log('─'.repeat(72));
  console.log(`SPONSOR net cost per claim : ${sponsorNet.toFixed(7)} XLM (${Math.round(sponsorNet * 1e7)} stroops)`);
  console.log(`  · bracket (create ephemeral)      : ${bracketCharged} stroops charged`);
  console.log(`  · claim+seed fee-bump             : ${claimCharged} stroops charged`);
  console.log(`  · SAC transfer fee-bump           : ${transferCharged} stroops charged (2 × ${transferInner.fee} inner: inclusion + resource fee)`);
  console.log(`  · merge fee-bump                  : ${mergeCharged} stroops charged`);
  console.log(`SENDER cost for 2 links    : ${senderFees.toFixed(7)} XLM (both link amounts settled: 25 claimed, 5 reclaimed)`);
  console.log(`elapsed                    : ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('═'.repeat(72));
}

main().catch((e) => {
  console.error('SPIKE FAILED:', e?.message ?? e);
  const codes = e?.response?.data?.extras?.result_codes ?? e?.extras?.result_codes;
  if (codes) console.error('result_codes:', JSON.stringify(codes, null, 2));
  process.exit(1);
});
