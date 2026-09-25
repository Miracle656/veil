import { isRegisteredSigner, RECOVERY_SIGNER_CASES } from '../recovery/signerVerification';

describe('shared recovery signer rule', () => {
    it.each(RECOVERY_SIGNER_CASES)('$name', ({ signers, candidate, accepted }) => {
        expect(isRegisteredSigner([...signers], candidate)).toBe(accepted);
    });
});