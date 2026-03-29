/**
 * FTAS Telegram Integration
 *
 * Sends trading signals directly to a Telegram channel/group.
 *
 * Setup (Render env vars):
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHANNEL_ID — channel username (@ftassignals) or chat ID (-100xxxxxxx)
 *
 * Routes:
 *   GET  /api/telegram/status          — check bot connection
 *   POST /api/telegram/test            — admin: send test message
 *   POST /api/telegram/send-signal     — admin: send specific signal
 *   GET  /api/telegram/settings        — get current settings
 *   POST /api/telegram/settings        — update auto-send settings
 */

const express = require("express");
const axios   = require("axios");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { mutateCollection, readCollection } = require("../storage/fileStore");

const router = express.Router();

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN  || "";
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";
const TG_API     = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isConfigured() {
  return Boolean(BOT_TOKEN && CHANNEL_ID);
}

function getTelegramErrorMessage(err) {
  const description = err?.response?.data?.description;
  const errorCode = err?.response?.data?.error_code;
  if (description && errorCode) return `Telegram ${errorCode}: ${description}`;
  if (description) return description;
  return err?.message || "Telegram request failed";
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10000) return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1)     return n.toFixed(4);
  return n.toFixed(6);
}

function formatSymbol(signal) {
  const tradingSymbol = signal.scanMeta?.instrument?.tradingSymbol;
  if (tradingSymbol) return tradingSymbol;
  const coin = String(signal.coin || "").toUpperCase();
  return coin.endsWith("USDT") ? coin.replace("USDT", "/USDT") : coin;
}

function isStock(signal) {
  if (signal.source === "SMART_ENGINE") return true;
  const coin = String(signal.coin || "").toUpperCase();
  return !coin.endsWith("USDT");
}

function confEmoji(conf) {
  const n = Number(conf);
  if (n >= 90) return "🔥🔥🔥";
  if (n >= 80) return "🔥🔥";
  if (n >= 70) return "🔥";
  return "⚡";
}

function nowIST() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── Build Telegram message ───────────────────────────────────────────────────
function buildSignalMessage(signal) {
  const sym    = formatSymbol(signal);
  const side   = signal.side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const market = isStock(signal)
    ? `🇮🇳 ${signal.scanMeta?.instrument?.exchange || "NSE/BSE"}`
    : "💹 Binance Futures";

  const reasons = Array.isArray(signal.confirmations)
    ? signal.confirmations.slice(0, 3).map(r => `  • ${r}`).join("\n")
    : "";

  return [
    `📡 *FTAS SIGNAL ALERT*`,
    ``,
    `${side} *${sym}*`,
    `🏛 Market: ${market}`,
    `⏱ Timeframe: ${signal.timeframe?.toUpperCase()}`,
    ``,
    `💰 *Entry:* \`${formatPrice(signal.entry)}\``,
    `🛡 *Stop Loss:* \`${formatPrice(signal.stopLoss)}\``,
    ``,
    `🎯 *Take Profits:*`,
    `  TP1 → \`${formatPrice(signal.tp1)}\``,
    `  TP2 → \`${formatPrice(signal.tp2)}\``,
    `  TP3 → \`${formatPrice(signal.tp3)}\``,
    ``,
    `📊 *Confidence:* ${signal.confidence}% ${confEmoji(signal.confidence)}`,
    signal.leverage ? `⚡ *Leverage:* ${signal.leverage}x` : "",
    reasons ? `\n✅ *Signals:*\n${reasons}` : "",
    ``,
    `🕐 ${nowIST()} IST`,
    ``,
    `⚠️ _Algorithmic signal. Manage risk. DYOR._`,
    ``,
    `[Join Channel](https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c) | [Facebook](https://facebook.com/Ftas.trading.network)`,
  ].filter(l => l !== "").join("\n");
}

function buildSignalResultMessage(signal) {
  const sym = formatSymbol(signal);
  const side = signal.side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const market = isStock(signal)
    ? `🇮🇳 ${signal.scanMeta?.instrument?.exchange || "NSE/BSE"}`
    : "💹 Binance Futures";
  const result = String(signal.result || "").toUpperCase();
  const isWin = result === "TP1_HIT" || result === "TP2_HIT" || result === "TP3_HIT";
  const resultLabel = isWin ? result.replace("_HIT", "") : "STOP LOSS";

  return [
    isWin ? `🏆 *FTAS TRADE WIN*` : `🛑 *FTAS TRADE CLOSED*`,
    ``,
    `${side} *${sym}*`,
    `🏛 Market: ${market}`,
    `⏱ Timeframe: ${signal.timeframe?.toUpperCase()}`,
    ``,
    `📌 *Result:* ${isWin ? `\`${resultLabel} HIT\`` : `\`SL HIT\``}`,
    `💰 *Entry:* \`${formatPrice(signal.entry)}\``,
    `🏁 *Close:* \`${formatPrice(signal.closePrice)}\``,
    `🛡 *Stop Loss:* \`${formatPrice(signal.stopLoss)}\``,
    `🎯 *TP1 / TP2 / TP3:* \`${formatPrice(signal.tp1)}\` / \`${formatPrice(signal.tp2)}\` / \`${formatPrice(signal.tp3)}\``,
    ``,
    isWin
      ? `✅ Trade reached ${resultLabel}.`
      : `⚠️ Stop loss triggered. Risk remained capped.`,
    `🕐 ${nowIST()} IST`,
    ``,
    `[Join Channel](https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c) | [Facebook](https://facebook.com/Ftas.trading.network)`,
  ].join("\n");
}

// ─── Send to Telegram ─────────────────────────────────────────────────────────
async function sendToTelegram(chatId, text) {
  if (!isConfigured()) throw new Error("Telegram bot not configured");
  const res = await axios.post(`${TG_API}/sendMessage`, {
    chat_id:    chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  }, { timeout: 10_000 });
  return res.data;
}

// ─── Auto-send to channel (called by signal engines) ─────────────────────────
async function autoSendSignal(signal) {
  if (!isConfigured()) return;
  try {
    // Check auto-send setting
    const settings = await getTelegramSettings();
    if (!settings.autoSend) return;

    // Filter by min confidence
    const minConf = Number(settings.minConfidence || 80);
    if (Number(signal.confidence) < minConf) return;

    const msg = buildSignalMessage(signal);
    await sendToTelegram(CHANNEL_ID, msg);
    console.log(`[telegram] Signal sent: ${signal.coin} ${signal.side}`);
  } catch (err) {
    console.error("[telegram] autoSendSignal failed:", err.message);
  }
}

async function autoSendSignalResult(signal) {
  if (!isConfigured()) return;
  try {
    const settings = await getTelegramSettings();
    if (!settings.autoSend) return;

    const minConf = Number(settings.minConfidence || 80);
    if (Number(signal.confidence) < minConf) return;
    if (!["TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT"].includes(String(signal.result || "").toUpperCase())) return;

    const msg = buildSignalResultMessage(signal);
    await sendToTelegram(CHANNEL_ID, msg);
    console.log(`[telegram] Signal result sent: ${signal.coin} ${signal.result}`);
  } catch (err) {
    console.error("[telegram] autoSendSignalResult failed:", err.message);
  }
}

async function getTelegramSettings() {
  try {
    const all = await readCollection("telegramSubs");
    return all[0] || { autoSend: false, minConfidence: 82 };
  } catch { return { autoSend: false, minConfidence: 82 }; }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Check bot status
router.get("/status", requireAuth, requireAdmin, async (_req, res) => {
  if (!isConfigured()) {
    return res.json({ configured: false, message: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in Render env vars" });
  }
  try {
    const [botRes, chatRes] = await Promise.allSettled([
      axios.get(`${TG_API}/getMe`, { timeout: 5000 }),
      axios.get(`${TG_API}/getChat`, {
        timeout: 5000,
        params: { chat_id: CHANNEL_ID },
      }),
    ]);
    const settings = await getTelegramSettings();
    if (botRes.status !== "fulfilled") {
      throw botRes.reason;
    }
    const channel = chatRes.status === "fulfilled" ? chatRes.value.data?.result : null;
    const channelError = chatRes.status === "rejected" ? getTelegramErrorMessage(chatRes.reason) : null;
    return res.json({
      configured: true,
      bot: botRes.value.data.result,
      channel,
      channelId: CHANNEL_ID,
      channelOk: Boolean(channel),
      channelError,
      settings,
    });
  } catch (err) {
    return res.status(502).json({ configured: true, error: getTelegramErrorMessage(err) });
  }
});

// Get/update settings
router.get("/settings", requireAuth, requireAdmin, async (_req, res) => {
  const settings = await getTelegramSettings();
  return res.json({ settings });
});

router.post("/settings", requireAuth, requireAdmin, async (req, res) => {
  const { autoSend, minConfidence } = req.body;
  await mutateCollection("telegramSubs", () => [{
    autoSend:      Boolean(autoSend),
    minConfidence: Number(minConfidence || 82),
    updatedAt:     new Date().toISOString(),
  }]);
  return res.json({ success: true });
});

// Send test message
router.post("/test", requireAuth, requireAdmin, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: "Telegram not configured" });
  try {
    const msg = [
      `✅ *FTAS Telegram Bot Connected!*`,
      ``,
      `Bot is working correctly.`,
      `Auto-signal sending is now available.`,
      ``,
      `🕐 ${nowIST()} IST`,
    ].join("\n");
    const data = await sendToTelegram(CHANNEL_ID, msg);
    return res.json({ success: true, messageId: data.result?.message_id });
  } catch (err) {
    return res.status(502).json({ message: getTelegramErrorMessage(err) });
  }
});

// Send specific signal(s) to Telegram manually
router.post("/send-signal", requireAuth, requireAdmin, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: "Telegram not configured" });
  const { signalIds } = req.body;
  if (!Array.isArray(signalIds) || !signalIds.length) {
    return res.status(400).json({ message: "signalIds array required" });
  }
  try {
    const [cryptoSigs, stockSigs] = await Promise.all([
      readCollection("signals"),
      readCollection("stockSignals"),
    ]);
    const all     = [...cryptoSigs, ...stockSigs];
    const signals = all.filter(s => signalIds.includes(s.id));
    const results = [];
    for (const signal of signals) {
      const msg  = buildSignalMessage(signal);
      const data = await sendToTelegram(CHANNEL_ID, msg);
      results.push({ id: signal.id, messageId: data.result?.message_id });
      await new Promise(r => setTimeout(r, 500)); // rate limit
    }
    return res.json({ success: true, sent: results.length, results });
  } catch (err) {
    return res.status(502).json({ message: getTelegramErrorMessage(err) });
  }
});

module.exports = { router, autoSendSignal, autoSendSignalResult };
