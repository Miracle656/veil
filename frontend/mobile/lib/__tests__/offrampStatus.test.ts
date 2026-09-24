jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

import { isFailure, isTerminal } from '../offramp';

describe('isTerminal', () => {
  it.each(['refunded', 'expired', 'cancelled', 'reversed', 'refunded (failed)', 'expired (timeout)'])(
    'treats %s as finished, so the screen stops offering to pay it',
    (status) => {
      expect(isTerminal(status)).toBe(true);
      expect(isFailure(status)).toBe(true);
    },
  );

  it.each(['settled', 'disbursed'])('treats %s as a finished success', (status) => {
    expect(isTerminal(status)).toBe(true);
    expect(isFailure(status)).toBe(false);
  });

  it.each(['initiated', 'processing: wallet worker on it..', 'processing: in bank queue'])(
    'keeps %s in flight',
    (status) => {
      expect(isTerminal(status)).toBe(false);
    },
  );
});
