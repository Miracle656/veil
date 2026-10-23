/**
 * SEP-43 — Standard Web Wallet API Interface.
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
 *
 * Provides a unified, standard interface for Stellar wallets so dApps and
 * connectors (like Stellar Wallets Kit's sep43Modules()) can interact with
 * Veil without bespoke handling.
 *
 * Implements the standard surface over the existing signer rather than beside
 * it: one implementation shared across the SDK, injected providers, and
 * WalletConnect.
 */

import {
  Address,
  hash as stellarHash,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import type { WebAuthnSignature } from './core';

// ── Standard SEP-43 Types & Error Codes ──────────────────────────────────────

export const SEP43_ERROR_INTERNAL = -1;
export const SEP43_ERROR_EXTERNAL = -2;
export const SEP43_ERROR_CLIENT = -3;

export interface Sep43Error {
  message: string;
  code: number;
  ext?: string[];
}

export interface Sep43GetAddressResponse {
  address?: string;
  error?: Sep43Error;
}

export interface Sep43GetNetworkResponse {
  network?: string;
  networkPassphrase?: string;
  error?: Sep43Error;
}

export interface Sep43SignTransactionOpts {
  networkPassphrase?: string;
  address?: string;
  submit?: boolean;
  submitUrl?: string;
}

export interface Sep43SignTransactionResponse {
  signedTxXdr?: string;
  signerAddress?: string;
  error?: Sep43Error;
}

export interface Sep43SignAuthEntryOpts {
  networkPassphrase?: string;
  address?: string;
}

export interface Sep43SignAuthEntryResponse {
  signedAuthEntry?: string;
  signerAddress?: string;
  error?: Sep43Error;
}

export interface Sep43SignMessageOpts {
  networkPassphrase?: string;
  address?: string;
}

export interface Sep43SignMessageResponse {
  signedMessage?: string;
  signerAddress?: string;
  error?: Sep43Error;
}

export interface Sep43Wallet {
  getAddress: () => Promise<Sep43GetAddressResponse>;
  getNetwork: () => Promise<Sep43GetNetworkResponse>;
  signTransaction: (xdr: string, opts?: Sep43SignTransactionOpts) => Promise<Sep43SignTransactionResponse>;
  signAuthEntry: (authEntry: string, opts?: Sep43SignAuthEntryOpts) => Promise<Sep43SignAuthEntryResponse>;
  signMessage: (message: string, opts?: Sep43SignMessageOpts) => Promise<Sep43SignMessageResponse>;
}

// ── Adapter Interface for Callers ───────────────────────────────────────────

export interface Sep43WalletAdapter {
  getAddress: () => Promise<string | null>;
  getNetwork: () =>
    | Promise<{ network: string; networkPassphrase: string; rpcUrl?: string }>
    | { network: string; networkPassphrase: string; rpcUrl?: string };
  signTransaction: (xdrString: string, opts?: Sep43SignTransactionOpts) => Promise<string>;
  signAuthEntry?: (authEntryXdr: string, opts?: Sep43SignAuthEntryOpts) => Promise<string>;
  signAuthPayload?: (payloadHash: Uint8Array) => Promise<WebAuthnSignature | null>;
  getWalletNonce?: (contractAddress: string) => Promise<bigint | null>;
  getLatestLedger?: () => Promise<number>;
  signMessage?: (message: string, opts?: Sep43SignMessageOpts) => Promise<string>;
  submitTransaction?: (signedXdr: string, submitUrl?: string) => Promise<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function createSep43Error(code: number, message: string, ext?: string[]): Sep43Error {
  const err: Sep43Error = { code, message };
  if (ext && ext.length > 0) {
    err.ext = ext;
  }
  return err;
}

export function isUserRejectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    message.includes('USER_REJECTED') ||
    message.includes('NotAllowedError') ||
    normalized.includes('cancel') ||
    normalized.includes('declined') ||
    normalized.includes('user rejected')
  );
}

export function classifySep43Error(error: unknown): Sep43Error {
  if (isUserRejectionError(error)) {
    return createSep43Error(SEP43_ERROR_CLIENT, 'USER_REJECTED');
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes('network') ||
    normalized.includes('simulation') ||
    normalized.includes('rpc') ||
    normalized.includes('horizon') ||
    normalized.includes('timeout') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('503') ||
    normalized.includes('500')
  ) {
    return createSep43Error(SEP43_ERROR_EXTERNAL, message);
  }

  if (
    normalized.includes('invalid') ||
    normalized.includes('missing') ||
    normalized.includes('mismatch') ||
    normalized.includes('does not match') ||
    normalized.includes('not match') ||
    normalized.includes('unsupported') ||
    normalized.includes('bad') ||
    normalized.includes('eof') ||
    normalized.includes('base64') ||
    normalized.includes('malformed') ||
    normalized.includes('parse')
  ) {
    return createSep43Error(SEP43_ERROR_CLIENT, message);
  }

  return createSep43Error(SEP43_ERROR_INTERNAL, message);
}

/**
 * Sign a Soroban authorization entry with a WebAuthn passkey.
 *
 * Implements the standard `__check_auth` signing ceremony on a raw entry:
 *  1. Checks address credentials
 *  2. Constructs HashIdPreimage::SorobanAuthorization
 *  3. Hashes with SHA-256 and calls the passkey signer
 *  4. Builds the 5-element signature vector [publicKey, authData, clientDataJSON, signature, nonce]
 *  5. Replaces the credentials signature and re-serializes
 */
export async function signSorobanAuthEntry(
  authEntryBase64: string,
  options: {
    signerAddress: string;
    networkPassphrase: string;
    signPayload: (hash: Uint8Array) => Promise<WebAuthnSignature | null>;
    validUntilLedger?: number;
    getNonce?: (contractAddress: string) => Promise<bigint | null>;
  }
): Promise<string> {
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryBase64, 'base64');
  } catch (err) {
    throw new Error(`Invalid SorobanAuthorizationEntry XDR: ${err instanceof Error ? err.message : String(err)}`);
  }
  const credentials = entry.credentials();

  if (credentials.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
    throw new Error('Only address credentials (SorobanCredentialsAddress) can be signed.');
  }

  const addressCredentials = credentials.address();
  const contractAddress = Address.fromScAddress(addressCredentials.address()).toString();

  if (contractAddress !== options.signerAddress) {
    throw new Error(
      `Auth entry target address (${contractAddress}) does not match signer address (${options.signerAddress})`
    );
  }

  const sigExpLedger =
    options.validUntilLedger ??
    (addressCredentials.signatureExpirationLedger() || 100);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const networkIdBytes = (stellarHash as any)(Buffer.from(options.networkPassphrase));

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: Buffer.from(networkIdBytes),
      nonce: addressCredentials.nonce(),
      invocation: entry.rootInvocation(),
      signatureExpirationLedger: sigExpLedger,
    })
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payloadHash = new Uint8Array((stellarHash as any)(Buffer.from(preimage.toXDR())));

  const webAuthnSig = await options.signPayload(payloadHash);
  if (!webAuthnSig) {
    throw new Error('USER_REJECTED');
  }

  const currentNonce = options.getNonce
    ? await options.getNonce(contractAddress)
    : null;

  const sigElements = [
    nativeToScVal(Buffer.from(webAuthnSig.publicKey), { type: 'bytes' }),
    nativeToScVal(Buffer.from(webAuthnSig.authData), { type: 'bytes' }),
    nativeToScVal(Buffer.from(webAuthnSig.clientDataJSON), { type: 'bytes' }),
    nativeToScVal(Buffer.from(webAuthnSig.signature), { type: 'bytes' }),
  ];

  if (currentNonce !== null && currentNonce !== undefined) {
    sigElements.push(nativeToScVal(currentNonce, { type: 'u64' }));
  }

  entry.credentials(
    xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: addressCredentials.address(),
        nonce: addressCredentials.nonce(),
        signatureExpirationLedger: sigExpLedger,
        signature: xdr.ScVal.scvVec(sigElements),
      })
    )
  );

  return entry.toXDR('base64');
}

// ── SEP-43 Implementation ───────────────────────────────────────────────────

export function createSep43Wallet(adapter: Sep43WalletAdapter): Sep43Wallet {
  return {
    async getAddress(): Promise<Sep43GetAddressResponse> {
      try {
        const address = await adapter.getAddress();
        if (!address) {
          return {
            error: createSep43Error(SEP43_ERROR_CLIENT, 'No wallet available on this device.'),
          };
        }
        return { address };
      } catch (error) {
        return { error: classifySep43Error(error) };
      }
    },

    async getNetwork(): Promise<Sep43GetNetworkResponse> {
      try {
        const net = await adapter.getNetwork();
        const network = net.network.toUpperCase();
        return {
          network,
          networkPassphrase: net.networkPassphrase,
        };
      } catch (error) {
        return { error: classifySep43Error(error) };
      }
    },

    async signTransaction(
      xdrString: string,
      opts?: Sep43SignTransactionOpts
    ): Promise<Sep43SignTransactionResponse> {
      try {
        if (!xdrString || typeof xdrString !== 'string') {
          return {
            error: createSep43Error(SEP43_ERROR_CLIENT, 'Missing or invalid XDR string.'),
          };
        }

        const currentAddress = await adapter.getAddress();
        if (!currentAddress) {
          return {
            error: createSep43Error(SEP43_ERROR_CLIENT, 'No wallet available.'),
          };
        }

        if (opts?.address && opts.address !== currentAddress) {
          return {
            error: createSep43Error(
              SEP43_ERROR_CLIENT,
              `Requested address (${opts.address}) does not match wallet address (${currentAddress}).`
            ),
          };
        }

        const net = await adapter.getNetwork();
        if (opts?.networkPassphrase && opts.networkPassphrase !== net.networkPassphrase) {
          return {
            error: createSep43Error(
              SEP43_ERROR_CLIENT,
              `Requested network passphrase does not match wallet network passphrase.`
            ),
          };
        }

        const signedTxXdr = await adapter.signTransaction(xdrString, opts);

        if (opts?.submit) {
          if (!adapter.submitTransaction) {
            return {
              error: createSep43Error(
                SEP43_ERROR_CLIENT,
                'Transaction submission is not supported by this wallet instance.'
              ),
            };
          }
          await adapter.submitTransaction(signedTxXdr, opts.submitUrl);
        }

        return {
          signedTxXdr,
          signerAddress: currentAddress,
        };
      } catch (error) {
        return { error: classifySep43Error(error) };
      }
    },

    async signAuthEntry(
      authEntry: string,
      opts?: Sep43SignAuthEntryOpts
    ): Promise<Sep43SignAuthEntryResponse> {
      try {
        if (!authEntry || typeof authEntry !== 'string') {
          return {
            error: createSep43Error(SEP43_ERROR_CLIENT, 'Missing or invalid authEntry XDR string.'),
          };
        }

        const currentAddress = await adapter.getAddress();
        if (!currentAddress) {
          return {
            error: createSep43Error(SEP43_ERROR_CLIENT, 'No wallet available.'),
          };
        }

        if (opts?.address && opts.address !== currentAddress) {
          return {
            error: createSep43Error(
              SEP43_ERROR_CLIENT,
              `Requested address (${opts.address}) does not match wallet address (${currentAddress}).`
            ),
          };
        }

        const net = await adapter.getNetwork();
        if (opts?.networkPassphrase && opts.networkPassphrase !== net.networkPassphrase) {
          return {
            error: createSep43Error(
              SEP43_ERROR_CLIENT,
              `Requested network passphrase does not match wallet network passphrase.`
            ),
          };
        }

        let signedAuthEntry: string;
        if (adapter.signAuthEntry) {
          signedAuthEntry = await adapter.signAuthEntry(authEntry, opts);
        } else if (adapter.signAuthPayload) {
          const latestLedger = adapter.getLatestLedger
            ? await adapter.getLatestLedger()
            : undefined;
          signedAuthEntry = await signSorobanAuthEntry(authEntry, {
            signerAddress: currentAddress,
            networkPassphrase: opts?.networkPassphrase ?? net.networkPassphrase,
            signPayload: adapter.signAuthPayload,
            validUntilLedger: latestLedger ? latestLedger + 100 : undefined,
            getNonce: adapter.getWalletNonce,
          });
        } else {
          return {
            error: createSep43Error(
              SEP43_ERROR_CLIENT,
              'signAuthEntry is not supported by this wallet adapter.'
            ),
          };
        }

        return {
          signedAuthEntry,
          signerAddress: currentAddress,
        };
      } catch (error) {
        return { error: classifySep43Error(error) };
      }
    },

    async signMessage(
      message: string,
      opts?: Sep43SignMessageOpts
    ): Promise<Sep43SignMessageResponse> {
      try {
        if (typeof message !== 'string') {
          return {
            error: createSep43Error(SEP43_ERROR_CLIENT, 'Message must be a string.'),
          };
        }

        const currentAddress = await adapter.getAddress();
        if (!currentAddress) {
          return {
            error: createSep43Error(SEP43_ERROR_CLIENT, 'No wallet available.'),
          };
        }

        if (opts?.address && opts.address !== currentAddress) {
          return {
            error: createSep43Error(
              SEP43_ERROR_CLIENT,
              `Requested address (${opts.address}) does not match wallet address (${currentAddress}).`
            ),
          };
        }

        if (!adapter.signMessage) {
          return {
            error: createSep43Error(
              SEP43_ERROR_CLIENT,
              'signMessage is not supported by this wallet adapter.'
            ),
          };
        }

        const signedMessage = await adapter.signMessage(message, opts);
        return {
          signedMessage,
          signerAddress: currentAddress,
        };
      } catch (error) {
        return { error: classifySep43Error(error) };
      }
    },
  };
}
