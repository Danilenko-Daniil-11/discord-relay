import { ChannelType } from "discord.js";
import { bot } from "./bot.js";
import { GUILD_ID, LOG_CHANNEL, LOG_CATEGORY } from "../config.js";
import { logToFile } from "../utils/logger.js";

const categoryCache = new Map();
let logChannelCache = null;

export async function getOrCreateCategory(guild, name) {
    const gid = guild.id;
    if (!categoryCache.has(gid)) categoryCache.set(gid, {});
    const cache = categoryCache.get(gid);
    if (cache[name]) return cache[name];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c => c.type === ChannelType.GuildCategory && c.name === name);
    if (matches.size >= 1) { cache[name] = matches.first(); return matches.first(); }

    const created = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    cache[name] = created;
    return created;
}

export async function getOrCreateLogChannel(guild) {
    if (logChannelCache) return logChannelCache;
    const category = await getOrCreateCategory(guild, LOG_CATEGORY);

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c => c.type === ChannelType.GuildText && c.name === LOG_CHANNEL && c.parentId === category.id);
    if (matches.size > 0) { logChannelCache = matches.first(); return matches.first(); }

    const created = await guild.channels.create({ name: LOG_CHANNEL, type: ChannelType.GuildText, parent: category.id });
    logChannelCache = created;
    return created;
}

export async function logToDiscord(msg) {
    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channel = await getOrCreateLogChannel(guild);
        await channel.send(`[${new Date().toISOString()}] ${msg}`);
    } catch (e) { await logToFile(`Ошибка логирования: ${e}`); }
}
