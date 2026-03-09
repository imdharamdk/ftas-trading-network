const express = require("express");
const { getAllTickerStats, getKlines } = require("../services/binanceService");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

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
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 5), 50);
    const sortBy = String(req.query.sort || "quoteVolume");
    const tickers = await getAllTickerStats();

    const normalized = tickers
      .map(normalizeTicker)
      .filter((ticker) => ticker.symbol.endsWith("USDT"))
      .sort((left, right) => {
        const leftValue = Number(left[sortBy] || 0);
        const rightValue = Number(right[sortBy] || 0);
        return rightValue - leftValue;
      })
      .slice(0, limit);

    return res.json({
      source: "BINANCE_FUTURES",
      tickers: normalized,
    });
  } catch (error) {
    return res.status(503).json({
      message: error.message,
      source: "BINANCE_FUTURES",
      tickers: [],
    });
  }
});

module.exports = router;
