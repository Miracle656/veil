import { maybeRegisterForPush, resetPushRegistrationForTests } from '../usePushRegistration';
import type { PushRegistrationResult } from '../../lib/pushToken';

jest.mock('expo-notifications', () => ({
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('expo-router', () => ({ useSegments: jest.fn(() => []) }));

function deps(
  result: PushRegistrationResult = { status: 'registered', token: 'ExponentPushToken[x]' },
  address: string | null = 'CWALLET',
) {
  return {
    walletAddress: jest.fn(async () => address),
    register: jest.fn(async () => result),
    watch: jest.fn(() => jest.fn()),
  };
}

describe('maybeRegisterForPush', () => {
  beforeEach(() => resetPushRegistrationForTests());

  it('does not ask for permission before the user reaches the app (onboarding)', async () => {
    const d = deps();

    await maybeRegisterForPush(false, d);

    expect(d.walletAddress).not.toHaveBeenCalled();
    expect(d.register).not.toHaveBeenCalled();
  });

  it('does not ask until a wallet exists', async () => {
    const d = deps(undefined, null);

    await maybeRegisterForPush(true, d);

    expect(d.register).not.toHaveBeenCalled();
  });

  it('registers once a wallet exists, and watches for token rotation', async () => {
    const d = deps();

    await maybeRegisterForPush(true, d);

    expect(d.register).toHaveBeenCalledTimes(1);
    expect(d.watch).toHaveBeenCalledTimes(1);
  });

  it('tries once per app session, not on every tab change', async () => {
    const d = deps();

    await maybeRegisterForPush(true, d);
    await maybeRegisterForPush(true, d);

    expect(d.register).toHaveBeenCalledTimes(1);
    expect(d.watch).toHaveBeenCalledTimes(1);
  });

  it.each([['denied'], ['unsupported'], ['no-project-id']] as const)(
    'does not watch for rotation after %s, since there is nothing to re-register',
    async (status) => {
      const d = deps({ status } as PushRegistrationResult);

      await maybeRegisterForPush(true, d);

      expect(d.watch).not.toHaveBeenCalled();
    },
  );
});
