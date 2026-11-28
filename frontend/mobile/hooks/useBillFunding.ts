import { useCallback, useEffect, useMemo, useState } from 'react';

import { getBillHoldings } from '../lib/billHoldings';
import {
  decideFundingAsset,
  loadFundingChoice,
  saveFundingChoice,
  type FundingDecision,
  type FundingHoldings,
} from '../lib/billFundingAsset';
import { getOnrampRate, type NairaCoin } from '../lib/onramp';

/**
 * Which asset a bill screen pays with, and why. Loads both balances and both
 * rates, decides with `decideFundingAsset`, and remembers an explicit choice.
 * The screen mirrors `decision.coin` into its own `coin` state.
 */
export function useBillFunding(amountNgn: number, enabled: boolean) {
  const [holdings, setHoldings] = useState<FundingHoldings | null>(null);
  const [rates, setRates] = useState<{ xlm: number | null; usdc: number | null }>({ xlm: null, usdc: null });
  const [preferred, setPreferred] = useState<NairaCoin | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const [h, p, xlm, usdc] = await Promise.all([
        getBillHoldings().catch(() => null),
        loadFundingChoice(),
        getOnrampRate('xlm').catch(() => null),
        getOnrampRate('usdc').catch(() => null),
      ]);
      if (cancelled) return;
      setHoldings(h);
      setPreferred(p);
      setRates({ xlm, usdc });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const decision: FundingDecision = useMemo(
    () =>
      decideFundingAsset({
        costs: {
          xlm: rates.xlm && amountNgn > 0 ? amountNgn / rates.xlm : null,
          usdc: rates.usdc && amountNgn > 0 ? amountNgn / rates.usdc : null,
        },
        holdings,
        preferred,
      }),
    [amountNgn, rates, holdings, preferred],
  );

  const choose = useCallback((coin: NairaCoin) => {
    setPreferred(coin);
    void saveFundingChoice(coin);
  }, []);

  return { decision, choose };
}
