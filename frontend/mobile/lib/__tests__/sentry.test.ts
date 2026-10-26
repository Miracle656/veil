/**
 * #442 — crash reporting earns its place only by staying silent: no DSN, no
 * opt-in, no traffic; and when it does report, wallet data never rides along.
 */

const mockInit = jest.fn();
const mockCaptureException = jest.fn();
const mockClose = jest.fn();

jest.mock('@sentry/react-native', () => ({
  init: (...args: unknown[]) => mockInit(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  close: (...args: unknown[]) => mockClose(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  captureMobileError,
  getSentryDsn,
  getSentryOptIn,
  initSentry,
  resetSentryInitForTesting,
  scrubEvent,
  scrubString,
  setSentryOptIn,
} from '../sentry';

const DSN = 'https://public-key@example.com/1';

// Full-length stand-ins: G + 55 base32 chars, S + 55 base32 chars. Elided
// fixtures would let a too-greedy or too-shy pattern pass.
const ADDRESS = `G${'A'.repeat(55)}`;
const SECRET = `S${'B'.repeat(55)}`;

beforeEach(async () => {
  mockInit.mockReset();
  mockCaptureException.mockReset();
  mockClose.mockReset();
  await AsyncStorage.clear();
  resetSentryInitForTesting();
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
});

it('does nothing at all without a DSN', async () => {
  expect(getSentryDsn()).toBeNull();
  expect(await initSentry()).toBe(false);
  captureMobileError(new Error('boom'));
  expect(mockInit).not.toHaveBeenCalled();
  expect(mockCaptureException).not.toHaveBeenCalled();
});

it('does nothing before the user opts in, even with a DSN', async () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;
  expect(await getSentryOptIn()).toBe(false);
  expect(await initSentry()).toBe(false);
  captureMobileError(new Error('boom'));
  expect(mockInit).not.toHaveBeenCalled();
  expect(mockCaptureException).not.toHaveBeenCalled();
});

it('initialises exactly once and reports after opt-in', async () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;

  await setSentryOptIn(true);
  expect(await getSentryOptIn()).toBe(true);
  expect(mockInit).toHaveBeenCalledTimes(1);
  expect(mockInit).toHaveBeenCalledWith(
    expect.objectContaining({
      dsn: DSN,
      tracesSampleRate: 0,
      beforeSend: expect.any(Function),
    }),
  );
  // A second launch-style call must not double-init.
  expect(await initSentry()).toBe(true);
  expect(mockInit).toHaveBeenCalledTimes(1);

  const error = new Error('boom');
  captureMobileError(error);
  expect(mockCaptureException).toHaveBeenCalledWith(error);
});

it('opt-out closes the reporter immediately, not at next launch', async () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;
  await setSentryOptIn(true);
  mockClose.mockClear();

  await setSentryOptIn(false);
  expect(await getSentryOptIn()).toBe(false);
  expect(mockClose).toHaveBeenCalledTimes(1);

  captureMobileError(new Error('boom'));
  expect(mockCaptureException).not.toHaveBeenCalled();
});

it('strips keys and amounts out of any string headed for Sentry', () => {
  const line = `tx ${SECRET} funded ${ADDRESS} with 1234.50 XLM`;
  const scrubbed = scrubString(line);
  expect(scrubbed).not.toContain(ADDRESS);
  expect(scrubbed).not.toContain(SECRET);
  expect(scrubbed).not.toContain('1234.50 XLM');
  expect(scrubbed).toContain('[address]');
  expect(scrubbed).toContain('[secret]');
  expect(scrubbed).toContain('[amount]');
});

it('scrubs every exception value and the message, and returns the event', async () => {
  // The hook lives on the init options, so reporting has to be armed first.
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;
  await setSentryOptIn(true);

  type Event = {
    message?: string;
    exception?: { values?: { value?: string }[] };
  };
  const beforeSend = (
    mockInit.mock.calls[0][0] as { beforeSend: (e: Event) => Event | null }
  ).beforeSend;

  const event: Event = {
    message: `failed for ${ADDRESS}`,
    exception: { values: [{ value: `signer ${SECRET}` }, { value: undefined }] },
  };
  const result = beforeSend(event);

  expect(result).not.toBeNull();
  expect(result?.message).not.toContain(ADDRESS);
  expect(result?.exception?.values?.[0]?.value).not.toContain(SECRET);
  // A null event drops the report entirely — also acceptable to beforeSend.
  const scrubbed = scrubEvent({
    message: `sent 5 XLM from ${ADDRESS}`,
  } as unknown as Parameters<typeof scrubEvent>[0]);
  expect(scrubbed?.message).toBe('sent [amount] from [address]');
});