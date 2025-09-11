import express from "express";
import http from "http";
import { bot } from "./discord/bot.js";
import { wssSetup } from "./ws/wsServer.js";
import uploadPC from "./routes/uploadPC.js";
import uploadCam from "./routes/uploadCam.js";
import pingRoute from "./routes/ping.js";

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.static("public"));

app.use("/upload-pc", uploadPC);
app.use("/upload-cam", uploadCam);
app.use("/ping", pingRoute);

const server = http.createServer(app);
wssSetup(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер слушает порт ${PORT}`));
