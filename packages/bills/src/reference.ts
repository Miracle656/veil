/**
 * Order references.
 *
 * Minted by us, persisted before dispatch, and the only handle we have on an
 * order whose response never arrived. eBills caps them at 50 characters and
 * rejects reuse with 409, so they must be unique and they must be short.
 *
 * The shape is deliberately greppable in a provider's dashboard: a prefix, a
 * millisecond timestamp, and enough randomness that two requests in the same
 * millisecond cannot collide.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newReference(prefix = 'veil', random: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  const ref = prefix + '_' + Date.now().toString(36) + '_' + suffix;
  // Cheap insurance: a caller passing a long prefix should fail here rather
  // than at the provider, after the order may already have been dispatched.
  if (ref.length > 50) throw new Error('reference prefix too long: ' + prefix);
  return ref;
}
