import express from "express";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: "50mb" }));

// ---------- Конфиг ----------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const PC_CATEGORY_NAME = "Все ПК";
const CAMERA_CATEGORY_NAME = "Камеры";
const ONLINE_TIMEOUT = 3 * 60 * 1000; // 3 минуты

// ---------- Состояние ----------
const onlinePCs = {};            // pcId -> timestamp
const onlineCams = {};           // camId -> timestamp
const lastMessageByCam = {};     // camId -> Discord message
const channelByCam = {};         // camId -> channelId

// ---------- Discord Bot ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

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

// ---------- Приём данных ПК ----------
app.post("/upload-pc", async (req,res)=>{
    try{
        const { pcId, info } = req.body;
        if(!pcId) return res.status(400).json({ error:"pcId required" });

        onlinePCs[pcId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, PC_CATEGORY_NAME);
        await getOrCreateTextChannel(guild, pcId, category.id); // канал создаём только для ПК, сообщения не трогаем

        res.json({ success:true });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Приём данных камеры ----------
app.post("/upload-cam", async (req,res)=>{
    try{
        const { camId, screenshot } = req.body;
        if(!camId || !screenshot) return res.status(400).json({ error:"camId и screenshot required" });

        onlineCams[camId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CAMERA_CATEGORY_NAME);
        const channel = await getOrCreateTextChannel(guild, camId, category.id);
        channelByCam[camId] = channel.id;

        // ---------- Удаляем предыдущее сообщение ----------
        if(lastMessageByCam[camId]){
            try { await lastMessageByCam[camId].delete(); } catch(e){ console.error("Не удалось удалить сообщение камеры:", e); }
        }

        // ---------- Отправляем новое ----------
        const message = await channel.send({ content: `Камера: ${camId}`, files: [{ attachment: Buffer.from(screenshot, "base64"), name: `${camId}.jpeg` }] });
        lastMessageByCam[camId] = message;

        res.json({ success:true });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Проверка онлайн камер ----------
setInterval(async ()=>{
    const guild = await bot.guilds.fetch(GUILD_ID);
    const now = Date.now();
    for(const camId of Object.keys(onlineCams)){
        if(now - onlineCams[camId] > ONLINE_TIMEOUT){
            // оффлайн — удаляем канал
            const channelId = channelByCam[camId];
            if(channelId){
                try{
                    const channel = await guild.channels.fetch(channelId);
                    if(channel) await channel.delete();
                }catch(e){ console.error("Не удалось удалить канал камеры:", e); }
            }
            delete onlineCams[camId];
            delete lastMessageByCam[camId];
            delete channelByCam[camId];
        }
    }
}, 30*1000);

// ---------- API ----------
app.get("/api/online-pcs", (req,res)=> res.json(Object.keys(onlinePCs)));
app.get("/api/online-cams", (req,res)=> res.json(Object.keys(onlineCams)));

// ---------- Статика ----------
app.use(express.static(join(__dirname,"public")));

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);
