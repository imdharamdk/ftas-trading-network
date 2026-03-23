const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { mutateCollection, readCollection } = require("../storage/fileStore");
const router = express.Router();

const MAX_MSG_LENGTH = 500;
const MAX_MESSAGES = 200; // keep last 200 messages in store

// ─── GET /api/chat/messages ───────────────────────────────────────────────────
// Returns latest chat messages (auth required)
router.get("/messages", requireAuth, async (req, res) => {
  try {
    const messages = await readCollection("chat_messages");
    // Return most recent 100 for display
    const latest = [...messages]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 100)
      .reverse();
    return res.json({ messages: latest });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// ─── POST /api/chat/messages ──────────────────────────────────────────────────
router.post("/messages", requireAuth, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ message: "text is required" });
    }
    const trimmed = text.trim().slice(0, MAX_MSG_LENGTH);
    if (!trimmed) return res.status(400).json({ message: "Empty message" });

    const user = req.user;
    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text: trimmed,
      userId: user.id,
      userName: user.name || user.email?.split("@")[0] || "User",
      userRole: user.role || "USER",
      createdAt: new Date().toISOString(),
    };

    await mutateCollection("chat_messages", (records) => {
      const updated = [message, ...records].slice(0, MAX_MESSAGES);
      return { records: updated, value: message };
    });

    // Broadcast to all connected WS clients instantly
    try { require("../services/wsServer").broadcastChatMessage(message); } catch {}

    return res.status(201).json({ message });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// ─── DELETE /api/chat/messages/:id  (Admin only) ─────────────────────────────
router.delete("/messages/:id", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ message: "Admin only" });
    }
    await mutateCollection("chat_messages", (records) => ({
      records: records.filter((m) => m.id !== req.params.id),
      value: true,
    }));
    return res.json({ deleted: true });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

module.exports = router;
