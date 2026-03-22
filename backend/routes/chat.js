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

function normalizeAssistantLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "hi" || raw === "hindi") return "hi";
  if (raw === "hinglish") return "hinglish";
  return "en";
}

function inLang(language, enText, hinglishText, hiText) {
  if (language === "hi") return hiText || hinglishText || enText;
  if (language === "hinglish") return hinglishText || enText;
  return enText;
}

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

function hasAnyKeyword(text, keywords) {
  return keywords.some((k) => text.includes(k));
}

function buildAssistantAnswer({ query, language, activeSignals, recentStats, engineStatus, selfLearningStatus }) {
  const q = String(query || "").toLowerCase();
  const normalized = q.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const activeCount = activeSignals.length;
  const topSignal = pickBestLowRiskSignal(activeSignals);
  const runningText = engineStatus?.running
    ? inLang(language, "running", "running", "chalu")
    : inLang(language, "stopped", "stopped", "ruka hua");

  const summaryLine = inLang(
    language,
    `Engine is ${runningText}; ${activeCount} active signals; recent-30 win rate ${recentStats.winRate ?? "N/A"}%.`,
    `Engine ${runningText} hai; ${activeCount} active signals; recent-30 win rate ${recentStats.winRate ?? "N/A"}%.`,
    `Engine ${runningText} hai; ${activeCount} sakriya sanket; pichhle 30 ka win rate ${recentStats.winRate ?? "N/A"}%.`
  );

  if (hasAnyKeyword(normalized, ["hi", "hello", "hey", "namaste", "good morning", "good evening"])) {
    return {
      answer: inLang(
        language,
        "Hi. I am FTAS Assistant. I can help with signals, performance, scanner status, and platform usage.",
        "Hi. Main FTAS Assistant hoon. Main signals, performance, scanner status aur platform usage me help kar sakta hoon.",
        "Namaste. Main FTAS Sahayak hoon. Main sanket, pradarshan, scanner sthiti aur platform upyog me madad kar sakta hoon."
      ),
      bullets: [
        inLang(language, "Ask: 'best low-risk setup now'", "Pucho: 'best low-risk setup now'", "Poochhein: 'abhi sabse kam jokhim setup'"),
        inLang(language, "Ask: 'recent performance'", "Pucho: 'recent performance'", "Poochhein: 'haal ka pradarshan'"),
        inLang(language, "Ask: 'engine status'", "Pucho: 'engine status'", "Poochhein: 'engine sthiti'"),
      ],
    };
  }

  if (hasAnyKeyword(normalized, ["how are you", "kaise ho", "kese ho"])) {
    return {
      answer: inLang(
        language,
        "I am operational and connected to live FTAS engine data.",
        "Main operational hoon aur live FTAS engine data se connected hoon.",
        "Main sakriya hoon aur live FTAS engine data se juda hoon."
      ),
      bullets: [summaryLine],
    };
  }

  if (hasAnyKeyword(normalized, ["thanks", "thank you", "thx", "shukriya"])) {
    return {
      answer: inLang(language, "You're welcome.", "Welcome ji.", "Aapka swagat hai."),
      bullets: [
        inLang(
          language,
          "You can ask another question about signals or dashboard actions.",
          "Aap signals ya dashboard actions par next question puch sakte ho.",
          "Aap sanket ya dashboard kriyaon par agla prashn pooch sakte hain."
        ),
      ],
    };
  }

  if (hasAnyKeyword(normalized, ["who are you", "what are you", "tum kaun", "aap kaun"])) {
    return {
      answer: inLang(
        language,
        "I am the FTAS in-dashboard assistant.",
        "Main FTAS ka in-dashboard assistant hoon.",
        "Main FTAS ka dashboard sahayak hoon."
      ),
      bullets: [
        inLang(
          language,
          "I use live FTAS signal and engine state for answers.",
          "Main answers ke liye live FTAS signal aur engine state use karta hoon.",
          "Main uttaron ke liye live FTAS sanket aur engine sthiti ka upyog karta hoon."
        ),
        inLang(
          language,
          "I do not place orders; I only guide using current platform data.",
          "Main orders place nahi karta; sirf current platform data se guide karta hoon.",
          "Main order nahi lagata; sirf vartaman platform data ke aadhar par margdarshan deta hoon."
        ),
      ],
    };
  }

  if (hasAnyKeyword(normalized, ["help", "what can you do", "commands", "options"])) {
    return {
      answer: inLang(
        language,
        "I can answer both basic conversation and trading dashboard questions.",
        "Main basic conversation aur trading dashboard dono questions ka answer de sakta hoon.",
        "Main samanya baatcheet aur trading dashboard dono prashnon ka uttar de sakta hoon."
      ),
      bullets: [
        inLang(language, "Conversation: hi, how are you, thanks.", "Conversation: hi, how are you, thanks.", "Baatcheet: namaste, kaise ho, dhanyavaad."),
        inLang(language, "Trading: best low-risk setup, win rate, drawdown.", "Trading: best low-risk setup, win rate, drawdown.", "Trading: kam jokhim setup, win rate, drawdown."),
        inLang(language, "System: scanner status, last run, generated count.", "System: scanner status, last run, generated count.", "System: scanner sthiti, pichhla run, generated count."),
      ],
    };
  }

  if (normalized.includes("best") || normalized.includes("low") || normalized.includes("risk")) {
    if (!topSignal) {
      return {
        answer: inLang(
          language,
          `${summaryLine} No active setup is available right now for a low-risk pick.`,
          `${summaryLine} Abhi low-risk pick ke liye koi active setup available nahi hai.`,
          `${summaryLine} Is samay kam jokhim chunav ke liye koi sakriya setup uplabdh nahi hai.`
        ),
        bullets: [
          inLang(
            language,
            "Wait for next scan cycle and check highest-confidence setups.",
            "Next scan cycle ka wait karo aur highest-confidence setups check karo.",
            "Agli scan cycle ka intezar karein aur sabse uchch confidence setup dekhein."
          ),
          inLang(
            language,
            "Prefer lower leverage with strong confirmation stack.",
            "Lower leverage aur strong confirmation stack ko prefer karo.",
            "Kam leverage aur majboot confirmation stack ko prathmikta dein."
          ),
        ],
      };
    }

    const conf = toNumber(topSignal.confidence);
    const lev = toNumber(topSignal.leverage || topSignal?.indicatorSnapshot?.leverage || 0);
    const reasons = Array.isArray(topSignal.confirmations) ? topSignal.confirmations.slice(0, 3) : [];

    return {
      answer: inLang(
        language,
        `${summaryLine} Best low-risk candidate now: ${topSignal.coin} ${topSignal.side} (${topSignal.timeframe}) at ${conf}% confidence and ${lev}x leverage.`,
        `${summaryLine} Abhi best low-risk candidate: ${topSignal.coin} ${topSignal.side} (${topSignal.timeframe}), confidence ${conf}% aur leverage ${lev}x.`,
        `${summaryLine} Vartaman sabse kam jokhim vikalp: ${topSignal.coin} ${topSignal.side} (${topSignal.timeframe}), confidence ${conf}% aur leverage ${lev}x.`
      ),
      bullets: reasons.length ? reasons : [
        inLang(language, "Strong multi-indicator alignment", "Strong multi-indicator alignment", "Majboot multi-indicator samanvay"),
        inLang(language, "Trend and momentum filters passed", "Trend aur momentum filters pass hue", "Trend aur momentum filters safal hue"),
      ],
    };
  }

  if (normalized.includes("win rate") || normalized.includes("performance") || normalized.includes("drawdown")) {
    const riskMode = recentStats.winRate !== null && recentStats.winRate <= 46 ? "RISK-OFF" : "BALANCED";
    return {
      answer: inLang(
        language,
        `${summaryLine} Current mode is ${riskMode}.`,
        `${summaryLine} Current mode ${riskMode} hai.`,
        `${summaryLine} Vartaman mode ${riskMode} hai.`
      ),
      bullets: [
        inLang(
          language,
          `Recent closed trades: ${recentStats.total} (${recentStats.wins}W / ${recentStats.losses}L).`,
          `Recent closed trades: ${recentStats.total} (${recentStats.wins}W / ${recentStats.losses}L).`,
          `Haal ke closed trades: ${recentStats.total} (${recentStats.wins}W / ${recentStats.losses}L).`
        ),
        inLang(
          language,
          `Self-learning: ${selfLearningStatus?.enabled ? "enabled" : "disabled"}.`,
          `Self-learning: ${selfLearningStatus?.enabled ? "enabled" : "disabled"}.`,
          `Self-learning: ${selfLearningStatus?.enabled ? "enabled" : "disabled"}.`
        ),
        inLang(
          language,
          "If drawdown continues, keep confidence floor high and reduce frequency.",
          "Agar drawdown continue ho, confidence floor high rakho aur frequency kam karo.",
          "Yadi drawdown jaari rahe, confidence floor uchch rakhein aur frequency kam karein."
        ),
      ],
    };
  }

  if (normalized.includes("status") || normalized.includes("scanner") || normalized.includes("engine")) {
    return {
      answer: inLang(
        language,
        `${summaryLine} Scanner last run: ${engineStatus?.lastScanAt || "N/A"}.`,
        `${summaryLine} Scanner last run: ${engineStatus?.lastScanAt || "N/A"}.`,
        `${summaryLine} Scanner ka pichhla run: ${engineStatus?.lastScanAt || "N/A"}.`
      ),
      bullets: [
        inLang(language, `Scan count: ${toNumber(engineStatus?.scanCount)}.`, `Scan count: ${toNumber(engineStatus?.scanCount)}.`, `Scan count: ${toNumber(engineStatus?.scanCount)}.`),
        inLang(language, `Last generated: ${toNumber(engineStatus?.lastGenerated)} signals.`, `Last generated: ${toNumber(engineStatus?.lastGenerated)} signals.`, `Last generated: ${toNumber(engineStatus?.lastGenerated)} sanket.`),
        inLang(language, `Last error: ${engineStatus?.lastError || "none"}.`, `Last error: ${engineStatus?.lastError || "none"}.`, `Pichhli truti: ${engineStatus?.lastError || "none"}.`),
      ],
    };
  }

  return {
    answer: inLang(
      language,
      "I can handle basic chat and FTAS platform questions.",
      "Main basic chat aur FTAS platform questions handle kar sakta hoon.",
      "Main samanya baatcheet aur FTAS platform prashn sambhal sakta hoon."
    ),
    bullets: [
      inLang(language, "Try: hi, who are you, help.", "Try: hi, who are you, help.", "Poochhein: namaste, aap kaun ho, help."),
      inLang(language, "Try: best low-risk setup now, recent performance, engine status.", "Try: best low-risk setup now, recent performance, engine status.", "Poochhein: best low-risk setup, recent performance, engine status."),
      summaryLine,
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
    const language = normalizeAssistantLanguage(req.body?.language);

    const signals = await readSignalsWithTimeout();
    const activeSignals = (signals || []).filter((s) => s.status === "ACTIVE");
    const recentStats = buildRecentStats(signals || []);
    const engineStatus = getCryptoEngineStatus();
    const selfLearningStatus = getSelfLearningStatus();

    const response = buildAssistantAnswer({
      query,
      language,
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
        language,
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
