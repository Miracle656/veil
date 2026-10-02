import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
} from 'discord.js';
import { loadConfig } from './config.js';
import { sendFaucetPayment } from './faucet.js';

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// In-memory rate-limiting state (demonstration only)
const lastClaimByUser = new Map<string, number>();
const lastClaimByDestination = new Map<string, number>();
const globalClaimTimestamps: number[] = [];

function getUserRetryTimestamp(userId: string): number | undefined {
  const lastClaimedAt = lastClaimByUser.get(userId);
  if (!lastClaimedAt) return undefined;

  const retryAt = lastClaimedAt + config.cooldownSeconds * 1000;
  return retryAt > Date.now() ? retryAt : undefined;
}

function getDestinationRetryTimestamp(destination: string): number | undefined {
  const lastClaimedAt = lastClaimByDestination.get(destination);
  if (!lastClaimedAt) return undefined;

  const retryAt = lastClaimedAt + config.destinationCooldownSeconds * 1000;
  return retryAt > Date.now() ? retryAt : undefined;
}

function isGlobalCapReached(): boolean {
  const windowStart = Date.now() - config.cooldownSeconds * 1000;
  while (globalClaimTimestamps.length > 0 && globalClaimTimestamps[0] < windowStart) {
    globalClaimTimestamps.shift();
  }
  return globalClaimTimestamps.length >= config.globalCap;
}

async function handleFaucetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const userRetryAt = getUserRetryTimestamp(interaction.user.id);
  if (userRetryAt) {
    await interaction.reply({
      content: `You can request faucet funds again <t:${Math.ceil(userRetryAt / 1000)}:R>.`,
      ephemeral: true,
    });
    return;
  }

  if (isGlobalCapReached()) {
    await interaction.reply({
      content: `The faucet has reached its global limit (${config.globalCap} claims per window). Please try again later.`,
      ephemeral: true,
    });
    return;
  }

  const destination = interaction.options.getString('account', true).trim();
  const destRetryAt = getDestinationRetryTimestamp(destination);
  if (destRetryAt) {
    await interaction.reply({
      content: `Destination \`${destination}\` already received faucet funds recently. It can receive funds again <t:${Math.ceil(destRetryAt / 1000)}:R>.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await sendFaucetPayment({
      faucetSecretKey: config.faucetSecretKey,
      destination,
      amountXlm: config.faucetAmountXlm,
      horizonUrl: config.horizonUrl,
      networkPassphrase: config.networkPassphrase,
      memo: `discord:${interaction.user.id}`,
    });

    const now = Date.now();
    lastClaimByUser.set(interaction.user.id, now);
    lastClaimByDestination.set(destination, now);
    globalClaimTimestamps.push(now);

    await interaction.editReply(
      `Sent ${config.faucetAmountXlm} testnet XLM to \`${destination}\`.\n${result.explorerUrl}\n\n*⚠️ Demo faucet: in-memory cooldowns and caps only.*`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown faucet error';
    await interaction.editReply(`Faucet request failed: ${message}`);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord faucet logged in as ${readyClient.user.tag}`);
  console.warn(
    '⚠️ Demonstration only — not production-safe: Cooldowns and caps are stored in-memory and reset on restart.',
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'faucet') return;

  try {
    await handleFaucetCommand(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('Faucet request failed unexpectedly.');
      return;
    }

    await interaction.reply({
      content: 'Faucet request failed unexpectedly.',
      ephemeral: true,
    });
  }
});

client.login(config.discordToken).catch((error) => {
  console.error(error);
  process.exit(1);
});
