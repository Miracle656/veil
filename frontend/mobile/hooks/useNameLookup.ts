import { useEffect, useState } from 'react';

import { IDLE, isLookupCandidate, lookupName, type NameLookup } from '../lib/nameLookup';

/**
 * The account a typed `name*domain` currently points at, looked up as the user
 * types. Debounced so each keystroke of a name is not its own request, and
 * guarded so a slow answer for an earlier value cannot overwrite a later one.
 */
export function useNameLookup(value: string, delayMs = 400): NameLookup {
  const [lookup, setLookup] = useState<NameLookup>(IDLE);

  useEffect(() => {
    const name = value.trim();
    if (!isLookupCandidate(name)) {
      setLookup(IDLE);
      return;
    }

    let active = true;
    setLookup({ status: 'resolving', name });
    const timer = setTimeout(() => {
      void lookupName(name).then((result) => {
        if (active) setLookup(result);
      });
    }, delayMs);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return lookup;
}
