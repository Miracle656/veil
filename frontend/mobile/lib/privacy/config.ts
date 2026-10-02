/**
 * The privacy feature flag, per-network Stellar Private Payments (SPP)
 * config (V131), and association-set policy configuration (V132).
 *
 * SPP is an unaudited developer preview that runs on testnet only — "not yet
 * approved for mainnet". Every later issue in the privacy batch reads from
 * this module:
 *
 *   - {@link isPrivacyEnabled} — the single switch that hides the feature;
 *   - {@link getSppConfig} — the pool, verifier, ASP and registry contract
 *     IDs for the active network;
 *   - {@link getAssociationSetPolicy} / {@link getAssociationSetContract} —
 *     the active ASP policy and corresponding contract address;
 *   - {@link formatPrivacyError} / {@link isPolicyRejectionError} — error
 *     classification distinguishing policy rejections from proving failures.
 *
 * The network is resolved per call rather than captured at import time, so the
 * runtime override in `lib/network.ts` takes effect without module-level state
 * going stale.
 */

import { getNetworkName, type VeilNetworkName } from '../network';

/**
 * Build-time switch for the privacy feature, off unless a build opts in with
 * `EXPO_PUBLIC_PRIVACY_FEATURE_FLAG=1` (or `true`), mirroring the wallet's
 * `NEXT_PUBLIC_PRIVACY_FEATURE_FLAG`.
 */
function privacyFlagOn(): boolean {
  return (
    process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'] === '1' ||
    process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'] === 'true'
  );
}

/**
 * Whether the privacy feature is available for `network`, defaulting to the
 * active network.
 *
 * Off by default, and unconditionally off on mainnet. SPP is a testnet-only
 * preview, so an enabled build flag must never become a path to private
 * payments on mainnet — even a mainnet build that sets it gets `false`.
 */
export function isPrivacyEnabled(network: VeilNetworkName = getNetworkName()): boolean {
  if (network === 'mainnet') return false;
  return privacyFlagOn();
}

/** Supported association-set compliance policies (V132). */
export type AssociationSetPolicy = 'blocklist' | 'allowlist';

/**
 * Default association-set policy for Veil: 'blocklist' using `asp_non_membership`.
 * Rationale: A blocklist policy maximizes the anonymity set size by including
 * all non-sanctioned deposits by default, unlike allowlist which restricts the set
 * strictly to pre-screened members.
 */
export const DEFAULT_ASSOCIATION_SET_POLICY: AssociationSetPolicy = 'blocklist';

/**
 * Resolves the active Association Set Policy.
 * Changing the policy is a configuration change (via `EXPO_PUBLIC_PRIVACY_ASP_POLICY`),
 * not a code change.
 */
export function getAssociationSetPolicy(): AssociationSetPolicy {
  const envPolicy = process.env['EXPO_PUBLIC_PRIVACY_ASP_POLICY'];
  if (envPolicy === 'allowlist' || envPolicy === 'blocklist') {
    return envPolicy;
  }
  return DEFAULT_ASSOCIATION_SET_POLICY;
}

/** Metadata defining user-facing policy details and honest anonymity-set descriptions. */
export interface PolicyMetadata {
  /** The policy identifier. */
  policy: AssociationSetPolicy;
  /** User-friendly name. */
  name: string;
  /**
   * Honest description of the anonymity set size and bounds.
   * Clarifies that the set is all non-excluded deposits in this pool under this policy,
   * not the entire blockchain.
   */
  anonymitySetDescription: string;
  /** Explanation of exclusion consequences. */
  exclusionExplanation: string;
}

export const POLICY_METADATA: Record<AssociationSetPolicy, PolicyMetadata> = {
  blocklist: {
    policy: 'blocklist',
    name: 'Blocklist Policy',
    anonymitySetDescription:
      'Anonymity set consists of all non-excluded depositors in this pool under the active blocklist policy.',
    exclusionExplanation:
      'Deposits flagged or added to the ASP blocklist cannot construct valid non-membership proofs and cannot be spent or unshielded in this pool.',
  },
  allowlist: {
    policy: 'allowlist',
    name: 'Allowlist Policy',
    anonymitySetDescription:
      'Anonymity set is restricted strictly to pre-approved members on the ASP allowlist in this pool.',
    exclusionExplanation:
      'Only addresses verified and included on the ASP allowlist are permitted to construct valid membership proofs.',
  },
};

/**
 * Returns metadata and honest descriptions for `policy`, defaulting to the active policy.
 */
export function getPolicyMetadata(
  policy: AssociationSetPolicy = getAssociationSetPolicy()
): PolicyMetadata {
  return POLICY_METADATA[policy] ?? POLICY_METADATA.blocklist;
}

/** One entry of SPP's `pools` array in `deployments/testnet/deployments.json`. */
export type SppPool = {
  /** `poolContractId` — the pool's own contract. */
  id: string;
  /** `tokenContractId` — the token contract the pool moves. */
  tokenContractId: string;
  /** `policyFlags` — the compliance policy the pool was deployed with. */
  policyFlags: readonly string[];
  /** `asset.kind` — whether the pool's base asset is native XLM. */
  assetKind: 'native' | 'soroban';
  /** `gvkMode`, present only when the pool is global-view-key traceable. */
  gvkMode?: 'traceable';
};

/** The SPP deployment the app should talk to on one network, if any. */
export type SppNetworkConfig = {
  /** `asp_membership` — ASP contract holding the approved-key Merkle tree. */
  aspMembership: string;
  /** `asp_non_membership` — ASP contract holding the blocked-key tree. */
  aspNonMembership: string;
  /** `verifiers` — the on-chain Groth16 verifier contracts. */
  verifiers: {
    /** `verifiers.B` — block-list / allow-list pools without a global view key. */
    standard: string;
    /** `verifiers.B_gvk_T` — traceable global-view-key pools. */
    traceable: string;
  };
  /** `public_key_registry` — Stellar address → SPP public keys. */
  publicKeyRegistry: string;
  /** Nethermind's hosted events archive for sync past the 7-day RPC window. */
  bootnodeUrl: string;
  /** `pools` — the canonical pools for this network. */
  pools: readonly SppPool[];
};

/**
 * SPP contract addresses, copied from SPP's
 * `deployments/testnet/deployments.json` at upstream commit
 * `91ba67d659cb50a66ecba7ba42e27f8e686117f4`
 * (NethermindEth/stellar-private-payments, 2026-09-23 — "redeploy testnet for
 * the packed storage layout"). Copy the testnet entry again — and bump the
 * commit hash above with it — whenever SPP redeploys.
 *
 * Mainnet has no entry on purpose: SPP is not approved for mainnet, so there is
 * nothing to point at, and {@link getSppConfig} returning `null` there is how a
 * screen knows not to offer any of it.
 */
export const SPP_NETWORKS: Partial<Record<VeilNetworkName, SppNetworkConfig>> = {
  testnet: {
    aspMembership: 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC',
    aspNonMembership: 'CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ',
    verifiers: {
      standard: 'CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV',
      traceable: 'CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV',
    },
    publicKeyRegistry: 'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4',
    bootnodeUrl: 'https://bootnode.dev-nethermind.xyz',
    pools: [
      {
        // XLM pool with a block-list policy.
        id: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
        tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        policyFlags: ['blocklist'],
        assetKind: 'native',
      },
      {
        // XLM pool with a block-list policy and a global view key (traceable).
        id: 'CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42',
        tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        policyFlags: ['blocklist'],
        assetKind: 'native',
        gvkMode: 'traceable',
      },
    ],
  },
  // mainnet: no entry — see the comment above.
};

/**
 * The SPP config for `network`, or `null` when that network has no deployment
 * (mainnet). Resolved per call so it tracks the runtime network override.
 */
export function getSppConfig(network: VeilNetworkName = getNetworkName()): SppNetworkConfig | null {
  return SPP_NETWORKS[network] ?? null;
}

/**
 * Returns the contract ID of the Association Set Provider contract matching `policy`
 * for `network`. Returns `null` on networks with no SPP deployment (mainnet).
 */
export function getAssociationSetContract(
  network: VeilNetworkName = getNetworkName(),
  policy: AssociationSetPolicy = getAssociationSetPolicy()
): string | null {
  const config = getSppConfig(network);
  if (!config) return null;
  return policy === 'allowlist' ? config.aspMembership : config.aspNonMembership;
}

/** Categorized privacy error codes. */
export type PrivacyErrorCode =
  | 'POLICY_REJECTED'
  | 'PROVING_FAILED';

/** Formatted, UI-friendly privacy error structure. */
export interface FormattedPrivacyError {
  /** High-level error classification. */
  code: PrivacyErrorCode;
  /** Whether the failure was caused by association set / compliance policy rejection. */
  isPolicyRejection: boolean;
  /** The raw or normalized technical error message. */
  message: string;
  /** Human-friendly user-facing message. */
  userFacingMessage: string;
}

/**
 * Distinguishes whether an error is due to an Association Set Policy rejection
 * rather than a generic proving or computation failure.
 */
export function isPolicyRejectionError(error: unknown): boolean {
  if (!error) return false;
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
      ? error.message
      : typeof (error as Record<string, unknown>)?.message === 'string'
      ? String((error as Record<string, unknown>).message)
      : String(error);

  const lower = message.toLowerCase();
  return (
    lower.includes('policy_rejected') ||
    lower.includes('asp rejection') ||
    lower.includes('non-membership proof rejected') ||
    lower.includes('membership proof rejected') ||
    lower.includes('blocked deposit') ||
    lower.includes('blocklisted') ||
    lower.includes('excluded by association set') ||
    lower.includes('not in allowlist') ||
    lower.includes('association set verification failed')
  );
}

/**
 * Formats a privacy or proving error into a structured object for UI display,
 * clearly distinguishing compliance/policy rejections from generic proving errors.
 */
export function formatPrivacyError(error: unknown): FormattedPrivacyError {
  const rawMessage =
    typeof error === 'string'
      ? error
      : error instanceof Error
      ? error.message
      : typeof (error as Record<string, unknown>)?.message === 'string'
      ? String((error as Record<string, unknown>).message)
      : 'Unknown privacy error';

  if (isPolicyRejectionError(error)) {
    return {
      code: 'POLICY_REJECTED',
      isPolicyRejection: true,
      message: rawMessage,
      userFacingMessage:
        'Transaction rejected by compliance policy: deposit is excluded from the active association set.',
    };
  }

  return {
    code: 'PROVING_FAILED',
    isPolicyRejection: false,
    message: rawMessage,
    userFacingMessage:
      'Failed to generate or verify zero-knowledge proof. Please try again.',
  };
}
