/**
 * Carrying out the random-fee-payer rescue planned in `feePayerRepair.ts`.
 *
 * Everything touching the network or the keystore is injected, so the
 * orchestration can be tested without Horizon and without ever holding a real
 * secret. The default bindings are at the bottom and are the only part a unit
 * test cannot exercise.
 *
 * Two rules this follows, both learned from the sweep that came before it:
 *
 * - **The destination is derived, never passed in.** It is whatever the
 *   passkey's PRF output produces, so a caller — or a screen, or a deep link —
 *   cannot aim this at an address of its choosing.
 * - **The stored secret is replaced only after the transaction succeeds.**
 *   Swapping first and submitting second would, on any failure, leave the app
 *   holding a key for an empty account while the money sat behind one it had
 *   just forgotten. That is the exact shape of the loss this exists to prevent.
 */

import {
    Asset,
    Horizon,
    Keypair,
    Operation,
    TransactionBuilder,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { planFeePayerRepair, type RepairInputs, type RepairPlan, type RepairStep } from './feePayerRepair';
import { getFeePayerInfo, recordFeePayerSource } from './feePayerSource';
import { inclusionFee } from './fees';
import { getNetwork } from './network';
import { evaluatePrf } from './passkey';
import { FEE_PAYER_PRF_SALT } from './passkeyWallet';
import {
    getPasskeyId,
    getPasskeyPublicKey,
    getSignerSecret,
    getWalletAddress,
    setSignerSecret,
} from './walletStore';
import { writeBreadcrumbs } from './walletBreadcrumbs';

export type RepairAccount = {
    xlm: number | null;
    subentryCount: number;
    trustlines: Array<{ code: string; issuer: string; balance: number }>;
    dataNames: string[];
};

/**
 * A key the app holds, carried as a pair so nothing in the orchestration has
 * to parse a secret to learn its address. Only the default bindings at the
 * bottom touch the Stellar SDK.
 */
export type HeldKey = { secret: string; address: string };

export type RepairRunDeps = {
    /** The PRF-derived key, or null when the passkey returned no PRF. */
    derivePrfKey: () => Promise<HeldKey | null>;
    /** The random fee-payer this device is currently holding. */
    currentKey: () => Promise<HeldKey | null>;
    /** What `recordFeePayerSource` last recorded for it. */
    currentSource: () => Promise<RepairInputs['source']>;
    /** Reads an account, or null when Horizon has never heard of it. */
    loadAccount: (address: string) => Promise<RepairAccount | null>;
    /** Submits the whole plan as one transaction and returns its hash. */
    submit: (fromSecret: string, to: string, steps: RepairStep[]) => Promise<string>;
    /** Points the app at the rescued key. Only called after `submit` resolves. */
    adopt: (key: HeldKey) => Promise<void>;
};

export type RepairOutcome =
    | { repaired: true; txHash: string; from: string; to: string; amount: string; closedAccount: boolean }
    | { repaired: false; plan: RepairPlan }
    | { repaired: false; error: string };

/**
 * Is a PRF secret available on this device, and what fee-payer does it make?
 *
 * This is the question a user with a "Random fallback fee payer" warning
 * actually has, and it is answerable without moving anything: a passkey either
 * returns a PRF output or it does not. A null address means the authenticator
 * answered without PRF — the wallet is still usable, but its fee-payer can
 * never be re-derived on another device.
 */
export async function checkPrfDerivation(
    derivePrfKey: RepairRunDeps['derivePrfKey'],
): Promise<{ available: boolean; address: string | null }> {
    try {
        const key = await derivePrfKey();
        return key
            ? { available: true, address: key.address }
            : { available: false, address: null };
    } catch {
        // A cancelled or failed ceremony is not proof the device lacks PRF, so
        // this reports "not available now" rather than recording anything.
        return { available: false, address: null };
    }
}

/**
 * Move a random fee-payer's balance onto the PRF-derived one, and adopt it.
 *
 * Returns what happened rather than throwing, so a screen can explain a refusal
 * as readily as a success.
 */
export async function repairRandomFeePayer(deps: RepairRunDeps): Promise<RepairOutcome> {
    try {
        const [derived, current, source] = await Promise.all([
            deps.derivePrfKey(),
            deps.currentKey(),
            deps.currentSource(),
        ]);

        if (!current) return { repaired: false, error: 'no-current-secret' };

        const [sourceAccount, destination] = await Promise.all([
            deps.loadAccount(current.address),
            derived ? deps.loadAccount(derived.address) : Promise.resolve(null),
        ]);

        const plan = planFeePayerRepair({
            source,
            currentAddress: current.address,
            currentXlm: sourceAccount?.xlm ?? null,
            currentSubentryCount: sourceAccount?.subentryCount ?? 0,
            currentTrustlines: sourceAccount?.trustlines ?? [],
            currentDataNames: sourceAccount?.dataNames ?? [],
            derivedAddress: derived?.address ?? null,
            derivedXlm: destination?.xlm ?? null,
        });

        if (plan.action !== 'repair') return { repaired: false, plan };

        const txHash = await deps.submit(current.secret, plan.to, plan.steps);

        // Only now. Until the transaction confirmed, the random key was still
        // the one holding the money.
        if (derived) await deps.adopt(derived);

        return {
            repaired: true,
            txHash,
            from: plan.from,
            to: plan.to,
            amount: plan.recoverableXlm,
            closedAccount: plan.closesAccount,
        };
    } catch (error) {
        return { repaired: false, error: error instanceof Error ? error.message : 'repair-failed' };
    }
}

// ── Default bindings ─────────────────────────────────────────────────────────

/** Horizon's account shape, reduced to what the plan needs. */
export function repairSnapshotFromHorizon(account: {
    balances: Array<{ asset_type: string; balance: string; asset_code?: string; asset_issuer?: string }>;
    subentry_count: number;
    data_attr?: Record<string, string>;
}): RepairAccount {
    const native = account.balances.find((b) => b.asset_type === 'native');
    return {
        xlm: native ? Number(native.balance) : 0,
        subentryCount: account.subentry_count,
        trustlines: account.balances
            .filter((b) => b.asset_type !== 'native' && b.asset_code && b.asset_issuer)
            .map((b) => ({
                code: b.asset_code as string,
                issuer: b.asset_issuer as string,
                balance: Number(b.balance),
            })),
        dataNames: Object.keys(account.data_attr ?? {}),
    };
}

/**
 * Turn the plan into operations on one transaction.
 *
 * Order is the plan's order and it matters: trustlines and data entries have to
 * be gone before `accountMerge` is allowed, and the destination has to exist
 * before anything can be merged into it.
 */
export function buildRepairTransaction(
    source: Horizon.AccountResponse,
    to: string,
    steps: RepairStep[],
    networkPassphrase: string,
    fee: string,
): ReturnType<TransactionBuilder['build']> {
    const builder = new TransactionBuilder(source, { fee, networkPassphrase });

    for (const step of steps) {
        switch (step.step) {
            case 'close-trustline':
                builder.addOperation(
                    Operation.changeTrust({ asset: new Asset(step.code, step.issuer), limit: '0' }),
                );
                break;
            case 'delete-data':
                builder.addOperation(Operation.manageData({ name: step.name, value: null }));
                break;
            case 'create-destination':
                builder.addOperation(
                    Operation.createAccount({ destination: to, startingBalance: step.amount }),
                );
                break;
            case 'merge':
                builder.addOperation(Operation.accountMerge({ destination: to }));
                break;
            case 'send-xlm':
                builder.addOperation(
                    Operation.payment({ destination: to, asset: Asset.native(), amount: step.amount }),
                );
                break;
        }
    }

    return builder.setTimeout(120).build();
}

/** Build, sign and submit. Separated so a test never signs. */
export async function submitRepair(
    fromSecret: string,
    to: string,
    steps: RepairStep[],
    net: { horizonUrl: string; networkPassphrase: string },
    fee: string,
): Promise<string> {
    const server = new Horizon.Server(net.horizonUrl);
    const keypair = Keypair.fromSecret(fromSecret);
    const account = await server.loadAccount(keypair.publicKey());
    const tx = buildRepairTransaction(account, to, steps, net.networkPassphrase, fee);
    tx.sign(keypair);
    const result = await server.submitTransaction(tx);
    return (result as { hash: string }).hash;
}

/**
 * The real bindings.
 *
 * `adopt` is the only part that writes: it points the wallet at the rescued key
 * and republishes the breadcrumbs, because the old account's copy went with it
 * when the account was merged away. It runs only after the transaction
 * confirmed.
 */
export function defaultRepairDeps(): RepairRunDeps {
    const net = getNetwork();
    return {
        derivePrfKey: async () => {
            const keyId = await getPasskeyId();
            if (!keyId) return null;
            const result = await evaluatePrf(keyId, FEE_PAYER_PRF_SALT);
            if (result.outcome !== 'ok' || !result.output || result.output.length < 32) return null;
            const keypair = Keypair.fromRawEd25519Seed(Buffer.from(result.output.subarray(0, 32)));
            return { secret: keypair.secret(), address: keypair.publicKey() };
        },
        currentKey: async () => {
            const secret = await getSignerSecret().catch(() => null);
            if (!secret) return null;
            return { secret, address: Keypair.fromSecret(secret).publicKey() };
        },
        currentSource: async () => (await getFeePayerInfo().catch(() => null))?.source ?? 'unknown',
        loadAccount: horizonRepairLoader(net),
        submit: (fromSecret, to, steps) => submitRepair(fromSecret, to, steps, net, inclusionFee()),
        adopt: async (key) => {
            await Promise.all([
                setSignerSecret(key.secret),
                recordFeePayerSource(key.address, 'prf'),
            ]);
            const [walletAddress, pubHex] = await Promise.all([
                getWalletAddress().catch(() => null),
                getPasskeyPublicKey().catch(() => null),
            ]);
            if (!walletAddress) return;
            const pub =
                pubHex && /^[0-9a-fA-F]{130}$/.test(pubHex)
                    ? new Uint8Array(Buffer.from(pubHex, 'hex'))
                    : null;
            // Best-effort: the rescue has already succeeded, and a failed
            // breadcrumb write is recoverable on any later sign-in.
            void writeBreadcrumbs(key.secret, walletAddress, pub).catch(() => undefined);
        },
    };
}

/** Reads an account through Horizon, treating a 404 as "not funded". */
export function horizonRepairLoader(
    net: { horizonUrl: string },
): (address: string) => Promise<RepairAccount | null> {
    const server = new Horizon.Server(net.horizonUrl);
    return async (address) => {
        try {
            const account = await server.loadAccount(address);
            return repairSnapshotFromHorizon(
                account as unknown as Parameters<typeof repairSnapshotFromHorizon>[0],
            );
        } catch {
            return null;
        }
    };
}
