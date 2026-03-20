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

// ─── Stock vs Crypto Detection ─────────────────────────────────────────────
// FIX: Previously relied ONLY on signal.source === "SMART_ENGINE"
// But stockSignalEngine was incorrectly setting source: "ENGINE" (now fixed to "SMART_ENGINE")
// Double-safety: also check if coin ends with USDT — stock coins never end with USDT
function isStockSignal(signal) {
  // Primary check: source field (most reliable after fix)
  if (signal.source === "SMART_ENGINE" || signal.source === "SMART_MANUAL") return true;
  // Secondary check: crypto coins always end with USDT on Bybit/Binance
  const coin = String(signal.coin || "").toUpperCase();
  if (coin.endsWith("USDT")) return false;
  // Tertiary check: if it has an exchange field like NSE/BSE it's definitely stock
  if (signal.exchange === "NSE" || signal.exchange === "BSE" || signal.exchange === "MCX") return true;
  return false;
}

// ─── Symbol cleanup ────────────────────────────────────────────────────────
// Crypto: "BTCUSDT" → "BTC"
// Stock:  "RELIANCE-EQ" → "RELIANCE", "NIFTY25APRFUT" → "NIFTY25APRFUT" (keep as-is)
function cleanSymbol(signal) {
  const coin  = String(signal.coin || "");
  const stock = isStockSignal(signal);
  if (!stock) {
    // Crypto — remove USDT suffix
    return coin.replace(/USDT$/i, "").replace(/BUSD$/i, "").trim() || coin;
  }
  // Stock — remove exchange suffix like -EQ, -BE, -N1 etc.
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

  // FIX: typeLabel correctly reflects signal type
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

  // Add top confirmations (max 3)
  if (Array.isArray(signal.confirmations) && signal.confirmations.length > 0) {
    lines.push(`📊 Reasons:`);
    signal.confirmations.slice(0, 3).forEach(c => lines.push(`  • ${c}`));
    lines.push(``);
  }

  // FIX: hashtags now correctly split between stock and crypto
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

// ─── Post to Facebook Page ─────────────────────────────────────────────────
async function postToFacebook(message) {
  if (!FB_ENABLED) return null;

  try {
    const response = await axios.post(
      `${FB_GRAPH_URL}/${FB_PAGE_ID}/feed`,
      {
        message,
        access_token: FB_ACCESS_TOKEN,
      },
      { timeout: 10_000 }
    );

    const postId = response.data?.id;
    console.log(`[fb] ✅ Posted to Facebook: ${postId}`);
    return postId;
  } catch (err) {
    const fbError = err.response?.data?.error;
    if (fbError) {
      console.error(`[fb] ❌ Facebook API error: (${fbError.code}) ${fbError.message}`);
      // Token expired — common issue
      if (fbError.code === 190) {
        console.error("[fb] 🔑 Access token expired! Refresh FB_PAGE_ACCESS_TOKEN in Render env vars.");
      }
    } else {
      console.error("[fb] ❌ Post failed:", err.message);
    }
    return null;
  }
}

// ─── Publish a new signal ──────────────────────────────────────────────────
async function publishSignal(signal) {
  if (!FB_ENABLED) return;

  // Only publish HIGH confidence signals (85+) to avoid spamming the page
  const minConfidence = Number(process.env.FB_MIN_CONFIDENCE || 85);
  if (Number(signal.confidence) < minConfidence) {
    console.log(`[fb] Skipping signal (confidence ${signal.confidence} < ${minConfidence})`);
    return;
  }

  const message = formatSignalPost(signal);
  return postToFacebook(message);
}

// ─── Publish signal result (when TP hit or SL hit) ────────────────────────
async function publishSignalResult(signal) {
  if (!FB_ENABLED) return;
  if (!["TP1_HIT","TP2_HIT","TP3_HIT","SL_HIT"].includes(signal.result)) return;

  const isWin   = signal.result !== "SL_HIT";
  const symbol  = cleanSymbol(signal);   // FIX: was signal.coin?.replace("USDT","") — broke for stocks
  const tpLevel = signal.result.replace("_HIT", "");
  const isStock = isStockSignal(signal); // FIX: was hardcoded per function, now shared helper

  function fmt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v >= 10000) return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    if (v >= 1)     return v.toFixed(4);
    return v.toFixed(6);
  }

  // FIX: result post also correctly shows stock vs crypto label and hashtags
  const hashTags = isStock
    ? `#FTAS #TradingSignals #StockMarket #NSE #${symbol}`
    : `#FTAS #TradingSignals #Crypto #${symbol}`;

  const lines = [
    isWin
      ? `🏆 TRADE RESULT: ${tpLevel} HIT! ✅`
      : `📊 TRADE CLOSED: Stop Loss Hit`,
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

// ─── postToFacebook exported for test-post route ───────────────────────────
module.exports = { publishSignal, publishSignalResult, postToFacebook, testConnection, FB_ENABLED };
