import { WebSocketServer } from "ws";
import { logToDiscord } from "../discord/channels.js";

const wsCameraClients = global.wsCameraClients || (global.wsCameraClients = {});

export function wssSetup(server) {
    const wss = new WebSocketServer({ noServer: true });

    // Обработка нового соединения
    wss.on("connection", (ws, req) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const camId = url.searchParams.get("camId") || "all";

        if (!wsCameraClients[camId]) wsCameraClients[camId] = [];
        wsCameraClients[camId].push(ws);

        // Инициализация heartbeat
        ws.isAlive = true;
        ws.on("pong", () => { ws.isAlive = true; });

        ws.on("close", () => {
            wsCameraClients[camId] = wsCameraClients[camId].filter(c => c !== ws);
        });

        ws.on("error", async (err) => {
            await logToDiscord(`❌ WS error (camId=${camId}): ${err.message}`);
        });
    });

    // Heartbeat для проверки живости клиентов
    const interval = setInterval(() => {
        for (const camId in wsCameraClients) {
            wsCameraClients[camId].forEach(ws => {
                if (!ws.isAlive) {
                    ws.terminate();
                    wsCameraClients[camId] = wsCameraClients[camId].filter(c => c !== ws);
                } else {
                    ws.isAlive = false;
                    ws.ping();
                }
            });
        }
    }, 30000); // каждые 30 секунд

    wss.on("close", () => clearInterval(interval));

    // Интеграция с HTTP server для upgrade
    server.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
    });
}
