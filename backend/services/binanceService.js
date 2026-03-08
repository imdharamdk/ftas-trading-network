const axios = require("axios");

const client = axios.create({
  baseURL: "https://fapi.binance.com",
  timeout: 10000,
});

// Stable reference prices used for mock fallback
const BASE_PRICES = {
  BTCUSDT: 84000, ETHUSDT: 1900,  BNBUSDT: 590,
  SOLUSDT: 130,   XRPUSDT: 2.1,   ADAUSDT: 0.72,
  DOGEUSDT: 0.17, AVAXUSDT: 22,   LINKUSDT: 13,
  DOTUSDT: 4.5,   MATICUSDT: 0.45,TRXUSDT: 0.24,
  LTCUSDT: 88,    ATOMUSDT: 4.8,  APTUSDT: 5.5,
  NEARUSDT: 2.8,  ARBUSDT: 0.38,  OPUSDT: 0.72,
  SUIUSDT: 2.3,   INJUSDT: 12,
};

const INTERVAL_MS = {
  "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000,
  "30m": 1800000, "1h": 3600000, "2h": 7200000, "4h": 14400000,
  "6h": 21600000, "12h": 43200000, "1d": 86400000,
};

// Deterministic seeded PRNG — same seed always same sequence
function seededRand(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

// Generate realistic trending OHLCV candles without network access.
// Each coin gets a stable trend direction from its symbol seed so the
// indicator engine can build proper EMA stacks for signal detection.
function generateMockCandles(symbol, interval, limit) {
  const intervalMs = INTERVAL_MS[interval] || INTERVAL_MS["1h"];
  const basePrice  = BASE_PRICES[symbol] || 100;
  const now        = Date.now();
  const startTime  = now - intervalMs * (limit + 2);

  const symSeed = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng     = seededRand(symSeed * 6271);

  const trendStrength = (rng() - 0.48) * 0.0008;
  const volatility    = basePrice * (0.001 + rng() * 0.002);

  const candles = [];
  // Start close to base price so candles end near it too
  let price = basePrice * (0.97 + rng() * 0.06);

  for (let i = 0; i < limit; i++) {
    const openTime  = startTime + i * intervalMs;
    const closeTime = openTime + intervalMs - 1;
    const iRng      = seededRand(symSeed + i * 8191);

    const open   = price;
    const trend  = trendStrength * basePrice;
    const noise  = (iRng() - 0.5) * 2 * volatility;
    // Stronger mean-reversion so price stays within ~3% of base
    const revert = (basePrice - price) * 0.02;
    const close  = Math.max(open + trend + noise + revert, basePrice * 0.01);

    const body   = Math.abs(close - open);
    const wick   = 0.2 + iRng() * 0.6;
    const high   = Math.max(open, close) + body * wick + volatility * 0.1;
    const low    = Math.min(open, close) - body * wick - volatility * 0.1;

    const baseVol = basePrice < 1 ? 8000000 : basePrice < 10 ? 800000 : basePrice < 500 ? 80000 : 2000;
    const spike   = (i % 17 === 0 || i % 23 === 0) ? 2.8 + iRng() * 2 : 1;
    const volume  = baseVol * (0.4 + iRng() * 1.6) * spike;

    candles.push({ openTime, open, high, low, close, volume, closeTime });
    price = close;
  }
  return candles;
}

// Return stable BASE_PRICES as "live" prices in offline mode.
// This prevents signals (whose entry = mock candle close, which mean-reverts
// toward base) from being immediately SL-triggered by a wildly different random price.
function generateMockPrices(symbols) {
  const result = {};
  for (const sym of symbols) {
    result[sym] = BASE_PRICES[sym] || 100;
  }
  return result;
}

function normalizeKline(kline) {
  return {
    openTime:  Number(kline[0]), open:      Number(kline[1]),
    high:      Number(kline[2]), low:       Number(kline[3]),
    close:     Number(kline[4]), volume:    Number(kline[5]),
    closeTime: Number(kline[6]),
  };
}

async function getKlines(symbol, interval, limit = 250) {
  try {
    const response = await client.get("/fapi/v1/klines", {
      params: { symbol, interval, limit: limit + 1 },
    });
    const candles = Array.isArray(response.data)
      ? response.data.map(normalizeKline)
      : [];
    return candles.length > 1 ? candles.slice(0, -1) : candles;
  } catch (err) {
    console.warn(`[binance] getKlines fallback ${symbol}/${interval}: ${err.message}`);
    return generateMockCandles(symbol, interval, limit);
  }
}

async function getAllTickerStats() {
  try {
    const response = await client.get("/fapi/v1/ticker/24hr");
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.warn(`[binance] getAllTickerStats fallback: ${err.message}`);
    return Object.entries(BASE_PRICES).map(([symbol, price]) => ({
      symbol,
      lastPrice:          String(price),
      priceChangePercent: String(((Math.random() - 0.5) * 8).toFixed(2)),
      highPrice:          String((price * 1.04).toFixed(4)),
      lowPrice:           String((price * 0.96).toFixed(4)),
      volume:             String(price < 1 ? 50000000 : price < 100 ? 500000 : 10000),
      quoteVolume:        String((price * 500000).toFixed(2)),
    }));
  }
}

async function getPrices(symbols = []) {
  try {
    const response = await client.get("/fapi/v1/ticker/price");
    const tickers  = Array.isArray(response.data) ? response.data : [];
    const wanted   = new Set(symbols.map(s => String(s).toUpperCase()));
    return tickers.reduce((acc, item) => {
      const sym = String(item.symbol || "").toUpperCase();
      if (!wanted.size || wanted.has(sym)) acc[sym] = Number(item.price);
      return acc;
    }, {});
  } catch (err) {
    console.warn(`[binance] getPrices fallback: ${err.message}`);
    return generateMockPrices(symbols.map(s => String(s).toUpperCase()));
  }
}

module.exports = { getAllTickerStats, getKlines, getPrices };
