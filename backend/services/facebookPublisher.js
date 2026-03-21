/**
 * FTAS Facebook Publisher
 *
 * Naye signals automatically Facebook Page pe post karta hai via Graph API.
 *
 * Setup (one-time manual steps):
 * 1. developers.facebook.com → Create App → Business type
 * 2. Add "Facebook Login" + "Pages API" products
 * 3. Graph API Explorer → Get User Token → select pages_manage_posts, pages_read_engagement
 * 4. Exchange for Long-Lived Page Token (60 days):
 *    GET /oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=USER_TOKEN
 * 5. Get your Page ID:
 *    GET /me/accounts (use the page's access_token field, not id)
 * 6. Set Render env vars:
 *    FB_PAGE_ID=your_numeric_page_id
 *    FB_PAGE_ACCESS_TOKEN=your_long_lived_page_token
 *    FB_AUTO_POST=true
 *
 * Token refresh: tokens expire in 60 days — set a reminder to refresh.
 * For never-expiring tokens, create a System User in Business Manager.
 */

const axios = require("axios");

const FB_GRAPH_URL    = "https://graph.facebook.com/v19.0";
const FB_PAGE_ID      = process.env.FB_PAGE_ID;
const FB_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_ENABLED      = Boolean(FB_PAGE_ID && FB_ACCESS_TOKEN);

if (!FB_ENABLED) {
  console.log("[fb] Facebook publishing disabled — set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN env vars to enable.");
}

// ─── Global Post Queue (Rate Limit Protection) ─────────────────────────────
// Facebook strict rate limit lagaata hai agar posts ek saath aayein.
// Solution: serial queue + 3 min minimum gap + 10 min cool-down after 368 error.
//
// Env vars to tune:
//   FB_POST_MIN_GAP_MS  — gap between posts in ms (default: 180000 = 3 min)
//   FB_POST_QUEUE_LIMIT — max pending posts in queue (default: 3)

const FB_POST_MIN_GAP_MS  = Number(process.env.FB_POST_MIN_GAP_MS  || 3 * 60_000); // 3 min
const FB_POST_QUEUE_LIMIT = Number(process.env.FB_POST_QUEUE_LIMIT || 3);

let _lastPostAt     = 0;
let _postQueue      = [];
let _queueRunning   = false;
let _rateLimitUntil = 0; // epoch ms — 368 error ke baad yahan tak wait karo

function _flushQueue(reason) {
  if (_postQueue.length > 0) {
    console.warn(`[fb] flushing ${_postQueue.length} queued post(s) — ${reason}`);
    _postQueue.forEach(item => item.resolve(null));
    _postQueue = [];
  }
}

async function _drainQueue() {
  if (_queueRunning) return;
  _queueRunning = true;

  while (_postQueue.length > 0) {
    // 368 rate-limit cool-down still active?
    const coolDownLeft = Math.max(0, _rateLimitUntil - Date.now());
    if (coolDownLeft > 0) {
      console.warn(`[fb] 368 cool-down active — ${Math.round(coolDownLeft / 1000)}s left. Flushing queue.`);
      _flushQueue("rate limit cool-down — posts dropped");
      break;
    }

    // Minimum gap between posts
    const gapWait = Math.max(0, _lastPostAt + FB_POST_MIN_GAP_MS - Date.now());
    if (gapWait > 0) {
      console.log(`[fb] queue: waiting ${Math.round(gapWait / 1000)}s before next post`);
      await new Promise(r => setTimeout(r, gapWait));
    }

    const item = _postQueue.shift();
    if (!item) break;

    _lastPostAt = Date.now();
    try {
      const result = await _postToFacebookDirect(item.message, item.options);
      // Rate limit hit ho gayi during this post?
      if (result?.error?.code === 368) {
        _rateLimitUntil = Date.now() + 10 * 60_000; // 10 min cool-down
        console.warn("[fb] 368 rate limit — 10min cool-down set, flushing remaining queue");
        _flushQueue("rate limit after post — remaining posts dropped");
      }
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
  }

  _queueRunning = false;
}

function enqueuePost(message, options = {}) {
  return new Promise((resolve, reject) => {
    // Already in cool-down?
    const coolDownLeft = Math.max(0, _rateLimitUntil - Date.now());
    if (coolDownLeft > 0) {
      console.warn(`[fb] rate limit cool-down (${Math.round(coolDownLeft / 1000)}s left) — dropping post`);
      return resolve(null);
    }
    if (_postQueue.length >= FB_POST_QUEUE_LIMIT) {
      console.warn(`[fb] queue full (${FB_POST_QUEUE_LIMIT} max) — dropping post`);
      return resolve(null);
    }
    _postQueue.push({ message, options, resolve, reject });
    console.log(`[fb] queued post (queue size: ${_postQueue.length})`);
    _drainQueue().catch(err => console.error("[fb] queue drain error:", err.message));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pickFbUsageHeaders(headers) {
  if (!headers) return {};
  const out = {};
  const keys = [
    "x-app-usage", "x-page-usage", "x-business-use-case-usage",
    "x-ad-account-usage", "x-fb-trace-id",
  ];
  for (const k of keys) {
    if (headers[k]) out[k] = headers[k];
  }
  return out;
}

// ─── Stock vs Crypto Detection ─────────────────────────────────────────────
const CRYPTO_QUOTE_SUFFIXES = ["USDT", "BUSD", "USDC", "USDP", "FDUSD", "TUSD", "DAI"];
const CRYPTO_QUOTE_RE = new RegExp(`(${CRYPTO_QUOTE_SUFFIXES.join("|")})$`, "i");

function isCryptoSymbol(coin = "") {
  return CRYPTO_QUOTE_RE.test(String(coin || "").toUpperCase());
}

function isStockSignal(signal) {
  const assetClass = String(signal.assetClass || "").toUpperCase();
  if (assetClass === "STOCK") return true;
  if (assetClass === "CRYPTO") return false;
  if (signal.source === "SMART_ENGINE" || signal.source === "SMART_MANUAL") return true;
  if (signal.exchange === "NSE" || signal.exchange === "BSE" || signal.exchange === "MCX") return true;
  const coin = String(signal.coin || "").toUpperCase();
  if (isCryptoSymbol(coin)) return false;
  return Boolean(coin);
}

function cleanSymbol(signal) {
  const coin  = String(signal.coin || "");
  const stock = isStockSignal(signal);
  if (!stock) return coin.replace(CRYPTO_QUOTE_RE, "").trim() || coin;
  return coin.replace(/-(EQ|BE|N1|BL|IL|SM|GR|ST)$/i, "").trim() || coin;
}

// ─── Format signal as Facebook post message ────────────────────────────────
function formatSignalPost(signal) {
  const isStock  = isStockSignal(signal);
  const symbol   = cleanSymbol(signal);
  const side     = signal.side === "LONG" ? "🟢 LONG (BUY)" : "🔴 SHORT (SELL)";
  const tf       = signal.timeframe?.toUpperCase();
  const conf     = signal.confidence;
  const strength = signal.strength || "MEDIUM";
  const lev      = signal.leverage ? `${signal.leverage}x` : "—";
  const strengthEmoji = strength === "STRONG" ? "⚡ STRONG" : "✅ MEDIUM";
  const typeLabel = isStock ? "🇮🇳 Indian Stock Signal" : "💹 Crypto Futures Signal";

  function fmt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v >= 10000) return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    if (v >= 1)     return v.toFixed(4);
    return v.toFixed(6);
  }

  const lines = [
    `${typeLabel} | ${strengthEmoji}`,
    ``,
    `📌 ${symbol} | ${side}`,
    `⏱ Timeframe: ${tf}  |  🎯 Confidence: ${conf}%  |  🔧 Leverage: ${lev}`,
    ``,
    `💰 Entry:     ${fmt(signal.entry)}`,
    `🛑 Stop Loss: ${fmt(signal.stopLoss)}`,
    ``,
    `🎯 Targets:`,
    `  TP1 → ${fmt(signal.tp1)}`,
    `  TP2 → ${fmt(signal.tp2)}`,
    `  TP3 → ${fmt(signal.tp3)}`,
    ``,
  ];

  if (Array.isArray(signal.confirmations) && signal.confirmations.length > 0) {
    lines.push(`📊 Reasons:`);
    signal.confirmations.slice(0, 3).forEach(c => lines.push(`  • ${c}`));
    lines.push(``);
  }

  const hashTags = isStock
    ? `#FTAS #TradingSignals #StockMarket #NSE #IndianStocks #${symbol}`
    : `#FTAS #TradingSignals #Crypto #CryptoTrading #${symbol} #Bitcoin`;

  lines.push(
    `━━━━━━━━━━━━━━━━━━━━`,
    `⚠️ Risk disclaimer: Trading involves risk. This is not financial advice.`,
    `📲 Join our WhatsApp channel for instant alerts:`,
    `https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c`,
    ``,
    `🔗 Live signals: ${process.env.FRONTEND_URL || "https://ftas-trading-network.vercel.app"}`,
    hashTags,
  );

  return lines.join("\n");
}

// ─── Direct Post (internal — called by queue OR test route) ───────────────
async function _postToFacebookDirect(message, options = {}) {
  if (!FB_ENABLED) return null;

  const endpoint   = `${FB_GRAPH_URL}/${FB_PAGE_ID}/feed`;
  const pageTail   = FB_PAGE_ID ? `...${FB_PAGE_ID.slice(-4)}` : "unknown";
  console.log(`[fb] → POST /feed page=${pageTail}`);

  const maxRetries  = Number(process.env.FB_RETRY_MAX    || 1);   // low retry — queue handles spacing
  const baseDelayMs = Number(process.env.FB_RETRY_BASE_MS || 5000);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        endpoint,
        { message, access_token: FB_ACCESS_TOKEN },
        { timeout: 10_000 }
      );
      const postId = response.data?.id;
      console.log(`[fb] ✅ Posted: ${postId}`);
      const usage = pickFbUsageHeaders(response.headers || {});
      if (Object.keys(usage).length) console.log("[fb] usage headers:", usage);
      return options.returnUsage ? { postId, usage } : postId;
    } catch (err) {
      const fbError = err.response?.data?.error;
      const status  = err.response?.status;
      const usage   = pickFbUsageHeaders(err.response?.headers || {});
      const isRateLimit = fbError?.code === 368;

      if (isRateLimit && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[fb] rate limit — retrying in ${Math.round(delay / 1000)}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (fbError) {
        console.error(`[fb] ❌ FB API error: (${fbError.code}) ${fbError.message}`);
        if (fbError.code === 190) {
          console.error("[fb] 🔑 Token expired! Refresh FB_PAGE_ACCESS_TOKEN in Render.");
        }
      } else {
        console.error("[fb] ❌ Post failed:", err.message);
      }
      if (Object.keys(usage).length) console.error("[fb] usage headers:", usage);

      if (options.returnUsage) {
        return {
          postId: null,
          usage,
          error: fbError
            ? { code: fbError.code, message: fbError.message, status }
            : { message: err.message, status },
        };
      }
      return null;
    }
  }

  return options.returnUsage ? { postId: null, usage: {} } : null;
}

// ─── Public postToFacebook — goes through rate-limit queue ────────────────
async function postToFacebook(message, options = {}) {
  return enqueuePost(message, options);
}

// ─── Publish a new signal ──────────────────────────────────────────────────
async function publishSignal(signal, options = {}) {
  if (!FB_ENABLED) return;

  // FB_AUTO_POST=true hona chahiye Render env mein — yahi main gate hai
  if (process.env.FB_AUTO_POST !== "true") {
    console.log("[fb] Auto-post disabled (FB_AUTO_POST != true) — skipping signal");
    return;
  }

  const minConfidence = Number(process.env.FB_MIN_CONFIDENCE || 85);
  if (Number(signal.confidence) < minConfidence) {
    console.log(`[fb] Skipping signal — confidence ${signal.confidence} < ${minConfidence}`);
    return;
  }

  const message = formatSignalPost(signal);
  return postToFacebook(message, options);
}

// ─── Publish signal result (TP hit / SL hit) ──────────────────────────────
async function publishSignalResult(signal) {
  if (!FB_ENABLED) return;
  if (process.env.FB_AUTO_POST !== "true") return;
  if (!["TP1_HIT","TP2_HIT","TP3_HIT","SL_HIT"].includes(signal.result)) return;

  const isWin   = signal.result !== "SL_HIT";
  const symbol  = cleanSymbol(signal);
  const tpLevel = signal.result.replace("_HIT", "");
  const isStock = isStockSignal(signal);

  function fmt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v >= 10000) return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    if (v >= 1)     return v.toFixed(4);
    return v.toFixed(6);
  }

  const hashTags = isStock
    ? `#FTAS #TradingSignals #StockMarket #NSE #${symbol}`
    : `#FTAS #TradingSignals #Crypto #${symbol}`;

  const lines = [
    isWin ? `🏆 TRADE RESULT: ${tpLevel} HIT! ✅` : `📊 TRADE CLOSED: Stop Loss Hit`,
    ``,
    `${isStock ? "🇮🇳 Indian Stock" : "💹 Crypto"} | ${symbol} | ${signal.side}`,
    `Entry: ${fmt(signal.entry)} → Close: ${fmt(signal.closePrice)}`,
    ``,
    isWin
      ? `✅ Target ${tpLevel} reached! Great trade 🎯`
      : `🛑 SL triggered. Risk was managed. Next signal incoming!`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📲 Join for more signals: https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c`,
    `🔗 ${process.env.FRONTEND_URL || "https://ftas-trading-network.vercel.app"}`,
    hashTags,
  ];

  return postToFacebook(lines.join("\n"));
}

// ─── Test connection ───────────────────────────────────────────────────────
async function testConnection() {
  if (!FB_ENABLED) {
    return { ok: false, message: "FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN not set" };
  }
  try {
    const res = await axios.get(`${FB_GRAPH_URL}/${FB_PAGE_ID}`, {
      params: { access_token: FB_ACCESS_TOKEN, fields: "name,fan_count" },
      timeout: 8000,
    });
    return { ok: true, page: res.data };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    return { ok: false, message: msg };
  }
}

// postToFacebookDirect — test route ke liye (queue bypass, instant response)
module.exports = {
  publishSignal,
  publishSignalResult,
  postToFacebook,
  postToFacebookDirect: _postToFacebookDirect,
  testConnection,
  FB_ENABLED,
};
