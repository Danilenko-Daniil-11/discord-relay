import { Client, GatewayIntentBits } from "discord.js";
import { createControlButtons } from "./buttons.js"; // обязательно './' и '.js'

// Создание клиента Discord
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once("ready", () => console.log(`✅ Бот вошёл как ${bot.user.tag}`));

// Пример использования кнопок
bot.on("interactionCreate", async interaction => {
    if (!interaction.isButton()) return;

    const [command, encodedPcId] = interaction.customId.split("|");
    const pcId = decodeURIComponent(encodedPcId);

    // Здесь должна быть логика добавления команды в очередь
    // Например: pendingCommands[pcId].push(command);

    await interaction.reply({
        content: `✅ Команда "${command}" отправлена ПК ${pcId}`,
        ephemeral: true,
    });

    // Можно добавить кнопки обратно (обновление UI)
    const buttons = createControlButtons(pcId);
    // interaction.message.edit({ components: buttons }); // если нужно обновить кнопки
});

export { bot };
