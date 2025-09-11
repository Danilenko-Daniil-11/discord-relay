// discord/channels.js
import { ChannelType } from "discord.js";
import { bot } from "./bot.js"; // если нужен доступ к боту
import { GUILD_ID } from "../config.js"; // пример

export async function logToDiscord(msg) {
    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channels = await guild.channels.fetch();
        const logChannel = channels.find(
            c => c.type === ChannelType.GuildText && c.name === "server-logs"
        );
        if (logChannel) {
            await logChannel.send(`[${new Date().toISOString()}] ${msg}`);
        }
    } catch (e) {
        console.error("Ошибка логирования:", e);
    }
}
