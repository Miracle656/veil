/**
 * Linking this wallet to a Discord account, to get roles in the Veil server.
 *
 * Pasting an address into Discord would prove nothing, since every address is
 * public. So the member asks the bot for a short code, and this phone signs
 * one statement with the wallet's own keys: the passkey for the smart wallet
 * and the spending key for the spending account. The backend checks the
 * signatures and tells Discord which roles to give.
 *
 * WHAT THE PASSKEY SIGNS. The same passkey authorises payments, by signing a
 * 32-byte hash the wallet contract checks. So this file never signs a value
 * the server hands over. The text is built here, by {@link linkStatement},
 * from a fixed label and fields the screen has already shown the user, and it
 * is its SHA-256 that gets signed. A hash that starts from that label cannot
 * also be the hash of a transaction, whatever the server says.
 *
 * Nothing is sent on chain and nothing is spent. The backend keeps the pairing
 * of Discord account and addresses to itself; no route returns it.
 */

import { Buffer } from 'buffer';

import { hash, Keypair } from '@stellar/stellar-sdk';

import { getNetworkName } from './network';
import { getOwnAddresses } from './ownAddresses';
import { loadOwnedNames } from './ownedNames';
import { signPayloadWithPasskey } from './passkey';
import { getSignerSecret } from './walletStore';

/** Read when used, not when loaded, so a missing value is one clear error. */
function baseUrl(): string {
  return process.env['EXPO_PUBLIC_WRAITH_URL']?.replace(/\/+$/, '') ?? '';
}
const TIMEOUT_MS = 30_000;

/** Letters and digits that cannot be mistaken for each other when typed. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** Read a code the way a person types it: any case, spaces, a dash. */
export function normalizeLinkCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.toUpperCase().replace(/[\s-]/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  return [...cleaned].every((char) => CODE_ALPHABET.includes(char)) ? cleaned : null;
}

/** `ABCD2345` as `ABCD-2345`, the way the bot shows it. */
export function formatLinkCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface LinkStatementFields {
  code: string;
  discordUserId: string;
  wallet: string | null;
  spending: string | null;
}

/**
 * The exact text that is hashed and signed. The backend builds the same
 * string (`wraith/src/discord/proof.ts`); a change to either is a change to
 * both, and needs a new version label.
 */
export function linkStatement(fields: LinkStatementFields): string {
  return [
    'veil-discord-link:v1',
    `code=${fields.code}`,
    `discord=${fields.discordUserId}`,
    `wallet=${fields.wallet ?? ''}`,
    `spending=${fields.spending ?? ''}`,
  ].join('\n');
}

export function linkChallenge(fields: LinkStatementFields): Uint8Array {
  return new Uint8Array(hash(Buffer.from(linkStatement(fields), 'utf8')));
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A failure the screen can explain. `code` is the backend's, when it gave one. */
export class DiscordLinkError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DiscordLinkError';
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const base = baseUrl();
  if (!base) {
    throw new DiscordLinkError('Discord linking is not available in this build.', 'not_configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new DiscordLinkError('Could not reach Veil. Check your connection and try again.', 'network');
  } finally {
    clearTimeout(timer);
  }
  const body = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  if (!response.ok) {
    const message =
      typeof body?.error === 'string' && body.error
        ? body.error
        : 'Something went wrong. Nothing was linked.';
    throw new DiscordLinkError(message, typeof body?.code === 'string' ? body.code : `http_${response.status}`);
  }
  return body as T;
}

export interface LinkCodeInfo {
  code: string;
  discordUserId: string;
  discordUsername: string;
}

/** Ask the backend whose code this is, so the user can see it before signing. */
export async function lookUpLinkCode(code: string): Promise<LinkCodeInfo> {
  const info = await call<{ discordUserId?: unknown; discordUsername?: unknown }>(
    `/discord/link/${encodeURIComponent(code)}`,
  );
  if (typeof info.discordUserId !== 'string' || !/^\d{5,25}$/.test(info.discordUserId)) {
    throw new DiscordLinkError('That code could not be read. Get a new one in Discord.', 'bad_response');
  }
  return {
    code,
    discordUserId: info.discordUserId,
    discordUsername: typeof info.discordUsername === 'string' ? info.discordUsername : 'your account',
  };
}

export interface LinkResult {
  roles: string[];
  /** True when a check could not be finished; it will be tried again. */
  incomplete: boolean;
  /** False when this Discord account is not in the Veil server. */
  inServer: boolean;
}

/** What this phone can link, for the screen to show before anything is signed. */
export interface LinkableAccounts {
  /** The smart wallet, when this is a passkey wallet. */
  wallet: string | null;
  /** The spending account. */
  spending: string | null;
}

export async function getLinkableAccounts(): Promise<LinkableAccounts> {
  const own = await getOwnAddresses();
  return {
    // A classic wallet stores its G address as "the wallet"; only a contract
    // address is a smart wallet, and only that is signed for by a passkey.
    wallet: own.wallet?.startsWith('C') ? own.wallet : null,
    spending: own.spending,
  };
}

/** Linking describes the real network. A testnet wallet has nothing to show. */
export function canLinkOnThisNetwork(): boolean {
  return getNetworkName() === 'mainnet';
}

/**
 * Sign the statement with every key this phone has for the wallet and send
 * the proof. One fingerprint prompt for a passkey wallet; none for a classic
 * one. Throws a {@link DiscordLinkError} or the passkey's own ceremony error.
 */
export async function linkDiscord(info: LinkCodeInfo, accounts: LinkableAccounts): Promise<LinkResult> {
  if (!accounts.wallet && !accounts.spending) {
    throw new DiscordLinkError('There is no wallet on this phone to link.', 'no_wallet');
  }
  const challenge = linkChallenge({
    code: info.code,
    discordUserId: info.discordUserId,
    wallet: accounts.wallet,
    spending: accounts.spending,
  });

  let spendingSignature: string | undefined;
  if (accounts.spending) {
    const secret = await getSignerSecret();
    const keypair = secret ? Keypair.fromSecret(secret) : null;
    if (!keypair || keypair.publicKey() !== accounts.spending) {
      throw new DiscordLinkError('The spending key on this phone could not be read.', 'no_spending_key');
    }
    spendingSignature = base64Url(new Uint8Array(keypair.sign(Buffer.from(challenge))));
  }

  let passkey: Record<string, string> | undefined;
  if (accounts.wallet) {
    const assertion = await signPayloadWithPasskey(challenge);
    if (!assertion) throw new DiscordLinkError('The passkey did not sign. Nothing was linked.', 'no_signature');
    passkey = {
      publicKey: base64Url(assertion.publicKey),
      authData: base64Url(assertion.authData),
      clientDataJSON: base64Url(assertion.clientDataJSON),
      signature: base64Url(assertion.signature),
    };
  }

  // Names are only hints: the backend asks the registry about each one. A
  // failure to list them must not stop the link.
  const names = await loadOwnedNames({ wallet: accounts.wallet, spending: accounts.spending })
    .then((owned) => owned.names.map((entry) => entry.name))
    .catch(() => [] as string[]);

  const result = await call<{ roles?: unknown; incomplete?: unknown; inServer?: unknown }>('/discord/link', {
    method: 'POST',
    body: {
      code: info.code,
      wallet: accounts.wallet,
      spending: accounts.spending,
      passkey,
      spendingSignature,
      names,
    },
  });
  return {
    roles: Array.isArray(result.roles) ? result.roles.filter((role): role is string => typeof role === 'string') : [],
    incomplete: result.incomplete === true,
    inServer: result.inServer !== false,
  };
}
