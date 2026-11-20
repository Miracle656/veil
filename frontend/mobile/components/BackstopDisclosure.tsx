import React, { useCallback, useEffect, useState } from 'react';

/**
 * First-loss capital disclosure copy required by #1301.
 *
 * Backstop depositors are protocol first-loss capital, which is materially
 * different from lending or a savings account. These three sentences must be
 * plainly stated before the first deposit:
 *   1. You are insuring this pool, and you are paid for it.
 *   2. When the pool takes a loss, your share value falls, and you cannot leave for 17 days.
 *   3. This is not a savings account and not a deposit.
 */
export const BACKSTOP_DISCLOSURE_COPY = {
  INSURING_POOL: 'You are insuring this pool, and you are paid for it.',
  LOSS_AND_QUEUE: 'When the pool takes a loss, your share value falls, and you cannot leave for 17 days.',
  NOT_SAVINGS_OR_DEPOSIT: 'This is not a savings account and not a deposit.',
  FIRST_LOSS_MECHANISM:
    "Backstop depositors are the protocol's first-loss capital. Deposits can be used to cover bad debt, reducing share value, and withdrawals are subject to a 17-day queue.",
  ACKNOWLEDGE_CHECKBOX:
    'I understand that I am providing first-loss insurance, my share value can fall, withdrawals take 17 days, and this is not a savings account or deposit.',
  TITLE: 'First-loss capital disclosure',
  BADGE: 'Higher risk',
} as const;

export interface BackstopAcknowledgement {
  poolId: string;
  timestamp: string;
}

export interface BackstopDisclosureProps {
  poolId: string;
  poolName?: string;
  onAcknowledge?: (ack: BackstopAcknowledgement) => void;
  children?: React.ReactNode | ((props: { acknowledged: boolean }) => React.ReactNode);
  style?: any;
}

// In-memory fallback for test and non-storage environments
const memoryStore = new Map<string, string>();

let secureStore: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  secureStore = require('expo-secure-store');
} catch {
  secureStore = null;
}

async function getStorageItem(key: string): Promise<string | null> {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const val = window.localStorage.getItem(key);
      if (val !== null) return val;
    } catch {
      // Local storage unavailable or blocked
    }
  }
  if (secureStore && typeof secureStore.getItemAsync === 'function') {
    try {
      const val = await secureStore.getItemAsync(key);
      if (val !== null) return val;
    } catch {
      // Secure store error
    }
  }
  return memoryStore.get(key) ?? null;
}

async function setStorageItem(key: string, value: string): Promise<void> {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(key, value);
      return;
    } catch {
      // Local storage unavailable or blocked
    }
  }
  if (secureStore && typeof secureStore.setItemAsync === 'function') {
    try {
      await secureStore.setItemAsync(key, value);
      return;
    } catch {
      // Secure store error
    }
  }
  memoryStore.set(key, value);
}

/**
 * Records a backstop acknowledgement locally with an ISO timestamp and the poolId covered.
 */
export async function recordBackstopAcknowledgement(
  poolId: string,
  timestampOverride?: string
): Promise<BackstopAcknowledgement> {
  const record: BackstopAcknowledgement = {
    poolId,
    timestamp: timestampOverride || new Date().toISOString(),
  };
  const key = `veil_backstop_ack_${poolId.toLowerCase()}`;
  await setStorageItem(key, JSON.stringify(record));
  return record;
}

/**
 * Retrieves the stored acknowledgement for a given backstop pool.
 */
export async function getBackstopAcknowledgement(
  poolId: string
): Promise<BackstopAcknowledgement | null> {
  const key = `veil_backstop_ack_${poolId.toLowerCase()}`;
  const raw = await getStorageItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.poolId === 'string' && typeof parsed.timestamp === 'string') {
      return parsed as BackstopAcknowledgement;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Checks whether an acknowledgement has already been recorded for the given backstop pool.
 */
export async function hasAcknowledgedBackstop(poolId: string): Promise<boolean> {
  const ack = await getBackstopAcknowledgement(poolId);
  return ack !== null && ack.poolId.toLowerCase() === poolId.toLowerCase() && Boolean(ack.timestamp);
}

// React Native detection: true when react-native is resolvable with View/Text components
let RN: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RN = require('react-native');
} catch {
  RN = null;
}
const hasRN = Boolean(RN && RN.View && RN.Text);

/**
 * Unified cross-platform disclosure component for backstop deposits (#1301).
 *
 * Implements the required 3 sentences, states first-loss mechanism and the 17-day queue,
 * requires local acknowledgement with timestamp before first deposit, and gates any
 * wrapped deposit action until acknowledged.
 */
export function BackstopDisclosure({
  poolId,
  poolName,
  onAcknowledge,
  children,
  style,
}: BackstopDisclosureProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    hasAcknowledgedBackstop(poolId).then((hasAck) => {
      if (!cancelled) {
        setAcknowledged(hasAck);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [poolId]);

  const handleToggle = useCallback(async () => {
    const nextState = !acknowledged;
    setAcknowledged(nextState);
    if (nextState) {
      const ack = await recordBackstopAcknowledgement(poolId);
      if (onAcknowledge) {
        onAcknowledge(ack);
      }
    }
  }, [acknowledged, onAcknowledge, poolId]);

  // If React Native is available, render with React Native primitives
  if (hasRN) {
    const defaultStyles = RN.StyleSheet.create({
      card: {
        borderWidth: 1,
        borderColor: 'rgba(255, 179, 0, 0.4)',
        backgroundColor: 'rgba(255, 179, 0, 0.05)',
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
      },
      headerRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 10,
      },
      title: {
        fontSize: 14,
        fontWeight: '700',
        color: '#ffb300',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      },
      badge: {
        fontSize: 11,
        color: '#ffb300',
        borderWidth: 1,
        borderColor: '#ffb300',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
      },
      sentence1: {
        fontSize: 14,
        fontWeight: '600',
        color: '#ffffff',
        marginBottom: 8,
        lineHeight: 20,
      },
      sentence2: {
        fontSize: 13,
        color: 'rgba(255, 255, 255, 0.85)',
        marginBottom: 8,
        lineHeight: 18,
      },
      sentence3: {
        fontSize: 13,
        fontWeight: '600',
        color: '#ffb300',
        marginBottom: 10,
        lineHeight: 18,
      },
      mechanism: {
        fontSize: 12,
        color: 'rgba(255, 255, 255, 0.65)',
        marginBottom: 14,
        lineHeight: 16,
      },
      ackRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 10,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255, 179, 0, 0.2)',
      },
      checkbox: {
        width: 22,
        height: 22,
        borderRadius: 4,
        borderWidth: 1.5,
        borderColor: '#ffb300',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
        backgroundColor: 'transparent',
      },
      checkboxOn: {
        backgroundColor: '#ffb300',
      },
      checkMark: {
        color: '#000000',
        fontSize: 13,
        fontWeight: 'bold',
      },
      ackText: {
        flex: 1,
        fontSize: 12,
        color: 'rgba(255, 255, 255, 0.9)',
        lineHeight: 16,
      },
      gatedContainer: {
        marginTop: 12,
      },
    });

    const PressableComponent = RN.Pressable || RN.TouchableOpacity;

    return React.createElement(
      RN.View,
      { testID: 'backstop-disclosure', style: [defaultStyles.card, style] },
      React.createElement(
        RN.View,
        { style: defaultStyles.headerRow },
        React.createElement(
          RN.Text,
          { testID: 'backstop-title', style: defaultStyles.title },
          poolName ? `${poolName} · ${BACKSTOP_DISCLOSURE_COPY.TITLE}` : BACKSTOP_DISCLOSURE_COPY.TITLE
        ),
        React.createElement(
          RN.Text,
          { testID: 'backstop-badge', style: defaultStyles.badge },
          BACKSTOP_DISCLOSURE_COPY.BADGE
        )
      ),
      React.createElement(
        RN.Text,
        { testID: 'backstop-sentence-insuring', style: defaultStyles.sentence1 },
        BACKSTOP_DISCLOSURE_COPY.INSURING_POOL
      ),
      React.createElement(
        RN.Text,
        { testID: 'backstop-sentence-loss', style: defaultStyles.sentence2 },
        BACKSTOP_DISCLOSURE_COPY.LOSS_AND_QUEUE
      ),
      React.createElement(
        RN.Text,
        { testID: 'backstop-sentence-not-savings', style: defaultStyles.sentence3 },
        BACKSTOP_DISCLOSURE_COPY.NOT_SAVINGS_OR_DEPOSIT
      ),
      React.createElement(
        RN.Text,
        { testID: 'backstop-mechanism', style: defaultStyles.mechanism },
        BACKSTOP_DISCLOSURE_COPY.FIRST_LOSS_MECHANISM
      ),
      React.createElement(
        PressableComponent,
        {
          accessibilityRole: 'checkbox',
          accessibilityState: { checked: acknowledged },
          accessibilityLabel: BACKSTOP_DISCLOSURE_COPY.ACKNOWLEDGE_CHECKBOX,
          testID: 'backstop-acknowledge-checkbox',
          style: defaultStyles.ackRow,
          onPress: handleToggle,
        },
        React.createElement(
          RN.View,
          {
            testID: 'backstop-checkbox-indicator',
            style: [defaultStyles.checkbox, acknowledged && defaultStyles.checkboxOn],
          },
          acknowledged
            ? React.createElement(RN.Text, { testID: 'backstop-checkbox-mark', style: defaultStyles.checkMark }, '✓')
            : null
        ),
        React.createElement(
          RN.Text,
          { testID: 'backstop-acknowledge-label', style: defaultStyles.ackText },
          BACKSTOP_DISCLOSURE_COPY.ACKNOWLEDGE_CHECKBOX
        )
      ),
      children
        ? React.createElement(
            RN.View,
            {
              testID: 'backstop-gated-content',
              pointerEvents: acknowledged ? 'auto' : 'none',
              style: [defaultStyles.gatedContainer, { opacity: acknowledged ? 1 : 0.5 }],
            },
            typeof children === 'function' ? children({ acknowledged }) : children
          )
        : null
    );
  }

  // Web DOM rendering
  return React.createElement(
    'div',
    {
      'data-testid': 'backstop-disclosure',
      id: 'backstop-disclosure',
      className: 'card backstop-disclosure',
      style: {
        border: '1px solid rgba(255, 179, 0, 0.4)',
        background: 'rgba(255, 179, 0, 0.05)',
        borderRadius: '12px',
        padding: '1.25rem',
        marginBottom: '1.5rem',
        ...style,
      },
    },
    React.createElement(
      'div',
      {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.75rem',
        },
      },
      React.createElement(
        'span',
        {
          'data-testid': 'backstop-title',
          style: {
            fontSize: '0.75rem',
            fontFamily: 'Anton, Impact, sans-serif',
            letterSpacing: '0.06em',
            color: 'var(--gold, #ffb300)',
            textTransform: 'uppercase',
          },
        },
        poolName ? `${poolName} · ${BACKSTOP_DISCLOSURE_COPY.TITLE}` : BACKSTOP_DISCLOSURE_COPY.TITLE
      ),
      React.createElement(
        'span',
        {
          'data-testid': 'backstop-badge',
          style: {
            fontSize: '0.6875rem',
            border: '1px solid var(--gold, #ffb300)',
            color: 'var(--gold, #ffb300)',
            padding: '0.15rem 0.4rem',
            borderRadius: '4px',
          },
        },
        BACKSTOP_DISCLOSURE_COPY.BADGE
      )
    ),
    React.createElement(
      'p',
      {
        'data-testid': 'backstop-sentence-insuring',
        style: {
          fontSize: '0.9375rem',
          fontWeight: 600,
          color: 'var(--off-white, #ffffff)',
          marginBottom: '0.5rem',
          lineHeight: 1.4,
        },
      },
      BACKSTOP_DISCLOSURE_COPY.INSURING_POOL
    ),
    React.createElement(
      'p',
      {
        'data-testid': 'backstop-sentence-loss',
        style: {
          fontSize: '0.8125rem',
          color: 'rgba(246, 247, 248, 0.85)',
          marginBottom: '0.5rem',
          lineHeight: 1.4,
        },
      },
      BACKSTOP_DISCLOSURE_COPY.LOSS_AND_QUEUE
    ),
    React.createElement(
      'p',
      {
        'data-testid': 'backstop-sentence-not-savings',
        style: {
          fontSize: '0.8125rem',
          fontWeight: 600,
          color: 'var(--gold, #ffb300)',
          marginBottom: '0.625rem',
          lineHeight: 1.4,
        },
      },
      BACKSTOP_DISCLOSURE_COPY.NOT_SAVINGS_OR_DEPOSIT
    ),
    React.createElement(
      'p',
      {
        'data-testid': 'backstop-mechanism',
        style: {
          fontSize: '0.75rem',
          color: 'rgba(246, 247, 248, 0.6)',
          marginBottom: '1rem',
          lineHeight: 1.4,
        },
      },
      BACKSTOP_DISCLOSURE_COPY.FIRST_LOSS_MECHANISM
    ),
    React.createElement(
      'label',
      {
        'data-testid': 'backstop-acknowledge-container',
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.75rem',
          paddingTop: '0.75rem',
          borderTop: '1px solid rgba(255, 179, 0, 0.2)',
          cursor: 'pointer',
        },
      },
      React.createElement('input', {
        type: 'checkbox',
        'data-testid': 'backstop-acknowledge-checkbox',
        id: `backstop-ack-${poolId}`,
        checked: acknowledged,
        onChange: handleToggle,
        style: {
          marginTop: '0.2rem',
          accentColor: '#ffb300',
          cursor: 'pointer',
        },
      }),
      React.createElement(
        'span',
        {
          'data-testid': 'backstop-acknowledge-label',
          style: {
            fontSize: '0.75rem',
            color: 'rgba(246, 247, 248, 0.9)',
            lineHeight: 1.4,
          },
        },
        BACKSTOP_DISCLOSURE_COPY.ACKNOWLEDGE_CHECKBOX
      )
    ),
    children
      ? React.createElement(
          'div',
          {
            'data-testid': 'backstop-gated-content',
            style: {
              marginTop: '1rem',
              opacity: acknowledged ? 1 : 0.5,
              pointerEvents: acknowledged ? 'auto' : 'none',
            },
          },
          typeof children === 'function' ? children({ acknowledged }) : children
        )
      : null
  );
}
