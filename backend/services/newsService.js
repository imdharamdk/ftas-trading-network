const axios = require("axios");

const cache = new Map();
const NEWS_CACHE_MS = Number(process.env.NEWS_CACHE_MS || 10 * 60 * 1000);

// Hardcoded keys — can also be overridden via env vars
const HARDCODED_GNEWS_KEY     = "6e15ede0b451a6d92027c9d6c822e28a";
const HARDCODED_AV_KEY        = "SX9UN0F2N0JUEBMQ";
const HARDCODED_NEWSDATA_KEY  = "pub_a9c26d2a997f409398291993bd872dac";

/* ─── Fallback articles ──────────────────────────────────────────────────────── */
const FALLBACK_ARTICLES = {
  crypto: [
    { headline: "Bitcoin and crypto markets: live price tracking on FTAS", source: "FTAS", summary: "Track all major crypto pairs live on the Scanner page — BTC, ETH, SOL, and 500+ Binance futures pairs.", timePublished: "", url: "/market" },
    { headline: "Crypto signal engine running 24/7", source: "FTAS", summary: "The Binance signal scanner checks EMA, RSI, MACD, and ADX conditions across all USDT perpetual futures.", timePublished: "", url: "/crypto" },
    { headline: "How to read crypto signals on FTAS", source: "FTAS", summary: "Each signal shows entry price, stop loss, and three take-profit targets with a confidence score.", timePublished: "", url: "/crypto" },
  ],
  finance: [
    { headline: "Indian stock market signals via SmartAPI", source: "FTAS", summary: "NSE, BSE, NFO, and MCX instruments are scanned using Angel One SmartAPI for real-time F&O signals.", timePublished: "", url: "/stocks" },
    { headline: "Win rate and performance dashboard updated", source: "FTAS", summary: "See separate win rates for crypto and Indian stock signals on the Dashboard page.", timePublished: "", url: "/dashboard" },
    { headline: "Payment and subscription management on FTAS", source: "FTAS", summary: "Submit UPI or bank transfer payments directly on the website. Admin approval activates your plan instantly.", timePublished: "", url: "/dashboard" },
  ],
  stocks: [
    { headline: "Nifty 50 and BANKNIFTY F&O signals", source: "FTAS", summary: "FTAS scans index futures and options contracts to find high-confidence entry setups.", timePublished: "", url: "/stocks" },
    { headline: "MCX commodities: crude oil, gold, silver signals", source: "FTAS", summary: "Commodity contracts on MCX are scanned every 2 minutes by the SmartAPI engine.", timePublished: "", url: "/stocks" },
    { headline: "All NSE/BSE equity instruments in one scanner", source: "FTAS", summary: "The Scanner page now shows all stock instruments with segment and exchange filters.", timePublished: "", url: "/market" },
  ],
};
FALLBACK_ARTICLES.mixed = [
  ...FALLBACK_ARTICLES.finance,
  ...FALLBACK_ARTICLES.crypto,
  ...FALLBACK_ARTICLES.stocks,
];

function buildFallbackPayload(kind, limit, message = "") {
  const articles = (FALLBACK_ARTICLES[kind] || FALLBACK_ARTICLES.mixed).slice(0, limit);
  return { articles, degraded: true, message, provider: "FTAS_FALLBACK" };
}

/* ─── Alpha Vantage ─────────────────────────────────────────────────────────── */
function getAVTopic(kind) {
  if (kind === "crypto")  return "blockchain,cryptocurrency";
  if (kind === "stocks")  return "earnings,ipo,financial_markets";
  if (kind === "finance") return "economy_macro,financial_markets,forex";
  return "financial_markets,economy_macro,blockchain";
}

async function fetchFromAlphaVantage(kind, limit, apiKey) {
  const url = `https://www.alphavantage.co/query`;
  const params = {
    function: "NEWS_SENTIMENT",
    topics: getAVTopic(kind),
    limit: Math.min(limit + 5, 50),
    sort: "LATEST",
    apikey: apiKey,
  };
  const res = await axios.get(url, { params, timeout: 12000 });
  const feed = Array.isArray(res.data?.feed) ? res.data.feed : [];
  // AV sometimes returns info messages instead of feed
  if (!feed.length && res.data?.Information) {
    throw new Error(`Alpha Vantage: ${res.data.Information}`);
  }
  return feed.slice(0, limit).map(a => ({
    headline: a.title || "Untitled",
    source: a.source || "Alpha Vantage",
    summary: a.summary || "",
    timePublished: a.time_published || "",
    url: a.url || "#",
    bannerImage: a.banner_image || "",
  }));
}

/* ─── GNews API ─────────────────────────────────────────────────────────────── */
function getGNewsQuery(kind) {
  if (kind === "crypto")  return "bitcoin OR ethereum OR crypto OR blockchain";
  if (kind === "stocks")  return "stock market OR NSE OR BSE OR Nifty OR share market";
  if (kind === "finance") return "finance OR economy OR RBI OR interest rates OR inflation";
  return "finance OR stock market OR crypto OR economy OR bitcoin";
}

async function fetchFromGNews(kind, limit, apiKey) {
  const res = await axios.get("https://gnews.io/api/v4/search", {
    params: {
      q: getGNewsQuery(kind),
      lang: "en",
      max: Math.min(limit, 10),
      apikey: apiKey,
      sortby: "publishedAt",
    },
    timeout: 12000,
  });
  const articles = Array.isArray(res.data?.articles) ? res.data.articles : [];
  if (!articles.length) throw new Error("GNews returned 0 articles");
  return articles.map(a => ({
    headline: a.title || "Untitled",
    source: a.source?.name || "GNews",
    summary: a.description || a.content || "",
    timePublished: a.publishedAt || "",
    url: a.url || "#",
    bannerImage: a.image || "",
  }));
}

/* ─── NewsData.io API (free tier: 200 req/day) ──────────────────────────────── */
function getNewsDataCategory(kind) {
  if (kind === "crypto")  return "technology,science";
  if (kind === "stocks")  return "business";
  if (kind === "finance") return "business,politics";
  return "business,technology";
}

async function fetchFromNewsData(kind, limit, apiKey) {
  const url = `https://newsdata.io/api/1/news`;
  const params = {
    apikey: apiKey,
    language: "en",
    category: getNewsDataCategory(kind),
    q: kind === "crypto" ? "crypto OR bitcoin OR blockchain" : kind === "stocks" ? "stock market OR NSE OR Nifty" : "finance OR economy",
  };
  const res = await axios.get(url, { params, timeout: 12000 });
  const results = Array.isArray(res.data?.results) ? res.data.results : [];
  return results.slice(0, limit).map(a => ({
    headline: a.title || "Untitled",
    source: a.source_id || "NewsData",
    summary: a.description || a.content || "",
    timePublished: a.pubDate || "",
    url: a.link || "#",
    bannerImage: a.image_url || "",
  }));
}

/* ─── CryptoCompare News (free, no key needed for basic) ───────────────────── */
async function fetchFromCryptoCompare(limit) {
  const url = `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest`;
  const res = await axios.get(url, { timeout: 10000 });
  const data = Array.isArray(res.data?.Data) ? res.data.Data : [];
  return data.slice(0, limit).map(a => ({
    headline: a.title || "Untitled",
    source: a.source_info?.name || a.source || "CryptoCompare",
    summary: a.body?.slice(0, 200) || "",
    timePublished: a.published_on ? new Date(a.published_on * 1000).toISOString() : "",
    url: a.url || "#",
    bannerImage: a.imageurl || "",
  }));
}

/* ─── Main fetch function ───────────────────────────────────────────────────── */
async function fetchNews({ kind = "mixed", limit = 9 } = {}) {
  const normalizedKind = ["crypto", "finance", "stocks", "mixed"].includes(kind) ? kind : "mixed";
  const normalizedLimit = Math.min(Math.max(Number(limit) || 9, 3), 10);
  const cacheKey = `news:${normalizedKind}:${normalizedLimit}`;

  // Return cached if fresh
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NEWS_CACHE_MS) {
    return cached.payload;
  }

  const provider = String(process.env.NEWS_PROVIDER || "AUTO").trim().toUpperCase();
  if (provider === "FALLBACK") {
    return buildFallbackPayload(normalizedKind, normalizedLimit, "NEWS_PROVIDER set to FALLBACK.");
  }

  // Resolve keys — env vars override hardcoded values
  const gnewsKey    = process.env.GNEWS_API_KEY        || HARDCODED_GNEWS_KEY;
  const avKey       = process.env.ALPHA_VANTAGE_API_KEY || HARDCODED_AV_KEY;
  const newsdataKey = process.env.NEWSDATA_API_KEY      || HARDCODED_NEWSDATA_KEY;

  // Provider priority: GNews → NewsData → AlphaVantage → CryptoCompare
  const attempts = [
    { name: "GNews",        fn: () => fetchFromGNews(normalizedKind, normalizedLimit, gnewsKey) },
    { name: "NewsData",     fn: () => fetchFromNewsData(normalizedKind, normalizedLimit, newsdataKey) },
    { name: "AlphaVantage", fn: () => fetchFromAlphaVantage(normalizedKind, normalizedLimit, avKey) },
  ];

  // CryptoCompare always available as last resort for crypto/mixed
  if (normalizedKind === "crypto" || normalizedKind === "mixed") {
    attempts.push({ name: "CryptoCompare", fn: () => fetchFromCryptoCompare(normalizedLimit) });
  }

  let lastError = "";
  for (const attempt of attempts) {
    try {
      const articles = await attempt.fn();
      if (articles && articles.length > 0) {
        const payload = { articles, degraded: false, message: "", provider: attempt.name };
        cache.set(cacheKey, { ts: Date.now(), payload });
        console.log(`[news] Loaded ${articles.length} articles from ${attempt.name} (${normalizedKind})`);
        return payload;
      }
      lastError = `${attempt.name} returned 0 articles`;
    } catch (e) {
      console.error(`[news] ${attempt.name} failed:`, e.message);
      lastError = e.message;
    }
  }

  // All failed — return fallback, retry sooner
  console.warn(`[news] All providers failed for "${normalizedKind}": ${lastError}`);
  const payload = buildFallbackPayload(normalizedKind, normalizedLimit, "Live news temporarily unavailable.");
  cache.set(cacheKey, { ts: Date.now() - NEWS_CACHE_MS + 60000, payload });
  return payload;
}

module.exports = { fetchNews };
