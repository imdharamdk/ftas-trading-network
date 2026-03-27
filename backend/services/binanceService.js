const axios = require("axios");

const BINANCE_FAPI = "https://fapi.binance.com";
const TIMEOUT = Number(process.env.EXCHANGE_TIMEOUT_MS || 15_000);
const EXCHANGE_RETRIES = Math.max(0, Number(process.env.EXCHANGE_RETRIES || 1));
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const binanceClient = axios.create({
  baseURL: BINANCE_FAPI,
  timeout: TIMEOUT,
});

let coinsCache = null;
let coinsCacheTime = 0;
const COINS_TTL = 10 * 60 * 1000;

let bookTickerCache = {};
let bookTickerCacheTime = 0;
const BOOK_TICKER_TTL = 2000;

const FALLBACK_FUTURES_COINS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "MATICUSDT", "TRXUSDT", "LTCUSDT", "ATOMUSDT", "APTUSDT",
  "NEARUSDT", "ARBUSDT", "OPUSDT", "SUIUSDT", "INJUSDT",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const status = error?.response?.status;
  const code = String(error?.code || "").toUpperCase();

  if (status === 403 || status === 418) {
    return false;
  }

  if (RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  return ["ECONNABORTED", "ECONNRESET", "ENETUNREACH", "EAI_AGAIN", "ETIMEDOUT"].includes(code);
}

async function requestWithRetry(config, label) {
  let lastError;

  for (let attempt = 0; attempt <= EXCHANGE_RETRIES; attempt += 1) {
    try {
      return await binanceClient.request(config);
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt === EXCHANGE_RETRIES) {
        throw error;
      }

      const waitMs = 500 * (attempt + 1);
      console.warn(`[dataService] ${label} retry ${attempt + 1}/${EXCHANGE_RETRIES} after: ${error.message}`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function normalizeBinanceKline(kline) {
  return {
    openTime: Number(kline[0]),
    open: Number(kline[1]),
    high: Number(kline[2]),
    low: Number(kline[3]),
    close: Number(kline[4]),
    volume: Number(kline[5]),
    closeTime: Number(kline[6]),
  };
}

function normalizeBookTicker(ticker = {}) {
  const symbol = String(ticker.symbol || "").toUpperCase();
  const bid = Number(ticker.bidPrice);
  const ask = Number(ticker.askPrice);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const spreadBps = mid && ask >= bid ? Number((((ask - bid) / mid) * 10_000).toFixed(2)) : null;
  return { symbol, bid, ask, mid, spreadBps };
}

async function refreshBookTickerCache(force = false) {
  const now = Date.now();
  if (!force && now - bookTickerCacheTime <= BOOK_TICKER_TTL && Object.keys(bookTickerCache).length) {
    return bookTickerCache;
  }

  try {
    const res = await requestWithRetry({ method: "get", url: "/fapi/v1/ticker/bookTicker" }, "Binance bookTicker");
    const tickers = Array.isArray(res.data) ? res.data : [];
    const fresh = {};

    for (const ticker of tickers) {
      const normalized = normalizeBookTicker(ticker);
      if (normalized.symbol && Number.isFinite(normalized.mid)) {
        fresh[normalized.symbol] = normalized;
      }
    }

    if (Object.keys(fresh).length > 0) {
      bookTickerCache = fresh;
      bookTickerCacheTime = now;
    }
  } catch (error) {
    console.error("[dataService] Binance bookTicker failed:", error.message);
  }

  return bookTickerCache;
}

async function getAllFuturesCoins() {
  const now = Date.now();
  if (coinsCache && now - coinsCacheTime < COINS_TTL) {
    return coinsCache;
  }

  try {
    const res = await requestWithRetry({ method: "get", url: "/fapi/v1/exchangeInfo" }, "Binance exchangeInfo");
    const symbols = Array.isArray(res.data?.symbols) ? res.data.symbols : [];
    const coins = symbols
      .filter((item) => item.quoteAsset === "USDT" && item.contractType === "PERPETUAL" && item.status === "TRADING")
      .map((item) => item.symbol)
      .sort();

    if (coins.length) {
      coinsCache = coins;
      coinsCacheTime = now;
      return coins;
    }
  } catch (error) {
    console.error("[dataService] Binance exchangeInfo failed:", error.message);
  }

  return coinsCache || FALLBACK_FUTURES_COINS;
}

async function getKlines(symbol, interval, limit = 250) {
  try {
    const res = await requestWithRetry({
      method: "get",
      url: "/fapi/v1/klines",
      params: { symbol, interval, limit: limit + 1 },
    }, `Binance getKlines(${symbol}, ${interval})`);

    if (!Array.isArray(res.data) || res.data.length === 0) {
      return [];
    }

    return res.data.slice(0, -1).map(normalizeBinanceKline);
  } catch (error) {
    console.error(`[dataService] Binance getKlines(${symbol}, ${interval}) failed:`, error.message);
    return [];
  }
}

async function getBookTickers(symbols = []) {
  const cache = await refreshBookTickerCache();
  if (!symbols.length) {
    return Object.values(cache).map((item) => ({ ...item }));
  }

  const wanted = new Set(symbols.map((symbol) => String(symbol).toUpperCase()));
  const result = [];
  for (const symbol of wanted) {
    if (cache[symbol]) {
      result.push({ ...cache[symbol] });
    }
  }
  return result;
}

async function getPrices(symbols = []) {
  const cache = await refreshBookTickerCache();
  const prices = {};
  for (const [symbol, item] of Object.entries(cache)) {
    if (Number.isFinite(item.mid)) {
      prices[symbol] = item.mid;
    }
  }

  if (!symbols.length) {
    return prices;
  }

  const wanted = new Set(symbols.map((symbol) => String(symbol).toUpperCase()));
  const result = {};
  for (const symbol of wanted) {
    if (Number.isFinite(prices[symbol])) {
      result[symbol] = prices[symbol];
    }
  }
  return result;
}

async function getPrice(symbol) {
  const normalizedSymbol = String(symbol || "").toUpperCase();
  const prices = await getPrices([normalizedSymbol]);
  if (Number.isFinite(prices[normalizedSymbol])) {
    return prices[normalizedSymbol];
  }

  try {
    const res = await requestWithRetry({
      method: "get",
      url: "/fapi/v1/ticker/bookTicker",
      params: { symbol: normalizedSymbol },
    }, `Binance getPrice(${normalizedSymbol})`);

    const normalized = normalizeBookTicker(res.data || {});
    if (Number.isFinite(normalized.mid)) {
      return normalized.mid;
    }
  } catch (error) {
    console.error(`[dataService] Binance getPrice(${normalizedSymbol}) failed:`, error.message);
  }

  return null;
}

async function getAllTickerStats() {
  try {
    const res = await requestWithRetry({ method: "get", url: "/fapi/v1/ticker/24hr" }, "Binance 24hr");
    return Array.isArray(res.data) ? res.data : [];
  } catch (error) {
    console.error("[dataService] Binance 24hr failed:", error.message);
    return [];
  }
}

module.exports = {
  getAllFuturesCoins,
  getAllTickerStats,
  getBookTickers,
  getKlines,
  getPrice,
  getPrices,
};
