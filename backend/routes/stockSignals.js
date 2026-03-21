const express = require("express");
const axios = require("axios");
const { requireAdmin, requireAuth, requireSignalAccess } = require("../middleware/auth");
const { SIGNAL_STATUS } = require("../models/Signal");
const { readCollection, mutateCollection, writeCollection } = require("../storage/fileStore");
const stockEngine = require("../services/stockSignalEngine");
const { ensureSession } = require("../services/smartApiService");
const { getInstrumentUniverse } = require("../services/smartInstrumentService");
const cache = require("../services/apiCache");

const router = express.Router();

const RISK_MIN_CONFIDENCE = {
  AGGRESSIVE: 70,
  BALANCED: 80,
  CONSERVATIVE: 90,
};

function resolveRiskPreference(req) {
  const pref = String(req.query.risk || req.user?.riskPreference || "BALANCED").toUpperCase();
  if (pref === "ALL") return { preference: "ALL", minConfidence: 0 };
  const minConfidence = RISK_MIN_CONFIDENCE[pref] ?? RISK_MIN_CONFIDENCE.BALANCED;
  return { preference: pref, minConfidence };
}

// Stock signals should NOT auto-expire.
async function expireStaleActives() {
  return false;
}

function isWinningResult(result) {
  return ["TP1_HIT", "TP2_HIT", "TP3_HIT"].includes(result);
}

function sortByCreatedAtDesc(records) {
  return [...records].sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

// Fast path: assume records are already newest-first (they are prepended on insert).
function takeLatest(records, predicate, limit) {
  const out = [];
  const max = Number(limit || 0);
  for (const item of records) {
    if (!predicate(item)) continue;
    out.push(item);
    if (max && out.length >= max) break;
  }
  return out;
}

function buildOverview(signals) {
  const activeSignals   = signals.filter((s) => s.status === SIGNAL_STATUS.ACTIVE);
  const allClosed       = signals.filter((s) => s.status === SIGNAL_STATUS.CLOSED && s.result !== "EXPIRED");
  const resolvedSignals = allClosed;
  const expiredSignals  = [];
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
  const { preference, minConfidence } = resolveRiskPreference(req);
  const cacheKey = "stocks:active:" + (req.query.coin || "all") + ":" + (req.query.limit || 50) + ":" + preference;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  await expireStaleActives();
  const signals = await readCollection("stockSignals");
  const coin = req.query.coin ? String(req.query.coin).toUpperCase() : null;
  const limit = Number(req.query.limit || 50);
  const filtered = takeLatest(
    signals,
    (signal) =>
      signal.status === SIGNAL_STATUS.ACTIVE &&
      !isCryptoCoin(signal.coin) &&
      (!coin || signal.coin === coin) &&
      Number(signal.confidence || 0) >= minConfidence,
    limit
  );

  const result = { signals: filtered };
  cache.set(cacheKey, result, 20);
  return res.json(result);
});

router.get("/history", requireAuth, requireSignalAccess, async (req, res) => {
  const { preference, minConfidence } = resolveRiskPreference(req);
  const cacheKey = "stocks:history:" + (req.query.coin || "all") + ":" + (req.query.limit || "all") + ":" + preference;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const signals = await readCollection("stockSignals");
  // History = TP/SL hits only — no expired
  const coin = req.query.coin ? String(req.query.coin).toUpperCase() : null;
  const limit = Number(req.query.limit || 0);
  const predicate = (signal) =>
    signal.status === SIGNAL_STATUS.CLOSED &&
    signal.result !== "EXPIRED" &&
    !isCryptoCoin(signal.coin) &&
    (!coin || signal.coin === coin) &&
    Number(signal.confidence || 0) >= minConfidence;
  const result = { signals: limit ? takeLatest(signals, predicate, limit) : signals.filter(predicate) };
  cache.set(cacheKey, result, 30);
  return res.json(result);
});

router.get("/expired", requireAuth, requireSignalAccess, async (req, res) => {
  const { preference } = resolveRiskPreference(req);
  const cacheKey = "stocks:expired:" + (req.query.coin || "all") + ":" + (req.query.limit || "all") + ":" + preference;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  // Expiry disabled for stocks — always return empty
  const result = { signals: [] };
  cache.set(cacheKey, result, 20);
  return res.json(result);
});

router.post("/archive", requireAuth, requireAdmin, async (req, res) => {
  try {
    const action = String(req.body?.action || "").toUpperCase();
    if (action === "ARCHIVE_CLOSED") {
      const signals = await readCollection("stockSignals");
      const closedSignals = signals.filter((signal) => signal.status === SIGNAL_STATUS.CLOSED);
      if (!closedSignals.length) {
        const archiveSize = (await readCollection("stockSignalsArchive")).length;
        return res.json({ archived: 0, archiveSize, remaining: signals.length });
      }
      const closedIds = new Set(closedSignals.map((signal) => signal.id));
      const archiveRecords = await readCollection("stockSignalsArchive");
      const stamped = closedSignals.map((signal) => ({
        ...signal,
        archivedAt: signal.archivedAt || new Date().toISOString(),
      }));
      const remaining = signals.filter((signal) => signal.status !== SIGNAL_STATUS.CLOSED);
      const nextArchive = [...stamped, ...archiveRecords.filter((record) => record?.id && !closedIds.has(record.id))];
      await writeCollection("stockSignalsArchive", nextArchive);
      await writeCollection("stockSignals", remaining);
      cache.invalidatePrefix("stocks:");
      return res.json({ archived: stamped.length, archiveSize: nextArchive.length, remaining: remaining.length });
    }
    if (action === "CLEAR_ARCHIVE") {
      await writeCollection("stockSignalsArchive", []);
      cache.invalidatePrefix("stocks:");
      return res.json({ archived: 0, archiveSize: 0 });
    }
    if (action === "CLEAR_HISTORY") {
      const signals = await readCollection("stockSignals");
      const activeSignals = signals.filter((signal) => signal.status === SIGNAL_STATUS.ACTIVE);
      await writeCollection("stockSignals", activeSignals);
      cache.invalidatePrefix("stocks:");
      return res.json({ remaining: activeSignals.length });
    }
    return res.status(400).json({ message: "Invalid archive action" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
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
    cache.invalidatePrefix("stocks:");
    return res.json({ success: true, removed, message: `Removed ${removed} crypto signal(s) from stockSignals collection` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/stats/overview", requireAuth, async (req, res) => {
  const { preference, minConfidence } = resolveRiskPreference(req);
  const cached = cache.get("stocks:overview:" + preference);
  if (cached) return res.json(cached);

  await expireStaleActives(); // ensure stale actives are marked expired before counting
  const raw = await readCollection("stockSignals");
  const archive = await readCollection("stockSignalsArchive");
  const combined = [...raw, ...archive];
  const signals = combined.filter((s) =>
    !isCryptoCoin(s.coin) &&
    s.result !== "EXPIRED" &&
    Number(s.confidence || 0) >= minConfidence
  );
  const result = {
    stats: { ...buildOverview(signals), archiveSize: archive.length },
  };
  cache.set("stocks:overview:" + preference, result, 30);
  return res.json(result);
});

router.get("/stats/analytics", requireAuth, async (req, res) => {
  const { preference, minConfidence } = resolveRiskPreference(req);
  const cached = cache.get("stocks:analytics:" + preference);
  if (cached) return res.json(cached);

  const raw = await readCollection("stockSignals");
  const archive = await readCollection("stockSignalsArchive");
  const combined = [...raw, ...archive];
  const signals = combined.filter((s) =>
    !isCryptoCoin(s.coin) &&
    s.result !== "EXPIRED" &&
    Number(s.confidence || 0) >= minConfidence
  );
  const result = {
    analytics: buildAnalytics(signals),
  };
  cache.set("stocks:analytics:" + preference, result, 60);
  return res.json(result);
});

router.get("/stats/performance", requireAuth, async (req, res) => {
  const { preference, minConfidence } = resolveRiskPreference(req);
  const cached = cache.get("stocks:performance:" + preference);
  if (cached) return res.json(cached);

  const raw = await readCollection("stockSignals");
  const archive = await readCollection("stockSignalsArchive");
  const combined = [...raw, ...archive];
  const signals = combined.filter((s) =>
    !isCryptoCoin(s.coin) &&
    s.result !== "EXPIRED" &&
    Number(s.confidence || 0) >= minConfidence
  );
  const result = {
    performance: buildPerformance(signals),
  };
  cache.set("stocks:performance:" + preference, result, 60);
  return res.json(result);
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
    const rawLimit = Number(req.query.limit || 5000);
    const limit = Math.min(Math.max(rawLimit, 50), 20000);
    const query = String(req.query.q || "").trim();
    const fields = String(req.query.fields || "full").toLowerCase();

    const cacheKey = `stocks:instruments:${query || "all"}:${limit}:${fields}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const universe = getInstrumentUniverse({ limit, query });
    const instruments = fields === "lite"
      ? universe.map(i => ({
          tradingSymbol: i.tradingSymbol,
          exchange: i.exchange,
          segment: i.segment,
          token: i.token,
          lotSize: i.lotSize,
          expiry: i.expiry,
          instrumentType: i.instrumentType,
        }))
      : universe;

    const result = { instruments };
    cache.set(cacheKey, result, query ? 60 : 300);
    return res.json(result);
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

    const uniqueCoins = [...new Set(coins)].sort();
    const cacheKey = `stocks:live-prices:${uniqueCoins.join(",")}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const priceMap = await fetchStockLivePrices(uniqueCoins);
    const liveUpdatedAt = new Date().toISOString();

    const result = {
      prices: coins.map(coin => ({
        coin,
        livePrice: Number.isFinite(priceMap[coin]) ? priceMap[coin] : null,
        liveUpdatedAt,
      })),
    };
    cache.set(cacheKey, result, 12);
    return res.json(result);
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
