const express = require("express");
const axios = require("axios");
const { requireAdmin, requireAuth, requireSignalAccess } = require("../middleware/auth");
const { SIGNAL_STATUS } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const stockEngine = require("../services/stockSignalEngine");
const { ensureSession } = require("../services/smartApiService");
const { getInstrumentUniverse } = require("../services/smartInstrumentService");

const router = express.Router();

// ─── Stock signal expiry config ───────────────────────────────────────────────
const SIGNAL_EXPIRY_MS = {
  "1m":  8  * 60 * 1000,
  "5m":  25 * 60 * 1000,
  "15m": 90 * 60 * 1000,
  "30m": 3  * 60 * 60 * 1000,
  "1h":  6  * 60 * 60 * 1000,
  "4h":  24 * 60 * 60 * 1000,
  default: 6 * 60 * 60 * 1000,
};

function isTimeExpired(signal) {
  if (!signal.createdAt) return false;
  const age = Date.now() - new Date(signal.createdAt).getTime();
  return age > (SIGNAL_EXPIRY_MS[signal.timeframe] || SIGNAL_EXPIRY_MS.default);
}

async function expireStaleActives() {
  const now = new Date().toISOString();
  await mutateCollection("stockSignals", (records) =>
    records.map((sig) => {
      if (sig.status !== SIGNAL_STATUS.ACTIVE || !isTimeExpired(sig)) return sig;
      return { ...sig, status: SIGNAL_STATUS.CLOSED, result: "EXPIRED", closedAt: now, updatedAt: now };
    })
  );
}

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

// ─── Crypto filter — stockSignals collection mein kabhi crypto nahi dikhna chahiye ──
// Crypto coins USDT mein end hote hain (BTCUSDT, ETHUSDT etc.)
// Stock symbols kabhi USDT mein end nahi hote
function isCryptoCoin(coin) {
  return String(coin || "").toUpperCase().endsWith("USDT");
}

router.get("/active", requireAuth, requireSignalAccess, async (req, res) => {
  await expireStaleActives();
  const signals = await readCollection("stockSignals");
  const filtered = sortByCreatedAtDesc(signals)
    .filter((signal) => signal.status === SIGNAL_STATUS.ACTIVE)
    .filter((signal) => !isCryptoCoin(signal.coin))
    .filter((signal) => !req.query.coin || signal.coin === String(req.query.coin).toUpperCase());

  return res.json({
    signals: filtered.slice(0, Number(req.query.limit || 50)),
  });
});

router.get("/history", requireAuth, requireSignalAccess, async (req, res) => {
  const signals = await readCollection("stockSignals");
  // History = TP/SL hits only — no expired
  const filtered = sortByCreatedAtDesc(signals)
    .filter((signal) => signal.status === SIGNAL_STATUS.CLOSED && signal.result !== "EXPIRED")
    .filter((signal) => !isCryptoCoin(signal.coin))
    .filter((signal) => !req.query.coin || signal.coin === String(req.query.coin).toUpperCase());

  return res.json({
    signals: req.query.limit ? filtered.slice(0, Number(req.query.limit)) : filtered,
  });
});

router.get("/expired", requireAuth, requireSignalAccess, async (req, res) => {
  await expireStaleActives();
  const signals = await readCollection("stockSignals");
  const filtered = sortByCreatedAtDesc(signals)
    .filter((signal) => signal.result === "EXPIRED")
    .filter((signal) => !isCryptoCoin(signal.coin))
    .filter((signal) => !req.query.coin || signal.coin === String(req.query.coin).toUpperCase());

  return res.json({
    signals: req.query.limit ? filtered.slice(0, Number(req.query.limit)) : filtered,
  });
});

// ─── Admin: purge crypto signals from stockSignals collection ─────────────────
router.post("/admin/purge-crypto", requireAuth, requireAdmin, async (req, res) => {
  try {
    let removed = 0;
    await mutateCollection("stockSignals", (records) => {
      const clean = records.filter((s) => !isCryptoCoin(s.coin));
      removed = records.length - clean.length;
      return clean;
    });
    return res.json({ success: true, removed, message: `Removed ${removed} crypto signal(s) from stockSignals collection` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/stats/overview", requireAuth, async (req, res) => {
  const raw = await readCollection("stockSignals");
  const signals = raw.filter((s) => !isCryptoCoin(s.coin));
  return res.json({
    stats: buildOverview(signals),
  });
});

router.get("/stats/analytics", requireAuth, async (req, res) => {
  const raw = await readCollection("stockSignals");
  const signals = raw.filter((s) => !isCryptoCoin(s.coin));
  return res.json({
    analytics: buildAnalytics(signals),
  });
});

router.get("/stats/performance", requireAuth, async (req, res) => {
  const raw = await readCollection("stockSignals");
  const signals = raw.filter((s) => !isCryptoCoin(s.coin));
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
    // inst.symbol may be "NSE:RELIANCE", inst.tradingSymbol may be "RELIANCE"
    // Build map entries for BOTH so signal.coin always matches
    const tradingKey = (inst.tradingSymbol || "").toUpperCase().trim();
    const symbolKey  = (inst.symbol || "").toUpperCase().trim();
    // Strip exchange prefix if present (e.g. "NSE:RELIANCE" → "RELIANCE")
    const bareKey = symbolKey.includes(":") ? symbolKey.split(":")[1] : symbolKey;

    const entry = { exchange: inst.exchange, token: String(inst.token) };
    if (tradingKey) tokenMap[tradingKey] = entry;
    if (bareKey && bareKey !== tradingKey) tokenMap[bareKey] = entry;
    if (symbolKey && symbolKey !== tradingKey && symbolKey !== bareKey) tokenMap[symbolKey] = entry;
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


// ── Stock candle data for charts ─────────────────────────────────────────────
router.get("/candles", requireAuth, requireSignalAccess, async (req, res) => {
  try {
    const { exchange, token, interval, days } = req.query;
    if (!exchange || !token || !interval) {
      return res.status(400).json({ message: "exchange, token, and interval are required" });
    }

    const { getCandles } = require("../services/smartApiService");

    // Calculate from/to dates based on requested days (default 5 trading days)
    const lookbackDays = Math.min(Number(days || 5), 30);
    const to   = new Date();
    const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    // Angel One interval codes
    const INTERVAL_MAP = {
      "1m": "ONE_MINUTE", "3m": "THREE_MINUTE", "5m": "FIVE_MINUTE",
      "10m": "TEN_MINUTE", "15m": "FIFTEEN_MINUTE", "30m": "THIRTY_MINUTE",
      "1h": "ONE_HOUR", "4h": "FOUR_HOUR", "1d": "ONE_DAY",
    };

    const smartInterval = INTERVAL_MAP[interval] || "FIFTEEN_MINUTE";

    const rawCandles = await getCandles({
      exchange: exchange.toUpperCase(),
      symbolToken: token,
      interval: smartInterval,
      from,
      to,
    });

    // Angel One returns: [ [timestamp, open, high, low, close, volume], ... ]
    const candles = rawCandles.map(row => ({
      openTime: new Date(row[0]).getTime(),
      open:     Number(row[1]),
      high:     Number(row[2]),
      low:      Number(row[3]),
      close:    Number(row[4]),
      volume:   Number(row[5] || 0),
    })).filter(c => Number.isFinite(c.open) && c.open > 0);

    return res.json({ candles, interval, exchange, token });
  } catch (err) {
    console.error("[stocks/candles] Error:", err.message);
    return res.status(500).json({ message: err.message, candles: [] });
  }
});

module.exports = router;
