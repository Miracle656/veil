/**
 * Session keys on the deployed Veil wallet.
 *
 * A session key is an ed25519 key the wallet owner registers with a passkey.
 * Until its expiry it may call one function on one contract, and the third
 * argument of those calls (the amount, for a token `transfer`) is counted
 * against a cap that covers its whole life. Nothing else is limited: in
 * particular the contract never looks at who receives a transfer.
 *
 * The cap only works for a function whose THIRD argument is the amount. If
 * that argument is missing, or is not an i128, the contract counts the call
 * as zero, so the cap limits nothing and the key can call that function
 * without limit until it expires. Register a session key only for a function
 * shaped like a token `transfer(from, to, amount)`.
 *
 * Everything here follows the wallet WASM every Veil wallet on mainnet runs,
 * SHA-256 b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5,
 * built from contracts/invisible_wallet/src/ at commit
 * ccebd01a9b71c9857e6cd1e05dbdf6d45ea38ba2. That contract cannot be upgraded,
 * and `main` has since changed this interface (`register_session_key_scoped`,
 * payee lists, a per-call maximum). None of that exists on a real wallet, so
 * none of it is used here.
 */

import { Address, Keypair, hash, nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';

import { assertEntryAuthorized } from './authEntryGuard';
import { latestLedgerClose } from './latestLedger';

/** Element count of the credential `__check_auth` treats as a session-key signature. */
export const SESSION_KEY_SIGNATURE_VECTOR_LENGTH = 3;

/** Seconds per ledger the contract assumes when it turns `expiry` into a storage lifetime. */
export const SESSION_KEY_CONTRACT_LEDGER_SECONDS = 5n;

/** Ledgers the contract adds on top of `(expiry - now) / 5` when it extends the record's lifetime. */
export const SESSION_KEY_CONTRACT_TTL_BUFFER_LEDGERS = 10n;

/**
 * Seconds of headroom kept below the network's limit, for the time between
 * reading the ledger clock and the registration landing. The registration
 * only ever lands later than the read, which shortens the lifetime the
 * contract asks for, so this covers a ledger clock that runs ahead between
 * ledgers rather than the usual delay.
 */
export const SESSION_KEY_EXPIRY_MARGIN_SECONDS = 3600n;

const I128_MAX = (1n << 127n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const SYMBOL_RE = /^[A-Za-z0-9_]{1,32}$/;

/** A call for the wallet to make on itself, in the shape `invokeAsWallet(contractId, method, args)` takes. */
export type WalletSelfCall = {
    /** The wallet's own contract id. These calls require the wallet's own authorisation. */
    contractId: string;
    method: 'register_session_key' | 'revoke_session_key';
    args: xdr.ScVal[];
};

export type SessionKeyGrant = {
    /** ed25519 public key of the session key, 32 bytes. */
    pubkey: Uint8Array;
    /** Lookup handle chosen by the client, 32 bytes. Not a secret. */
    keyId: Uint8Array;
    /** The only contract the key may call. */
    targetContract: string;
    /** The only function the key may call on it. */
    selector: string;
    /** Total, over the key's whole life, of the third argument of the calls it authorises. */
    amountCap: bigint;
    /** Unix seconds. The contract accepts calls until 60 seconds after this. */
    expiry: bigint;
};

/** The record the deployed contract keeps for a session key. */
export type SessionKeyRecord = {
    pubkey: Uint8Array;
    targetContract: string;
    selector: string;
    amountCap: bigint;
    /** Only goes up. Registering the same key id again is the only thing that sets it back to 0. */
    spent: bigint;
    expiry: bigint;
};

/** What the network allows, needed to refuse an expiry it cannot honour. */
export type SessionKeyNetworkLimits = {
    /** The ledger's close time, unix seconds. Not the device clock. */
    ledgerTime: bigint;
    /** The network's `maxEntryTtl` (state archival setting), in ledgers. */
    maxEntryTtl: number;
};

export class SessionKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionKeyError';
    }
}

/**
 * The wallet nonce moved between reading it and the call landing.
 *
 * The passkey and every session key share one nonce, so this happens whenever
 * two of them sign at the same time. Nothing was spent; read the nonce again,
 * sign again and resubmit.
 */
export class SessionKeyNonceMismatch extends Error {
    readonly retryable = true;
    constructor(message = 'The wallet nonce changed before this call landed. Read it again and resubmit.') {
        super(message);
        this.name = 'SessionKeyNonceMismatch';
    }
}

/** `WalletError::NonceMismatch` in the deployed contract. */
export const WALLET_ERROR_NONCE_MISMATCH = 16;

/**
 * Why `walletAddress` refused to authorise a call, read from a simulation's
 * diagnostic events.
 *
 * The host reports any refusal inside a wallet's `__check_auth` as
 * `Error(Auth, InvalidAction)`, whatever the wallet said, so the error string
 * alone cannot tell a nonce race from an exhausted cap. The wallet's own error
 * is in the diagnostic event the host emits alongside it:
 * `["failed account authentication with error", <wallet>, <error>]`.
 * Returns that error, or `null` when no event names this wallet.
 */
export function walletAuthFailure(events: xdr.DiagnosticEvent[] | undefined, walletAddress: string): xdr.ScError | null {
    for (const diagnostic of events ?? []) {
        const body = diagnostic.event().body().v0();
        const data = body.data();
        if (data.switch().value !== xdr.ScValType.scvVec().value) continue;
        const items = data.vec() ?? [];
        if (items.length !== 3) continue;
        const [message, address, error] = items;
        const text =
            message.switch().value === xdr.ScValType.scvString().value
                ? message.str().toString()
                : message.switch().value === xdr.ScValType.scvSymbol().value
                  ? message.sym().toString()
                  : '';
        if (text !== 'failed account authentication with error') continue;
        if (address.switch().value !== xdr.ScValType.scvAddress().value) continue;
        if (Address.fromScVal(address).toString() !== walletAddress) continue;
        if (error.switch().value !== xdr.ScValType.scvError().value) continue;
        return error.error();
    }
    return null;
}

/**
 * Classify a refused session-key call from its enforce-mode simulation.
 *
 * Returns a {@link SessionKeyNonceMismatch} when the wallet refused with
 * `NonceMismatch`, the one refusal that a retry fixes, and `null` for
 * everything else (an exhausted cap, a wrong contract or function, an expired,
 * revoked or unknown key, a bad signature).
 */
export function sessionKeyRetryableError(
    simulation: { events?: xdr.DiagnosticEvent[] },
    walletAddress: string,
): SessionKeyNonceMismatch | null {
    const error = walletAuthFailure(simulation.events, walletAddress);
    if (!error || error.switch().value !== xdr.ScErrorType.sceContract().value) return null;
    return error.contractCode() === WALLET_ERROR_NONCE_MISMATCH ? new SessionKeyNonceMismatch() : null;
}

function bytes32(value: Uint8Array, name: string): Buffer {
    if (!(value instanceof Uint8Array) || value.length !== 32) {
        throw new SessionKeyError(`${name} must be exactly 32 bytes.`);
    }
    return Buffer.from(value);
}

/**
 * The latest `expiry` the network can keep a session key alive until.
 *
 * The contract extends the record's lifetime to `(expiry - now) / 5 + 10`
 * ledgers. A temporary entry cannot live longer than `maxEntryTtl - 1` ledgers
 * past the current one, and the host refuses an extension beyond that, so the
 * registration fails on chain. This is the last expiry that stays inside it,
 * less {@link SESSION_KEY_EXPIRY_MARGIN_SECONDS}.
 */
export function maxSessionKeyExpiry(limits: SessionKeyNetworkLimits): bigint {
    const ledgers = BigInt(limits.maxEntryTtl) - 1n - SESSION_KEY_CONTRACT_TTL_BUFFER_LEDGERS;
    if (ledgers <= 0n) throw new SessionKeyError('The network allows no session key lifetime at all.');
    return limits.ledgerTime + ledgers * SESSION_KEY_CONTRACT_LEDGER_SECONDS + (SESSION_KEY_CONTRACT_LEDGER_SECONDS - 1n) - SESSION_KEY_EXPIRY_MARGIN_SECONDS;
}

/** Refuse an expiry that is already past or that the network cannot keep the record alive for. */
export function assertSessionKeyExpiry(expiry: bigint, limits: SessionKeyNetworkLimits): void {
    if (expiry <= limits.ledgerTime) {
        throw new SessionKeyError(`expiry ${expiry} is not after the ledger time ${limits.ledgerTime}.`);
    }
    const max = maxSessionKeyExpiry(limits);
    if (expiry > max) {
        throw new SessionKeyError(
            `expiry ${expiry} is later than this network can keep a session key (latest is ${max}, ` +
                `${limits.maxEntryTtl} ledgers of storage lifetime).`,
        );
    }
}

/**
 * `register_session_key(pubkey, key_id, target_contract, selector, amount_cap, expiry)`,
 * in the deployed contract's argument order.
 *
 * Registering a key id that already exists overwrites its record and sets
 * `spent` back to 0. Needs the wallet's own authorisation: a passkey signature.
 */
export function buildRegisterSessionKeyCall(
    walletAddress: string,
    grant: SessionKeyGrant,
    limits: SessionKeyNetworkLimits,
): WalletSelfCall {
    const pubkey = bytes32(grant.pubkey, 'pubkey');
    const keyId = bytes32(grant.keyId, 'keyId');
    if (!SYMBOL_RE.test(grant.selector)) {
        throw new SessionKeyError(`selector "${grant.selector}" is not a Soroban symbol.`);
    }
    if (grant.amountCap <= 0n || grant.amountCap > I128_MAX) {
        throw new SessionKeyError('amountCap must be a positive i128.');
    }
    if (grant.expiry < 0n || grant.expiry > U64_MAX) {
        throw new SessionKeyError('expiry must be a u64.');
    }
    assertSessionKeyExpiry(grant.expiry, limits);

    return {
        contractId: Address.fromString(walletAddress).toString(),
        method: 'register_session_key',
        args: [
            nativeToScVal(pubkey, { type: 'bytes' }),
            nativeToScVal(keyId, { type: 'bytes' }),
            Address.fromString(grant.targetContract).toScVal(),
            nativeToScVal(grant.selector, { type: 'symbol' }),
            nativeToScVal(grant.amountCap, { type: 'i128' }),
            nativeToScVal(grant.expiry, { type: 'u64' }),
        ],
    };
}

/** `revoke_session_key(key_id)`. Needs the wallet's own authorisation: a passkey signature. */
export function buildRevokeSessionKeyCall(walletAddress: string, keyId: Uint8Array): WalletSelfCall {
    return {
        contractId: Address.fromString(walletAddress).toString(),
        method: 'revoke_session_key',
        args: [nativeToScVal(bytes32(keyId, 'keyId'), { type: 'bytes' })],
    };
}

/** `[key_id: BytesN<32>, ed25519 signature: BytesN<64>, wallet nonce: u64]`. */
export function buildSessionKeySignatureVector(keyId: Uint8Array, signature: Uint8Array, nonce: bigint): xdr.ScVal {
    if (signature.length !== 64) throw new SessionKeyError('An ed25519 signature is exactly 64 bytes.');
    if (nonce < 0n || nonce > U64_MAX) throw new SessionKeyError('The wallet nonce must be a u64.');
    return xdr.ScVal.scvVec([
        nativeToScVal(bytes32(keyId, 'keyId'), { type: 'bytes' }),
        nativeToScVal(Buffer.from(signature), { type: 'bytes' }),
        nativeToScVal(nonce, { type: 'u64' }),
    ]);
}

export type SessionKeySignOptions = {
    /** The session key's ed25519 secret, as a stellar-sdk Keypair. */
    sessionKey: Keypair;
    keyId: Uint8Array;
    walletAddress: string;
    /** The calls the transaction carrying this entry makes (`hostFunctionCalls(tx)`). */
    allowed: xdr.InvokeContractArgs[];
    /** The wallet's nonce, read just before signing. Shared with the passkey. */
    walletNonce: bigint;
    /** Last ledger the signature is valid for. */
    validUntilLedger: number;
    networkPassphrase: string;
};

/**
 * Sign a Soroban authorisation entry with a session key.
 *
 * The entry is checked first with {@link assertEntryAuthorized}: it must
 * authorise this wallet, and its root call must be one the transaction
 * actually makes, argument for argument. Anything else throws
 * `AuthEntryRejected` before the key signs.
 */
export function signAuthEntryWithSessionKey(
    entry: xdr.SorobanAuthorizationEntry,
    options: SessionKeySignOptions,
): { signature: xdr.ScVal; entry: xdr.SorobanAuthorizationEntry } {
    assertEntryAuthorized(entry, { walletAddress: options.walletAddress, allowed: options.allowed });

    const credentials = entry.credentials().address();
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
            networkId: hash(Buffer.from(options.networkPassphrase)),
            nonce: credentials.nonce(),
            invocation: entry.rootInvocation(),
            signatureExpirationLedger: options.validUntilLedger,
        }),
    );
    const payload = hash(preimage.toXDR());
    const signature = buildSessionKeySignatureVector(
        options.keyId,
        options.sessionKey.sign(payload),
        options.walletNonce,
    );

    return {
        signature,
        entry: new xdr.SorobanAuthorizationEntry({
            rootInvocation: entry.rootInvocation(),
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
                new xdr.SorobanAddressCredentials({
                    address: credentials.address(),
                    nonce: credentials.nonce(),
                    signatureExpirationLedger: options.validUntilLedger,
                    signature,
                }),
            ),
        }),
    };
}

/** Where the deployed contract keeps a session key's record: `SessionDataKey::Acl(key_id)` in temporary storage. */
export function sessionKeyLedgerKey(walletAddress: string, keyId: Uint8Array): xdr.LedgerKey {
    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: Address.fromString(walletAddress).toScAddress(),
            key: xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol('Acl'),
                nativeToScVal(bytes32(keyId, 'keyId'), { type: 'bytes' }),
            ]),
            durability: xdr.ContractDataDurability.temporary(),
        }),
    );
}

const RECORD_FIELDS = ['amount_cap', 'expiry', 'pubkey', 'selector', 'spent', 'target_contract'];

/**
 * Decode a `SessionKeyAcl` as the deployed contract stores it.
 *
 * Exactly these six fields. A record with any other field set was written by
 * a different contract build, and its meaning cannot be assumed.
 */
export function decodeSessionKeyRecord(value: xdr.ScVal): SessionKeyRecord {
    if (value.switch().value !== xdr.ScValType.scvMap().value) {
        throw new SessionKeyError('A session key record is a map.');
    }
    const fields = new Map<string, xdr.ScVal>();
    for (const item of value.map() ?? []) {
        if (item.key().switch().value !== xdr.ScValType.scvSymbol().value) {
            throw new SessionKeyError('A session key record has non-symbol field names.');
        }
        fields.set(item.key().sym().toString(), item.val());
    }
    const names = [...fields.keys()].sort();
    if (names.join(',') !== RECORD_FIELDS.join(',')) {
        throw new SessionKeyError(`Unexpected session key record fields: ${names.join(', ')}.`);
    }
    const field = (name: string) => fields.get(name)!;
    return {
        pubkey: new Uint8Array(field('pubkey').bytes()),
        targetContract: Address.fromScVal(field('target_contract')).toString(),
        selector: field('selector').sym().toString(),
        amountCap: BigInt(scValToNative(field('amount_cap')) as bigint),
        spent: BigInt(scValToNative(field('spent')) as bigint),
        expiry: BigInt(scValToNative(field('expiry')) as bigint),
    };
}

/**
 * Read a session key's record, or `null` when the wallet has none.
 *
 * The deployed contract has no getter, so this reads the ledger entry
 * directly. `null` means only that the key cannot authorise anything now: a
 * revoked key, an expired key whose record was removed, and a key that was
 * never registered all look the same, and this does not guess which. A record
 * whose `expiry` has passed is returned as it is; the contract refuses it.
 */
export async function readSessionKey(
    server: rpc.Server,
    walletAddress: string,
    keyId: Uint8Array,
): Promise<SessionKeyRecord | null> {
    const { entries, latestLedger } = await server.getLedgerEntries(sessionKeyLedgerKey(walletAddress, keyId));
    if (entries.length === 0) return null;
    const [entry] = entries;
    if (entry.liveUntilLedgerSeq !== undefined && entry.liveUntilLedgerSeq < latestLedger) return null;
    return decodeSessionKeyRecord(entry.val.contractData().val());
}

/** The network limits {@link buildRegisterSessionKeyCall} needs, read from the network itself. */
export async function readSessionKeyNetworkLimits(server: rpc.Server): Promise<SessionKeyNetworkLimits> {
    const [{ closeTime }, settings] = await Promise.all([
        latestLedgerClose(server),
        server.getLedgerEntries(
            xdr.LedgerKey.configSetting(
                new xdr.LedgerKeyConfigSetting({
                    configSettingId: xdr.ConfigSettingId.configSettingStateArchival(),
                }),
            ),
        ),
    ]);
    // The close time comes from latestLedgerClose, which does not decode the
    // ledger header: a Stellar SDK older than the network's protocol cannot.
    if (settings.entries.length !== 1) throw new SessionKeyError('The network did not return its state archival settings.');
    return {
        ledgerTime: BigInt(closeTime),
        maxEntryTtl: settings.entries[0].val.configSetting().stateArchivalSettings().maxEntryTtl(),
    };
}
