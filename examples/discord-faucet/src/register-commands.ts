import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { loadConfig } from './config.js';

export const faucetCommand = new SlashCommandBuilder()
  .setName('faucet')
  .setDescription('Request 10 testnet XLM from the Veil faucet')
  .addStringOption((option) =>
    option
      .setName('account')
      .setDescription('Stellar testnet account address to fund')
      .setRequired(true),
  );

export async function registerCommands(): Promise<void> {
  const config = loadConfig();
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const commandBody = [faucetCommand.toJSON()];

  if (config.discordGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
      { body: commandBody },
    );
    console.log(`Registered /faucet for guild ${config.discordGuildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), { body: commandBody });
  console.log('Registered global /faucet command');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  registerCommands().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
