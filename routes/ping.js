import express from "express";

const router = express.Router();
const onlinePCs = global.onlinePCs || (global.onlinePCs = {});
const pendingCommands = global.pendingCommands || (global.pendingCommands = {});

router.post("/", (req, res) => {
    const { pcId } = req.body;
    if (!pcId) return res.status(400).json({ error: "pcId required" });

    onlinePCs[pcId] = Date.now();
    const commands = pendingCommands[pcId] || [];
    pendingCommands[pcId] = [];
    res.json({ commands });
});

export default router;
