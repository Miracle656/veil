/**
 * The options on the privacy settings screen (#830), the mobile counterpart of
 * the web wallet's `app/settings/privacy/page.tsx`.
 *
 * Kept free of React so the rules are testable on their own: the screen only
 * renders what {@link getPrivacySettingsOptions} returns.
 *
 * Two rules shape every option:
 *
 *   - Availability comes from `./config` — {@link isPrivacyEnabled} and
 *     {@link getSppConfig} — never from a local copy of the flag, so the
 *     mainnet lockout here is the same one every other privacy surface obeys.
 *   - An option the mobile app cannot act on yet is still listed, with a label
 *     saying why, rather than hidden or given a switch that does nothing.
 */

import { getNetworkName, type VeilNetworkName } from '../network';
import { getPolicyMetadata, getSppConfig, isPrivacyEnabled } from './config';

/** Why an option is (or is not) usable right now. */
export type PrivacyOptionStatus =
  /** No SPP deployment on this network — mainnet, where SPP is not approved. */
  | 'unavailable-network'
  /** The network has SPP, but this build did not opt in to the feature flag. */
  | 'disabled-build'
  /** Enabled for this build and network, but the mobile app cannot act on it yet. */
  | 'unavailable-mobile';

export type PrivacyOption = {
  key: 'private-payments' | 'crash-reports';
  /** Section heading, as the web screen's uppercase labels. */
  section: string;
  title: string;
  description: string;
  status: PrivacyOptionStatus;
  /** Short badge text shown in place of a switch. */
  statusLabel: string;
  /** Longer, honest explanation of {@link statusLabel}. */
  statusDetail: string;
  /**
   * Whether the screen may render a working control. False for every option
   * today — no privacy action is implemented on mobile yet — and false on
   * mainnet whatever mobile later gains, because it is gated on the shared flag.
   */
  toggleable: boolean;
};

/**
 * Whether the mobile app implements shielded transfers. Flip this only when
 * the flow ships; the shared flag still has to be on for a control to appear.
 */
const MOBILE_SUPPORTS_PRIVATE_PAYMENTS = false;

function privatePaymentsOption(network: VeilNetworkName): PrivacyOption {
  const base = {
    key: 'private-payments' as const,
    section: 'PRIVATE PAYMENTS',
    title: 'Shielded transfers',
    description:
      'Move funds through a Stellar Private Payments pool so the sender and recipient are not linked on-chain. An unaudited developer preview.',
  };

  if (isPrivacyEnabled(network)) {
    const policy = getPolicyMetadata();
    return {
      ...base,
      status: 'unavailable-mobile',
      statusLabel: 'Not yet available on mobile',
      statusDetail: `Enabled for this build on ${network} (${policy.name}), but the mobile app cannot make shielded transfers yet. Use the web wallet for now.`,
      toggleable: MOBILE_SUPPORTS_PRIVATE_PAYMENTS,
    };
  }

  if (getSppConfig(network) === null) {
    return {
      ...base,
      status: 'unavailable-network',
      statusLabel: `Not available on ${network}`,
      statusDetail:
        'Private payments are a testnet-only preview and are not approved for mainnet. Nothing here can be turned on while you are on this network.',
      toggleable: false,
    };
  }

  return {
    ...base,
    status: 'disabled-build',
    statusLabel: 'Off in this build',
    statusDetail: `Private payments are deployed on ${network}, but this build of the app has not enabled the feature.`,
    toggleable: false,
  };
}

function crashReportsOption(): PrivacyOption {
  return {
    key: 'crash-reports',
    section: 'ERROR REPORTING',
    title: 'Send crash reports',
    description:
      'On the web wallet you can opt in to anonymous crash reports, with addresses and amounts stripped out.',
    status: 'unavailable-mobile',
    statusLabel: 'Not yet available on mobile',
    statusDetail: 'The mobile app does not send crash reports at all, so there is nothing to opt in to.',
    toggleable: false,
  };
}

/** The privacy screen's options for `network`, defaulting to the active network. */
export function getPrivacySettingsOptions(
  network: VeilNetworkName = getNetworkName()
): PrivacyOption[] {
  return [privatePaymentsOption(network), crashReportsOption()];
}
