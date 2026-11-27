/**
 * Things a spending account can own that a payment cannot move.
 *
 * `feePayerMove.ts` carries XLM and every trustline asset. A Veil-ian is
 * neither: the collection contract records an owner address, and moving one
 * means calling that contract as the owner. A wallet that switched spending
 * accounts without doing so would still own the figure on paper and have no
 * screen that could act as the account holding it.
 *
 * So the switch is refused while the old account holds one. Names are not
 * checked: the app registers them to the smart wallet, never to the spending
 * account, and a random-key spending account cannot be opened on the web,
 * which is the only place a name is bought as the spending account.
 */
import { nativeToScVal } from '@stellar/stellar-sdk';

import { simulateRead } from './contractInvoke';
import { collectionContractId } from './veilIans';

/**
 * True when `address` holds a Veil-ian, or when that could not be checked.
 *
 * "Could not check" counts as yes because the caller is deciding whether to
 * stop signing as this account, and a wrong no cannot be undone from the app.
 * That is why this reads the chain itself instead of using the gallery's
 * `fetchOwnedVeilIans`, which answers an empty list for a failed read: right
 * for a gallery, wrong for this.
 */
export async function mayHoldCollectibles(address: string): Promise<boolean> {
  try {
    const contractId = collectionContractId();
    // The collection is not deployed on this network, so nothing can be held.
    if (!contractId) return false;

    const sold = await simulateRead(contractId, 'sold', []);
    if (!Array.isArray(sold)) return true;

    for (const id of sold.map(Number)) {
      if (!Number.isInteger(id)) return true;
      const owner = await simulateRead(contractId, 'owner_of', [nativeToScVal(id, { type: 'u32' })]);
      if (typeof owner !== 'string') return true;
      if (owner === address) return true;
    }
    return false;
  } catch {
    return true;
  }
}
