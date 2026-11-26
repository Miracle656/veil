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

import type { AgentUserProfile } from './agentClient';

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

/**
 * How the agent is told to talk. `''` is a value in its own right — "Default" —
 * and the web page stores it, so the empty string has to survive a round trip
 * rather than being normalised away to "unset".
 */
export const PERSONAS: readonly { value: string; label: string; desc: string }[] = [
  { value: '', label: 'Default', desc: 'Friendly and professional' },
  { value: 'concise and direct', label: 'Concise', desc: 'Short answers, no fluff' },
  { value: 'friendly and casual', label: 'Casual', desc: 'Relaxed, conversational tone' },
  { value: 'detailed and educational', label: 'Teacher', desc: 'Explains concepts along the way' },
  { value: 'witty and fun', label: 'Fun', desc: 'Light-hearted with personality' },
];

/** A profile with every field answered — what the settings screen edits. */
export type CompleteProfile = Required<AgentUserProfile>;

/**
 * What an unanswered or fully reset profile looks like. Field for field this is
 * what the web page resets to, so a profile carried between the two clients
 * reads the same before anything has been chosen.
 */
export const DEFAULT_PROFILE: CompleteProfile = {
  name: '',
  language: 'English',
  persona: '',
  role: '',
};

/**
 * The longest name the profile will hold, counted in code points so a name
 * ending in an emoji is not measured in UTF-16 units.
 *
 * The web input carries no cap, so this is a bound the mobile side adds rather
 * than one it inherits. A name is the only free-text field in the profile and it
 * is interpolated into the agent's greeting and sent with every agent turn, so
 * it is not the place to accept an unbounded string.
 */
export const MAX_NAME_LENGTH = 64;

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

// ── Validation ──────────────────────────────────────────────────────────────────

/**
 * Drop the control characters out of a string and collapse its whitespace.
 *
 * A name is the one free-text field in the profile, and it is interpolated into
 * the agent's greeting — so a pasted "Ada\nJailed for 3000" would ride along
 * into every line the agent says, and into anything that ever prints the
 * profile, as what looks like a second record. Nothing a person legitimately
 * types into a name box is a control character, so they are removed rather
 * than escaped or rejected. The same reasoning keeps a newline out of any log
 * line the profile is ever written to.
 */
function scrub(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Cut to {@link MAX_NAME_LENGTH} without splitting an astral character in half. */
function bound(value: string): string {
  const chars = Array.from(value);
  return chars.length <= MAX_NAME_LENGTH ? value : chars.slice(0, MAX_NAME_LENGTH).join('');
}

/**
 * Clean a name to something worth storing, or `''` when there is not one.
 *
 * Anything that is not a string — a stored number, `null`, an object — is not a
 * name, and is treated as the absence of one rather than coerced into a string
 * the greeting would then read out loud.
 */
export function normaliseName(value: unknown): string {
  return typeof value === 'string' ? bound(scrub(value)) : '';
}

/** The stored role, or the unset default when it is not one the app offers. */
export function normaliseRole(value: unknown): string {
  return isAgentRole(value) ? value : DEFAULT_PROFILE.role;
}

/** The stored language, or English when it is not one the app offers. */
export function normaliseLanguage(value: unknown): string {
  return typeof value === 'string' && LANGUAGES.includes(value) ? value : DEFAULT_PROFILE.language;
}

/** The stored persona, or the Default one when it is not one the app offers. */
export function normalisePersona(value: unknown): string {
  const known = typeof value === 'string' && PERSONAS.some((p) => p.value === value);
  return known ? (value as string) : DEFAULT_PROFILE.persona;
}

/**
 * Coerce anything into a profile the settings screen can edit, answering every
 * field from the web defaults where the input is silent.
 *
 * Both clients read and write {@link PROFILE_STORAGE_KEY}, so this is the point
 * where a value one of them considers legitimate has to be accepted — including
 * one a future build adds a choice for — and anything else is refused in favour
 * of the default. Refusing, rather than passing it through, is what keeps an
 * unknown role or a language the app cannot render out of the stored profile.
 */
export function normaliseProfile(input: unknown): CompleteProfile {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  return {
    name: normaliseName(raw.name),
    language: normaliseLanguage(raw.language),
    persona: normalisePersona(raw.persona),
    role: normaliseRole(raw.role),
  };
}

/**
 * Why a name cannot be saved as typed, or `null` when it can.
 *
 * The input caps what can be typed, so this is the second line of defence for a
 * value that arrived another way — a paste on a platform where `maxLength` does
 * not bind, or a name an older web build stored with no cap at all.
 */
export function nameProblem(name: string): string | null {
  if (typeof name !== 'string' || Array.from(name).length <= MAX_NAME_LENGTH) return null;
  return `Use ${MAX_NAME_LENGTH} characters or fewer.`;
}

// ── Persistence ─────────────────────────────────────────────────────────────────

/**
 * Read the stored profile. A missing or corrupt entry yields an empty profile,
 * which the screen treats as "needs onboarding" — the same recovery the web
 * page performs, and the right one: an unreadable profile is not worth an error
 * screen when re-asking three questions fixes it.
 *
 * What comes back is validated, and fields left unanswered stay absent rather
 * than being filled in: `''` and "not set" mean the same thing to every reader
 * here, and a caller asking for the profile wants to know what was actually
 * stored. Use {@link normaliseProfile} for a full object to put in front of a
 * form.
 */
export async function loadProfile(): Promise<AgentUserProfile> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return validatedSubset(parsed as AgentUserProfile);
  } catch {
    return {};
  }
}

/**
 * Keep the fields of a stored profile that carry a value, each one validated.
 *
 * Validated on the way out as well as in, so a profile another client — or an
 * older build — wrote with an unknown role or an over-long name is repaired
 * before the agent greets the user with it, rather than being re-saved as-is.
 */
function validatedSubset(profile: AgentUserProfile): AgentUserProfile {
  const clean = normaliseProfile(profile);
  const out: AgentUserProfile = {};
  if (clean.name) out.name = clean.name;
  if (clean.role) out.role = clean.role;
  if (clean.persona) out.persona = clean.persona;
  // A stored language is always written out, even when it is the default, so
  // that reading the profile back cannot turn an answered field into a blank
  // one. English is the one value that is both a default and a real answer.
  if (clean.language !== DEFAULT_PROFILE.language || typeof profile.language === 'string') {
    out.language = clean.language;
  }
  return out;
}

/**
 * Persist the profile, merged over whatever is already stored.
 *
 * For callers that only know one field — the agent onboarding writing a name it
 * just asked for. A screen showing every field wants {@link replaceProfile},
 * which can also clear one.
 */
export async function saveProfile(profile: AgentUserProfile): Promise<AgentUserProfile> {
  const existing = await loadProfile();
  const merged = { ...existing, ...validatedSubset(profile) };
  await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Persist the whole profile, replacing what is stored, and return what was
 * written.
 *
 * This is the settings screen's save: every field is on the form, so a merge
 * would be wrong — clearing the name has to actually clear it, which a merge
 * over the stored copy cannot do. The result is validated first, so a value the
 * app does not offer cannot reach storage from here even by accident.
 */
export async function replaceProfile(profile: AgentUserProfile): Promise<CompleteProfile> {
  const clean = normaliseProfile(profile);
  await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

/**
 * Forget the stored profile entirely.
 *
 * The web page resets by removing the key rather than writing a blank profile
 * over it, and this matches that: the next reader sees no profile at all, so the
 * agent re-onboards instead of reading an empty name as an answer.
 */
export async function resetProfile(): Promise<void> {
  await AsyncStorage.removeItem(PROFILE_STORAGE_KEY);
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
