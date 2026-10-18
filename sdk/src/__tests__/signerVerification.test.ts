import { recoverWalletByAddress, WalletContractNotFoundError } from '../recovery/signerVerification';
import { ADDRESS_RECOVERY_CASES } from '../../tests/fixtures/addressRecoveryCases';

const REGISTERED = '04' + '11'.repeat(64);
const UNREGISTERED = '04' + '22'.repeat(64);

describe('shared address recovery sequence', () => {
    it.each(ADDRESS_RECOVERY_CASES)('$name', async (testCase) => {
        const resolveSigners = jest.fn(async () => {
            if (testCase.resolution === 'not-found') {
                throw new WalletContractNotFoundError(testCase.address);
            }
            if (testCase.resolution === 'network-error') throw new Error('RPC unavailable');
            return testCase.resolution === 'empty' ? [] : [REGISTERED];
        });
        const authenticate = jest.fn(async () => testCase.authentication === 'registered' ? REGISTERED : UNREGISTERED);

        if (testCase.expected === 'accepted') {
            await expect(recoverWalletByAddress(testCase.address, { resolveSigners, authenticate })).resolves.toMatchObject({
                address: testCase.address,
                publicKey: REGISTERED,
            });
        } else {
            await expect(recoverWalletByAddress(testCase.address, { resolveSigners, authenticate }))
                .rejects.toMatchObject({ name: testCase.expected });
        }
        expect(resolveSigners).toHaveBeenCalledTimes(testCase.expected === 'InvalidWalletAddressError' ? 0 : 1);
    });
});