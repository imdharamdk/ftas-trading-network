const axios = require("axios");

const client = axios.create({
  baseURL: "https://fapi.binance.com",
  timeout: 15000,
});

// ─── Cache for exchange info (coins list) ─────────────────────────────────────
// Refresh every 10 minutes — new listings don't need instant detection
let _coinsCache     = null;
let _coinsCacheTime = 0;
const COINS_CACHE_TTL = 10 * 60 * 1000;

// ─── Price cache — prevent stale values ──────────────────────────────────────
// Binance /ticker/price can return cached values up to ~500ms old.
// We use /ticker/bookTicker (best bid/ask midpoint) for tighter real-time price.
let _priceCache     = {};
let _priceCacheTime = 0;
const PRICE_CACHE_TTL = 2000; // 2 seconds — refresh at most every 2s

// ─── Normalize kline array → object ──────────────────────────────────────────
function normalizeKline(kline) {
  return {
    openTime: Number(kline[0]),
    open:     Number(kline[1]),
    high:     Number(kline[2]),
    low:      Number(kline[3]),
    close:    Number(kline[4]),
    volume:   Number(kline[5]),
    closeTime: Number(kline[6]),
  };
}

// ─── Get all active USDT perpetual futures symbols ────────────────────────────
// Returns array like ["BTCUSDT", "ETHUSDT", ...]
// Filtered: only USDT pairs, only PERPETUAL contracts, only TRADING status
async function getAllFuturesCoins() {
  const now = Date.now();

  // Return cached list if still fresh
  if (_coinsCache && now - _coinsCacheTime < COINS_CACHE_TTL) {
    return _coinsCache;
  }

  try {
    const response = await client.get("/fapi/v1/exchangeInfo");
    const symbols = response.data?.symbols || [];

    const coins = symbols
      .filter(s =>
        s.quoteAsset === "USDT" &&
        s.contractType === "PERPETUAL" &&
        s.status === "TRADING"
      )
      .map(s => s.symbol)
      .sort();

    if (coins.length) {
      _coinsCache     = coins;
      _coinsCacheTime = now;
    }

    return coins;
  } catch (err) {
    console.error("[binanceService] getAllFuturesCoins failed:", err.message);
    // Fallback to a reasonable default list if API fails
    return _coinsCache || [
      "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
      "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
      "MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT",
      "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT",
    ];
  }
}

// ─── Fetch klines (OHLCV candles) ─────────────────────────────────────────────
// Drops the last (currently open) candle to avoid unfinished candle analysis
async function getKlines(symbol, interval, limit = 250) {
  try {
    const response = await client.get("/fapi/v1/klines", {
      params: { symbol, interval, limit: limit + 1 }, // +1 to drop unfinished
    });

    if (!Array.isArray(response.data) || response.data.length === 0) return [];

    // Drop last candle (still open / unfinished)
    const complete = response.data.slice(0, -1);
    return complete.map(normalizeKline);
  } catch (err) {
    console.error(`[binanceService] getKlines(${symbol}, ${interval}) failed:`, err.message);
    return [];
  }
}

// ─── Get real-time prices using bookTicker ─────────────────────────────────────
// bookTicker returns best bid/ask — midpoint is the most accurate real-time price.
// Falls back to /ticker/price if bookTicker fails.
// Result is cached for PRICE_CACHE_TTL to avoid hammering the API on bulk calls.
async function getPrices(symbols = []) {
  const now = Date.now();

  // Refresh price cache if stale
  if (now - _priceCacheTime > PRICE_CACHE_TTL) {
    try {
      // bookTicker = best bid + best ask (tightest spread, most accurate)
      const response = await client.get("/fapi/v1/ticker/bookTicker");
      const tickers  = Array.isArray(response.data) ? response.data : [];

      const fresh = {};
      for (const t of tickers) {
        const sym  = String(t.symbol || "").toUpperCase();
        const bid  = Number(t.bidPrice);
        const ask  = Number(t.askPrice);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          // Midpoint of bid/ask = most accurate market price
          fresh[sym] = (bid + ask) / 2;
        }
      }

      if (Object.keys(fresh).length > 0) {
        _priceCache     = fresh;
        _priceCacheTime = now;
      }
    } catch (bookTickerErr) {
      // Fallback: use /ticker/price
      try {
        const response = await client.get("/fapi/v1/ticker/price");
        const tickers  = Array.isArray(response.data) ? response.data : [];
        const fresh    = {};
        for (const t of tickers) {
          const sym   = String(t.symbol || "").toUpperCase();
          const price = Number(t.price);
          if (Number.isFinite(price) && price > 0) fresh[sym] = price;
        }
        if (Object.keys(fresh).length > 0) {
          _priceCache     = fresh;
          _priceCacheTime = now;
        }
      } catch (fallbackErr) {
        console.error("[binanceService] getPrices fallback also failed:", fallbackErr.message);
      }
    }
  }

  // If no specific symbols requested, return everything
  if (!symbols.length) return { ..._priceCache };

  // Return only requested symbols
  const wanted = new Set(symbols.map(s => String(s).toUpperCase()));
  const result = {};
  for (const sym of wanted) {
    if (Number.isFinite(_priceCache[sym])) {
      result[sym] = _priceCache[sym];
    }
  }
  return result;
}

// ─── Get price for a single symbol (most accurate — direct book ticker) ───────
async function getPrice(symbol) {
  const sym = String(symbol).toUpperCase();
  try {
    const response = await client.get("/fapi/v1/ticker/bookTicker", {
      params: { symbol: sym },
    });
    const bid = Number(response.data?.bidPrice);
    const ask = Number(response.data?.askPrice);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) {
      return (bid + ask) / 2;
    }
  } catch {}

  // Fallback: direct price ticker
  try {
    const r = await client.get("/fapi/v1/ticker/price", { params: { symbol: sym } });
    const p = Number(r.data?.price);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {}

  return null;
}

// ─── 24H stats for all tickers (used in analytics) ────────────────────────────
async function getAllTickerStats() {
  try {
    const response = await client.get("/fapi/v1/ticker/24hr");
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error("[binanceService] getAllTickerStats failed:", err.message);
    return [];
  }
}

module.exports = {
  getAllFuturesCoins,
  getAllTickerStats,
  getKlines,
  getPrice,
  getPrices,
};
