/**
 * #1200 — `/verify` is the shared destination the naira rails push to.
 *
 * Airtime's Continue sent an unverified person to this route while no screen
 * existed there. What only a screen can get wrong, and what each test below
 * defends:
 *
 *   - the params a caller passes are honoured, and success puts the person back
 *     on the flow they left with the purchase still waiting;
 *   - declined, already-verified and provider-unreachable are three answers, not
 *     one error box — they cost the user different things, and a NIN can only be
 *     spent once;
 *   - the NIN is submitted and then kept by nobody: not in storage, not in the
 *     render tree, not in a console line.
 *
 * `lib/onramp` is replaced wholesale, including its `NairaUnavailable` and
 * `NairaTimeout` classes — the screen imports those from the same mocked module,
 * so `instanceof` still means what it means in the app. The storage-facing
 * setters write into a map the tests can dump for a leaked NIN.
 */

// Synthetic sequences, same as `wallet/lib/__tests__/ngn.test.ts`: a NIN, a
// phone number and an email here are placeholders to prove where they do and do
// not go, never anyone's real details.
const NIN = '12345678901';
const DETAILS = { firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com', phone: '08031234567' };

/** Everything this screen could persist, dumped by the NIN-leak test. */
const mockStore = new Map<string, string>();

const mockEnv = {
  customerRef: 'veil_00f1a2b3c4d5e6f7',
  verifiedOnDevice: false,
  mismatch: false,
  savedDetails: null as { firstName: string; lastName: string; email: string; phone: string } | null,
  network: 'mainnet',
  provision: { customerRef: 'r', verified: false, created: true },
  kyc: { customerRef: 'r', verified: true, status: 'verified' },
  provisionError: null as Error | null,
  kycError: null as Error | null,
  /** The digits that actually left the device, as the service received them. */
  sentNin: null as string | null,
};

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockBack = jest.fn();
let mockCanGoBack = true;
let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: jest.fn(),
    back: mockBack,
    dismissTo: mockDismissTo,
    canGoBack: () => mockCanGoBack,
  }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));

jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({
    networkName: mockEnv.network,
    network: {},
    switchNetwork: jest.fn(),
    isSwitching: false,
    error: null,
  }),
}));

jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));

jest.mock('../lib/onramp', () => {
  class NairaUnavailable extends Error {}
  class NairaTimeout extends Error {}
  return {
    NairaUnavailable,
    NairaTimeout,
    getCustomerRef: jest.fn(async () => mockEnv.customerRef),
    isNairaVerified: jest.fn(async () => mockEnv.verifiedOnDevice),
    isNairaKycMismatch: jest.fn(async () => mockEnv.mismatch),
    loadVerifyDetails: jest.fn(async () => mockEnv.savedDetails),
    // Writes the four fields as the real lib does, so a leaked NIN in these
    // arguments would land in `mockStore` and be caught by the dump below.
    saveVerifyDetails: jest.fn(async (d: Record<string, string>) => {
      mockStore.set('veil_ngn_details', JSON.stringify(d));
    }),
    setNairaVerified: jest.fn(async (v: boolean) => {
      mockStore.set('veil_ngn_verified', v ? 'true' : 'false');
    }),
    setNairaKycMismatch: jest.fn(async (v: boolean) => {
      mockStore.set('veil_ngn_kyc_mismatch', v ? 'true' : 'false');
    }),
    provisionCustomer: jest.fn(async () => {
      if (mockEnv.provisionError) throw mockEnv.provisionError;
      return mockEnv.provision;
    }),
    submitKyc: jest.fn(async (_customerRef: string, nin: string) => {
      mockEnv.sentNin = nin;
      if (mockEnv.kycError) throw mockEnv.kycError;
      return mockEnv.kyc;
    }),
  };
});

import { TextInput } from 'react-native';

import VerifyScreen from '../app/verify';
import { NairaTimeout, NairaUnavailable } from '../lib/onramp';

// No @types package ships for react-test-renderer; this is the slice used here.
type Instance = {
  props: Record<string, unknown>;
  children: (Instance | string)[];
  findAll: (predicate: (node: Instance) => boolean) => Instance[];
  findAllByType: (type: unknown) => Instance[];
};
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => { root: Instance; unmount: () => void };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

// The React Native renderer is initialised inside the first test of this file,
// which the default 5s charges to it as though the screen were slow.
jest.setTimeout(60_000);

function textOf(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

async function render(params: Record<string, string> = {}) {
  mockParams = params;
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<VerifyScreen />);
  });
  return { root: tree.root, rendered: () => textOf(tree.root) };
}

/** Every field the screen is showing, in the order it draws them. */
function fields(root: Instance): Instance[] {
  return root.findAllByType(TextInput);
}

async function type(root: Instance, index: number, value: string): Promise<void> {
  const onChangeText = fields(root)[index].props['onChangeText'] as (v: string) => void;
  await renderer.act(async () => {
    onChangeText(value);
  });
}

/**
 * Press the button whose visible text contains `label`.
 *
 * A disabled Pressable is not pressed: `onPress` is fired by hand here, and the
 * real control would swallow it, so honouring `disabled` is what keeps a test
 * about a gated button honest.
 */
async function tap(root: Instance, label: string): Promise<void> {
  const matches = root.findAll(
    (node) => typeof node.props['onPress'] === 'function' && textOf(node).includes(label),
  );
  if (matches.length === 0) throw new Error(`no button containing "${label}" on screen`);
  const button = matches[0];
  if (button.props['disabled']) throw new Error(`"${label}" is disabled`);
  await renderer.act(async () => {
    (button.props['onPress'] as () => void)();
  });
}

function isDisabled(root: Instance, label: string): boolean {
  return root
    .findAll((node) => typeof node.props['onPress'] === 'function' && textOf(node).includes(label))
    .some((node) => Boolean(node.props['disabled']));
}

/** Fill the details form and move to the NIN step. */
async function toNinStep(root: Instance): Promise<void> {
  await type(root, 0, DETAILS.firstName);
  await type(root, 1, DETAILS.lastName);
  await type(root, 2, DETAILS.email);
  await type(root, 3, DETAILS.phone);
  await tap(root, 'Continue');
}

async function submitNin(root: Instance, digits: string = NIN): Promise<void> {
  const onChange = fields(root).slice(-1)[0].props['onChangeText'] as (v: string) => void;
  await renderer.act(async () => {
    onChange(digits);
  });
  await tap(root, 'Verify');
}

beforeEach(() => {
  mockStore.clear();
  Object.assign(mockEnv, {
    customerRef: 'veil_00f1a2b3c4d5e6f7',
    verifiedOnDevice: false,
    mismatch: false,
    savedDetails: null,
    network: 'mainnet',
    provision: { customerRef: 'r', verified: false, created: true },
    kyc: { customerRef: 'r', verified: true, status: 'verified' },
    provisionError: null,
    kycError: null,
    sentNin: null,
  });
  mockReplace.mockClear();
  mockDismissTo.mockClear();
  mockBack.mockClear();
  mockCanGoBack = true;
  // One module registry for the whole file: without this, a later test would
  // pass `not.toHaveBeenCalled()` only because an earlier one had not called it.
  const onramp = jest.requireMock('../lib/onramp') as Record<string, unknown>;
  for (const value of Object.values(onramp)) {
    const fn = value as { mockClear?: () => void };
    if (fn && typeof fn.mockClear === 'function') fn.mockClear();
  }
});

describe('the airtime hand-off', () => {
  it('shows what was interrupted and returns the user to it', async () => {
    const { root, rendered } = await render({
      returnTo: '/airtime',
      label: 'Airtime',
      summary: 'Airtime · ₦500 to 08031234567',
    });

    // The reason the ask exists: someone mid-purchase needs to see which
    // purchase is waiting, or verification reads as a wall rather than a step.
    expect(rendered()).toContain('Airtime · ₦500 to 08031234567');

    await toNinStep(root);
    await submitNin(root);
    await tap(root, 'Continue with Airtime');

    // The purchase is still waiting on `/airtime`, and the only way back to it
    // is the route the caller named. It is dismissed-to rather than replaced:
    // the filled-in form is on the stack underneath, and replacing would cover
    // it with a second, empty airtime screen.
    expect(mockDismissTo).toHaveBeenCalledWith('/airtime');
    expect(mockReplace).not.toHaveBeenCalledWith('/airtime');
  });

  it('does not follow a returnTo that is not an in-app path', async () => {
    // A navigation param can arrive from a deep link. Handing `//host` to the
    // navigator would leave the app instead of returning to the flow.
    const { root } = await render({ returnTo: '//evil.example/airtime' });
    await toNinStep(root);
    await submitNin(root);
    await tap(root, 'Continue');

    expect(mockDismissTo).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalledWith('//evil.example/airtime');
    expect(mockBack).toHaveBeenCalled();
  });
});

describe('verified', () => {
  it('is recorded only from the answer the service gave, then returns', async () => {
    const { root, rendered } = await render({ returnTo: '/airtime', label: 'Airtime' });
    await toNinStep(root);
    await submitNin(root);

    expect(rendered()).toContain("You're verified");
    const onramp = jest.requireMock('../lib/onramp');
    expect(onramp.setNairaVerified).toHaveBeenCalledWith(true);
    // Nothing optimistic: the flag is the only thing written, and only because
    // the service said so.
    expect(mockStore.get('veil_ngn_verified')).toBe('true');
  });

  it('does not ask a device that already passed the check', async () => {
    mockEnv.verifiedOnDevice = true;
    const { rendered } = await render({ returnTo: '/airtime', label: 'Airtime' });

    expect(rendered()).toContain("You're verified");
    // Asking again cannot work: one NIN verifies one customer, ever, so a
    // verified person re-entering their digits is met with "already used".
    const onramp = jest.requireMock('../lib/onramp');
    expect(onramp.provisionCustomer).not.toHaveBeenCalled();
    expect(onramp.submitKyc).not.toHaveBeenCalled();
  });

  it('finishes without spending the NIN when the reference is already verified', async () => {
    mockEnv.provision = { customerRef: 'r', verified: true, created: false };
    const { root, rendered } = await render({ returnTo: '/airtime' });
    await toNinStep(root);
    await submitNin(root);

    // The reference was re-bound by support: provisioning answers verified, so
    // no digits go to KYC and the one permanent number stays unspent.
    const onramp = jest.requireMock('../lib/onramp');
    expect(onramp.submitKyc).not.toHaveBeenCalled();
    expect(mockEnv.sentNin).toBeNull();
    expect(onramp.setNairaVerified).toHaveBeenCalledWith(true);
    expect(rendered()).toContain("You're verified");
  });
});

describe('the three failures say three different things', () => {
  it('declined: the number was checked and came back wrong, and nothing was used up', async () => {
    mockEnv.kycError = Object.assign(new Error('NIN verification failed'), {
      code: 'nin_verification_failed',
    });
    const { root, rendered } = await render({ returnTo: '/airtime' });
    await toNinStep(root);
    await submitNin(root);

    expect(rendered()).toContain("That NIN didn't verify");
    expect(rendered()).toContain('not been used up');
    // Not a terminal state: the same digits can be retyped and tried again.
    expect(rendered()).toContain('Try again');
    const onramp = jest.requireMock('../lib/onramp');
    expect(onramp.setNairaVerified).not.toHaveBeenCalled();
    expect(onramp.setNairaKycMismatch).not.toHaveBeenCalled();
    expect(mockEnv.sentNin).toBe(NIN);
  });

  it('already verified elsewhere: not a wrong number, and not retryable', async () => {
    mockEnv.kycError = Object.assign(new Error('NIN already used'), { code: 'nin_already_used' });
    const { root, rendered } = await render({ returnTo: '/airtime' });
    await toNinStep(root);
    await submitNin(root);

    // Telling this person to check their 11 digits is the worst answer
    // available: the digits are right and a NIN verifies exactly one account.
    expect(rendered()).toContain('already verified elsewhere');
    expect(rendered()).not.toContain('Try again');
    // The reference is what support needs, so it is shown in full.
    expect(rendered()).toContain(mockEnv.customerRef);
    const onramp = jest.requireMock('../lib/onramp');
    expect(onramp.setNairaKycMismatch).toHaveBeenCalledWith(true);
    expect(onramp.setNairaVerified).not.toHaveBeenCalled();
    expect(mockStore.get('veil_ngn_verified')).toBeUndefined();
  });

  it('provider unreachable: nothing was sent, so nothing was checked', async () => {
    mockEnv.provisionError = new NairaUnavailable('Naira rails unavailable');
    const { root, rendered } = await render({ returnTo: '/airtime' });
    await toNinStep(root);
    await submitNin(root);

    expect(rendered()).toContain('could not be reached');
    // Not the declined screen: a person whose number was never looked at must
    // not be told to compare it against their slip.
    expect(rendered()).not.toContain("That NIN didn't verify");
    expect(mockEnv.sentNin).toBeNull();
    const onramp = jest.requireMock('../lib/onramp');
    expect(onramp.setNairaVerified).not.toHaveBeenCalled();
  });

  it('a service that times out is unreachable too, not a rejection', async () => {
    mockEnv.kycError = new NairaTimeout('The service did not respond in time.');
    const { root, rendered } = await render({ returnTo: '/airtime' });
    await toNinStep(root);
    await submitNin(root);

    expect(rendered()).toContain('could not be reached');
    const onramp = jest.requireMock('../lib/onramp');
    expect(onramp.setNairaKycMismatch).not.toHaveBeenCalled();
  });

  it('details refused before the NIN was sent is not blamed on the number', async () => {
    mockEnv.provisionError = Object.assign(new Error('invalid email'), { code: 'bad_request' });
    const { root, rendered } = await render({ returnTo: '/airtime' });
    await toNinStep(root);
    await submitNin(root);

    // "Check your 11 digits" is advice about a step that never happened.
    expect(rendered()).toContain('before your NIN was sent');
    expect(rendered()).not.toContain('11 digits against your NIN slip');
    expect(mockEnv.sentNin).toBeNull();
  });
});

describe('the NIN is personal data', () => {
  it('is submitted once and left in no storage, no render and no log', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { root, rendered } = await render({ returnTo: '/airtime', label: 'Airtime' });
      await toNinStep(root);
      await submitNin(root);

      // It reached the service exactly as typed.
      expect(mockEnv.sentNin).toBe(NIN);

      // And it is nowhere else on the screen the answer lands on.
      expect(rendered()).not.toContain(NIN);

      // Nothing the device remembers carries it — the details blob, the
      // verified flag, anything else the screen wrote.
      const dump = JSON.stringify([...mockStore.entries()]);
      expect(dump).not.toContain(NIN);
      expect(dump).toContain(DETAILS.firstName);

      // The contact fields are saved by name, so a form object carrying a NIN
      // could not ride along into storage.
      const saved = jest.requireMock('../lib/onramp').saveVerifyDetails.mock.calls[0][0];
      expect(Object.keys(saved).sort()).toEqual(['email', 'firstName', 'lastName', 'phone']);

      expect(warn.mock.calls.flat().join(' ')).not.toContain(NIN);
      expect(error.mock.calls.flat().join(' ')).not.toContain(NIN);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('is empty on the retry screen, not held hot for the next attempt', async () => {
    mockEnv.kycError = Object.assign(new Error('NIN verification failed'), {
      code: 'nin_verification_failed',
    });
    const { root } = await render({ returnTo: '/airtime' });
    await toNinStep(root);
    await submitNin(root);
    await tap(root, 'Try again');

    // The digits are held only until the request is made. Coming back to the
    // field empty is what keeps them from sitting in state across screens.
    const values = fields(root).map((f) => f.props['value']);
    expect(values).toEqual(['']);
  });
});

describe('mainnet only', () => {
  it('will not spend a permanent registration from testnet', async () => {
    mockEnv.network = 'testnet';
    const { root, rendered } = await render({ returnTo: '/airtime' });
    await type(root, 0, DETAILS.firstName);
    await type(root, 1, DETAILS.lastName);
    await type(root, 2, DETAILS.email);
    await type(root, 3, DETAILS.phone);

    // The reference is derived from the wallet address, which differs per
    // network: verified on testnet, the mainnet wallet can never be verified.
    expect(rendered()).toContain('Switch to mainnet to verify');
    expect(isDisabled(root, 'Continue')).toBe(true);
    const onramp = jest.requireMock('../lib/onramp');
    expect(onramp.provisionCustomer).not.toHaveBeenCalled();
  });
});
