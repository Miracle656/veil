import AsyncStorage from '@react-native-async-storage/async-storage';
import { p256 } from '@noble/curves/p256.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { getNetworkName } from './network';
import { discoverWithPrf, nativePrfEvaluator, type DiscoveredPasskey } from './passkey';
import { readSigners, WalletContractNotFoundError, type WalletSigner } from './signers';
import { readBreadcrumbs, writeBreadcrumbs } from './walletBreadcrumbs';
import { getSignerSecret, getWalletAddress, setPasskeyCredential, setPasskeyId, setSignerSecret, setWalletAddress } from './walletStore';
import { hexToUint8Array } from './webauthn';

/** Same PRF salt the fee-payer was derived with at creation (SDK constant). */
const FEE_PAYER_PRF_SALT = new Uint8Array(new TextEncoder().encode('invisible-wallet/prf/feepayer/v1'));

// SDK storage keys — mirrored so the SDK's login()/signAuthEntry() see the
// recovered wallet exactly as if register() had run on this device.
const SDK_ADDRESS = 'invisible_wallet_address';
const SDK_KEY_ID = 'invisible_wallet_key_id';
const SDK_PUBLIC_KEY = 'invisible_wallet_public_key';

export type LoginResult = {
  address: string;
  /** 'local' = wallet was already on this device; 'recovered' = rebuilt from the passkey. */
  source: 'local' | 'recovered';
};

export type AddressLoginResult = {
  address: string;
  /**
   * Whether the fee-payer was derived from the passkey's PRF output (so the
   * wallet stays recoverable from the passkey elsewhere) rather than a fresh
   * random key created this session.
   */
  recoverable: boolean;
};

export const INVALID_ADDRESS_MESSAGE =
  'That is not a wallet address. A wallet address begins with "C" and is 56 characters long.';
const WALLET_NOT_DEPLOYED_MESSAGE =
  'No deployed wallet is at this address on this network. Check the address and the selected network, then try again.';
const NETWORK_UNREACHABLE_MESSAGE =
  'Could not reach the network to check this address. Check your connection and try again.';
const SIGNER_MISMATCH_MESSAGE =
  'This passkey is not a signer on the wallet at this address. Use the passkey this wallet was created with.';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Sign in with an existing passkey.
 *
 * Same device (wallet still in secure storage): verify it's intact and return —
 * no stress, no prompts beyond what the caller chooses to gate with.
 *
 * Fresh install / new phone (passkey synced via Google Password Manager or
 * iCloud Keychain): one discoverable passkey prompt returns the credential and
 * its PRF output → the deterministic fee-payer keypair → the on-chain
 * breadcrumbs on that account name the C-address and passkey public key →
 * everything is re-persisted locally. Serverless, seedless.
 */
export async function loginWithPasskey(): Promise<LoginResult> {
  // ── Same-device fast path ──────────────────────────────────────────────────
  const [storedAddress, storedSecret] = await Promise.all([
    getWalletAddress().catch(() => null),
    getSignerSecret().catch(() => null),
  ]);
  if (storedAddress && storedSecret) {
    return { address: storedAddress, source: 'local' };
  }

  // ── Same-device, secure store cleared (e.g. "Reset wallet") ───────────────
  // The SDK's AsyncStorage copy survives a secure-store reset. One PRF prompt
  // against the recorded credential re-derives the fee-payer; the address and
  // public key come straight from that copy — no breadcrumbs required. Write
  // the breadcrumbs afterwards so a genuinely fresh device works next time.
  const [sdkAddress, sdkKeyId, sdkPubKey] = await Promise.all([
    AsyncStorage.getItem(SDK_ADDRESS).catch(() => null),
    AsyncStorage.getItem(SDK_KEY_ID).catch(() => null),
    AsyncStorage.getItem(SDK_PUBLIC_KEY).catch(() => null),
  ]);
  if (sdkAddress && sdkKeyId) {
    const prf = await nativePrfEvaluator(sdkKeyId)(FEE_PAYER_PRF_SALT);
    if (prf && prf.length >= 32) {
      const feePayer = Keypair.fromRawEd25519Seed(Buffer.from(prf.subarray(0, 32)));
      await Promise.all([
        setWalletAddress(sdkAddress),
        setSignerSecret(feePayer.secret()),
        sdkPubKey ? setPasskeyCredential(sdkKeyId, sdkPubKey) : setPasskeyId(sdkKeyId),
      ]);
      const pkBytes = sdkPubKey && /^[0-9a-fA-F]{130}$/.test(sdkPubKey) ? new Uint8Array(Buffer.from(sdkPubKey, 'hex')) : null;
      void writeBreadcrumbs(feePayer.secret(), sdkAddress, pkBytes).catch(() => undefined);
      return { address: sdkAddress, source: 'recovered' };
    }
    // PRF unavailable / cancelled — fall through to the discoverable flow,
    // which reports its own clearer errors.
  }

  // ── Fresh-device recovery ──────────────────────────────────────────────────
  const picked = await discoverWithPrf(FEE_PAYER_PRF_SALT);
  if (!picked) throw new Error('Passkey sign-in was cancelled.');
  if (!picked.prf || picked.prf.length < 32) {
    throw new Error(
      "This passkey didn't return a PRF secret, so the wallet can't be re-derived from it on this device. " +
        'Use the recovery-server flow instead.',
    );
  }

  const feePayer = Keypair.fromRawEd25519Seed(Buffer.from(picked.prf.subarray(0, 32)));
  const crumbs = await readBreadcrumbs(feePayer.publicKey());
  if (!crumbs) {
    throw new Error(
      'No wallet is linked to this passkey on this network. Wallets created before sign-in support ' +
        'publish their record the next time their home screen opens on the device that holds them — ' +
        'open the wallet there once, then sign in here.',
    );
  }

  // Persist to the app's secure store…
  await Promise.all([
    setWalletAddress(crumbs.walletAddress),
    setSignerSecret(feePayer.secret()),
    crumbs.publicKeyBytes
      ? setPasskeyCredential(picked.credentialId, toHex(crumbs.publicKeyBytes))
      : setPasskeyId(picked.credentialId),
  ]);

  // …and mirror the SDK's storage so its login()/signAuthEntry() work too.
  const sdkWrites: Array<[string, string]> = [
    [SDK_ADDRESS, crumbs.walletAddress],
    [SDK_KEY_ID, picked.credentialId],
  ];
  if (crumbs.publicKeyBytes) sdkWrites.push([SDK_PUBLIC_KEY, toHex(crumbs.publicKeyBytes)]);
  await AsyncStorage.multiSet(sdkWrites);

  return { address: crumbs.walletAddress, source: 'recovered' };
}

/**
 * Sign in to a wallet the user knows only by its C-address.
 *
 * The passkey-first flow is the easy path; PRF is the whole reason it works on
 * a fresh device, and a manager without PRF can never use it. The wallet's
 * address, by contrast, is public — anyone who knows it can ask what signers
 * it carries, and that is enough to prove possession to the wallet contract.
 *
 * So this path never needs PRF. Given the address:
 *
 *   1. Validate the shape before spending a network call.
 *   2. Read the on-chain signer set — cheap, and it lets us say "no wallet at
 *      this address" without pretending every network failure is that.
 *   3. One passkey gesture proves which key the user holds: the assertion is
 *      verified against each registered signer, and only a match proceeds.
 *      A mismatch refuses and writes nothing — never a read-only wallet.
 *   4. Persist address + credential, derive the fee-payer from PRF when the
 *      passkey offers it, else a fresh random key, and write breadcrumbs so
 *      the passkey-first flow works here next.
 */
export async function loginWithAddress(rawAddress: string): Promise<AddressLoginResult> {
  // ── Shape first: malformed input is rejected before any network call. ──
  const address = rawAddress.trim();
  if (!StrKey.isValidContract(address)) {
    throw new Error(INVALID_ADDRESS_MESSAGE);
  }

  // ── Resolve before trusting. Say "no wallet" vs "network down", and never
  //    ask for a passkey until a wallet has been found to get into. ──
  let signers: WalletSigner[];
  try {
    signers = await readSigners(address);
  } catch (error) {
    if (error instanceof WalletContractNotFoundError) throw new Error(WALLET_NOT_DEPLOYED_MESSAGE);
    throw new Error(NETWORK_UNREACHABLE_MESSAGE);
  }

  // ── Assert a passkey and prove it is one of the registered signers. ──
  const picked = await discoverWithPrf(FEE_PAYER_PRF_SALT);
  if (!picked) {
    throw new Error('Passkey sign-in was cancelled.');
  }

  const matchedPublicKey = findMatchingSigner(picked, signers);
  if (!matchedPublicKey) {
    // The wallet exists and the user held out a passkey, but that passkey is
    // not a signer on it. Refuse and explain — no wallet state is written.
    throw new Error(SIGNER_MISMATCH_MESSAGE);
  }

  // Everything has been checked; only now do we adopt the wallet.
  const publicKeyHex = toHex(matchedPublicKey);
  const prfSeed = picked.prf && picked.prf.length >= 32 ? picked.prf.subarray(0, 32) : null;
  const feePayer = prfSeed
    ? Keypair.fromRawEd25519Seed(Buffer.from(prfSeed))
    : Keypair.random();
  const recoverable = prfSeed !== null;

  await Promise.all([
    setWalletAddress(address),
    setSignerSecret(feePayer.secret()),
    setPasskeyCredential(picked.credentialId, publicKeyHex),
  ]);

  // Namespace the SDK's AsyncStorage copy like walletStore does (per network),
  // so the SDK's login()/signAuthEntry() see this wallet too. Supplementary —
  // a storage hiccup here must not undo a sign-in that already succeeded.
  await writeSdkMirror(address, picked.credentialId, publicKeyHex).catch(() => undefined);

  // Breadcrumbs make the passkey-first flow the easy path next time
  // (serverless recovery). Best-effort, as at creation/recovery.
  void writeBreadcrumbs(feePayer.secret(), address, matchedPublicKey).catch(() => undefined);

  return { address, recoverable };
}

/**
 * The registered signer whose public key verifies this assertion, or null.
 *
 * An assertion never reveals its public key, so possession is proven the other
 * way round: the signature is checked against every signer the wallet holds,
 * and a match means the asserting passkey owns that signer's private key.
 */
function findMatchingSigner(picked: DiscoveredPasskey, signers: WalletSigner[]): Uint8Array | null {
  // WebAuthn signs SHA-256(authData ‖ SHA-256(clientDataJSON)).
  const clientDataHash = sha256(picked.clientDataJSON);
  const verificationData = new Uint8Array(picked.authData.length + clientDataHash.length);
  verificationData.set(picked.authData, 0);
  verificationData.set(clientDataHash, picked.authData.length);

  for (const signer of signers) {
    // A signer is an uncompressed P-256 point: 0x04 ‖ x ‖ y, exactly 65 bytes.
    if (!/^[0-9a-f]{130}$/.test(signer.publicKey)) continue;
    try {
      const publicKeyBytes = hexToUint8Array(signer.publicKey);
      if (publicKeyBytes.length !== 65) continue;
      if (p256.verify(picked.signature, verificationData, publicKeyBytes, { prehash: true })) {
        return publicKeyBytes;
      }
    } catch {
      // Malformed key — try the next signer rather than aborting the check.
    }
  }
  return null;
}

/** Write the SDK's AsyncStorage keys, namespaced per network like walletStore. */
async function writeSdkMirror(address: string, credentialId: string, publicKeyHex: string): Promise<void> {
  const suffix = getNetworkName() === 'mainnet' ? '_mainnet' : '';
  await AsyncStorage.multiSet([
    [`${SDK_ADDRESS}${suffix}`, address],
    [`${SDK_KEY_ID}${suffix}`, credentialId],
    [`${SDK_PUBLIC_KEY}${suffix}`, publicKeyHex],
  ]);
}
