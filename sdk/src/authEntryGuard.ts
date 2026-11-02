/**
 * What a simulation is allowed to ask the passkey to sign.
 *
 * Simulation output is not trustworthy. It arrives over the network from an RPC
 * endpoint, and whoever controls that endpoint chooses what comes back. The
 * wallet then puts a passkey prompt in front of the user and signs the result,
 * so an unchecked simulation response is a signature the caller did not intend
 * and the user cannot see.
 *
 * Soroban auth entries are bound to a nonce, a network and an expiry — not to
 * the transaction that carried them. A signed entry can therefore be lifted out
 * and submitted inside someone else's transaction, which is why "it would have
 * failed anyway when the real call ran" is not a defence.
 *
 * The rule here is simple: an entry may be signed only if it authorises *this*
 * wallet to make a call *this* transaction actually contains. Everything else
 * is refused before the passkey is touched.
 *
 * Deliberately pure and free of network access, so the decision can be tested
 * against hostile input without an RPC.
 */

import { Address, Operation, xdr, type Transaction } from '@stellar/stellar-sdk';

/**
 * How far ahead of the current ledger a signature may remain valid.
 *
 * Matches the window the SDK already used when a simulation returned no expiry.
 * The point of capping is that the expiry is part of the signed preimage: an
 * entry that never expires is a signature that can be held and replayed later.
 */
export const AUTH_EXPIRY_LEDGER_WINDOW = 100;

/** Thrown before any passkey prompt when a simulation asks for the wrong thing. */
export class AuthEntryRejected extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuthEntryRejected';
    }
}

/** The contract calls a transaction actually makes. */
export function hostFunctionCalls(tx: Transaction): xdr.InvokeContractArgs[] {
    const calls: xdr.InvokeContractArgs[] = [];
    for (const op of tx.operations) {
        if (op.type !== 'invokeHostFunction') continue;
        const { func } = op as Operation.InvokeHostFunction;
        if (func.switch().value === xdr.HostFunctionType.hostFunctionTypeInvokeContract().value) {
            calls.push(func.invokeContract());
        }
    }
    return calls;
}

/**
 * The contract call an entry's root invocation authorises, or `null` when the
 * entry authorises something that is not a contract call (uploading or
 * creating a contract, for instance).
 */
export function rootContractCall(
    entry: xdr.SorobanAuthorizationEntry,
): xdr.InvokeContractArgs | null {
    const fn = entry.rootInvocation().function();
    const contractFn = xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn();
    if (fn.switch().value !== contractFn.value) return null;
    return fn.contractFn();
}

/**
 * Compare two calls by their encoded form rather than field by field.
 *
 * The arguments matter as much as the contract and the function name — an
 * entry for the right `transfer` on the right token with a different
 * destination is still the wrong entry — and comparing the XDR covers every
 * field at once, including any the SDK does not currently read.
 */
function sameCall(a: xdr.InvokeContractArgs, b: xdr.InvokeContractArgs): boolean {
    return a.toXDR('base64') === b.toXDR('base64');
}

/** A readable `contract.function` for an error message. */
function describe(call: xdr.InvokeContractArgs): string {
    const contract = Address.fromScAddress(call.contractAddress()).toString();
    return `${contract}.${call.functionName().toString()}`;
}

/**
 * Refuse an auth entry that this wallet should not be signing.
 *
 * `allowed` is the set of calls the transaction being signed actually makes,
 * so the comparison is against what the caller asked for rather than against
 * what the RPC says the caller asked for.
 */
export function assertEntryAuthorized(
    entry: xdr.SorobanAuthorizationEntry,
    options: { walletAddress: string; allowed: xdr.InvokeContractArgs[] },
): void {
    const credentials = entry.credentials();
    const addressType = xdr.SorobanCredentialsType.sorobanCredentialsAddress();
    if (credentials.switch().value !== addressType.value) {
        throw new AuthEntryRejected(
            'Refusing to sign: the simulation returned an authorisation that is not an address credential.',
        );
    }

    const credentialAddress = Address.fromScAddress(credentials.address().address()).toString();
    if (credentialAddress !== options.walletAddress) {
        throw new AuthEntryRejected(
            `Refusing to sign: the simulation asked this wallet to authorise ${credentialAddress}, ` +
                'which is a different address.',
        );
    }

    const call = rootContractCall(entry);
    if (!call) {
        throw new AuthEntryRejected(
            'Refusing to sign: the simulation returned an authorisation that is not a contract call.',
        );
    }

    if (!options.allowed.some((candidate) => sameCall(candidate, call))) {
        throw new AuthEntryRejected(
            `Refusing to sign: the simulation asked for ${describe(call)}, ` +
                'which is not a call this transaction makes.',
        );
    }
}

/**
 * The expiry to sign, given what the simulation asked for.
 *
 * Recording-mode simulation hands back `0`, which the host reads as already
 * expired, so a real value has to be supplied. Anything further out than the
 * window is brought back to it rather than refused: the SDK writes this value
 * into the credential it signs, so clamping is sufficient and cannot strand a
 * legitimate call that merely asked for too long.
 */
export function cappedExpiration(requested: number, latestLedger: number): number {
    const ceiling = latestLedger + AUTH_EXPIRY_LEDGER_WINDOW;
    if (!requested) return ceiling;
    return Math.min(requested, ceiling);
}
