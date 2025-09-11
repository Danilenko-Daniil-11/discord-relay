import crypto from "crypto";

export function shortHash(s, len = 8) {
    return crypto.createHash('sha1').update(s).digest('hex').slice(0, len);
}

export function safeChannelName(prefix, id) {
    return `${prefix}-${shortHash(id, 8)}`.toLowerCase().replace(/[^a-z0-9\-]/g, '-').slice(0, 90);
}

export function safeFileChunking(str, maxBytes) {
    const chunks = [];
    let buf = Buffer.from(str);
    for (let i = 0; i < buf.length; i += maxBytes) {
        chunks.push(buf.slice(i, i + maxBytes));
    }
    return chunks;
}
