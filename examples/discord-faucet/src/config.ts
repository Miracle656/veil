import { Networks } from '@stellar/stellar-sdk';

export type FaucetConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  faucetSecretKey: string;
  faucetAmountXlm: string;
  cooldownSeconds: number;
  horizonUrl: string;
  networkPassphrase: string;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return value;
}

export function loadConfig(): FaucetConfig {
  const faucetAmount = readPositiveNumber('FAUCET_AMOUNT_XLM', 10);

  return {
    discordToken: requireEnv('DISCORD_TOKEN'),
    discordClientId: requireEnv('DISCORD_CLIENT_ID'),
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
    faucetSecretKey: requireEnv('FAUCET_SECRET_KEY'),
    faucetAmountXlm: faucetAmount.toFixed(7),
    cooldownSeconds: readPositiveNumber('FAUCET_COOLDOWN_SECONDS', 86_400),
    horizonUrl: process.env.HORIZON_URL?.trim() || 'https://horizon-testnet.stellar.org',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE?.trim() || Networks.TESTNET,
  };
}
