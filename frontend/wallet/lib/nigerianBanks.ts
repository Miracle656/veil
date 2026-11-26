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
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 *
 * Source: two things agree here, and both matter.
 *
 *  1. What the payout needs: Linq's own supported-bank list, transcribed by hand
 *     when the web cash-out flow landed on 2026-09-09 (commit eb758e1,
 *     "feat(web): cash out to a bank account"). Linq is the institution that
 *     decides whether a payout succeeds, so its code is the one that counts.
 *  2. What the list is checked against on review: the NIBSS institution codes
 *     published in the Nigerian bank-code lists the major PSPs maintain. Last
 *     reviewed 2026-10-22, when `nigerianBanks.test.ts` was added.
 *
 * Two things are NOT claims this file makes:
 *
 *  - It is not a complete Nigerian bank list. It is the subset a person
 *    cashing out actually uses; a bank that is missing is refused below rather
 *    than approximated to the nearest entry.
 *  - It is not "corrected" from another provider's list. Nigerian code lists
 *    genuinely disagree about the digital banks, because the legacy codes and
 *    the newer NIBSS institution codes both stay in circulation: Kuda appears as
 *    50211 or 090267, Moniepoint MFB as 50515 or 090405, OPay as 999992 or
 *    100004, PalmPay as 999991 or 100033, and Stanbic IBTC as 221 or 039. This
 *    table carries 090267, 090405, 100004, 100033 and 039. A row is changed
 *    only because Linq changed, never because a blog disagreed: moving one digit
 *    here reroutes real money, and the failure is silent until the payout
 *    fails — after the USDC has left.
 *
 * The 039/221 Stanbic IBTC pair is the one row worth confirming with Linq
 * before the next payout to a Stanbic account. It is reported, not "fixed",
 * because the value that has to be right is Linq's and this change cannot see
 * Linq's answer.
 *
 * ── Should this be fetched instead? ──────────────────────────────────────────
 *
 * Not at runtime, and not from a public mirror. NIBSS publishes the codes as a
 * document rather than a feed; the machine-readable mirrors (Paystack's
 * `/bank`, nigerianbanks.xyz, assorted gists) are either key-gated or
 * community-maintained, and none of them is the list that decides whether Linq
 * accepts a payout. A fetch would add a network dependency to a picker that has
 * to work offline, and could confidently pick a code Linq rejects — worse than a
 * curated list that is stale but known.
 *
 * The refinement worth doing, if this list ever starts drifting: have Wraith
 * re-expose Linq's own supported-bank list (it already holds the key) and
 * generate this table from it at build time. That keeps one authority and still
 * ships a static picker. Until then this table is hand-maintained, and
 * `nigerianBanks.test.ts` is what stops a half-edited row from shipping.
 */
export interface NigerianBank {
  code: string;
  name: string;
}

/** The table itself. Every row is asserted in `__tests__/nigerianBanks.test.ts`. */
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

/**
 * The display name for a bank code.
 *
 * An unknown code comes back as the code itself — never the nearest entry, and
 * never a default institution. That is the refusal: the cash-out screen shows
 * "999999" where a name would be, which reads as "we do not know this bank"
 * rather than naming a bank the user never chose. It must stay this way; a
 * fallback name would label a payout with the wrong institution, and the user
 * would only find out after the money had gone.
 */
export function bankName(code: string): string {
  return NIGERIAN_BANKS.find((b) => b.code === code)?.name ?? code;
}
