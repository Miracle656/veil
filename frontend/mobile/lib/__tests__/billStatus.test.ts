import { classifyBillStatus } from '../onramp';

describe('classifyBillStatus', () => {
  describe('terminal success (acceptance criteria: real status value)', () => {
    it('drives real provider status value "completed" to done state', () => {
      expect(classifyBillStatus('completed')).toBe('done');
    });

    it('handles real provider status with different casing or whitespace', () => {
      expect(classifyBillStatus('Completed')).toBe('done');
      expect(classifyBillStatus('  completed  ')).toBe('done');
      expect(classifyBillStatus('COMPLETED')).toBe('done');
    });

    it('recognizes delivered, complete, and success variants', () => {
      expect(classifyBillStatus('complete')).toBe('done');
      expect(classifyBillStatus('completed-api')).toBe('done');
      expect(classifyBillStatus('delivered')).toBe('done');
      expect(classifyBillStatus('success')).toBe('done');
    });
  });

  describe('terminal failures', () => {
    it.each(['failed', 'refunded', 'reversed', 'cancelled', 'FAILED', 'refund'])(
      'classifies %s as terminal failure',
      (status) => {
        expect(classifyBillStatus(status)).toBe('failed');
      },
    );
  });

  describe('in-flight statuses', () => {
    it.each(['pending', 'processing', 'queued', 'initiated', 'on-hold'])(
      'keeps %s as pending so caller continues to poll',
      (status) => {
        expect(classifyBillStatus(status)).toBe('pending');
      },
    );

    it('defaults unknown/unrecognized statuses to pending so we requery rather than falsely failing', () => {
      expect(classifyBillStatus('awaiting_carrier')).toBe('pending');
      expect(classifyBillStatus('transmitting')).toBe('pending');
      expect(classifyBillStatus('unknown_status_code')).toBe('pending');
    });
  });
});
