#!/usr/bin/env node
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const {
    Asset,
    Horizon,
    Keypair,
    Networks,
    Operation,
    TransactionBuilder,
} = require('@stellar/stellar-sdk');
const {
    claimableBalanceReserveXlm,
    createStealthIdentity,
    getUsdcIssuer,
    inclusionFee,
    reclaimEscrow,
    sendStealthPayment,
} = require('../sdk/dist/index.js');

const NETWORKS = {
    mainnet: { horizonUrl: 'https://horizon.stellar.org', passphrase: Networks.PUBLIC },
    testnet: { horizonUrl: 'https://horizon-testnet.stellar.org', passphrase: Networks.TESTNET },
};
const BASE_RESERVE_STROOPS = 5_000_000n;

function parseArgs(argv) {
    const options = {
        network: 'mainnet',
        asset: 'usdc',
        amount: '0.0000001',
        deadlineSeconds: 20,
        testAsset: false,
        apply: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];
        if (argument === '--apply') options.apply = true;
        else if (argument === '--network') options.network = argv[++i];
        else if (argument === '--asset') options.asset = argv[++i];
        else if (argument === '--amount') options.amount = argv[++i];
        else if (argument === '--deadline-seconds') options.deadlineSeconds = Number(argv[++i]);
        else if (argument === '--test-asset') options.testAsset = true;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!NETWORKS[options.network]) throw new Error('--network must be mainnet or testnet.');
    if (!['native', 'usdc'].includes(options.asset)) throw new Error('--asset must be native or usdc.');
    if (options.testAsset && (options.network !== 'testnet' || options.asset !== 'usdc')) {
        throw new Error('--test-asset is only valid with --network testnet --asset usdc.');
    }
    if (!Number.isSafeInteger(options.deadlineSeconds) || options.deadlineSeconds < 1 || options.deadlineSeconds > 300) {
        throw new Error('--deadline-seconds must be an integer from 1 to 300.');
    }
    return options;
}

function stroops(amount) {
    if (!/^\d+(\.\d{1,7})?$/.test(amount)) throw new Error('Amounts must have at most seven decimal places.');
    const [whole, fraction = ''] = amount.split('.');
    return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
}

function formatAmount(value) {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 10_000_000n}.${(absolute % 10_000_000n).toString().padStart(7, '0')}`;
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function transactionDetails(server, hash) {
    const transaction = await server.transactions().transaction(hash).call();
    return {
        hash: transaction.hash,
        maxFeeStroops: transaction.max_fee,
        feeChargedStroops: transaction.fee_charged,
        ledger: transaction.ledger_attr,
        createdAt: transaction.created_at,
        successful: transaction.successful,
    };
}

async function waitForTransaction(server, hash) {
    let lastError;
    for (let attempt = 0; attempt < 15; attempt++) {
        try {
            return await transactionDetails(server, hash);
        } catch (error) {
            if (error?.response?.status !== 404) throw error;
            lastError = error;
            if (attempt < 14) await delay(2000);
        }
    }
    throw lastError;
}

async function sponsoredClaimableBalances(server, address) {
    let page = await server.claimableBalances().sponsor(address).limit(200).call();
    let count = 0;
    let reserveStroops = 0n;
    while (true) {
        for (const balance of page.records) {
            count += 1;
            reserveStroops += BigInt(balance.claimants.length) * BASE_RESERVE_STROOPS;
        }
        if (page.records.length < 200) break;
        page = await page.next();
    }
    return { count, reserveStroops };
}

async function snapshot(server, address, asset) {
    const account = await server.loadAccount(address);
    const native = account.balances.find((balance) => balance.asset_type === 'native');
    const issued = asset.isNative() ? null : account.balances.find((balance) =>
        balance.asset_type === 'credit_alphanum4'
        && balance.asset_code === asset.getCode()
        && balance.asset_issuer === asset.getIssuer(),
    );
    return {
        nativeStroops: stroops(native?.balance ?? '0'),
        assetStroops: asset.isNative() ? 0n : stroops(issued?.balance ?? '0'),
        nativeSellingLiabilitiesStroops: stroops(native?.selling_liabilities ?? '0'),
        subentryCount: account.subentry_count,
        sponsoringCount: account.num_sponsoring,
        sponsoredCount: account.num_sponsored,
    };
}

async function accountExists(server, address) {
    try {
        await server.loadAccount(address);
        return true;
    } catch (error) {
        if (error?.response?.status === 404) return false;
        throw error;
    }
}

async function fundTestAccount(address) {
    let response;
    try {
        response = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
    } catch (error) {
        throw new Error(`Friendbot request failed: ${error?.cause?.message ?? error.message}`, { cause: error });
    }
    if (!response.ok) throw new Error(`Friendbot returned HTTP ${response.status}`);
}

async function prepareTestAsset(server, sender, issuer, asset, amount) {
    const submit = async (operation, signer) => {
        const account = await server.loadAccount(signer.publicKey());
        const transaction = new TransactionBuilder(account, {
            fee: inclusionFee('testnet'),
            networkPassphrase: Networks.TESTNET,
        })
            .addOperation(operation)
            .setTimeout(30)
            .build();
        transaction.sign(signer);
        await server.submitTransaction(transaction);
    };
    let account = await server.loadAccount(sender.publicKey());
    const hasTrustline = account.balances.some((balance) =>
        balance.asset_type === 'credit_alphanum4'
        && balance.asset_code === asset.getCode()
        && balance.asset_issuer === asset.getIssuer());
    if (!hasTrustline) await submit(Operation.changeTrust({ asset, limit: '1000000' }), sender);
    account = await server.loadAccount(sender.publicKey());
    const issued = account.balances.find((balance) =>
        balance.asset_type === 'credit_alphanum4'
        && balance.asset_code === asset.getCode()
        && balance.asset_issuer === asset.getIssuer());
    if (stroops(issued?.balance ?? '0') < stroops(amount)) {
        await submit(Operation.payment({ asset, destination: sender.publicKey(), amount }), issuer);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const secret = process.env.FUNDER_SECRET?.trim();
    if (!secret) throw new Error('FUNDER_SECRET is not set. Export it in the shell; do not pass it as an argument.');
    const sender = Keypair.fromSecret(secret);
    const network = NETWORKS[options.network];
    const server = new Horizon.Server(network.horizonUrl);
    let testIssuer;
    if (options.testAsset) testIssuer = Keypair.random();
    const asset = options.asset === 'native'
        ? Asset.native()
        : new Asset('USDC', options.testAsset ? testIssuer.publicKey() : getUsdcIssuer(options.network));
    const amountStroops = stroops(options.amount);
    if (amountStroops <= 0n) throw new Error('--amount must be positive.');
    const reserveStroops = BigInt(Math.round(claimableBalanceReserveXlm() * 10_000_000));

    const identity = createStealthIdentity();
    const plan = {
        network: options.network,
        sender: sender.publicKey(),
        recipientPublicKey: identity.publicKey,
        asset: asset.isNative() ? 'native' : `${asset.getCode()}:${asset.getIssuer()}`,
        amount: options.amount,
        expectedReserveXlm: formatAmount(reserveStroops),
        feeBidStroops: inclusionFee(options.network),
        claimDeadlineSeconds: options.deadlineSeconds,
        testAsset: options.testAsset,
        reclaimAfterDeadline: true,
        apply: options.apply,
    };
    if (!options.apply) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }

    if (options.testAsset) {
        await fundTestAccount(testIssuer.publicKey());
        await prepareTestAsset(server, sender, testIssuer, asset, options.amount);
    }
    const before = await snapshot(server, sender.publicKey(), asset);
    const beforeSponsored = await sponsoredClaimableBalances(server, sender.publicKey());
    const requiredNative = reserveStroops + (asset.isNative() ? amountStroops : 0n) + 100_000_000n;
    const accountReserve = (2n + BigInt(before.subentryCount)
        + BigInt(before.sponsoringCount) - BigInt(before.sponsoredCount)) * BASE_RESERVE_STROOPS;
    // num_sponsoring already includes claimable-balance claimant reserves.
    const spendableNative = before.nativeStroops - accountReserve
        - before.nativeSellingLiabilitiesStroops;
    if (spendableNative < requiredNative) {
        throw new Error(`Insufficient spendable XLM: need ${formatAmount(requiredNative)} plus fees and existing liabilities.`);
    }
    if (!asset.isNative() && before.assetStroops < amountStroops) {
        throw new Error(`Insufficient ${asset.getCode()} balance for ${options.amount}.`);
    }

    const signer = {
        publicKey: sender.publicKey(),
        signTransaction(xdr, context) {
            const transaction = TransactionBuilder.fromXDR(xdr, context.networkPassphrase);
            transaction.sign(sender);
            return transaction.toXDR();
        },
    };
    let created;
    try {
        created = await sendStealthPayment({
            sender: signer,
            recipientPublicKey: identity.publicKey,
            amount: options.amount,
            asset,
            claimDeadlineSeconds: options.deadlineSeconds,
            fee: inclusionFee(options.network),
            config: { horizonUrl: network.horizonUrl, networkPassphrase: network.passphrase },
        });
    } catch (error) {
        const submission = error instanceof Error ? error : {};
        if (!submission.balanceId || !submission.txHash || !submission.address
            || !submission.ephemeralPublicKey || !submission.expiresAt) {
            throw error;
        }
        created = {
            balanceId: submission.balanceId,
            txHash: submission.txHash,
            expiresAt: submission.expiresAt,
            address: submission.address,
            ephemeralPublicKey: submission.ephemeralPublicKey,
        };
        console.log(JSON.stringify({
            stage: 'submission-uncertain',
            txHash: created.txHash,
            balanceId: created.balanceId,
            recipientOneTimeAddress: created.address,
            ephemeralPublicKey: created.ephemeralPublicKey,
            expiresAt: created.expiresAt,
        }, null, 2));
    }
    const creation = {
        ...plan,
        recipientOneTimeAddress: created.address,
        ephemeralPublicKey: created.ephemeralPublicKey,
        balanceId: created.balanceId,
        expiresAt: created.expiresAt,
        createTxHash: created.txHash,
    };
    let reclaimed = false;
    let creationConfirmed = false;
    let pendingReclaimHash;
    const reconcileReclaim = async (hash) => {
        const recovered = await waitForTransaction(server, hash);
        if (!recovered.successful) {
            pendingReclaimHash = undefined;
            throw new Error(`The previously submitted reclaim transaction ${hash} failed.`);
        }
        return {
            txHash: recovered.hash,
            feeCharged: recovered.feeChargedStroops,
            recovered: true,
        };
    };
    const reclaim = async () => {
        if (pendingReclaimHash) {
            // An ambiguous submission must be reconciled, never blindly resubmitted.
            const result = await reconcileReclaim(pendingReclaimHash);
            reclaimed = true;
            return result;
        }
        const waitMilliseconds = Math.max(0, (created.expiresAt + 2 - Math.floor(Date.now() / 1000)) * 1000);
        if (waitMilliseconds > 0) await delay(waitMilliseconds);
        let result;
        try {
            result = await reclaimEscrow({
                sender: signer,
                balanceId: created.balanceId,
                fee: inclusionFee(options.network),
                config: { horizonUrl: network.horizonUrl, networkPassphrase: network.passphrase },
            });
        } catch (error) {
            if (error?.balanceId !== created.balanceId || typeof error?.txHash !== 'string') throw error;
            pendingReclaimHash = error.txHash;
            result = await reconcileReclaim(pendingReclaimHash);
        }
        reclaimed = true;
        return result;
    };

    let failure;
    try {
        console.log(JSON.stringify({ stage: 'created', ...creation }, null, 2));
        const createTransaction = await waitForTransaction(server, created.txHash);
        if (!createTransaction.successful) throw new Error('The claimable-balance creation transaction failed.');
        creationConfirmed = true;
        const afterCreate = await snapshot(server, sender.publicKey(), asset);
        const afterCreateSponsored = await sponsoredClaimableBalances(server, sender.publicKey());
        const createFee = BigInt(createTransaction.feeChargedStroops);
        const observedNativeDebit = before.nativeStroops - afterCreate.nativeStroops;
        const expectedNativeDebit = createFee + (asset.isNative() ? amountStroops : 0n);
        const observedReserve = afterCreateSponsored.reserveStroops - beforeSponsored.reserveStroops;
        const observedAssetDebit = asset.isNative() ? 0n : before.assetStroops - afterCreate.assetStroops;
        if (afterCreateSponsored.count !== beforeSponsored.count + 1) {
            throw new Error('Horizon did not show exactly one new sponsored claimable balance.');
        }
        if (observedReserve !== reserveStroops) {
            throw new Error(`Measured reserve ${formatAmount(observedReserve)} XLM did not match ${formatAmount(reserveStroops)} XLM.`);
        }
        if (observedNativeDebit !== expectedNativeDebit) {
            throw new Error(`Measured native debit ${formatAmount(observedNativeDebit)} XLM did not match ${formatAmount(expectedNativeDebit)} XLM.`);
        }
        if (!asset.isNative() && observedAssetDebit !== amountStroops) {
            throw new Error(`Measured ${asset.getCode()} debit ${formatAmount(observedAssetDebit)} did not match ${options.amount}.`);
        }
        const balance = await server.claimableBalances().claimableBalance(created.balanceId).call();
        const claimants = balance.claimants.map((claimant) => ({
            destination: claimant.destination,
            predicate: claimant.predicate,
        }));
        if (balance.sponsor !== sender.publicKey()) {
            throw new Error('Horizon returned an unexpected claimable-balance reserve holder.');
        }
        const expectedAsset = asset.isNative() ? 'native' : `${asset.getCode()}:${asset.getIssuer()}`;
        if (balance.asset !== expectedAsset || stroops(balance.amount) !== amountStroops) {
            throw new Error('Horizon returned an unexpected claimable-balance asset or amount.');
        }
        if (claimants.length !== 2 || claimants[0]?.destination !== created.address
            || claimants[1]?.destination !== sender.publicKey()) {
            throw new Error('Horizon returned unexpected claimable-balance claimants.');
        }
        const deadlineIso = new Date(created.expiresAt * 1000).toISOString().replace('.000Z', 'Z');
        if (!isDeepStrictEqual(claimants[0].predicate, { unconditional: true })
            || !isDeepStrictEqual(claimants[1].predicate, {
                not: {
                    abs_before: deadlineIso,
                    abs_before_epoch: created.expiresAt.toString(),
                },
            })) {
            throw new Error('Horizon returned unexpected claimable-balance predicates.');
        }
        if (await accountExists(server, created.address)) {
            throw new Error('The derived one-time account unexpectedly exists.');
        }

        const report = {
            ...plan,
            recipientOneTimeAddress: created.address,
            ephemeralPublicKey: created.ephemeralPublicKey,
            balanceId: created.balanceId,
            expiresAt: created.expiresAt,
            reserveHolderWhileUnclaimed: sender.publicKey(),
            oneTimeAccountExists: false,
            createTransaction,
            claimants,
            sponsoredClaimableBalancesBefore: beforeSponsored.count,
            sponsoredClaimableBalancesAfter: afterCreateSponsored.count,
            measuredNativeDebitStroops: observedNativeDebit.toString(),
            measuredNativeDebitXlm: formatAmount(observedNativeDebit),
            measuredReserveStroops: observedReserve.toString(),
            measuredReserveXlm: formatAmount(observedReserve),
            measuredAssetDebitStroops: observedAssetDebit.toString(),
            measuredAssetDebit: formatAmount(observedAssetDebit),
        };

        const reclaimedBalance = await reclaim();
        const afterReclaim = await snapshot(server, sender.publicKey(), asset);
        const afterReclaimSponsored = await sponsoredClaimableBalances(server, sender.publicKey());
        const reclaimTransaction = await transactionDetails(server, reclaimedBalance.txHash);
        const reclaimFee = BigInt(reclaimTransaction.feeChargedStroops);
        const releasedReserve = afterCreateSponsored.reserveStroops - afterReclaimSponsored.reserveStroops;
        const nativeReturned = afterReclaim.nativeStroops - afterCreate.nativeStroops + reclaimFee;
        const returnedAsset = asset.isNative() ? 0n : afterReclaim.assetStroops - afterCreate.assetStroops;
        if (afterReclaimSponsored.count !== afterCreateSponsored.count - 1) {
            throw new Error('Horizon did not show exactly one fewer sponsored claimable balance after reclaim.');
        }
        if (releasedReserve !== reserveStroops) {
            throw new Error(`Reclaim released ${formatAmount(releasedReserve)} XLM instead of ${formatAmount(reserveStroops)} XLM.`);
        }
        if (nativeReturned !== (asset.isNative() ? amountStroops : 0n)) {
            throw new Error(`Reclaim returned ${formatAmount(nativeReturned)} XLM instead of ${formatAmount(asset.isNative() ? amountStroops : 0n)} XLM.`);
        }
        if (!asset.isNative() && returnedAsset !== amountStroops) {
            throw new Error(`Reclaim returned ${formatAmount(returnedAsset)} ${asset.getCode()} instead of ${options.amount}.`);
        }
        if (await accountExists(server, created.address)) {
            throw new Error('Reclaim unexpectedly created the one-time account.');
        }
        report.reclaimTransaction = reclaimTransaction;
        report.reclaimSubmissionRecovered = reclaimedBalance.recovered === true;
        report.sponsoredClaimableBalancesAfterReclaim = afterReclaimSponsored.count;
        report.releasedReserveStroops = releasedReserve.toString();
        report.releasedReserveXlm = formatAmount(releasedReserve);
        report.returnedNativeStroops = nativeReturned.toString();
        report.returnedNativeXlm = formatAmount(nativeReturned);
        report.returnedAssetStroops = returnedAsset.toString();
        report.returnedAsset = formatAmount(returnedAsset);
        report.netNativeCostStroops = (before.nativeStroops - afterReclaim.nativeStroops).toString();
        report.netNativeCostXlm = formatAmount(before.nativeStroops - afterReclaim.nativeStroops);
        report.netAssetCostStroops = (before.assetStroops - afterReclaim.assetStroops).toString();
        report.netAssetCost = formatAmount(before.assetStroops - afterReclaim.assetStroops);

        console.log(JSON.stringify({ stage: 'complete', ...report }, null, 2));
    } catch (error) {
        failure = error;
    } finally {
        if (creationConfirmed && !reclaimed) {
            try {
                const recovered = await reclaim();
                const recoverTransaction = await transactionDetails(server, recovered.txHash);
                console.log(JSON.stringify({
                    stage: 'reclaimed-after-error',
                    balanceId: created.balanceId,
                    reclaimTransaction: recoverTransaction,
                }, null, 2));
            } catch (cleanupError) {
                console.error(`Automatic reclaim failed for balance ${created.balanceId}: ${cleanupError?.message ?? cleanupError}`);
                failure = failure
                    ? new AggregateError([failure, cleanupError], `Measurement and automatic reclaim failed: ${failure.message}; ${cleanupError.message}`)
                    : cleanupError;
            }
        }
    }
    if (failure) throw failure;
}

main().catch((error) => {
    const codes = error?.response?.data?.extras?.result_codes;
    console.error(codes ? JSON.stringify(codes) : error?.message ?? error);
    process.exitCode = 1;
});
