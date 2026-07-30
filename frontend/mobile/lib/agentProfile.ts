/**
 * The agent's memory of who it is talking to.
 *
 * Port of the profile, greeting, and suggestion logic embedded in the web
 * wallet's `app/agent/page.tsx`. The web page reads and writes `localStorage`
 * synchronously inside render; React Native's AsyncStorage is a promise, so the
 * reads are async here and the screen loads the profile in an effect.
 *
 * The storage keys match the web wallet's exactly, so a user who set themselves
 * up in the browser and then restores onto a phone keeps the same agent
 * persona rather than being asked to introduce themselves twice.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AgentUserProfile } from './agentSocket';

export type { AgentUserProfile };

/** AsyncStorage key holding the user's agent profile. Shared with the web wallet. */
export const PROFILE_STORAGE_KEY = 'veil_user_profile';

/** AsyncStorage key holding a one-shot "you received funds" prompt, consumed on read. */
export const NOTIFICATION_STORAGE_KEY = 'veil_agent_notification';

/** How the user describes their own wallet use. Drives the greeting and the suggestion chips. */
export type AgentRole = 'trader' | 'investor' | 'saver' | 'explorer';

export const ROLES: readonly { value: AgentRole; label: string; desc: string }[] = [
  { value: 'trader', label: 'Trader', desc: 'I actively swap and trade assets' },
  { value: 'investor', label: 'Investor', desc: 'I hold long-term and look for yield' },
  { value: 'saver', label: 'Saver', desc: 'I save and send money to people' },
  { value: 'explorer', label: 'Explorer', desc: "I'm new and want to learn" },
];

export const LANGUAGES: readonly string[] = [
  'English', 'Spanish', 'French', 'Portuguese', 'Chinese', 'Japanese',
  'Korean', 'Arabic', 'Hindi', 'Russian', 'German', 'Turkish', 'Yoruba', 'Igbo', 'Swahili',
];

const ROLE_SUGGESTIONS: Record<AgentRole, readonly string[]> = {
  trader: ["What's my balance?", 'Best XLM/USDC rate?', 'Swap 100 XLM to USDC', 'Show recent trades'],
  investor: ["What's my balance?", 'Best XLM/USDC rate?', 'Show my portfolio', 'Any yield opportunities?'],
  saver: ["What's my balance?", 'Send 50 XLM', 'Show recent transfers', 'Who sent me XLM?'],
  explorer: ["What's my balance?", 'How do swaps work?', 'What can you do?', 'Show recent transfers'],
};

const DEFAULT_SUGGESTIONS: readonly string[] = [
  "What's my balance?",
  'Swap 100 XLM to USDC',
  'Show recent transfers',
  'Best XLM/USDC rate?',
];

/** Narrow an arbitrary value to a known role. */
export function isAgentRole(value: unknown): value is AgentRole {
  return ROLES.some((role) => role.value === value);
}

/** The suggestion chips for a profile, falling back to the generic set. */
export function suggestionsFor(profile: AgentUserProfile): readonly string[] {
  return isAgentRole(profile.role) ? ROLE_SUGGESTIONS[profile.role] : DEFAULT_SUGGESTIONS;
}

/**
 * The agent's opening line.
 *
 * A pending notification wins outright: something happened to the user's money
 * while they were away, and that is more useful than a greeting.
 */
export function buildGreeting(profile: AgentUserProfile, notification?: string | null): string {
  if (notification) return notification;

  const name = profile.name ? `, ${profile.name}` : '';

  switch (profile.role) {
    case 'trader':
      return `Hey${name}! Ready to trade? I can check live prices, find the best swap routes, and execute trades — all with your approval.`;
    case 'investor':
      return `Hey${name}! I can help you check your portfolio, find the best rates, and manage your positions. What would you like to review?`;
    case 'saver':
      return `Hey${name}! Need to send or check on funds? I can show your balance, recent transfers, and help you send payments securely.`;
    case 'explorer':
      return `Hey${name}! Welcome to Veil. I can help you check balances, explore prices, make swaps, and send payments. Ask me anything!`;
    default:
      return `Hey${name}! I'm your Veil agent. I can check prices, view transfer history, and execute swaps — all with your approval. What would you like to do?`;
  }
}

/** Shape of the stored incoming-funds notification. Every field is optional — it is written by another screen. */
export type AgentNotification = {
  amount?: string | number;
  asset?: string;
  from?: string;
};

/** Role-flavoured phrasing of "you received funds while you were away". */
export function buildNotificationMessage(
  profile: AgentUserProfile,
  notification: AgentNotification
): string {
  const name = profile.name ? `, ${profile.name}` : '';
  const amount = notification.amount ?? '?';
  const asset = notification.asset ?? 'XLM';
  const from = notification.from
    ? `${notification.from.slice(0, 6)}…${notification.from.slice(-6)}`
    : 'someone';

  switch (profile.role) {
    case 'trader':
      return `Hey${name}! You just received **${amount} ${asset}** from ${from}. Want to check the current rates and make a trade?`;
    case 'investor':
      return `Hey${name}! **${amount} ${asset}** just landed in your wallet from ${from}. Would you like to explore yield opportunities or check market prices?`;
    case 'saver':
      return `Hey${name}! You received **${amount} ${asset}** from ${from}. Your updated balance is ready — want to see it?`;
    case 'explorer':
      return `Hey${name}! Good news — you just received **${amount} ${asset}** from ${from}. Want me to explain what you can do with it?`;
    default:
      return `Hey${name}! You received **${amount} ${asset}** from ${from}. What would you like to do?`;
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────────

/**
 * Read the stored profile. A missing or corrupt entry yields an empty profile,
 * which the screen treats as "needs onboarding" — the same recovery the web
 * page performs, and the right one: an unreadable profile is not worth an error
 * screen when re-asking three questions fixes it.
 */
export async function loadProfile(): Promise<AgentUserProfile> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as AgentUserProfile;
  } catch {
    return {};
  }
}

/** Persist the profile, merged over whatever is already stored. */
export async function saveProfile(profile: AgentUserProfile): Promise<AgentUserProfile> {
  const existing = await loadProfile();
  const merged = { ...existing, ...profile };
  await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Read and clear the pending incoming-funds notification.
 *
 * Consumed on read so it is announced once. If it survived a read it would
 * greet the user with the same stale news on every visit.
 */
export async function consumeNotification(profile: AgentUserProfile): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (!raw) return null;
    await AsyncStorage.removeItem(NOTIFICATION_STORAGE_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return buildNotificationMessage(profile, parsed as AgentNotification);
  } catch {
    return null;
  }
}
