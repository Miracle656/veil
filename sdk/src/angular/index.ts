/**
 * `invisible-wallet-sdk/angular` — the Angular entry point.
 *
 * Everything an Angular app needs is re-exported here so it never has to import
 * from the React entry point (and never pulls React into its bundle).
 */

export { VeilService, VEIL_WALLET_CONFIG } from './lib/veil.service';
export { VeilModule } from './lib/veil.module';
export { provideVeil } from './lib/provide-veil';

export {
    RecoveryTimelockActive,
    NoGuardianSet,
    RecoveryNotPending,
} from '../core';

export type {
    StorageAdapter,
    WalletConfig,
    WalletState,
    InvisibleWalletActions,
    WebAuthnSignature,
    AuthenticatorAttachment,
    RegisterOptions,
    LoginOptions,
    PortableSigner,
    RegisterResult,
    DeployResult,
    AddSignerResult,
    RotateSignerResult,
    SignerInfo,
    InitiateRecoveryResult,
} from '../core';