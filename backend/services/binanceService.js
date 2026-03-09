const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
//  DATA SOURCE: Bybit V5 API only (Binance is IP-banned on Render cloud IPs)
//  Bybit has no geo-restrictions and supports all USDT perpetual pairs.
// ─────────────────────────────────────────────────────────────────────────────

const BYBIT_API = "https://api.bybit.com";
const TIMEOUT   = 15_000;

const bybitClient = axios.create({ baseURL: BYBIT_API, timeout: TIMEOUT });

// ─── Timeframe mapping: internal → Bybit interval ────────────────────────────
const TF_TO_BYBIT = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
  "1d": "D", "1w": "W", "1M": "M",
};

// ─── Simple delay helper ──────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Caches ───────────────────────────────────────────────────────────────────
let _coinsCache     = null;
let _coinsCacheTime = 0;
const COINS_TTL     = 10 * 60 * 1000;

let _priceCache     = {};
let _priceCacheTime = 0;
const PRICE_TTL     = 2000;

// ─── Normalize Bybit kline → standard object ──────────────────────────────────
// Bybit returns: [startTime, open, high, low, close, volume, turnover]
function normalizeBybitKline(k) {
  return {
    openTime:  Number(k[0]),
    open:      Number(k[1]),
    high:      Number(k[2]),
    low:       Number(k[3]),
    close:     Number(k[4]),
    volume:    Number(k[5]),
    closeTime: Number(k[0]) + 60000,
  };
}

// ─── Top coins list (used as fallback) ───────────────────────────────────────
const TOP_COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
  "TRXUSDT","LTCUSDT","ATOMUSDT","NEARUSDT","ARBUSDT",
  "OPUSDT","INJUSDT","SUIUSDT","APTUSDT","SEIUSDT",
  "TIAUSDT","WLDUSDT","JUPUSDT","PYTHUSDT","ONDOUSDT",
  "FETUSDT","RENDERUSDT","ARUSDT","ENAUSDT","EIGENUSDT",
  "AAVEUSDT","UNIUSDT","CRVUSDT","MKRUSDT","SNXUSDT",
  "GRTUSDT","FTMUSDT","SANDUSDT","MANAUSDT","AXSUSDT",
  "GALAUSDT","IMXUSDT","LDOUSDT","RNDRUSDT","STXUSDT",
  "CFXUSDT","BLURUSDT","MINAUSDT","ZILUSDT","1000PEPEUSDT",
];

// ─── getAllFuturesCoins ───────────────────────────────────────────────────────
async function getAllFuturesCoins() {
  const now = Date.now();
  if (_coinsCache && now - _coinsCacheTime < COINS_TTL) return _coinsCache;

  try {
    const res  = await bybitClient.get("/v5/market/instruments-info", {
      params: { category: "linear", limit: 1000 },
    });
    const list = res.data?.result?.list || [];
    const coins = list
      .filter(s => s.quoteCoin === "USDT" && s.status === "Trading" && s.contractType === "LinearPerpetual")
      .map(s => s.symbol)
      .sort();

    if (coins.length) {
      // Prioritize top coins — put them first so they get scanned first
      const topSet   = new Set(TOP_COINS);
      const priority = TOP_COINS.filter(c => coins.includes(c));
      const rest     = coins.filter(c => !topSet.has(c));
      _coinsCache     = [...priority, ...rest];
      _coinsCacheTime = now;
      console.log(`[dataService] Bybit: ${coins.length} USDT perp coins`);
      return _coinsCache;
    }
  } catch (err) {
    console.error("[dataService] getAllFuturesCoins failed:", err.message);
  }

  return _coinsCache || TOP_COINS;
}

// ─── getKlines ────────────────────────────────────────────────────────────────
async function getKlines(symbol, interval, limit = 250) {
  const bybitInterval = TF_TO_BYBIT[interval];
  if (!bybitInterval) return [];

  const needed = limit + 1;
  let allKlines = []; // newest-first while collecting

  try {
    // Page 1
    const res1 = await bybitClient.get("/v5/market/kline", {
      params: { category: "linear", symbol, interval: bybitInterval, limit: Math.min(200, needed) },
    });
    const list1 = res1.data?.result?.list;
    if (!Array.isArray(list1) || list1.length === 0) return [];
    allKlines.push(...list1);

    // Page 2 if needed (for 250 candles we need 2 pages of 200)
    if (allKlines.length < needed) {
      await delay(120); // small delay to avoid rate limit
      const oldestTime = Number(allKlines[allKlines.length - 1][0]) - 1;
      const stillNeed  = Math.min(200, needed - allKlines.length);
      const res2 = await bybitClient.get("/v5/market/kline", {
        params: { category: "linear", symbol, interval: bybitInterval, limit: stillNeed, end: oldestTime },
      });
      const list2 = res2.data?.result?.list;
      if (Array.isArray(list2) && list2.length > 0) allKlines.push(...list2);
    }

    // Reverse to oldest-first, normalize, drop last open candle
    allKlines.reverse();
    return allKlines.map(normalizeBybitKline).slice(0, -1);

  } catch (err) {
    console.error(`[dataService] getKlines(${symbol}, ${interval}) failed:`, err.message);
    return [];
  }
}

// ─── getPrices ────────────────────────────────────────────────────────────────
async function getPrices(symbols = []) {
  const now = Date.now();

  if (now - _priceCacheTime > PRICE_TTL) {
    try {
      const res  = await bybitClient.get("/v5/market/tickers", { params: { category: "linear" } });
      const list = res.data?.result?.list || [];
      const fresh = {};
      for (const t of list) {
        const sym   = String(t.symbol || "").toUpperCase();
        const price = Number(t.lastPrice);
        if (price > 0) fresh[sym] = price;
      }
      if (Object.keys(fresh).length > 0) {
        _priceCache     = fresh;
        _priceCacheTime = now;
      }
    } catch (err) {
      console.error("[dataService] getPrices failed:", err.message);
    }
  }

  if (!symbols.length) return { ..._priceCache };
  const result = {};
  for (const sym of symbols.map(s => s.toUpperCase())) {
    if (_priceCache[sym]) result[sym] = _priceCache[sym];
  }
  return result;
}

// ─── getPrice ─────────────────────────────────────────────────────────────────
async function getPrice(symbol) {
  const sym = String(symbol).toUpperCase();
  try {
    const res   = await bybitClient.get("/v5/market/tickers", {
      params: { category: "linear", symbol: sym },
    });
    const price = Number(res.data?.result?.list?.[0]?.lastPrice);
    if (price > 0) return price;
  } catch (err) {
    console.error(`[dataService] getPrice(${sym}) failed:`, err.message);
  }
  return null;
}

// ─── getAllTickerStats ────────────────────────────────────────────────────────
async function getAllTickerStats() {
  try {
    const res  = await bybitClient.get("/v5/market/tickers", { params: { category: "linear" } });
    const list = res.data?.result?.list || [];
    return list.map(t => ({
      symbol:             t.symbol,
      lastPrice:          t.lastPrice,
      priceChangePercent: t.price24hPcnt ? (Number(t.price24hPcnt) * 100).toFixed(2) : "0",
      volume:             t.volume24h,
      quoteVolume:        t.turnover24h,
      highPrice:          t.highPrice24h,
      lowPrice:           t.lowPrice24h,
    }));
  } catch (err) {
    console.error("[dataService] getAllTickerStats failed:", err.message);
    return [];
  }
}

module.exports = { getAllFuturesCoins, getAllTickerStats, getKlines, getPrice, getPrices };

// ─────────────────────────────────────────────────────────────────────────────
//  DATA SOURCE STRATEGY
//
//  Render / cloud IPs are IP-banned (418) by Binance Futures (fapi.binance.com).
//  Solution: Use Bybit V5 API as primary fallback — no IP restrictions,
//  same USDT perpetual pairs, same OHLCV format, free & reliable.
//
//  Priority:
//    1. fapi.binance.com        (works if not banned)
//    2. Bybit v5 linear futures (always works on Render)
// ─────────────────────────────────────────────────────────────────────────────

const BINANCE_FAPI = "https://fapi.binance.com";
const BYBIT_API    = "https://api.bybit.com";
const TIMEOUT      = 12_000;

const binanceClient = axios.create({ baseURL: BINANCE_FAPI, timeout: TIMEOUT });
const bybitClient   = axios.create({ baseURL: BYBIT_API,    timeout: TIMEOUT });

// Track if Binance is currently banned (reset every 10 min to retry)
let _binanceBanned     = false;
let _binanceBannedAt   = 0;
const BAN_RETRY_MS     = 10 * 60 * 1000; // retry Binance after 10 min

function isBinanceAvailable() {
  if (!_binanceBanned) return true;
  if (Date.now() - _binanceBannedAt > BAN_RETRY_MS) {
    _binanceBanned = false; // retry
    return true;
  }
  return false;
}

function markBinanceBanned() {
  if (!_binanceBanned) {
    console.warn("[dataService] Binance IP banned (418) — switching to Bybit");
    _binanceBanned   = true;
    _binanceBannedAt = Date.now();
  }
}

// ─── Timeframe mapping: Binance → Bybit ──────────────────────────────────────
const TF_TO_BYBIT = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
  "1d": "D", "1w": "W", "1M": "M",
};

// ─── Caches ───────────────────────────────────────────────────────────────────
let _coinsCache     = null;
let _coinsCacheTime = 0;
const COINS_TTL     = 10 * 60 * 1000;

let _priceCache     = {};
let _priceCacheTime = 0;
const PRICE_TTL     = 2000;

// ─── Normalize Binance kline array → object ───────────────────────────────────
function normalizeBinanceKline(k) {
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

// ─── Normalize Bybit kline → same object ──────────────────────────────────────
// Bybit returns: [startTime, open, high, low, close, volume, turnover]
function normalizeBybitKline(k) {
  return {
    openTime:  Number(k[0]),
    open:      Number(k[1]),
    high:      Number(k[2]),
    low:       Number(k[3]),
    close:     Number(k[4]),
    volume:    Number(k[5]),
    closeTime: Number(k[0]) + 60000, // approximate
  };
}

// ─── getAllFuturesCoins ───────────────────────────────────────────────────────
async function getAllFuturesCoins() {
  const now = Date.now();
  if (_coinsCache && now - _coinsCacheTime < COINS_TTL) return _coinsCache;

  // Try Binance first
  if (isBinanceAvailable()) {
    try {
      const res     = await binanceClient.get("/fapi/v1/exchangeInfo");
      const symbols = res.data?.symbols || [];
      const coins   = symbols
        .filter(s => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
        .map(s => s.symbol)
        .sort();
      if (coins.length) {
        _coinsCache     = coins;
        _coinsCacheTime = now;
        return coins;
      }
    } catch (err) {
      if (err?.response?.status === 418 || err?.response?.status === 403) markBinanceBanned();
      else console.warn("[dataService] Binance exchangeInfo failed:", err.message);
    }
  }

  // Bybit fallback — get all linear (USDT perpetual) instruments
  try {
    const res    = await bybitClient.get("/v5/market/instruments-info", {
      params: { category: "linear", limit: 1000 },
    });
    const list   = res.data?.result?.list || [];
    const coins  = list
      .filter(s => s.quoteCoin === "USDT" && s.status === "Trading" && s.contractType === "LinearPerpetual")
      .map(s => s.symbol)
      .sort();
    if (coins.length) {
      _coinsCache     = coins;
      _coinsCacheTime = now;
      console.log(`[dataService] Bybit returned ${coins.length} USDT perp coins`);
      return coins;
    }
  } catch (err) {
    console.error("[dataService] Bybit exchangeInfo also failed:", err.message);
  }

  // Final hardcoded fallback
  return _coinsCache || [
    "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
    "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
    "MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT",
    "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT",
  ];
}

// ─── getKlines ────────────────────────────────────────────────────────────────
async function getKlines(symbol, interval, limit = 250) {

  // 1) Try Binance
  if (isBinanceAvailable()) {
    try {
      const res = await binanceClient.get("/fapi/v1/klines", {
        params: { symbol, interval, limit: limit + 1 },
      });
      if (Array.isArray(res.data) && res.data.length > 0) {
        return res.data.slice(0, -1).map(normalizeBinanceKline);
      }
    } catch (err) {
      const code = err?.response?.status;
      if (code === 418 || code === 403) {
        markBinanceBanned();
      } else {
        console.warn(`[dataService] Binance getKlines(${symbol}, ${interval}) failed: ${err.message}`);
      }
    }
  }

  // 2) Bybit fallback
  try {
    const bybitInterval = TF_TO_BYBIT[interval];
    if (!bybitInterval) {
      console.warn(`[dataService] No Bybit mapping for interval "${interval}"`);
      return [];
    }

    // Bybit returns newest-first, max 200 per request
    // We fetch in pages going backwards in time using 'end' param
    const perPage   = 200;
    const needed    = limit + 1; // +1 to drop open candle later
    let   allKlines = []; // will be newest-first while collecting

    // Page 1: latest candles
    const res1 = await bybitClient.get("/v5/market/kline", {
      params: { category: "linear", symbol, interval: bybitInterval, limit: Math.min(perPage, needed) },
    });
    const list1 = res1.data?.result?.list;
    if (!Array.isArray(list1) || list1.length === 0) return [];
    allKlines.push(...list1); // newest first

    // Page 2+ if we still need more
    while (allKlines.length < needed) {
      const oldest  = allKlines[allKlines.length - 1]; // oldest so far (last in newest-first array)
      const endTime = Number(oldest[0]) - 1;           // go back 1ms before oldest
      const stillNeed = Math.min(perPage, needed - allKlines.length);

      const resN = await bybitClient.get("/v5/market/kline", {
        params: { category: "linear", symbol, interval: bybitInterval, limit: stillNeed, end: endTime },
      });
      const listN = resN.data?.result?.list;
      if (!Array.isArray(listN) || listN.length === 0) break;
      allKlines.push(...listN);
      if (listN.length < stillNeed) break;
    }

    if (allKlines.length === 0) return [];

    // Reverse to oldest-first, normalize, drop last open candle
    allKlines.reverse();
    const normalized = allKlines.map(normalizeBybitKline);
    return normalized.slice(0, -1);

  } catch (err) {
    console.error(`[dataService] Bybit getKlines(${symbol}, ${interval}) failed:`, err.message);
    return [];
  }
}

// ─── getPrices ────────────────────────────────────────────────────────────────
async function getPrices(symbols = []) {
  const now = Date.now();

  if (now - _priceCacheTime > PRICE_TTL) {

    // 1) Try Binance bookTicker
    if (isBinanceAvailable()) {
      try {
        const res    = await binanceClient.get("/fapi/v1/ticker/bookTicker");
        const tickers = Array.isArray(res.data) ? res.data : [];
        const fresh  = {};
        for (const t of tickers) {
          const sym = String(t.symbol || "").toUpperCase();
          const bid = Number(t.bidPrice);
          const ask = Number(t.askPrice);
          if (bid > 0 && ask > 0) fresh[sym] = (bid + ask) / 2;
        }
        if (Object.keys(fresh).length > 0) {
          _priceCache     = fresh;
          _priceCacheTime = now;
        }
      } catch (err) {
        if (err?.response?.status === 418 || err?.response?.status === 403) markBinanceBanned();
      }
    }

    // 2) Bybit tickers if cache still empty
    if (Object.keys(_priceCache).length === 0 || _priceCacheTime !== now) {
      try {
        const res  = await bybitClient.get("/v5/market/tickers", { params: { category: "linear" } });
        const list = res.data?.result?.list || [];
        const fresh = {};
        for (const t of list) {
          const sym   = String(t.symbol || "").toUpperCase();
          const price = Number(t.lastPrice);
          if (price > 0) fresh[sym] = price;
        }
        if (Object.keys(fresh).length > 0) {
          _priceCache     = { ..._priceCache, ...fresh }; // merge, Binance wins for overlap
          _priceCacheTime = now;
          console.log(`[dataService] Bybit prices loaded (${Object.keys(fresh).length} symbols)`);
        }
      } catch (err) {
        console.error("[dataService] Bybit getPrices failed:", err.message);
      }
    }
  }

  if (!symbols.length) return { ..._priceCache };

  const wanted = new Set(symbols.map(s => String(s).toUpperCase()));
  const result = {};
  for (const sym of wanted) {
    if (Number.isFinite(_priceCache[sym])) result[sym] = _priceCache[sym];
  }
  return result;
}

// ─── getPrice (single symbol) ─────────────────────────────────────────────────
async function getPrice(symbol) {
  const sym = String(symbol).toUpperCase();

  if (isBinanceAvailable()) {
    try {
      const res = await binanceClient.get("/fapi/v1/ticker/bookTicker", { params: { symbol: sym } });
      const bid = Number(res.data?.bidPrice);
      const ask = Number(res.data?.askPrice);
      if (bid > 0 && ask > 0) return (bid + ask) / 2;
    } catch (err) {
      if (err?.response?.status === 418 || err?.response?.status === 403) markBinanceBanned();
    }
  }

  // Bybit single ticker
  try {
    const res   = await bybitClient.get("/v5/market/tickers", {
      params: { category: "linear", symbol: sym },
    });
    const price = Number(res.data?.result?.list?.[0]?.lastPrice);
    if (price > 0) return price;
  } catch (err) {
    console.error(`[dataService] Bybit getPrice(${sym}) failed:`, err.message);
  }

  return null;
}

// ─── getAllTickerStats ────────────────────────────────────────────────────────
async function getAllTickerStats() {
  if (isBinanceAvailable()) {
    try {
      const res = await binanceClient.get("/fapi/v1/ticker/24hr");
      if (Array.isArray(res.data)) return res.data;
    } catch (err) {
      if (err?.response?.status === 418 || err?.response?.status === 403) markBinanceBanned();
    }
  }

  // Bybit 24hr stats — map to Binance-compatible shape
  try {
    const res  = await bybitClient.get("/v5/market/tickers", { params: { category: "linear" } });
    const list = res.data?.result?.list || [];
    return list.map(t => ({
      symbol:             t.symbol,
      lastPrice:          t.lastPrice,
      priceChangePercent: t.price24hPcnt ? (Number(t.price24hPcnt) * 100).toFixed(2) : "0",
      volume:             t.volume24h,
      quoteVolume:        t.turnover24h,
      highPrice:          t.highPrice24h,
      lowPrice:           t.lowPrice24h,
    }));
  } catch (err) {
    console.error("[dataService] getAllTickerStats Bybit failed:", err.message);
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
