const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { mutateCollection, readCollection } = require("../storage/fileStore");
const { getStatus: getCryptoEngineStatus, getSelfLearningStatus } = require("../services/signalEngine");
const { WIN_RESULTS, LOSS_RESULTS } = require("../constants");

const router = express.Router();

const MAX_MSG_LENGTH = 500;
const MAX_MESSAGES = 200; // keep last 200 messages in store
const MAX_ASSISTANT_QUERY = 300;
const ASSISTANT_SIGNAL_READ_TIMEOUT_MS = 5000;

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}


async function readSignalsWithTimeout() {
  try {
    const timeoutTask = new Promise((resolve) => {
      setTimeout(() => resolve([]), ASSISTANT_SIGNAL_READ_TIMEOUT_MS);
    });
    const signals = await Promise.race([readCollection("signals"), timeoutTask]);
    return Array.isArray(signals) ? signals : [];
  } catch {
    return [];
  }
}

function buildRecentStats(signals) {
  const resolved = (signals || [])
    .filter((s) => WIN_RESULTS.has(s.result) || LOSS_RESULTS.has(s.result))
    .sort((a, b) => {
      const aTs = new Date(a.closedAt || a.updatedAt || a.createdAt || 0).getTime();
      const bTs = new Date(b.closedAt || b.updatedAt || b.createdAt || 0).getTime();
      return bTs - aTs;
    });

  const recent30 = resolved.slice(0, 30);
  const wins = recent30.filter((s) => WIN_RESULTS.has(s.result)).length;
  const losses = recent30.filter((s) => LOSS_RESULTS.has(s.result)).length;
  const total = wins + losses;
  const winRate = total ? Number(((wins / total) * 100).toFixed(1)) : null;

  return { wins, losses, total, winRate };
}

function pickBestLowRiskSignal(activeSignals = []) {
  if (!activeSignals.length) return null;
  const withScores = activeSignals.map((s) => {
    const confidence = toNumber(s.confidence);
    const leverage = Math.max(1, toNumber(s.leverage || s?.indicatorSnapshot?.leverage || 10));
    const riskPenalty = Math.min(leverage, 30) * 0.8;
    const score = confidence - riskPenalty;
    return { signal: s, score };
  });
  withScores.sort((a, b) => b.score - a.score);
  return withScores[0]?.signal || null;
}

function buildAssistantAnswer({ query, activeSignals, recentStats, engineStatus, selfLearningStatus }) {
  const q = String(query || "").toLowerCase();
  const activeCount = activeSignals.length;
  const topSignal = pickBestLowRiskSignal(activeSignals);
  const runningText = engineStatus?.running ? "running" : "stopped";

  const summaryLine = `Engine is ${runningText}; ${activeCount} active signals; recent-30 win rate ${recentStats.winRate ?? "N/A"}%.`;

  if (q.includes("best") || q.includes("low") || q.includes("risk")) {
    if (!topSignal) {
      return {
        answer: `${summaryLine} No active setup is available right now for a low-risk pick.`,
        bullets: [
          "Wait for next scan cycle and check highest-confidence setups.",
          "Prefer lower leverage with strong confirmation stack.",
        ],
      };
    }

    const conf = toNumber(topSignal.confidence);
    const lev = toNumber(topSignal.leverage || topSignal?.indicatorSnapshot?.leverage || 0);
    const reasons = Array.isArray(topSignal.confirmations) ? topSignal.confirmations.slice(0, 3) : [];

    return {
      answer:
        `${summaryLine} Best low-risk candidate now: ${topSignal.coin} ${topSignal.side} (${topSignal.timeframe}) at ${conf}% confidence and ${lev}x leverage.`,
      bullets: reasons.length ? reasons : ["Strong multi-indicator alignment", "Trend and momentum filters passed"],
    };
  }

  if (q.includes("win rate") || q.includes("performance") || q.includes("drawdown")) {
    const riskMode = recentStats.winRate !== null && recentStats.winRate <= 46 ? "RISK-OFF" : "BALANCED";
    return {
      answer: `${summaryLine} Current mode is ${riskMode}.`,
      bullets: [
        `Recent closed trades: ${recentStats.total} (${recentStats.wins}W / ${recentStats.losses}L).`,
        `Self-learning: ${selfLearningStatus?.enabled ? "enabled" : "disabled"}.`,
        "If drawdown continues, keep confidence floor high and reduce frequency.",
      ],
    };
  }

  if (q.includes("status") || q.includes("scanner") || q.includes("engine")) {
    return {
      answer: `${summaryLine} Scanner last run: ${engineStatus?.lastScanAt || "N/A"}.`,
      bullets: [
        `Scan count: ${toNumber(engineStatus?.scanCount)}.`,
        `Last generated: ${toNumber(engineStatus?.lastGenerated)} signals.`,
        `Last error: ${engineStatus?.lastError || "none"}.`,
      ],
    };
  }

  return {
    answer: `${summaryLine} Ask about low-risk setup, performance, or engine status for a focused answer.`,
    bullets: [
      "Examples: 'best low-risk setup now', 'recent performance', 'engine status'.",
      "Assistant answers are generated from live FTAS engine data.",
    ],
  };
}

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

// ─── POST /api/chat/assistant ────────────────────────────────────────────────
router.post("/assistant", requireAuth, async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim().slice(0, MAX_ASSISTANT_QUERY);
    if (!query) return res.status(400).json({ message: "query is required" });

    const signals = await readSignalsWithTimeout();
    const activeSignals = (signals || []).filter((s) => s.status === "ACTIVE");
    const recentStats = buildRecentStats(signals || []);
    const engineStatus = getCryptoEngineStatus();
    const selfLearningStatus = getSelfLearningStatus();

    const response = buildAssistantAnswer({
      query,
      activeSignals,
      recentStats,
      engineStatus,
      selfLearningStatus,
    });

    return res.json({
      answer: response.answer,
      bullets: response.bullets || [],
      meta: {
        generatedAt: new Date().toISOString(),
        activeSignals: activeSignals.length,
        recent30WinRate: recentStats.winRate,
      },
    });
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
