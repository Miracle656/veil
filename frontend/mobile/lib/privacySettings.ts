/**
 * Facts and options behind the mobile Privacy settings screen (Issue #830).
 *
 * Web has `app/settings/privacy/page.tsx` for Sentry error reporting.
 * With Stellar Private Payments (SPP) arriving, mobile needs a matching surface.
 *
 * Ground rules:
 * 1. Read the privacy flag from the shared `lib/privacy/config.ts` (never duplicate).
 * 2. SPP is testnet-only and unconditionally locked out on mainnet.
 * 3. Unavailable features on mobile (like crash reporting) must be explicitly
 *    labelled as unavailable, never hidden or faked with a dummy toggle.
 */

import { isPrivacyEnabled } from './privacy/config';
import { getNetworkName, type VeilNetworkName } from './network';

export interface PrivacyOption {
  key: string;
  category: string;
  title: string;
  description: string;
  /** Whether the feature is currently active and usable. */
  available: boolean;
  /** Whether the user can toggle the option on the current network. */
  toggleable: boolean;
  /** Status badge / copy. */
  statusLabel: string;
  /** Explanatory note when unavailable or locked out. */
  unavailableReason?: string;
}

export function getPrivacyOptions(network: VeilNetworkName = getNetworkName()): PrivacyOption[] {
  const isMainnet = network === 'mainnet';
  const privacyActive = isPrivacyEnabled(network);

  return [
    {
      key: 'crash_reporting',
      category: 'ERROR REPORTING',
      title: 'Crash reports',
      description: 'Help improve Veil by sending anonymous crash reports. No addresses or keys are ever included.',
      available: false,
      toggleable: false,
      statusLabel: 'Unavailable on mobile',
      unavailableReason: 'Error reporting service is not yet enabled for the mobile application.',
    },
    {
      key: 'stellar_private_payments',
      category: 'STELLAR PRIVATE PAYMENTS',
      title: 'Private transfers (SPP)',
      description: 'Zero-knowledge shielded payments via Soroban smart contracts. Unaudited developer preview.',
      available: !isMainnet && privacyActive,
      toggleable: !isMainnet,
      statusLabel: isMainnet
        ? 'Locked out on mainnet'
        : privacyActive
          ? 'Enabled (Testnet preview)'
          : 'Disabled (Preview flag off)',
      unavailableReason: isMainnet
        ? 'Stellar Private Payments is a testnet-only preview and unconditionally locked out on mainnet.'
        : !privacyActive
          ? 'Feature flag EXPO_PUBLIC_PRIVACY_FEATURE_FLAG is disabled for this build.'
          : undefined,
    },
  ];
}
