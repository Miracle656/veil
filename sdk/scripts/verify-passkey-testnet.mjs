#!/usr/bin/env node
/**
 * verify-passkey-testnet.mjs — spends from a Veil wallet on TESTNET with a
 * passkey-authorised Soroban transaction, and prints the transaction hash.
 *
 * Why this exists
 * ---------------
 * The passkey path is the part of the SDK that a typecheck cannot prove. Every
 * `__check_auth` requirement is a runtime contract: the payload the authenticator
 * signs, the five-element signature vector, the ledger-window expiry, the nonce,
 * the budget for the host's secp256r1 verify, and which CAP-71 credential arm the
 * network hands back. A green build says nothing about any of them.
 *
 * This script runs the real path — `deploy()`, then `sendPayment()` through the
 * wallet's own `authorizeEntries` — against the deployed testnet factory, with a
 * software P-256 authenticator standing in for the platform's WebAuthn UI. It is
 * the same assertion shape `frontend/mobile/lib/__tests__/signXdrPayload.test.ts`
 * builds, driven over a live network instead of a mocked one.
 *
 * Usage
 * -----
 *   node scripts/verify-passkey-testnet.mjs
 *   FACTORY_ADDRESS=C... RPC_URL=... node scripts/verify-passkey-testnet.mjs
 *
 * Nothing here touches mainnet: the network passphrase is asserted to be testnet
 * before any transaction is built. Testnet XLM comes from friendbot, so the only
 * cost is the fee payer's own time to fund.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Resolved from sdk/, so this is the same @stellar/stellar-sdk instance the built
// SDK below loads. Two copies in one process means two sets of XDR classes, and an
// Asset or Keypair built by one fails `instanceof` against the other.
const {
    Asset, Contract, Keypair, Networks, TransactionBuilder, Horizon,
    nativeToScVal, rpc: SorobanRpc,
} = require('@stellar/stellar-sdk');
const { InvisibleWalletCore } = require('../dist/core.js');

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS
    || 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA';
const FRIENDBOT_URL = process.env.FRIENDBOT_URL || 'https://friendbot.stellar.org';

// The wallet contract binds both into the assertion, so the deploy and the
// signature must agree on them.
const RP_ID = 'localhost';
const ORIGIN = 'https://localhost';

const WALLET_FUND_STROOPS = 100_000_000n; // 10 XLM to cover the reserve
const SPEND_STROOPS = 10_000_000n;        // 1 XLM, the payment under test

if (PASSPHRASE !== Networks.TESTNET) {
    console.error(`Refusing to run: NETWORK_PASSPHRASE must be testnet, got ${PASSPHRASE}`);
    process.exit(1);
}

const sha256 = (...parts) => {
    const h = createHash('sha256');
    for (const part of parts) h.update(part);
    return h.digest();
};
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * A P-256 key that answers `signAuthEntry` the way a platform passkey does, so
 * the SDK, the contract and the network are all exercised for real.
 */
function createSoftwarePasskey() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const uncompressed = Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, 'base64url'),
        Buffer.from(jwk.y, 'base64url'),
    ]);
    const rpIdHash = sha256(Buffer.from(RP_ID));

    // secp256r1 order, for the low-S normalisation the host requires.
    const CURVE_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

    return {
        publicKeyBytes: new Uint8Array(uncompressed),
        /** Matches the SDK's WebAuthnSignature shape. */
        signAuthEntry: async (payload) => {
            const clientDataJSON = Buffer.from(JSON.stringify({
                type: 'webauthn.get',
                challenge: b64url(payload),
                origin: ORIGIN,
                crossOrigin: false,
            }));
            // rpIdHash | flags (UserPresent | UserVerified) | signCount
            const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);

            const message = Buffer.concat([authData, sha256(clientDataJSON)]);
            let signature = cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });

            const r = signature.subarray(0, 32);
            let s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
            if (s > CURVE_N >> 1n) {
                s = CURVE_N - s;
                signature = Buffer.concat([r, Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
            }

            return {
                publicKey: new Uint8Array(uncompressed),
                authData: new Uint8Array(authData),
                clientDataJSON: new Uint8Array(clientDataJSON),
                signature: new Uint8Array(signature),
            };
        },
    };
}

const memoryStorage = () => {
    const map = new Map();
    return {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
        removeItem: (k) => void map.delete(k),
    };
};

async function fund(address) {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${address}`);
    if (!res.ok) throw new Error(`friendbot failed for ${address}: ${res.status} ${await res.text()}`);
}

const server = () => new SorobanRpc.Server(RPC_URL);

async function submit(tx, signerKeypair, label) {
    const sim = await server().simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error(`${label} failed to simulate: ${sim.error}`);
    }
    const ready = SorobanRpc.assembleTransaction(tx, sim).build();
    ready.sign(signerKeypair);
    const sent = await server().sendTransaction(ready);
    if (sent.status === 'ERROR') {
        throw new Error(`${label} rejected: ${sent.errorResult?.toXDR('base64')}`);
    }
    const receipt = await waitFor(sent.hash);
    console.log(`  ${label}: ${sent.hash} (${receipt.status})`);
    return { hash: sent.hash, receipt };
}

async function waitFor(hash) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const receipt = await server().getTransaction(hash);
        if (receipt.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) return receipt;
        await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error(`Transaction ${hash} never appeared on testnet`);
}

/** Send testnet XLM from a classic account to the wallet's contract address. */
async function fundWalletFrom(payerKeypair, walletAddress) {
    const native = new Contract(Asset.native().contractId(PASSPHRASE));
    const source = await server().getAccount(payerKeypair.publicKey());
    const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: PASSPHRASE })
        .addOperation(native.call(
            'transfer',
            nativeToScVal(payerKeypair.publicKey(), { type: 'address' }),
            nativeToScVal(walletAddress, { type: 'address' }),
            nativeToScVal(WALLET_FUND_STROOPS, { type: 'i128' }),
        ))
        .setTimeout(30)
        .build();
    return submit(tx, payerKeypair, 'fund wallet');
}

const nativeBalanceOf = async (address) => {
    const account = await new Horizon.Server(HORIZON_URL).loadAccount(address);
    const native = account.balances.find((b) => b.asset_type === 'native');
    return BigInt(Math.round(Number(native.balance) * 10_000_000));
};

async function main() {
    console.log(`Network   : ${PASSPHRASE}`);
    console.log(`RPC       : ${RPC_URL}`);
    console.log(`Factory   : ${FACTORY_ADDRESS}`);
    console.log(`SDK build : ${require('../package.json').version}`);

    console.log('\n1. Fee payer and recipient');
    const payerKeypair = Keypair.random();
    const recipientKeypair = Keypair.random();
    await fund(payerKeypair.publicKey());
    await fund(recipientKeypair.publicKey());
    console.log(`  payer     ${payerKeypair.publicKey()}`);
    console.log(`  recipient ${recipientKeypair.publicKey()}`);

    console.log('\n2. Passkey (software P-256) and deploy');
    const passkey = createSoftwarePasskey();
    const wallet = new InvisibleWalletCore({
        factoryAddress: FACTORY_ADDRESS,
        rpcUrl: RPC_URL,
        networkPassphrase: PASSPHRASE,
        rpId: RP_ID,
        origin: ORIGIN,
        storage: memoryStorage(),
    });
    wallet.signAuthEntry = passkey.signAuthEntry;

    // Record which CAP-71 credential arm the network actually returns, since the
    // two arms sign different preimages and only one of them verifies.
    const credentialArms = [];
    const recordArms = wallet.authorizeEntries.bind(wallet);
    wallet.authorizeEntries = async (sim) => {
        for (const entry of sim.result?.auth ?? []) {
            credentialArms.push(entry.credentials?.type ?? 'unknown');
        }
        return recordArms(sim);
    };

    const deployed = await wallet.deploy(payerKeypair.secret(), passkey.publicKeyBytes);
    if (deployed.alreadyDeployed) throw new Error('a fresh key should not already be deployed');
    const walletAddress = deployed.walletAddress;
    console.log(`  wallet ${walletAddress}`);

    await fundWalletFrom(payerKeypair, walletAddress);

    const nonceBefore = await wallet.getNonce();
    const recipientBefore = await nativeBalanceOf(recipientKeypair.publicKey());

    console.log(`\n3. Passkey-authorised spend of ${SPEND_STROOPS} stroops`);
    const spend = await wallet.sendPayment(
        payerKeypair.secret(), recipientKeypair.publicKey(), SPEND_STROOPS
    );

    const receipt = await server().getTransaction(spend.transactionHash);
    const recipientAfter = await nativeBalanceOf(recipientKeypair.publicKey());
    const nonceAfter = await wallet.getNonce();

    console.log(`  credential arms signed : ${credentialArms.join(', ') || 'none'}`);
    console.log(`  on-chain status        : ${receipt.status}`);
    console.log(`  ledger / closed at     : ${receipt.latestLedger} ${receipt.latestLedgerCloseTime}`);
    console.log(`  recipient balance      : ${recipientBefore} -> ${recipientAfter}`);
    console.log(`  wallet nonce           : ${nonceBefore} -> ${nonceAfter}`);

    if (receipt.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`expected SUCCESS, got ${receipt.status}`);
    }
    if (recipientAfter - recipientBefore !== SPEND_STROOPS) {
        throw new Error('recipient balance did not move by the spent amount');
    }
    if (nonceAfter !== nonceBefore + 1n) {
        throw new Error('__check_auth did not advance the nonce');
    }

    console.log('\nPASS — passkey-authorised transaction confirmed on testnet');
    console.log(`transaction hash: ${spend.transactionHash}`);
    console.log(`explorer: https://explorer.stellar.org/testnet/transactions/${spend.transactionHash}`);
}

main().catch((error) => {
    console.error(`\nFAIL: ${error && error.message ? error.message : error}`);
    if (error?.response?.data) console.error(error.response.data);
    process.exit(1);
});
