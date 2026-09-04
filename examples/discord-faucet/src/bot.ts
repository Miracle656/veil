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
const lastClaimByUser = new Map<string, number>();

function getRetryTimestamp(userId: string): number | undefined {
  const lastClaimedAt = lastClaimByUser.get(userId);
  if (!lastClaimedAt) return undefined;

  const retryAt = lastClaimedAt + config.cooldownSeconds * 1000;
  return retryAt > Date.now() ? retryAt : undefined;
}

async function handleFaucetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const retryAt = getRetryTimestamp(interaction.user.id);
  if (retryAt) {
    await interaction.reply({
      content: `You can request faucet funds again <t:${Math.ceil(retryAt / 1000)}:R>.`,
      ephemeral: true,
    });
    return;
  }

  const destination = interaction.options.getString('account', true);

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

    lastClaimByUser.set(interaction.user.id, Date.now());
    await interaction.editReply(
      `Sent ${config.faucetAmountXlm} testnet XLM to \`${destination}\`.\n${result.explorerUrl}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown faucet error';
    await interaction.editReply(`Faucet request failed: ${message}`);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord faucet logged in as ${readyClient.user.tag}`);
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
