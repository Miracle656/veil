/**
 * Component tests for the Blend backstop withdrawal queue presentation.
 *
 * Verifies:
 *  - Pre-deposit exit terms state the 17-day protocol rule before confirmation
 *  - Queued state shows an absolute date (not a day count), emissions-stopped
 *    and pool-interest-continues facts, and a one-action reversible cancel
 *  - Matured state shows ready status, absolute date, Withdraw CTA, and
 *    reversible put-back action
 */

import { BackstopExitTerms, BackstopWithdrawalCard } from '../BackstopQueue';
import type { BackstopQueuedWithdrawal } from '../../lib/blendBackstop';

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void>;
  create: (el: unknown) => {
    root: {
      findByProps: (p: object) => Instance;
      findAllByProps: (p: object) => Instance[];
    };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

const NOV_2_2026 = Math.floor(Date.UTC(2026, 10, 2, 12, 0, 0) / 1_000);
const NOV_19_2026 = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1_000);

const SAMPLE_WITHDRAWAL: BackstopQueuedWithdrawal = {
  id: 'CPOOL1:1795089600:0',
  poolId: 'CPOOL1',
  poolName: 'Fixed',
  backstopId: 'CBACKSTOP1',
  shares: '1000000000',
  tokens: '1250000000',
  availableAt: NOV_19_2026,
};

jest.setTimeout(60_000);

describe('BackstopExitTerms', () => {
  it('states the 17-day protocol queue and bad-debt purpose before deposit confirmation', async () => {
    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(() => {
      tree = renderer.create(<BackstopExitTerms />);
    });

    const summary = text(tree.root.findByProps({ testID: 'backstop-exit-terms-summary' }));
    const detail = text(tree.root.findByProps({ testID: 'backstop-exit-terms-detail' }));

    expect(summary).toContain('17 days');
    expect(summary).toContain('Blend protocol');
    expect(summary).toContain('not a Veil policy');
    expect(summary.toLowerCase()).toContain('bad debt');
    expect(summary.toLowerCase()).not.toContain('locked savings');
    expect(detail.toLowerCase()).toContain('emissions stop');
    expect(detail.toLowerCase()).toContain('pool interest continues');
  });
});

describe('BackstopWithdrawalCard', () => {
  it('renders the queued state with an absolute date, both facts, and one-action cancellation', async () => {
    const onCancel = jest.fn();
    const onWithdraw = jest.fn();

    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(() => {
      tree = renderer.create(
        <BackstopWithdrawalCard
          withdrawal={SAMPLE_WITHDRAWAL}
          nowSeconds={NOV_2_2026}
          onCancel={onCancel}
          onWithdraw={onWithdraw}
        />,
      );
    });

    const dateText = text(tree.root.findByProps({ testID: 'backstop-available-date' }));
    expect(dateText).toBe('Available 19 November');
    expect(dateText.toLowerCase()).not.toContain('days remaining');

    const emissionsFact = text(tree.root.findByProps({ testID: 'backstop-fact-emissions' }));
    const interestFact = text(tree.root.findByProps({ testID: 'backstop-fact-interest' }));
    expect(emissionsFact.toLowerCase()).toContain('emissions stopped');
    expect(interestFact.toLowerCase()).toContain('pool interest continues');

    // No claim button while still queued.
    expect(tree.root.findAllByProps({ testID: 'backstop-withdraw-button' })).toHaveLength(0);

    // One-action reversible cancel.
    const cancelBtn = tree.root.findByProps({ testID: 'backstop-cancel-button' });
    const helper = text(tree.root.findByProps({ testID: 'backstop-cancel-helper' }));
    expect(helper.toLowerCase()).toContain('emissions resume');

    await renderer.act(() => {
      (cancelBtn.props.onPress as () => void)();
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith(SAMPLE_WITHDRAWAL);
    expect(onWithdraw).not.toHaveBeenCalled();
  });

  it('renders the matured state with Withdraw as primary action and allows putting back', async () => {
    const onCancel = jest.fn();
    const onWithdraw = jest.fn();

    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(() => {
      tree = renderer.create(
        <BackstopWithdrawalCard
          withdrawal={SAMPLE_WITHDRAWAL}
          nowSeconds={NOV_19_2026 + 60}
          onCancel={onCancel}
          onWithdraw={onWithdraw}
        />,
      );
    });

    expect(text(tree.root.findByProps({ testID: 'backstop-status-label' }))).toBe('Ready to withdraw');
    expect(text(tree.root.findByProps({ testID: 'backstop-available-date' }))).toBe(
      'Available since 19 November',
    );

    const withdrawBtn = tree.root.findByProps({ testID: 'backstop-withdraw-button' });
    await renderer.act(() => {
      (withdrawBtn.props.onPress as () => void)();
    });
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    expect(onWithdraw).toHaveBeenCalledWith(SAMPLE_WITHDRAWAL);

    const cancelBtn = tree.root.findByProps({ testID: 'backstop-cancel-button' });
    await renderer.act(() => {
      (cancelBtn.props.onPress as () => void)();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith(SAMPLE_WITHDRAWAL);
  });
});
