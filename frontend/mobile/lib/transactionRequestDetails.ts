/**
 * Decode a signing request into something a user can judge.
 *
 * Two approval surfaces need the same thing — the WalletConnect modal and the
 * dApp browser's provider prompt — and a wallet that shows one request
 * accurately and the other vaguely is a wallet whose approvals mean different
 * things depending on how the dApp reached it. So the reading lives here, once.
 *
 * Everything is best-effort by design. A request that cannot be decoded comes
 * back as `unknown` with `undecodable: true`, and the caller's job is to present
 * that as "review carefully" — never to guess a friendlier description. Nothing
 * here throws: these values are produced for a screen, and a malformed XDR is
 * the dApp's problem to answer for, not a reason to break the UI.
 */

import { Address, Operation, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

/** What an envelope asks for, in the few words a prompt has room for. */
export type RequestDetails = {
  operationType: 'payment' | 'contract' | 'authEntry' | 'unknown';
  /** Only for a classic payment. */
  amount?: string;
  /** Only for a classic payment. */
  destination?: string;
  /** The contract a Soroban call targets, when it can be read. */
  contractAddress?: string;
  /** The Soroban function being invoked, when it can be read. */
  functionName?: string;
  /** Operations in the envelope — more than one is why this wallet refuses. */
  operationCount?: number;
  /** The envelope could not be read at all, or not far enough to describe it. */
  undecodable?: boolean;
};

/** Labels for the one line a prompt shows. Keys match {@link RequestDetails.operationType}. */
export const REQUEST_TYPE_LABELS: Record<RequestDetails['operationType'], string> = {
  payment: 'Payment',
  contract: 'Contract call',
  authEntry: 'Soroban authorization',
  unknown: 'Unknown',
};

/** The answer when the envelope cannot be read: say so, and describe nothing. */
function unknown(): RequestDetails {
  return { operationType: 'unknown', undecodable: true };
}

/**
 * A full account or contract address, the way it is written on chain.
 *
 * `ScAddress` is an XDR union, and its own `toString()` is the generic one — it
 * renders `[object Object]`, which on an approval sheet is worse than showing
 * nothing: the user reads a blank-looking field as "there was nothing to read".
 * The address has to go through `Address`, and it is written out in full because
 * an elided one cannot be compared with anything.
 */
function addressToString(value: unknown): string | undefined {
  if (!value) return undefined;
  try {
    return Address.fromScAddress(value as xdr.ScAddress).toString();
  } catch {
    return undefined;
  }
}

/** A Soroban symbol, which does render as its own text. */
function symbolToString(value: unknown): string | undefined {
  if (!value) return undefined;
  try {
    const text = String(value);
    return text && text !== '[object Object]' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the contract and function out of an `invokeHostFunction` operation.
 *
 * A transaction that has come through `fromXDR` exposes its host function as the
 * legacy union, where an invoked contract is the `invokeContract` arm. A raw
 * `SorobanAuthorizedFunction`, as an authorization entry carries, names the same
 * payload `contractFn`. Each caller reads its own shape.
 */
function describeInvokeHostFunction(operation: Operation.InvokeHostFunction): RequestDetails {
  try {
    const invokeContract = operation.func?.invokeContract?.();
    return {
      operationType: 'contract',
      contractAddress: addressToString(invokeContract?.contractAddress?.()),
      functionName: symbolToString(invokeContract?.functionName?.()),
    };
  } catch {
    // Fall through: an entry whose inner shape is unexpected is still a contract
    // call the user must review carefully, not one to describe as something else.
    return { operationType: 'contract' };
  }
}

/**
 * Describe the transaction a dApp wants signed.
 *
 * `networkPassphrase` matters as much as the payload: an XDR is only decodable
 * against the network it was built for, and reading it against the wrong one
 * produces a hash that silently differs from what the chain will check.
 */
export function describeTransactionXdr(xdrString: string, networkPassphrase: string): RequestDetails {
  let transaction: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(xdrString, networkPassphrase);
    // A fee-bump envelope wraps the real transaction; its own operation list is
    // empty, so describing it directly would report "0 operations".
    if ('transaction' in parsed) {
      transaction = (parsed as unknown as { transaction: Transaction }).transaction;
    } else {
      transaction = parsed as Transaction;
    }
  } catch {
    return unknown();
  }

  const operations = transaction.operations ?? [];
  const operationCount = operations.length;
  const first = operations[0];
  if (!first) return { operationType: 'unknown', operationCount, undecodable: true };

  if (first.type === 'payment') {
    const payment = first as Operation.Payment;
    return {
      operationType: 'payment',
      amount: typeof payment.amount === 'string' ? payment.amount : undefined,
      destination: typeof payment.destination === 'string' ? payment.destination : undefined,
      operationCount,
    };
  }

  if (first.type === 'invokeHostFunction') {
    return { ...describeInvokeHostFunction(first as Operation.InvokeHostFunction), operationCount };
  }

  return { operationType: 'unknown', operationCount, undecodable: true };
}

/**
 * Describe one standalone Soroban authorization entry.
 *
 * The interesting fields are the contract the entry invokes and the function it
 * invokes, because that is what `__check_auth` will authorise. The entry also
 * names the wallet whose key must sign it, which the caller checks separately —
 * showing it is not enough, and refusing it is not the prompt's job.
 */
export function describeAuthEntryXdr(xdrString: string): RequestDetails {
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(xdrString, 'base64');
  } catch {
    return unknown();
  }

  try {
    const invocation = entry.rootInvocation().function();
    if (invocation.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
      // A create-contract or upload-wasm authorisation is still an authorisation
      // the user must read carefully; it is just not one this function can name.
      return { operationType: 'authEntry', undecodable: true };
    }
    const contractFn = invocation.contractFn();
    return {
      operationType: 'authEntry',
      contractAddress: addressToString(contractFn.contractAddress()),
      functionName: symbolToString(contractFn.functionName()),
    };
  } catch {
    return unknown();
  }
}
