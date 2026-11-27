/**
 * Which KYC replies mean "stop" and which mean "carry on".
 *
 * Linq allows one verified customer per NIN, forever. So "this NIN has already
 * been used" is the expected reply for someone who verified before and lost
 * local state — a reinstall, cleared storage, a network switch — and it is NOT
 * a rejection. Telling that person to check their eleven digits is the worst
 * answer available, because the digits are right and the one NIN that would
 * verify them is the one being refused. There is no self-service way out.
 *
 * A name mismatch is the opposite: a real rejection, fixable by the person
 * reading it, and worth sending them back to the name screen for.
 *
 * The screen matches on the message text, so the patterns are pinned here.
 */

/** Mirrors the test in `app/verify.tsx`. Keep the two in step. */
const ALREADY_VERIFIED = /already|duplicate|exists|in use|verified/i;

describe('KYC replies that mean "already verified, carry on"', () => {
  const carryOn = [
    'This NIN has already been used for verification',
    'NIN already in use',
    'Customer already exists',
    'duplicate NIN',
    'This identity is already verified',
  ];

  it.each(carryOn)('treats %p as already verified', (message) => {
    expect(ALREADY_VERIFIED.test(message)).toBe(true);
  });
});

describe('KYC replies that are real rejections', () => {
  const rejections = [
    'NIN does not match the name provided',
    'Invalid NIN',
    'NIN not found',
    'Verification failed',
  ];

  it.each(rejections)('treats %p as a rejection', (message) => {
    // These send the user back to fix something. If one of them started
    // matching the pattern above, a genuinely unverified person would be waved
    // through to the amount screen and meet "has not completed KYC" at the
    // moment they expected to pay.
    expect(ALREADY_VERIFIED.test(message)).toBe(false);
  });
});
