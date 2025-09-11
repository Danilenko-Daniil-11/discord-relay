import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { DISCORD_BOT_TOKEN, GUILD_ID } from "../config.js";
import { createControlButtons } from "./buttons.js";
import { logToDiscord } from "./channels.js"; // обязательно './' и '.js'


export const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));
bot.login(DISCORD_BOT_TOKEN);

bot.on("interactionCreate", async interaction => {
    if (!interaction.isButton()) return;
    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);

    if (!global.pendingCommands) global.pendingCommands = {};
    if (!global.pendingCommands[pcId]) global.pendingCommands[pcId] = [];
    global.pendingCommands[pcId].push(command);

    await interaction.reply({ content: `✅ Команда "${command}" отправлена ПК ${pcId}`, ephemeral: true });
});

export function createControlButtonsForPC(pcId) {
    return createControlButtons(pcId);
}
