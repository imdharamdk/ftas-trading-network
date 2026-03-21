/**
 * FTAS Push Notification Routes
 *
 * POST /api/notifications/subscribe       — save push subscription
 * POST /api/notifications/unsubscribe     — remove subscription
 * GET  /api/notifications/vapid-public-key — return VAPID public key
 * POST /api/notifications/test            — admin: send test push
 */

const express   = require("express");
const webpush   = require("web-push");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { mutateCollection, readCollection, writeCollection } = require("../storage/fileStore");

const router = express.Router();

// ── VAPID setup ───────────────────────────────────────────────────────────────
// Generate keys once: node -e "const wp=require('web-push'); console.log(wp.generateVAPIDKeys())"
// Then set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Render env vars
let VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
let VAPID_EMAIL       = process.env.VAPID_EMAIL || "mailto:admin@ftas.app";


let vapidReady = false;
let vapidInit = null;

function applyVapidKeys(publicKey, privateKey, email) {
  if (!publicKey || !privateKey) return false;
  VAPID_PUBLIC_KEY = publicKey;
  VAPID_PRIVATE_KEY = privateKey;
  VAPID_EMAIL = email || VAPID_EMAIL;
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

async function ensureVapidKeys() {
  if (vapidReady && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) return true;
  if (vapidInit) return vapidInit;

  vapidInit = (async () => {
    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      applyVapidKeys(VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL);
      console.log("[push] VAPID configured ✅");
      return true;
    }

    try {
      const settings = await readCollection("appSettings");
      const record = settings.find((s) => s?.id === "vapid") || {};
      if (record.publicKey && record.privateKey) {
        applyVapidKeys(record.publicKey, record.privateKey, record.email || VAPID_EMAIL);
        console.log("[push] VAPID loaded from app settings ✅");
        return true;
      }
    } catch {}

    try {
      const generated = webpush.generateVAPIDKeys();
      if (applyVapidKeys(generated.publicKey, generated.privateKey, VAPID_EMAIL)) {
        const settings = await readCollection("appSettings");
        const next = [
          ...settings.filter((s) => s?.id !== "vapid"),
          { id: "vapid", publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, email: VAPID_EMAIL, updatedAt: new Date().toISOString() },
        ];
        await writeCollection("appSettings", next);
        console.log("[push] VAPID generated and stored ✅");
        return true;
      }
    } catch (err) {
      console.warn("[push] VAPID generation failed:", err.message);
    }

    return false;
  })();

  try {
    return await vapidInit;
  } finally {
    vapidInit = null;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Return VAPID public key to frontend
router.get("/vapid-public-key", async (req, res) => {
  const ready = await ensureVapidKeys();
  if (!ready || !VAPID_PUBLIC_KEY) return res.status(503).json({ message: "Push notifications not configured" });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Save subscription for this user
router.post("/subscribe", requireAuth, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ message: "Invalid subscription" });

  try {
    await mutateCollection("pushSubscriptions", (records) => {
      // Remove old subscriptions for this user, add new one
      const filtered = records.filter(r => r.userId !== req.userId);
      return [
        ...filtered,
        {
          userId:       req.userId,
          userEmail:    req.user.email,
          subscription,
          createdAt:    new Date().toISOString(),
        },
      ];
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Remove subscription for this user
router.post("/unsubscribe", requireAuth, async (req, res) => {
  try {
    await mutateCollection("pushSubscriptions", (records) =>
      records.filter(r => r.userId !== req.userId)
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: send test push
router.post("/test", requireAuth, requireAdmin, async (req, res) => {
  const { title = "FTAS Test", body = "Push notifications are working! 🎉" } = req.body;
  const results = await sendPushToUser(req.userId, { title, body, url: "/dashboard" });
  res.json({ results });
});

// ── Core send function (called by signal engines) ─────────────────────────────

/**
 * Send push notification to all subscribed users with signal access
 */
async function broadcastSignalPush(signal) {
  const ready = await ensureVapidKeys();
  if (!ready) return;
  try {
    const subs    = await readCollection("pushSubscriptions");
    const { hasSignalAccess } = require("../models/User");
    const users   = await readCollection("users");

    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    const coin = String(signal.coin || "").replace("USDT", "");
    const side = signal.side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
    const conf = signal.confidence ? `${signal.confidence}% confidence` : "";

    const payload = JSON.stringify({
      title: `📡 ${side} ${coin}`,
      body:  `Entry: ${Number(signal.entry).toFixed(4)} · ${conf} · ${signal.timeframe}`,
      tag:   `signal-${signal.id}`,
      url:   signal.source === "SMART_ENGINE" ? "/stocks" : "/crypto",
    });

    const promises = subs
      .filter(s => {
        const user = userMap[s.userId];
        return user && hasSignalAccess(user);
      })
      .map(s => sendRaw(s.subscription, payload).catch(() => null));

    await Promise.allSettled(promises);
  } catch (err) {
    console.error("[push] broadcastSignalPush failed:", err.message);
  }
}

async function sendPushToUser(userId, data) {
  const ready = await ensureVapidKeys();
  if (!ready) return [];
  try {
    const subs = await readCollection("pushSubscriptions");
    const userSubs = subs.filter(s => s.userId === userId);
    const payload  = JSON.stringify(data);
    return await Promise.allSettled(userSubs.map(s => sendRaw(s.subscription, payload)));
  } catch { return []; }
}

async function sendRaw(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, payload);
  } catch (err) {
    // 410 = subscription expired — remove it
    if (err.statusCode === 410) {
      await mutateCollection("pushSubscriptions", (records) =>
        records.filter(r => r.subscription.endpoint !== subscription.endpoint)
      ).catch(() => {});
    }
    throw err;
  }
}

module.exports = { router, broadcastSignalPush };
