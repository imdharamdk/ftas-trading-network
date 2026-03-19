/**
 * FTAS Price Alerts
 *
 * Users set price thresholds — when crossed, they get browser push + Telegram notification.
 *
 * Routes:
 *   GET    /api/price-alerts              — get user's alerts
 *   POST   /api/price-alerts              — create alert
 *   DELETE /api/price-alerts/:id          — delete alert
 *   GET    /api/price-alerts/check        — admin: trigger manual check
 */

const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { mutateCollection, readCollection } = require("../storage/fileStore");

const router = express.Router();

function createId() {
  return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Get user alerts ──────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const all = await readCollection("priceAlerts");
    const userAlerts = all.filter(a => a.userId === req.userId);
    return res.json({ alerts: userAlerts });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── Create alert ─────────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  const { coin, condition, price, note } = req.body;
  // condition: "above" | "below"
  if (!coin || !condition || !price) {
    return res.status(400).json({ message: "coin, condition, and price are required" });
  }
  if (!["above", "below"].includes(condition)) {
    return res.status(400).json({ message: "condition must be 'above' or 'below'" });
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return res.status(400).json({ message: "Invalid price" });
  }

  // Limit: 10 alerts per user
  const all = await readCollection("priceAlerts");
  const userCount = all.filter(a => a.userId === req.userId && !a.triggered).length;
  if (userCount >= 10) {
    return res.status(400).json({ message: "Maximum 10 active alerts per user" });
  }

  const alert = {
    id:        createId(),
    userId:    req.userId,
    userEmail: req.user.email,
    coin:      String(coin).toUpperCase(),
    condition,
    price:     priceNum,
    note:      note ? String(note).slice(0, 100) : "",
    triggered: false,
    createdAt: new Date().toISOString(),
  };

  await mutateCollection("priceAlerts", records => [alert, ...records]);
  return res.status(201).json({ alert });
});

// ─── Delete alert ─────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await mutateCollection("priceAlerts", records => {
      const alert = records.find(a => a.id === req.params.id);
      if (!alert) throw Object.assign(new Error("Alert not found"), { status: 404 });
      if (alert.userId !== req.userId && req.user.role !== "ADMIN") {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      }
      return records.filter(a => a.id !== req.params.id);
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
});

// ─── Check alerts against current prices ──────────────────────────────────────
// Called periodically from signalEngine or manually by admin
async function checkPriceAlerts(priceMap) {
  try {
    const alerts  = await readCollection("priceAlerts");
    const active  = alerts.filter(a => !a.triggered);
    if (!active.length) return;

    const triggered = [];
    const now       = new Date().toISOString();

    const updated = alerts.map(alert => {
      if (alert.triggered) return alert;
      const livePrice = priceMap[alert.coin];
      if (!Number.isFinite(livePrice)) return alert;

      const hit = alert.condition === "above"
        ? livePrice >= alert.price
        : livePrice <= alert.price;

      if (!hit) return alert;

      triggered.push({ ...alert, livePrice });
      return { ...alert, triggered: true, triggeredAt: now, triggeredPrice: livePrice };
    });

    if (!triggered.length) return;
    await mutateCollection("priceAlerts", () => updated);

    // Send notifications for triggered alerts
    for (const alert of triggered) {
      const dir   = alert.condition === "above" ? "📈 crossed above" : "📉 dropped below";
      const title = `💰 ${alert.coin} Price Alert!`;
      const body  = `${alert.coin} has ${dir} ${alert.price}. Current: ${alert.livePrice.toFixed(4)}`;

      // Browser push notification
      try {
        const { broadcastSignalPush } = require("./notifications");
        // Send to the specific user only
        const subs  = await readCollection("pushSubscriptions");
        const userSub = subs.find(s => s.userId === alert.userId);
        if (userSub) {
          const webpush = require("web-push");
          await webpush.sendNotification(userSub.subscription, JSON.stringify({
            title, body, tag: `price-alert-${alert.id}`, url: "/crypto",
          })).catch(() => {});
        }
      } catch {}

      // Telegram notification (if configured)
      try {
        const { autoSendSignal } = require("./telegram");
        // Not ideal but works — build a fake signal-like object for Telegram
        const tgMsg = [
          `💰 *PRICE ALERT TRIGGERED*`,
          ``,
          `*${alert.coin}* has ${dir} \`${alert.price}\``,
          `Current price: \`${alert.livePrice?.toFixed?.(4)}\``,
          alert.note ? `📝 Note: ${alert.note}` : "",
          ``,
          `🕐 ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`,
        ].filter(Boolean).join("\n");

        const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
        const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
        if (BOT_TOKEN && CHANNEL_ID) {
          const axios = require("axios");
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHANNEL_ID, text: tgMsg, parse_mode: "Markdown",
          }, { timeout: 5000 }).catch(() => {});
        }
      } catch {}

      console.log(`[priceAlerts] Triggered: ${alert.coin} ${alert.condition} ${alert.price} for ${alert.userEmail}`);
    }
  } catch (err) {
    console.error("[priceAlerts] checkPriceAlerts error:", err.message);
  }
}

// Admin: manual check trigger
router.post("/check", requireAuth, requireAdmin, async (req, res) => {
  const { prices } = req.body; // { BTCUSDT: 60000, ... }
  if (!prices || typeof prices !== "object") {
    return res.status(400).json({ message: "prices object required" });
  }
  await checkPriceAlerts(prices);
  return res.json({ success: true });
});

module.exports = { router, checkPriceAlerts };
