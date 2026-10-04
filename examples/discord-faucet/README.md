# Discord Faucet Example

> [!WARNING]
> **Demonstration only — not production-safe**: Faucet cooldowns and rate-limit caps are stored in-memory (`Map` and array) without persistent storage, meaning all rate limits and caps reset whenever the bot process restarts. A single malicious user running multiple accounts can drain funds if the bot restarts frequently. Production faucets must persist claims in a durable database (e.g. Redis, PostgreSQL), enforce global budget caps, and use anti-sybil protections.

This example registers a Discord `/faucet` slash command that sends 10 testnet
XLM to a Stellar account. It uses `discord.js` for the bot, `@stellar/stellar-sdk`
for transaction submission, and `invisible-wallet-sdk` for destination
validation.

## Setup

1. Install dependencies from this directory:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in the values:

   ```bash
   cp .env.example .env
   ```

3. Fund the account behind `FAUCET_SECRET_KEY` on Stellar testnet. You can use
   Friendbot or another testnet funding source.

4. Register the slash command:

   ```bash
   npm run register-commands
   ```

   Set `DISCORD_GUILD_ID` for fast guild-scoped registration during development.
   Leave it empty to register the command globally.

5. Start the bot:

   ```bash
   npm run dev
   ```

## Usage

In Discord, run:

```text
/faucet account:G...
```

Each Discord user can claim once per cooldown window. The default cooldown is
24 hours and can be changed with `FAUCET_COOLDOWN_SECONDS`.

The faucet also enforces:
- **Per-destination cooldown**: A destination account can only receive funds once per cooldown window (configurable with `FAUCET_DESTINATION_COOLDOWN_SECONDS`, default 24h).
- **Global cap**: Maximum total claims allowed across all users within the window (configurable with `FAUCET_GLOBAL_CAP`, default 100).

The example keeps rate limits in memory for clarity. Production faucets should
store claims in a durable database and add abuse controls such as per-account,
per-server, and IP-based limits.
