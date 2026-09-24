import { isRegisteredSigner, RECOVERY_SIGNER_CASES } from '@veil/sdk';

describe('mobile recovery uses the shared signer table', () => {
  it.each(RECOVERY_SIGNER_CASES)('$name', ({ signers, candidate, accepted }) => {
    expect(isRegisteredSigner([...signers], candidate)).toBe(accepted);
  });
});