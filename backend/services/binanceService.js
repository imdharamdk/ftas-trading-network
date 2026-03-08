const axios = require("axios");
const { HttpsProxyAgent } = (() => { try { return require("https-proxy-agent"); } catch { return {}; } })();

// ─── Proxy support ────────────────────────────────────────────────────────────
// If HTTP_PROXY or HTTPS_PROXY is set in .env, route all Binance requests through it.
// This is the recommended fix for Indian servers where fapi.binance.com is blocked.
// Usage in .env:  HTTP_PROXY=http://proxy-ip:port
function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxyUrl && HttpsProxyAgent) {
    console.log(`[Binance] Using proxy: ${proxyUrl}`);
    return new HttpsProxyAgent(proxyUrl);
  }
  return undefined;
}

const proxyAgent = getProxyAgent();

// ─── Endpoint config ──────────────────────────────────────────────────────────
// Binance Futures (fapi) is geo-blocked in India and some other regions.
// We try multiple base URLs in order — first one that responds wins.
// Also falls back to Spot API for price data if Futures is unavailable.

const FUTURES_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://fapi4.binance.com",
];

const SPOT_HOST = "https://api.binance.com";

// In-memory: which futures host is currently working
let activeHost = FUTURES_HOSTS[0];
let lastHostCheck = 0;
const HOST_CHECK_INTERVAL = 5 * 60 * 1000; // re-check every 5 min

// Simple in-memory price cache to avoid hammering API on repeated calls
const priceCache = new Map(); // symbol → { price, ts }
const CACHE_TTL  = 8 * 1000; // 8 seconds

// ─── Create clients ───────────────────────────────────────────────────────────
function makeFuturesClient(host) {
  return axios.create({
    baseURL: host,
    timeout: 10000,
    ...(proxyAgent ? { httpsAgent: proxyAgent } : {}),
  });
}

const spotClient = axios.create({
  baseURL: SPOT_HOST,
  timeout: 10000,
  ...(proxyAgent ? { httpsAgent: proxyAgent } : {}),
});

// ─── Host resolver ────────────────────────────────────────────────────────────
// Tries each futures host in order, returns first reachable one.
async function resolveActiveHost() {
  const now = Date.now();
  if (now - lastHostCheck < HOST_CHECK_INTERVAL) return activeHost;

  for (const host of FUTURES_HOSTS) {
    try {
      await axios.get(`${host}/fapi/v1/ping`, { timeout: 5000 });
      activeHost    = host;
      lastHostCheck = now;
      console.log(`[Binance] Active futures host: ${host}`);
      return host;
    } catch {}
  }

  // All futures hosts failed — will use spot fallback
  lastHostCheck = now;
  console.warn("[Binance] All futures hosts unreachable, using spot fallback");
  return null;
}

// ─── Normalize kline ──────────────────────────────────────────────────────────
function normalizeKline(k) {
  return {
    openTime:  Number(k[0]),
    open:      Number(k[1]),
    high:      Number(k[2]),
    low:       Number(k[3]),
    close:     Number(k[4]),
    volume:    Number(k[5]),
    closeTime: Number(k[6]),
  };
}

// ─── getKlines ────────────────────────────────────────────────────────────────
// Fetches OHLCV candles. Tries Futures first, falls back to Spot.
// Drops the last (incomplete/open) candle to avoid dirty signals.
async function getKlines(symbol, interval, limit = 251) {
  // Fetch one extra so we can drop the unfinished current candle
  const fetchLimit = limit + 1;

  // Try Futures
  const host = await resolveActiveHost();
  if (host) {
    try {
      const res = await makeFuturesClient(host).get("/fapi/v1/klines", {
        params: { symbol, interval, limit: fetchLimit },
      });
      if (Array.isArray(res.data) && res.data.length > 1) {
        // Drop last candle (open/unfinished)
        const candles = res.data.slice(0, -1).map(normalizeKline);
        return candles;
      }
    } catch (err) {
      console.warn(`[Binance] Futures klines failed for ${symbol}/${interval}: ${err.message}`);
      // Mark host as stale so next call re-checks
      lastHostCheck = 0;
    }
  }

  // Fallback: Spot API
  // Note: 12h interval not available on spot — map to closest
  const spotInterval = interval === "12h" ? "1d" : interval;
  try {
    const res = await spotClient.get("/api/v3/klines", {
      params: { symbol, interval: spotInterval, limit: fetchLimit },
    });
    if (Array.isArray(res.data) && res.data.length > 1) {
      return res.data.slice(0, -1).map(normalizeKline);
    }
  } catch (err) {
    console.error(`[Binance] Spot klines also failed for ${symbol}/${interval}: ${err.message}`);
  }

  return [];
}

// ─── getPrices ────────────────────────────────────────────────────────────────
// Returns { BTCUSDT: 65000, ETHUSDT: 3200, ... }
// Cached for 8 seconds to avoid per-coin hammering during a scan.
async function getPrices(symbols = []) {
  const result  = {};
  const toFetch = [];
  const now     = Date.now();

  // Serve from cache if fresh
  for (const s of symbols) {
    const cached = priceCache.get(s);
    if (cached && now - cached.ts < CACHE_TTL) {
      result[s] = cached.price;
    } else {
      toFetch.push(s);
    }
  }

  if (!toFetch.length) return result;

  // Try Futures price endpoint
  const host = await resolveActiveHost();
  if (host) {
    try {
      const res = await makeFuturesClient(host).get("/fapi/v2/ticker/price");
      const tickers = Array.isArray(res.data) ? res.data : [];
      const wanted  = new Set(toFetch.map(s => s.toUpperCase()));
      for (const t of tickers) {
        const sym = String(t.symbol || "").toUpperCase();
        if (wanted.has(sym)) {
          const price = Number(t.price);
          result[sym] = price;
          priceCache.set(sym, { price, ts: now });
        }
      }
      // Check if we got all prices
      if (toFetch.every(s => result[s])) return result;
    } catch (err) {
      console.warn(`[Binance] Futures prices failed: ${err.message}`);
      lastHostCheck = 0;
    }
  }

  // Fallback: Spot prices for any missing
  const stillMissing = toFetch.filter(s => !result[s]);
  if (stillMissing.length) {
    try {
      const res = await spotClient.get("/api/v3/ticker/price");
      const tickers = Array.isArray(res.data) ? res.data : [];
      const wanted  = new Set(stillMissing.map(s => s.toUpperCase()));
      for (const t of tickers) {
        const sym = String(t.symbol || "").toUpperCase();
        if (wanted.has(sym)) {
          const price = Number(t.price);
          result[sym] = price;
          priceCache.set(sym, { price, ts: now });
        }
      }
    } catch (err) {
      console.error(`[Binance] Spot prices also failed: ${err.message}`);
    }
  }

  return result;
}

// ─── getAllTickerStats ────────────────────────────────────────────────────────
// For Market page — 24hr stats. Tries Futures, falls back to Spot.
async function getAllTickerStats() {
  // Try Futures
  const host = await resolveActiveHost();
  if (host) {
    try {
      const res = await makeFuturesClient(host).get("/fapi/v1/ticker/24hr");
      if (Array.isArray(res.data) && res.data.length > 10) return res.data;
    } catch (err) {
      console.warn(`[Binance] Futures 24hr stats failed: ${err.message}`);
      lastHostCheck = 0;
    }
  }

  // Fallback: Spot 24hr stats
  try {
    const res = await spotClient.get("/api/v3/ticker/24hr");
    if (Array.isArray(res.data)) return res.data;
  } catch (err) {
    console.error(`[Binance] Spot 24hr stats also failed: ${err.message}`);
  }

  return [];
}

// ─── Health check ─────────────────────────────────────────────────────────────
// Called by engine status endpoint — tells frontend if data is available
async function checkConnectivity() {
  const host = await resolveActiveHost();

  if (host) {
    return { connected: true, source: "FUTURES", host };
  }

  // Test spot as last resort
  try {
    await spotClient.get("/api/v3/ping", { timeout: 4000 });
    return { connected: true, source: "SPOT", host: SPOT_HOST };
  } catch {
    return { connected: false, source: null, host: null };
  }
}

module.exports = { getAllTickerStats, getKlines, getPrices, checkConnectivity };
