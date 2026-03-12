const express = require("express");
const axios = require("axios");
const { requireAdmin, requireAuth, requireSignalAccess } = require("../middleware/auth");
const { SIGNAL_STATUS } = require("../models/Signal");
const { readCollection } = require("../storage/fileStore");
const stockEngine = require("../services/stockSignalEngine");
const { ensureSession } = require("../services/smartApiService");
const { getInstrumentUniverse } = require("../services/smartInstrumentService");

const router = express.Router();

function isWinningResult(result) {
  return ["TP1_HIT", "TP2_HIT", "TP3_HIT"].includes(result);
}

function sortByCreatedAtDesc(records) {
  return [...records].sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

function buildOverview(signals) {
  const activeSignals   = signals.filter((s) => s.status === SIGNAL_STATUS.ACTIVE);
  const allClosed       = signals.filter((s) => s.status === SIGNAL_STATUS.CLOSED);
  const resolvedSignals = allClosed.filter((s) => s.result !== "EXPIRED");
  const expiredSignals  = allClosed.filter((s) => s.result === "EXPIRED");
  const wins            = resolvedSignals.filter((s) => isWinningResult(s.result));
  const losses          = resolvedSignals.filter((s) => s.result === "SL_HIT");
  const longs           = signals.filter((s) => s.side === "LONG");
  const shorts          = signals.filter((s) => s.side === "SHORT");
  const activeSrc       = activeSignals.length ? activeSignals : signals;
  const avgConfidence   = activeSrc.length
    ? activeSrc.reduce((sum, s) => sum + Number(s.confidence || 0), 0) / activeSrc.length
    : 0;
  return {
    activeSignals:     activeSignals.length,
    closedSignals:     resolvedSignals.length,
    expiredSignals:    expiredSignals.length,
    totalSignals:      signals.length,
    totalWins:         wins.length,
    totalLosses:       losses.length,
    strongSignals:     signals.filter((s) => Number(s.confidence || 0) >= 90).length,
    longSignals:       longs.length,
    shortSignals:      shorts.length,
    averageConfidence: Number(avgConfidence.toFixed(1)),
    winRate: resolvedSignals.length
      ? Number(((wins.length / resolvedSignals.length) * 100).toFixed(1))
      : 0,
  };
}

function buildAnalytics(signals) {
  const recent = sortByCreatedAtDesc(signals).slice(0, 12).reverse();
  const timeframeCounts = {};
  const statusCounts = {};
  const directionCounts = { LONG: 0, SHORT: 0 };
  const confidenceBands = { low: 0, medium: 0, strong: 0 };

  signals.forEach((signal) => {
    timeframeCounts[signal.timeframe] = (timeframeCounts[signal.timeframe] || 0) + 1;
    statusCounts[signal.status] = (statusCounts[signal.status] || 0) + 1;
    directionCounts[signal.side] = (directionCounts[signal.side] || 0) + 1;

    if (signal.confidence >= 80) confidenceBands.strong += 1;
    else if (signal.confidence >= 65) confidenceBands.medium += 1;
    else confidenceBands.low += 1;
  });

  return {
    recentConfidence: recent.map((signal) => ({
      coin: signal.coin,
      confidence: signal.confidence,
      createdAt: signal.createdAt,
      side: signal.side,
      timeframe: signal.timeframe,
    })),
    timeframeMix: Object.entries(timeframeCounts).map(([label, value]) => ({ label, value })),
    statusMix: Object.entries(statusCounts).map(([label, value]) => ({ label, value })),
    directionMix: Object.entries(directionCounts).map(([label, value]) => ({ label, value })),
    confidenceBands: Object.entries(confidenceBands).map(([label, value]) => ({ label, value })),
  };
}

function buildBucketLabel(confidence) {
  if (confidence >= 85) return "85+";
  if (confidence >= 75) return "75-84";
  if (confidence >= 65) return "65-74";
  return "55-64";
}

function summarizePerformanceGroup(signals, labelAccessor) {
  const groups = new Map();

  signals.forEach((signal) => {
    const label = labelAccessor(signal);
    const current = groups.get(label) || {
      label,
      losses: 0,
      total: 0,
      wins: 0,
    };

    current.total += 1;

    if (signal.result === "SL_HIT") {
      current.losses += 1;
    } else if (isWinningResult(signal.result)) {
      current.wins += 1;
    }

    groups.set(label, current);
  });

  return [...groups.values()]
    .map((group) => ({
      ...group,
      winRate: group.total ? Number(((group.wins / group.total) * 100).toFixed(1)) : 0,
    }))
    .sort((left, right) => right.total - left.total);
}

function buildPerformance(signals) {
  const closedSignals = sortByCreatedAtDesc(signals).filter((signal) => signal.status !== SIGNAL_STATUS.ACTIVE);
  const completedSignals = closedSignals;
  const summary = {
    avgConfidence: completedSignals.length
      ? Number((completedSignals.reduce((sum, signal) => sum + Number(signal.confidence || 0), 0) / completedSignals.length).toFixed(1))
      : 0,
    losses: closedSignals.filter((signal) => signal.result === "SL_HIT").length,
    totalClosed: closedSignals.length,
    wins: closedSignals.filter((signal) => isWinningResult(signal.result)).length,
  };

  summary.winRate = completedSignals.length ? Number(((summary.wins / completedSignals.length) * 100).toFixed(1)) : 0;

  const timeframeBreakdown = summarizePerformanceGroup(closedSignals, (signal) => signal.timeframe || "unknown");
  const sideBreakdown = summarizePerformanceGroup(closedSignals, (signal) => signal.side || "unknown");
  const confidenceBreakdown = summarizePerformanceGroup(closedSignals, (signal) => buildBucketLabel(Number(signal.confidence || 0)));
  const sourceBreakdown = summarizePerformanceGroup(closedSignals, (signal) => signal.source || "unknown");

  return {
    summary,
    timeframeBreakdown,
    sideBreakdown,
    confidenceBreakdown,
    sourceBreakdown,
    troubleCoins: [],
    recommendations: [],
  };
}

router.get("/active", requireAuth, requireSignalAccess, async (req, res) => {
  const signals = await readCollection("stockSignals");
  const filtered = sortByCreatedAtDesc(signals)
    .filter((signal) => signal.status === SIGNAL_STATUS.ACTIVE)
    .filter((signal) => !req.query.coin || signal.coin === String(req.query.coin).toUpperCase());

  return res.json({
    signals: filtered.slice(0, Number(req.query.limit || 50)),
  });
});

router.get("/history", requireAuth, requireSignalAccess, async (req, res) => {
  const signals = await readCollection("stockSignals");
  const filtered = sortByCreatedAtDesc(signals)
    .filter((signal) => signal.status !== SIGNAL_STATUS.ACTIVE)
    .filter((signal) => !req.query.coin || signal.coin === String(req.query.coin).toUpperCase());

  return res.json({
    signals: req.query.limit ? filtered.slice(0, Number(req.query.limit)) : filtered,
  });
});

router.get("/stats/overview", requireAuth, async (req, res) => {
  const signals = await readCollection("stockSignals");
  return res.json({
    stats: buildOverview(signals),
  });
});

router.get("/stats/analytics", requireAuth, async (req, res) => {
  const signals = await readCollection("stockSignals");
  return res.json({
    analytics: buildAnalytics(signals),
  });
});

router.get("/stats/performance", requireAuth, async (req, res) => {
  const signals = await readCollection("stockSignals");
  return res.json({
    performance: buildPerformance(signals),
  });
});

router.get("/engine/status", requireAuth, (_req, res) => {
  return res.json({
    engine: stockEngine.getStatus(),
  });
});

router.post("/engine/start", requireAuth, requireAdmin, (_req, res) => {
  return res.json({
    engine: stockEngine.start(),
  });
});

router.post("/engine/stop", requireAuth, requireAdmin, (_req, res) => {
  return res.json({
    engine: stockEngine.stop(),
  });
});

router.post("/scan", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const result = await stockEngine.scanNow();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// ── Live prices for stock signals ────────────────────────────────────────────
async function fetchStockLivePrices(coins) {
  if (!coins.length) return {};

  const universe = getInstrumentUniverse();
  const tokenMap = {};
  for (const inst of universe) {
    const key = (inst.symbol || inst.tradingSymbol || "").toUpperCase();
    if (key) tokenMap[key] = { exchange: inst.exchange, token: String(inst.token) };
  }

  // Group by exchange
  const byExchange = {};
  const tokenToCoin = {};
  for (const coin of coins) {
    const info = tokenMap[coin];
    if (!info) continue;
    if (!byExchange[info.exchange]) byExchange[info.exchange] = [];
    byExchange[info.exchange].push(info.token);
    tokenToCoin[info.token] = coin;
  }

  if (!Object.keys(byExchange).length) return {};

  const baseUrl = process.env.SMART_API_BASE_URL || "https://apiconnect.angelone.in";
  const token = await ensureSession();

  const resp = await axios.post(
    `${baseUrl}/rest/secure/angelbroking/market/v1/quote/`,
    { mode: "OHLC", exchangeTokens: byExchange },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-PrivateKey": process.env.SMART_API_KEY,
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        Authorization: `Bearer ${token}`,
      },
      timeout: 8000,
    }
  );

  const priceMap = {};
  for (const item of resp.data?.data?.fetched || []) {
    const coinName = tokenToCoin[String(item.symbolToken)];
    // ltp = live during market hours, close = last closing price when market closed
    const price = Number(item.ltp) || Number(item.close);
    if (coinName && Number.isFinite(price) && price > 0) {
      priceMap[coinName] = price;
    }
  }
  return priceMap;
}

// ── All instruments list (for Scanner page) ───────────────────────────────────
router.get("/instruments", requireAuth, requireSignalAccess, (req, res) => {
  try {
    const universe = getInstrumentUniverse({ limit: 5000 });
    return res.json({ instruments: universe });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/live-prices", requireAuth, requireSignalAccess, async (req, res) => {
  try {
    const coins = String(req.query.coins || "")
      .split(",")
      .map(c => c.trim().toUpperCase())
      .filter(Boolean);

    if (!coins.length) return res.json({ prices: [] });

    const priceMap = await fetchStockLivePrices([...new Set(coins)]);
    const liveUpdatedAt = new Date().toISOString();

    return res.json({
      prices: coins.map(coin => ({
        coin,
        livePrice: Number.isFinite(priceMap[coin]) ? priceMap[coin] : null,
        liveUpdatedAt,
      })),
    });
  } catch (err) {
    console.error("[stocks/live-prices] Error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
