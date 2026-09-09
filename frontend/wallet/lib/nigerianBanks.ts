/**
 * Nigerian bank codes for the offramp payout picker.
 *
 * A subset of Linq's list — the banks people actually hold accounts with,
 * including the mobile-money providers that dominate here. The code is what
 * Linq matches on; the name is only ever shown.
 *
 * Deliberately not fetched at runtime: the list changes rarely, an offline
 * picker is better than a spinner, and a wrong code produces a failed payout
 * AFTER the USDC has gone rather than a validation error before it.
 */
export interface NigerianBank {
  code: string;
  name: string;
}

export const NIGERIAN_BANKS: NigerianBank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '058', name: 'GTBank' },
  { code: '011', name: 'First Bank' },
  { code: '057', name: 'Zenith Bank' },
  { code: '033', name: 'UBA' },
  { code: '090267', name: 'Kuda Microfinance Bank' },
  { code: '100004', name: 'OPay' },
  { code: '100033', name: 'PalmPay' },
  { code: '090405', name: 'Moniepoint MFB' },
  { code: '035', name: 'Wema Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '214', name: 'FCMB' },
  { code: '039', name: 'Stanbic IBTC' },
  { code: '076', name: 'Polaris Bank' },
];

export function bankName(code: string): string {
  return NIGERIAN_BANKS.find((b) => b.code === code)?.name ?? code;
}
