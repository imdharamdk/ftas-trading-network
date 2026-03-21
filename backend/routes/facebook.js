/**
 * FTAS Facebook Admin Routes
 *
 * Render env vars required:
 *   FB_PAGE_ID           — numeric page ID (from /me/accounts)
 *   FB_PAGE_ACCESS_TOKEN — long-lived page token (60 days)
 *   FB_MIN_CONFIDENCE    — minimum confidence to auto-post (default: 85)
 *   FB_AUTO_POST         — "true" to enable auto-posting (default: false)
 *
 * Routes:
 *   GET  /api/facebook/status          — connection status + page info
 *   POST /api/facebook/test            — send test post to page
 *   POST /api/facebook/post-signal     — manually post specific signal(s)
 *   GET  /api/facebook/settings        — get current settings
 *   POST /api/facebook/settings        — update settings
 *   POST /api/facebook/exchange-token  — exchange short-lived → long-lived token
 */

const express = require("express");
const axios   = require("axios");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { readCollection } = require("../storage/fileStore");

const router      = express.Router();
const FB_GRAPH    = "https://graph.facebook.com/v19.0";
const publisher   = require("../services/facebookPublisher");

function pickFbUsageHeaders(headers) {
  if (!headers) return {};
  const out = {};
  const keys = [
    "x-app-usage",
    "x-page-usage",
    "x-business-use-case-usage",
    "x-ad-account-usage",
    "x-fb-trace-id",
  ];
  for (const k of keys) {
    if (headers[k]) out[k] = headers[k];
  }
  return out;
}

// ─── GET status ───────────────────────────────────────────────────────────────
router.get("/status", requireAuth, requireAdmin, async (_req, res) => {
  const result = await publisher.testConnection();
  return res.json({
    configured: Boolean(process.env.FB_PAGE_ID && process.env.FB_PAGE_ACCESS_TOKEN),
    autoPost:   process.env.FB_AUTO_POST === "true",
    minConf:    Number(process.env.FB_MIN_CONFIDENCE || 85),
    ...result,
  });
});

// ─── GET settings ─────────────────────────────────────────────────────────────
router.get("/settings", requireAuth, requireAdmin, (_req, res) => {
  return res.json({
    configured:    Boolean(process.env.FB_PAGE_ID && process.env.FB_PAGE_ACCESS_TOKEN),
    autoPost:      process.env.FB_AUTO_POST === "true",
    minConfidence: Number(process.env.FB_MIN_CONFIDENCE || 85),
    pageId:        process.env.FB_PAGE_ID ? `...${process.env.FB_PAGE_ID.slice(-4)}` : null,
    tokenSet:      Boolean(process.env.FB_PAGE_ACCESS_TOKEN),
  });
});

// ─── POST test ────────────────────────────────────────────────────────────────
router.post("/test", requireAuth, requireAdmin, async (_req, res) => {
  if (!publisher.FB_ENABLED) {
    return res.status(503).json({
      message: "Facebook not configured. Set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN in Render env vars.",
    });
  }
  try {
    const nowIST = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
    const testMsg = [
      "✅ FTAS Facebook Integration Active!",
      "",
      `Auto-posting is working correctly.`,
      `New trading signals will be posted automatically.`,
      "",
      `🕐 ${nowIST} IST`,
      "",
      "📲 https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c",
      "#FTAS #TradingSignals",
    ].join("\n");

    // Access postToFacebook via the internal method
    const FB_PAGE_ID      = process.env.FB_PAGE_ID;
    const FB_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
    const response = await axios.post(
      `${FB_GRAPH}/${FB_PAGE_ID}/feed`,
      { message: testMsg, access_token: FB_ACCESS_TOKEN },
      { timeout: 10_000 }
    );
    const usage = pickFbUsageHeaders(response.headers || {});
    if (Object.keys(usage).length) {
      console.log("[fb] rate-limit headers:", usage);
    }
    return res.json({ success: true, postId: response.data?.id });
  } catch (err) {
    const fbErr = err.response?.data?.error;
    const usage = pickFbUsageHeaders(err.response?.headers || {});
    if (Object.keys(usage).length) {
      console.error("[fb] rate-limit headers:", usage);
    }
    return res.status(502).json({
      message: fbErr ? `Facebook API: ${fbErr.message}` : err.message,
      code: fbErr?.code,
    });
  }
});

// ─── POST manually post signal(s) ─────────────────────────────────────────────
router.post("/post-signal", requireAuth, requireAdmin, async (req, res) => {
  if (!publisher.FB_ENABLED) {
    return res.status(503).json({ message: "Facebook not configured" });
  }
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
      const result = await publisher.publishSignal(signal, { returnUsage: true });
      const postId = result && typeof result === "object" && "postId" in result
        ? result.postId
        : result;
      if (result?.usage && Object.keys(result.usage).length) {
        console.log("[fb] post-signal rate-limit headers:", result.usage);
      }
      if (result?.error) {
        console.error("[fb] post-signal error:", result.error);
      }
      results.push({ id: signal.id, postId, coin: signal.coin, error: result?.error || null });
      await new Promise(r => setTimeout(r, 1000)); // rate limit
    }
    return res.json({ success: true, posted: results.length, results });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── POST exchange short token → long-lived token ─────────────────────────────
router.post("/exchange-token", requireAuth, requireAdmin, async (req, res) => {
  const { appId, appSecret, shortToken } = req.body;
  if (!appId || !appSecret || !shortToken) {
    return res.status(400).json({ message: "appId, appSecret, shortToken required" });
  }
  try {
    // Step 1: Exchange user token for long-lived user token
    const userTokenRes = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
      params: {
        grant_type:        "fb_exchange_token",
        client_id:         appId,
        client_secret:     appSecret,
        fb_exchange_token: shortToken,
      },
    });
    const longUserToken = userTokenRes.data.access_token;

    // Step 2: Get page accounts to find page token
    const accountsRes = await axios.get(`${FB_GRAPH}/me/accounts`, {
      params: { access_token: longUserToken },
    });
    const pages = accountsRes.data?.data || [];

    return res.json({
      success: true,
      longUserToken,
      pages: pages.map(p => ({
        name:        p.name,
        id:          p.id,
        accessToken: p.access_token, // This is the long-lived page token — use this!
      })),
      instructions: "Copy the accessToken for your page (Ftas.trading.network) and set it as FB_PAGE_ACCESS_TOKEN in Render env vars. Also set FB_PAGE_ID to the page id.",
    });
  } catch (err) {
    const fbErr = err.response?.data?.error;
    return res.status(502).json({
      message: fbErr ? `Facebook API: ${fbErr.message}` : err.message,
    });
  }
});

module.exports = router;
