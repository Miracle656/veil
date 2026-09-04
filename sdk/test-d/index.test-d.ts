import { expectType, expectAssignable, expectNotAssignable } from 'tsd';
import type {
    WalletConfig,
    WebAuthnSignature,
    AuthenticatorAttachment,
    RegisterResult,
    DeployResult,
    AddSignerResult,
    RotateSignerResult,
    SignerInfo,
    InitiateRecoveryResult,
    StorageAdapter,
    InvisibleWallet,
} from 'invisible-wallet-sdk';
import {
    RecoveryTimelockActive,
    NoGuardianSet,
    RecoveryNotPending,
} from 'invisible-wallet-sdk';
import type { OutboxStatus, OutboxEntry } from 'invisible-wallet-sdk';
import type { Sep7MemoType, Sep7PayRequest } from 'invisible-wallet-sdk';
import type { SignedMessage } from 'invisible-wallet-sdk';

// ── WalletConfig ──────────────────────────────────────────────────────────────

declare const config: WalletConfig;
expectType<string>(config.factoryAddress);
expectType<string>(config.rpcUrl);
expectType<string>(config.networkPassphrase);
expectType<string | undefined>(config.rpId);
expectType<StorageAdapter | undefined>(config.storage);

// ── WebAuthnSignature ─────────────────────────────────────────────────────────

declare const sig: WebAuthnSignature;
expectType<Uint8Array>(sig.publicKey);
expectType<Uint8Array>(sig.authData);
expectType<Uint8Array>(sig.clientDataJSON);
expectType<Uint8Array>(sig.signature);

// ── AuthenticatorAttachment union ─────────────────────────────────────────────

expectAssignable<AuthenticatorAttachment>('platform');
expectAssignable<AuthenticatorAttachment>('cross-platform');
expectNotAssignable<AuthenticatorAttachment>('usb');

// ── RegisterResult ────────────────────────────────────────────────────────────

declare const reg: RegisterResult;
expectType<string>(reg.walletAddress);
expectType<Uint8Array>(reg.publicKeyBytes);
expectType<AuthenticatorAttachment | undefined>(reg.authenticatorAttachment);
expectType<boolean | undefined>(reg.isPortableSigner);

// ── DeployResult ──────────────────────────────────────────────────────────────

declare const dep: DeployResult;
expectType<string>(dep.walletAddress);
expectType<boolean>(dep.alreadyDeployed);

// ── AddSignerResult ───────────────────────────────────────────────────────────

declare const add: AddSignerResult;
expectType<number>(add.signerIndex);

// ── RotateSignerResult ────────────────────────────────────────────────────────

declare const rot: RotateSignerResult;
expectType<Uint8Array>(rot.oldPublicKeyBytes);
expectType<Uint8Array>(rot.newPublicKeyBytes);
expectType<string>(rot.walletAddress);

// ── SignerInfo ────────────────────────────────────────────────────────────────

declare const info: SignerInfo;
expectType<number>(info.index);
expectType<string>(info.publicKey);

// ── InitiateRecoveryResult ────────────────────────────────────────────────────

declare const ir: InitiateRecoveryResult;
expectType<number>(ir.unlockTime);

// ── StorageAdapter ────────────────────────────────────────────────────────────

declare const storage: StorageAdapter;
expectType<string | null | Promise<string | null>>(storage.getItem('k'));

// ── InvisibleWallet surface ───────────────────────────────────────────────────

declare const wallet: InvisibleWallet;
expectType<string | null>(wallet.address);
expectType<boolean>(wallet.isDeployed);
expectType<boolean>(wallet.isPending);
expectType<string | null>(wallet.error);
expectType<Promise<RegisterResult>>(wallet.register());
expectType<Promise<DeployResult>>(wallet.deploy({} as any));

// ── OutboxStatus union ────────────────────────────────────────────────────────

expectAssignable<OutboxStatus>('pending');
expectAssignable<OutboxStatus>('confirmed');
expectAssignable<OutboxStatus>('failed');
expectNotAssignable<OutboxStatus>('unknown');

// ── OutboxEntry ───────────────────────────────────────────────────────────────

declare const entry: OutboxEntry;
expectType<string>(entry.hash);
expectType<string>(entry.xdr);
expectType<OutboxStatus>(entry.status);

// ── Sep7MemoType union ────────────────────────────────────────────────────────

expectAssignable<Sep7MemoType>('text');
expectAssignable<Sep7MemoType>('id');
expectAssignable<Sep7MemoType>('hash');
expectAssignable<Sep7MemoType>('return');

// ── Sep7PayRequest ────────────────────────────────────────────────────────────

declare const sep7: Sep7PayRequest;
expectType<string>(sep7.destination);
expectType<string | undefined>(sep7.amount);

// ── SignedMessage ─────────────────────────────────────────────────────────────

declare const sm: SignedMessage;
expectType<1>(sm.version);
expectType<'VEIL_SIGNED_MESSAGE_V1'>(sm.domain);
expectType<string>(sm.signature);
expectType<string>(sm.publicKey);

// ── Error classes ─────────────────────────────────────────────────────────────

const rtErr = new RecoveryTimelockActive(9999);
expectType<number>(rtErr.unlockTime);
expectAssignable<Error>(rtErr);

const ngErr = new NoGuardianSet();
expectAssignable<Error>(ngErr);

const rnErr = new RecoveryNotPending();
expectAssignable<Error>(rnErr);
