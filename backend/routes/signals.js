const express    = require("express");
const rateLimit  = require("express-rate-limit");
const { requireAdmin, requireAuth, requireSignalAccess } = require("../middleware/auth");
const { SIGNAL_STATUS } = require("../models/Signal");
const { mutateCollection, readCollection, writeCollection } = require("../storage/fileStore");
const { getPrices } = require("../services/binanceService");

// Rate limit only manual scan triggers — not signal reads
const { ipKeyGenerator } = require("express-rate-limit");
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  message:  { message: "Too many scan requests. Wait a minute before scanning again." },
  keyGenerator: (req) => req.userId || ipKeyGenerator(req),
});
const { getLtp } = require("../services/smartApiService");
const { getInstrumentUniverse } = require("../services/smartInstrumentService");
const { createManualSignal, generateForCoin, getPausedCoins, getStatus, pauseCoin, resumeCoin, scanNow, start, stop } = require("../services/signalEngine");
const cache = require("../services/apiCache");

const router = express.Router();

// ─── /api/config — expose shared constants to frontend ───────────────────────
// Frontend reads this at startup so SIGNAL_EXPIRY_MS stays in sync with backend
router.get("/config", (_req, res) => {
  const { SIGNAL_EXPIRY_MS } = require("../constants");
  return res.json({ signalExpiryMs: SIGNAL_EXPIRY_MS });
});


// FIXED: dropExpiredSignals now ONLY filters for display — never deletes from storage.
// EXPIRED signals must stay in storage so stats (win rate, total closed, expired count) are correct.
// Deletion only happens via explicit admin "Archive Closed" action.
function dropExpiredSignals(signals) {
  const source = Array.isArray(signals) ? signals : [];
  return source.filter((signal) => signal.result !== "EXPIRED");
}

// FIX: Use shared constants — no more copy-paste duplication
const { getExpiryMs } = require("../constants");

function isTimeExpired(signal) {
  if (!signal.createdAt) return false;
  const age = Date.now() - new Date(signal.createdAt).getTime();
  return age > getExpiryMs(signal.timeframe);
}

// Expire any ACTIVE signals that have passed their time limit in DB
// Throttled to avoid repeated full-file writes on bursty traffic.
let lastExpireCheckAt = 0;
let expireInFlight = null;
const EXPIRE_CHECK_INTERVAL_MS = 30_000;
async function expireStaleActives(collectionName) {
  const nowMs = Date.now();
  if (expireInFlight) return expireInFlight;
  if (nowMs - lastExpireCheckAt < EXPIRE_CHECK_INTERVAL_MS) return false;

  expireInFlight = (async () => {
    const now = new Date().toISOString();
    let hadChanges = false;
    await mutateCollection(collectionName, (records) => {
      const updated = records.map((sig) => {
        if (sig.status !== SIGNAL_STATUS.ACTIVE) return sig;
        if (!isTimeExpired(sig)) return sig;
        hadChanges = true;
        return { ...sig, status: SIGNAL_STATUS.CLOSED, result: "EXPIRED", closedAt: now, updatedAt: now };
      });
      return updated;
    });
    lastExpireCheckAt = nowMs;
    if (hadChanges) cache.invalidatePrefix("signals:");
    return hadChanges;
  })();

  try {
    return await expireInFlight;
  } finally {
    expireInFlight = null;
  }
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
  const allClosed       = signals.filter((s) => s.status === SIGNAL_STATUS.CLOSED);
  const resolvedSignals = allClosed.filter((s) => s.result !== "EXPIRED");
  const expiredSignals  = allClosed.filter((s) => s.result === "EXPIRED");
  const wins            = resolvedSignals.filter((s) => isWinningResult(s.result));
  const losses          = resolvedSignals.filter((s) => s.result === "SL_HIT");
  const longSignals     = signals.filter((s) => s.side === "LONG");
  const shortSignals    = signals.filter((s) => s.side === "SHORT");
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
    longSignals:       longSignals.length,
    shortSignals:      shortSignals.length,
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
  const confidenceBands = {
    low: 0,
    medium: 0,
    strong: 0,
  };

  signals.forEach((signal) => {
    timeframeCounts[signal.timeframe] = (timeframeCounts[signal.timeframe] || 0) + 1;
    statusCounts[signal.status] = (statusCounts[signal.status] || 0) + 1;
    directionCounts[signal.side] = (directionCounts[signal.side] || 0) + 1;

    if (signal.confidence >= 70) {
      confidenceBands.strong += 1;
    } else if (signal.confidence >= 50) {
      confidenceBands.medium += 1;
    } else {
      confidenceBands.low += 1;
    }
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

function isClosedTrade(signal) {
  return signal.status === SIGNAL_STATUS.CLOSED || Boolean(signal.result);
}

function buildBucketLabel(confidence) {
  if (confidence >= 80) {
    return "80+";
  }

  if (confidence >= 70) {
    return "70-79";
  }

  if (confidence >= 60) {
    return "60-69";
  }

  return "50-59";
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

function buildRecommendations({ confidenceBreakdown, sideBreakdown, timeframeBreakdown, troubleCoins }) {
  const recommendations = [];
  const weakTimeframe = timeframeBreakdown.find((item) => item.total >= 3 && item.winRate <= 35);
  const weakConfidence = confidenceBreakdown.find((item) => item.total >= 3 && item.winRate <= 35);
  const weakSide = sideBreakdown.find((item) => item.total >= 3 && item.winRate <= 35);

  if (weakTimeframe) {
    recommendations.push(`${weakTimeframe.label} setups are underperforming at ${weakTimeframe.winRate}% win rate.`);
  }

  if (weakConfidence) {
    recommendations.push(`Signals in ${weakConfidence.label} confidence band are weak. Raise quality threshold before publishing them.`);
  }

  if (weakSide) {
    recommendations.push(`${weakSide.label} side is underperforming at ${weakSide.winRate}% win rate. Review trend filter for that direction.`);
  }

  if (troubleCoins[0]?.slHits >= 2) {
    recommendations.push(`${troubleCoins[0].coin} is causing repeated stop losses. Consider removing it from the scanner temporarily.`);
  }

  if (!recommendations.length) {
    recommendations.push("Current engine has limited closed-trade history. Let more trades close before making major parameter changes.");
  }

  return recommendations;
}

function buildPerformance(signals) {
  const closedSignals = sortByCreatedAtDesc(signals).filter(isClosedTrade);
  const completedSignals = closedSignals.filter((signal) => signal.result !== "EXPIRED");
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
  const modelBreakdown = summarizePerformanceGroup(closedSignals, (signal) => signal.scanMeta?.modelVersion || "legacy");
  const sourceBreakdown = summarizePerformanceGroup(closedSignals, (signal) => signal.source || "unknown");
  const troubleCoins = [...new Map(
    closedSignals
      .filter((signal) => signal.result === "SL_HIT")
      .map((signal) => [signal.coin, signal.coin]),
  ).values()].map((coin) => {
    const matching = closedSignals.filter((signal) => signal.coin === coin);
    const slHits = matching.filter((signal) => signal.result === "SL_HIT").length;

    return {
      coin,
      slHits,
      totalClosed: matching.length,
      winRate: matching.length ? Number(((matching.filter((signal) => isWinningResult(signal.result)).length / matching.length) * 100).toFixed(1)) : 0,
    };
  }).sort((left, right) => right.slHits - left.slHits).slice(0, 5);

  return {
    confidenceBreakdown,
    modelBreakdown,
    recommendations: buildRecommendations({
      confidenceBreakdown,
      sideBreakdown,
      timeframeBreakdown,
      troubleCoins,
    }),
    sideBreakdown,
    sourceBreakdown,
    summary,
    timeframeBreakdown,
    troubleCoins,
  };
}

function enrichSignalsWithPrices(signals, prices = {}) {
  if (!signals.length) {
    return [];
  }

  return signals.map((signal) => {
    const livePrice = prices[signal.coin];

    if (!Number.isFinite(livePrice)) {
      return signal;
    }

    const entry = Number(signal.entry || 0);
    const marketMovePercent = entry ? Number((((livePrice - entry) / entry) * 100).toFixed(2)) : null;
    const signalMovePercent = entry
      ? Number((((signal.side === "LONG" ? livePrice - entry : entry - livePrice) / entry) * 100).toFixed(2))
      : null;

    return {
      ...signal,
      livePrice,
      liveUpdatedAt: new Date().toISOString(),
      marketMovePercent,
      signalMovePercent,
    };
  });
}

async function attachLivePrices(signals) {
  if (!signals.length) return signals;

  try {
    const allCoins = [...new Set(signals.map((s) => s.coin).filter(Boolean))];
    const isIndianStock = (c) => /-(EQ|BE|N1|BL|IL|SM|GR|ST)$/i.test(c);
    const stockCoins  = allCoins.filter(isIndianStock);
    const cryptoCoins = allCoins.filter((c) => !isIndianStock(c));

    const cryptoPrices = cryptoCoins.length ? await getPrices(cryptoCoins) : {};
    const stockPriceMap = {};

    if (stockCoins.length) {
      try {
        const universe = getInstrumentUniverse();
        const tokenMap = {};
        for (const inst of universe) {
          const tradingKey = (inst.tradingSymbol || "").toUpperCase().trim();
          const symbolKey  = (inst.symbol || "").toUpperCase().trim();
          const bareKey = symbolKey.includes(":") ? symbolKey.split(":")[1] : symbolKey;
          const entry = { exchange: inst.exchange, token: String(inst.token) };
          if (tradingKey) tokenMap[tradingKey] = entry;
          if (bareKey && bareKey !== tradingKey) tokenMap[bareKey] = entry;
          if (symbolKey && symbolKey !== tradingKey && symbolKey !== bareKey) tokenMap[symbolKey] = entry;
        }
        const byExchange = {};
        for (const coin of stockCoins) {
          const info = tokenMap[coin];
          if (!info) continue;
          if (!byExchange[info.exchange]) byExchange[info.exchange] = [];
          byExchange[info.exchange].push(info.token);
        }
        if (Object.keys(byExchange).length) {
          const { ensureSession } = require("../services/smartApiService");
          const axios = require("axios");
          const token = await ensureSession();
          const baseUrl = process.env.SMART_API_BASE_URL || "https://apiconnect.angelone.in";
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
          const tokenToCoin = {};
          for (const coin of stockCoins) {
            const info = tokenMap[coin];
            if (info) tokenToCoin[info.token] = coin;
          }
          for (const item of resp.data?.data?.fetched || []) {
            const coinName = tokenToCoin[String(item.symbolToken)];
            // Market open: use ltp. Market closed: fallback to close (last closing price)
            const price = Number(item.ltp) || Number(item.close);
            if (coinName && Number.isFinite(price) && price > 0) {
              stockPriceMap[coinName] = price;
            }
          }
        }
      } catch (e) {
        console.warn("[attachLivePrices] Stock LTP failed:", e.message);
      }
    }

    return enrichSignalsWithPrices(signals, { ...cryptoPrices, ...stockPriceMap });
  } catch {
    return signals;
  }
}

router.get("/active", requireAuth, requireSignalAccess, async (req, res) => {
  const cacheKey = "signals:active:" + (req.query.coin || "all") + ":" + (req.query.limit || 50);
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  await expireStaleActives("signals");
  const rawSignals = await readCollection("signals");
  const coin = req.query.coin ? String(req.query.coin).toUpperCase() : null;
  const limit = Number(req.query.limit || 50);
  const filtered = takeLatest(
    rawSignals,
    (signal) => signal.status === SIGNAL_STATUS.ACTIVE && (!coin || signal.coin === coin),
    limit
  );

  const result = { signals: filtered };
  cache.set(cacheKey, result, 20); // 20s TTL
  return res.json(result);
});

router.get("/history", requireAuth, requireSignalAccess, async (req, res) => {
  const cacheKey = "signals:history:" + (req.query.coin || "all") + ":" + (req.query.limit || "all");
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const rawSignals = await readCollection("signals");
  // History = closed signals that hit TP or SL (NOT expired)
  const coin = req.query.coin ? String(req.query.coin).toUpperCase() : null;
  const limit = Number(req.query.limit || 0);
  const predicate = (signal) =>
    signal.status === SIGNAL_STATUS.CLOSED &&
    signal.result !== "EXPIRED" &&
    (!coin || signal.coin === coin);
  const signals = limit ? takeLatest(rawSignals, predicate, limit) : rawSignals.filter(predicate);

  const result = { signals };
  cache.set(cacheKey, result, 30);
  return res.json(result);
});

router.get("/expired", requireAuth, requireSignalAccess, async (req, res) => {
  const cacheKey = "signals:expired:" + (req.query.coin || "all") + ":" + (req.query.limit || "all");
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  // Expire any stale actives first so this list is always up-to-date
  await expireStaleActives("signals");
  const rawSignals = await readCollection("signals");
  const coin = req.query.coin ? String(req.query.coin).toUpperCase() : null;
  const limit = Number(req.query.limit || 0);
  const predicate = (signal) =>
    signal.result === "EXPIRED" && (!coin || signal.coin === coin);
  const signals = limit ? takeLatest(rawSignals, predicate, limit) : rawSignals.filter(predicate);

  const result = { signals };
  cache.set(cacheKey, result, 20);
  return res.json(result);
});

router.get("/stats/overview", requireAuth, async (req, res) => {
  const cached = cache.get("signals:overview");
  if (cached) return res.json(cached);

  await expireStaleActives("signals");
  const signals = await readCollection("signals");
  const result = { stats: buildOverview(signals) };
  cache.set("signals:overview", result, 30); // 30s TTL
  return res.json(result);
});

router.get("/stats/analytics", requireAuth, async (req, res) => {
  const cached = cache.get("signals:analytics");
  if (cached) return res.json(cached);

  const signals = await readCollection("signals");
  const result = {
    analytics: buildAnalytics(signals),
  };
  cache.set("signals:analytics", result, 60);
  return res.json(result);
});

router.get("/stats/performance", requireAuth, async (req, res) => {
  const cached = cache.get("signals:performance");
  if (cached) return res.json(cached);

  const signals = await readCollection("signals");
  const result = {
    performance: buildPerformance(signals),
  };
  cache.set("signals:performance", result, 60);
  return res.json(result);
});

router.get("/engine/status", requireAuth, (req, res) => {
  return res.json({
    engine: getStatus(),
  });
});

router.get("/live-prices", requireAuth, requireSignalAccess, async (req, res) => {
  try {
    const coins = String(req.query.coins || "")
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);

    if (!coins.length) {
      return res.json({ prices: [] });
    }

    const uniqueCoins = [...new Set(coins)].sort();
    const cacheKey = `signals:live-prices:${uniqueCoins.join(",")}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Split coins: Indian stocks end with -EQ, -BE, or have NSE/BSE prefix pattern
    const isIndianStock = (coin) => /-(EQ|BE|N1|BL|IL|SM|GR|ST)$/i.test(coin) || coin.includes("NSE:") || coin.includes("BSE:");
    const stockCoins  = uniqueCoins.filter(isIndianStock);
    const cryptoCoins = uniqueCoins.filter((c) => !isIndianStock(c));

    // Fetch crypto prices from Binance/Bybit
    const cryptoPrices = cryptoCoins.length ? await getPrices(cryptoCoins) : {};

    // Fetch Indian stock prices from SmartAPI in batches of 50
    const stockPriceMap = {};
    if (stockCoins.length) {
      try {
        // Build token map: coin -> { exchange, token }
        const universe = getInstrumentUniverse();
        const tokenMap = {};
        for (const inst of universe) {
          const tradingKey = (inst.tradingSymbol || "").toUpperCase().trim();
          const symbolKey  = (inst.symbol || "").toUpperCase().trim();
          const bareKey = symbolKey.includes(":") ? symbolKey.split(":")[1] : symbolKey;
          const entry = { exchange: inst.exchange, token: String(inst.token) };
          if (tradingKey) tokenMap[tradingKey] = entry;
          if (bareKey && bareKey !== tradingKey) tokenMap[bareKey] = entry;
          if (symbolKey && symbolKey !== tradingKey && symbolKey !== bareKey) tokenMap[symbolKey] = entry;
        }

        // Batch into groups of 50 (Angel One quote API limit)
        const BATCH = 50;
        for (let i = 0; i < stockCoins.length; i += BATCH) {
          const batch = stockCoins.slice(i, i + BATCH);

          // Group by exchange
          const byExchange = {};
          for (const coin of batch) {
            const info = tokenMap[coin];
            if (!info) continue;
            if (!byExchange[info.exchange]) byExchange[info.exchange] = [];
            byExchange[info.exchange].push(info.token);
          }

          if (!Object.keys(byExchange).length) continue;

          try {
            const { ensureSession } = require("../services/smartApiService");
            const axios = require("axios");
            const token = await ensureSession();
            const apiKey = process.env.SMART_API_KEY;
            const baseUrl = process.env.SMART_API_BASE_URL || "https://apiconnect.angelone.in";

            const resp = await axios.post(
              `${baseUrl}/rest/secure/angelbroking/market/v1/quote/`,
              { mode: "OHLC", exchangeTokens: byExchange },
              {
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                  "X-PrivateKey": apiKey,
                  "X-UserType": "USER",
                  "X-SourceID": "WEB",
                  Authorization: `Bearer ${token}`,
                },
                timeout: 8000,
              }
            );

            // Build reverse map: token -> coin name
            const tokenToCoin = {};
            for (const coin of batch) {
              const info = tokenMap[coin];
              if (info) tokenToCoin[info.token] = coin;
            }

            const fetched = resp.data?.data?.fetched || [];
            for (const item of fetched) {
              const coinName = tokenToCoin[String(item.symbolToken)];
              // Use ltp if market open, fallback to close (prev closing price) if market closed
              const price = Number(item.ltp) || Number(item.close);
              if (coinName && Number.isFinite(price) && price > 0) {
                stockPriceMap[coinName] = price;
              }
            }
          } catch (batchErr) {
            console.warn("[live-prices] SmartAPI batch failed:", batchErr.message);
          }
        }
      } catch (stockErr) {
        console.warn("[live-prices] Stock price fetch failed:", stockErr.message);
      }
    }

    const allPrices = { ...cryptoPrices, ...stockPriceMap };
    const liveUpdatedAt = new Date().toISOString();
    const priceRows = uniqueCoins.map((coin) => ({
      coin,
      livePrice: Number.isFinite(allPrices[coin]) ? allPrices[coin] : null,
      liveUpdatedAt,
    }));

    // Broadcast prices to all WS clients — they don't need to poll anymore
    try {
      const wsServer = require("../services/wsServer");
      const priceMap = {};
      priceRows.forEach(r => { if (r.livePrice !== null) priceMap[r.coin] = r.livePrice; });
      if (Object.keys(priceMap).length) {
        wsServer.broadcastPrices(priceMap);
        // Check price alerts async — don't block response
        require("./priceAlerts").checkPriceAlerts(priceMap).catch(() => {});
      }
    } catch {}

    const result = { prices: priceRows };
    cache.set(cacheKey, result, 8);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/archive", requireAuth, requireAdmin, async (req, res) => {
  try {
    const action = String(req.body?.action || "").toUpperCase();
    if (action === "ARCHIVE_CLOSED") {
      const signals = await readCollection("signals");
      const closedSignals = signals.filter((signal) => signal.status === SIGNAL_STATUS.CLOSED);
      if (!closedSignals.length) {
        const archiveSize = (await readCollection("signalsArchive")).length;
        return res.json({ archived: 0, archiveSize, remaining: signals.length });
      }
      const closedIds = new Set(closedSignals.map((signal) => signal.id));
      const archiveRecords = await readCollection("signalsArchive");
      const stamped = closedSignals.map((signal) => ({
        ...signal,
        archivedAt: signal.archivedAt || new Date().toISOString(),
      }));
      const remaining = signals.filter((signal) => signal.status !== SIGNAL_STATUS.CLOSED);
      const nextArchive = [...stamped, ...archiveRecords.filter((record) => record?.id && !closedIds.has(record.id))];
      await writeCollection("signalsArchive", nextArchive);
      await writeCollection("signals", remaining);
      cache.invalidatePrefix("signals:");
      return res.json({ archived: stamped.length, archiveSize: nextArchive.length, remaining: remaining.length });
    }
    if (action === "ARCHIVE_EXPIRED") {
      const signals = await readCollection("signals");
      const expiredSignals = signals.filter((signal) => signal.result === "EXPIRED");
      if (!expiredSignals.length) {
        const archiveSize = (await readCollection("signalsArchive")).length;
        return res.json({ archived: 0, archiveSize, remaining: signals.length });
      }
      const expiredIds = new Set(expiredSignals.map((signal) => signal.id));
      const archiveRecords = await readCollection("signalsArchive");
      const stamped = expiredSignals.map((signal) => ({
        ...signal,
        archivedAt: signal.archivedAt || new Date().toISOString(),
      }));
      const remaining = signals.filter((signal) => signal.result !== "EXPIRED");
      const nextArchive = [...stamped, ...archiveRecords.filter((record) => record?.id && !expiredIds.has(record.id))];
      await writeCollection("signalsArchive", nextArchive);
      await writeCollection("signals", remaining);
      cache.invalidatePrefix("signals:");
      return res.json({ archived: stamped.length, archiveSize: nextArchive.length, remaining: remaining.length });
    }
    if (action === "CLEAR_ARCHIVE") {
      await writeCollection("signalsArchive", []);
      cache.invalidatePrefix("signals:");
      return res.json({ archived: 0, archiveSize: 0 });
    }
    if (action === "CLEAR_HISTORY") {
      const signals = await readCollection("signals");
      const activeSignals = signals.filter((signal) => signal.status === SIGNAL_STATUS.ACTIVE);
      await writeCollection("signals", activeSignals);
      cache.invalidatePrefix("signals:");
      return res.json({ remaining: activeSignals.length });
    }
    return res.status(400).json({ message: "Invalid archive action" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/engine/start", requireAuth, requireAdmin, (req, res) => {
  return res.json({
    engine: start(),
  });
});

// ─── Admin: Get paused coins list ─────────────────────────────────────────────
router.get("/admin/paused-coins", requireAuth, requireAdmin, (req, res) => {
  return res.json({ pausedCoins: getPausedCoins() });
});

// ─── Admin: Pause a coin ──────────────────────────────────────────────────────
router.post("/admin/pause-coin", requireAuth, requireAdmin, (req, res) => {
  try {
    const { symbol, reason } = req.body || {};
    if (!symbol) return res.status(400).json({ message: "symbol required" });
    const pausedCoins = pauseCoin(symbol, req.user, reason);
    return res.json({ success: true, pausedCoins });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// ─── Admin: Resume a coin ─────────────────────────────────────────────────────
router.post("/admin/resume-coin", requireAuth, requireAdmin, (req, res) => {
  try {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ message: "symbol required" });
    const pausedCoins = resumeCoin(symbol);
    return res.json({ success: true, pausedCoins });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

// ─── Admin: Search & Force-Generate signal for a coin ─────────────────────────
router.post("/admin/generate-for-coin", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ message: "symbol required" });
    const result = await generateForCoin(symbol, req.user);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

router.post("/engine/stop", requireAuth, requireAdmin, (req, res) => {
  return res.json({
    engine: stop(),
  });
});

// ── Facebook Publisher: test connection + status ────────────────────────────
router.get("/facebook/status", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { testConnection, FB_ENABLED } = require("../services/facebookPublisher");
    if (!FB_ENABLED) {
      return res.json({ enabled: false, message: "Set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN in Render env vars." });
    }
    const result = await testConnection();
    return res.json({ enabled: true, ...result });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

router.post("/facebook/test-post", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { postToFacebook, FB_ENABLED } = require("../services/facebookPublisher");
    if (!FB_ENABLED) return res.status(400).json({ message: "Facebook publishing not configured." });
    const postId = await postToFacebook(
      "🧪 FTAS Test Post\n\nThis is a test post from FTAS Signal Engine.\n✅ Facebook integration is working!\n\n#FTAS #Test"
    );
    return res.json({ ok: Boolean(postId), postId });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

router.post("/scan", requireAuth, requireAdmin, scanLimiter, async (req, res) => {
  try {
    const result = await scanNow({ source: "MANUAL_SCAN" });
    cache.invalidatePrefix("signals:"); // flush cache after scan
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/manual", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { coin, entry, side, stopLoss, tp1, tp2, tp3 } = req.body || {};

    if (!coin || !side || !entry || !stopLoss || !tp1 || !tp2 || !tp3) {
      return res.status(400).json({ message: "coin, side, entry, stopLoss, tp1, tp2, tp3 are required" });
    }

    const signal = await createManualSignal(req.body, req.user);
    cache.invalidatePrefix("signals:");
    return res.status(201).json({ signal });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.patch("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await mutateCollection("signals", (records) => {
      let updatedSignal = null;

      const nextRecords = records.map((signal) => {
        if (signal.id !== req.params.id) {
          return signal;
        }

        updatedSignal = {
          ...signal,
          ...req.body,
          updatedAt: new Date().toISOString(),
        };

        if (updatedSignal.status === SIGNAL_STATUS.CLOSED && !updatedSignal.closedAt) {
          updatedSignal.closedAt = new Date().toISOString();
        }

        return updatedSignal;
      });

      return {
        records: nextRecords,
        value: updatedSignal,
      };
    });

    if (!result) {
      return res.status(404).json({ message: "Signal not found" });
    }

    cache.invalidatePrefix("signals:");
    return res.json({ signal: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await mutateCollection("signals", (records) => {
      const existing = records.find((signal) => signal.id === req.params.id);

      return {
        records: records.filter((signal) => signal.id !== req.params.id),
        value: existing,
      };
    });

    if (!result) {
      return res.status(404).json({ message: "Signal not found" });
    }

    cache.invalidatePrefix("signals:");
    return res.json({ deleted: true, signal: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
