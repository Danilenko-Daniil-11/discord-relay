import fs from "fs";
import path from "path";

const logFile = path.join(process.cwd(), "server.log");

export async function logToFile(msg) {
    fs.appendFile(logFile, `[${new Date().toISOString()}] ${msg}\n`, err => {
        if (err) console.error("Ошибка записи логов:", err);
    });
}

export async function log(msg) {
    console.log(msg);
    await logToFile(msg);
}
