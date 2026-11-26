/**
 * `invisible-wallet-sdk/vue` — the Vue 3 entry point.
 *
 * Everything a Vue app needs is re-exported here so it never has to import from
 * the React entry point (and never pulls React into its bundle).
 */

export { useInvisibleWallet } from './useInvisibleWallet';
export type { VueInvisibleWallet } from './useInvisibleWallet';

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
