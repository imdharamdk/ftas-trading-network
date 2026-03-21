const express = require("express");
const { getAllFuturesCoins, getAllTickerStats, getKlines } = require("../services/binanceService");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const cache  = require("../services/apiCache");
const SORTABLE_TICKER_FIELDS = new Set(["changePercent", "highPrice", "lowPrice", "price", "quoteVolume", "volume"]);

function normalizeTicker(ticker) {
  return {
    symbol: String(ticker.symbol || "").toUpperCase(),
    price: Number(ticker.lastPrice || 0),
    changePercent: Number(ticker.priceChangePercent || 0),
    highPrice: Number(ticker.highPrice || 0),
    lowPrice: Number(ticker.lowPrice || 0),
    volume: Number(ticker.volume || 0),
    quoteVolume: Number(ticker.quoteVolume || 0),
  };
}

function toLiteTicker(ticker) {
  return {
    symbol: ticker.symbol,
    price: ticker.price,
    changePercent: ticker.changePercent,
    highPrice: ticker.highPrice,
    lowPrice: ticker.lowPrice,
    quoteVolume: ticker.quoteVolume,
  };
}

// ─── Klines endpoint for frontend chart ───────────────────────────────────────
router.get("/klines", requireAuth, async (req, res) => {
  try {
    const symbol   = String(req.query.symbol || "BTCUSDT").toUpperCase();
    const interval = String(req.query.interval || "15m");
    const limit    = Math.min(Number(req.query.limit || 200), 500);

    const candles = await getKlines(symbol, interval, limit);
    return res.json({ symbol, interval, candles });
  } catch (error) {
    return res.status(500).json({ message: error.message, candles: [] });
  }
});

router.get("/tickers", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 5), 500);
    const requestedSort = String(req.query.sort || "quoteVolume");
    const sortBy = SORTABLE_TICKER_FIELDS.has(requestedSort) ? requestedSort : "quoteVolume";
    const fields = String(req.query.fields || "full").toLowerCase();

    // Cache tickers for 30s — Bybit API is slow and called on every Market page load
    const cacheKey = "market:tickers:" + sortBy;
    const cachedAll = cache.get(cacheKey);
    const allTickers = cachedAll || await (async () => {
      const raw = await getAllTickerStats();
      const result = raw.map(normalizeTicker).filter(t => t.symbol.endsWith("USDT"));
      cache.set(cacheKey, result, 30);
      return result;
    })();

    const normalized = [...allTickers]
      .sort((l, r) => Number(r[sortBy] || 0) - Number(l[sortBy] || 0))
      .slice(0, limit);

    const tickers = fields === "lite" ? normalized.map(toLiteTicker) : normalized;

    // Allow short-lived browser caching despite global no-store
    res.set("Cache-Control", "public, max-age=15");
    return res.json({ source: "BINANCE_FUTURES", tickers });
  } catch (error) {
    return res.status(503).json({ message: error.message, source: "BINANCE_FUTURES", tickers: [] });
  }
});

router.get("/coins", async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || 0);
    const cached = cache.get("market:coins");
    const coins  = cached || await (async () => {
      const c = await getAllFuturesCoins();
      cache.set("market:coins", c, 120); // 2 min — coin list rarely changes
      return c;
    })();
    res.set("Cache-Control", "public, max-age=120");
    return res.json({
      coins: requestedLimit > 0 ? coins.slice(0, requestedLimit) : coins,
      source: "BINANCE_FUTURES",
    });
  } catch (error) {
    return res.status(503).json({ coins: [], message: error.message, source: "BINANCE_FUTURES" });
  }
});

module.exports = router;
