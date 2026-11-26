/**
 * Per-network deployment config for the DAO multisig contract (issue #672).
 *
 * A WASM hash names bytecode that has been *installed on one specific network*.
 * `lib/multisig.ts` used to carry a single hardcoded hash and apply it to both
 * networks, next to an RPC URL and passphrase that were correctly network-aware.
 * That is not a cosmetic inconsistency: `createCustomContract` against a hash
 * the network has never seen fails at the signature, after the user has entered
 * signers and a threshold.
 *
 * On-chain check (2026-09-02, `getLedgerEntries` for the CONTRACT_CODE key):
 *
 *   testnet  7eb63568…  INSTALLED      (lastModifiedLedgerSeq 2843166)
 *   mainnet  7eb63568…  NOT INSTALLED  (confirmed on two independent RPCs)
 *
 * So the multisig deploy flow can only work on testnet today. The testnet hash
 * is committed as a default — it is verified, and it is what the route already
 * used — while mainnet has none, which makes `/multisig` unavailable there
 * until someone installs the contract and sets the mainnet variable.
 *
 * This module deliberately holds no `@stellar/stellar-sdk` imports and no
 * module-scope side effects, so the navigation and the route guard can ask
 * "is multisig available here?" without pulling the whole deploy path into
 * the shared app-shell bundle.
 */
import { NETWORKS, getNetworkName, type VeilNetworkName } from './network'

/**
 * Verified installed on Stellar testnet. Committed for the same reason the
 * testnet factory contract ID is: a fresh clone should run without secret
 * config. Override with `NEXT_PUBLIC_MULTISIG_WASM_HASH_TESTNET`.
 */
const BUILT_IN_WASM_HASH: Partial<Record<VeilNetworkName, string>> = {
  testnet: '7eb63568a7a41c19f5d85c55b5ec88c6f95ef840bcf98d1797850ace2dd3cf24',
  // No mainnet entry on purpose: the contract is not installed on mainnet.
  // Adding one here without installing the bytecode would restore exactly the
  // failure #672 is about.
}

/** A Soroban WASM hash is a SHA-256 digest: 64 hex characters. */
const WASM_HASH_PATTERN = /^[0-9a-f]{64}$/i

export const MULTISIG_WASM_HASH_ENV_VAR: Record<VeilNetworkName, string> = {
  testnet: 'NEXT_PUBLIC_MULTISIG_WASM_HASH_TESTNET',
  mainnet: 'NEXT_PUBLIC_MULTISIG_WASM_HASH_MAINNET',
}

/**
 * Why the branch instead of `process.env[VAR_NAME]`: Next.js inlines
 * `NEXT_PUBLIC_*` into the client bundle by matching the literal member
 * expression in the source. A computed key is not substituted and reads as
 * `undefined` in the browser — the config would silently vanish in production
 * while working in tests. `lib/vault.ts` spells its two out for the same reason.
 */
function rawConfiguredHash(network: VeilNetworkName): string | undefined {
  const value = network === 'mainnet'
    ? process.env.NEXT_PUBLIC_MULTISIG_WASM_HASH_MAINNET?.trim()
    : process.env.NEXT_PUBLIC_MULTISIG_WASM_HASH_TESTNET?.trim()
  return value || undefined
}

export type MultisigDeployment =
  /** The network has a usable hash; `/multisig` may deploy. */
  | { status: 'available'; network: VeilNetworkName; wasmHash: string; source: 'env' | 'built-in' }
  /** No hash for this network. Expected on mainnet — the contract is not there. */
  | { status: 'unconfigured'; network: VeilNetworkName; reason: string }
  /** A hash was supplied but is not a SHA-256 digest. A typo, not a policy. */
  | { status: 'invalid'; network: VeilNetworkName; reason: string; value: string }

/**
 * Resolve the multisig deployment for a network.
 *
 * `unconfigured` and `invalid` are kept apart on purpose. Collapsing them into
 * one falsy "not available" would let a typo in the env var look exactly like
 * the deliberate mainnet gate, so a broken deployment would silently lose the
 * route instead of complaining.
 */
export function getMultisigDeployment(
  network: VeilNetworkName = getNetworkName(),
): MultisigDeployment {
  const displayName = NETWORKS[network].displayName
  const envVar = MULTISIG_WASM_HASH_ENV_VAR[network]
  const configured = rawConfiguredHash(network)

  if (configured !== undefined) {
    if (!WASM_HASH_PATTERN.test(configured)) {
      return {
        status: 'invalid',
        network,
        value: configured,
        reason:
          `${envVar} is not a valid contract WASM hash. Expected 64 hex characters `
          + `(a SHA-256 digest), got ${configured.length} character(s).`,
      }
    }
    return { status: 'available', network, wasmHash: configured.toLowerCase(), source: 'env' }
  }

  const builtIn = BUILT_IN_WASM_HASH[network]
  if (builtIn) {
    return { status: 'available', network, wasmHash: builtIn, source: 'built-in' }
  }

  return {
    status: 'unconfigured',
    network,
    reason:
      `The multisig contract is not deployed on ${displayName}. Install the `
      + `multisig WASM there and set ${envVar} to its hash to enable this feature.`,
  }
}

/**
 * True when the multisig route can actually complete a deploy on this network.
 * Drives both the navigation entry and the route guard, so the two can never
 * disagree about whether the page is offered.
 */
export function isMultisigAvailable(network: VeilNetworkName = getNetworkName()): boolean {
  return getMultisigDeployment(network).status === 'available'
}

/**
 * The hash to deploy with, or a thrown error naming the network and the
 * variable to set. Resolved per call rather than at module load so that a
 * missing mainnet config surfaces as a clear message at the deploy attempt
 * instead of breaking the read-only paths (`fetchMultisigDetails`, the pending
 * queue) at import time.
 */
export function getMultisigWasmHash(network: VeilNetworkName = getNetworkName()): string {
  const deployment = getMultisigDeployment(network)
  if (deployment.status === 'available') return deployment.wasmHash
  throw new Error(deployment.reason)
}
