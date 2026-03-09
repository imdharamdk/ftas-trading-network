const express = require("express");
const { requireAdmin, requireAuth, requireSignalAccess } = require("../middleware/auth");
const { SIGNAL_STATUS } = require("../models/Signal");
const { mutateCollection, readCollection } = require("../storage/fileStore");
const { getPrices } = require("../services/binanceService");
const { createManualSignal, getStatus, scanNow, seedDemoSignals, start, stop } = require("../services/signalEngine");

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
  const activeSignals = signals.filter((signal) => signal.status === SIGNAL_STATUS.ACTIVE);
  const closedSignals = signals.filter((signal) => signal.status === SIGNAL_STATUS.CLOSED);
  const wins = closedSignals.filter((signal) => isWinningResult(signal.result));
  const longSignals = signals.filter((signal) => signal.side === "LONG");
  const shortSignals = signals.filter((signal) => signal.side === "SHORT");
  const avgConfidence = signals.length
    ? signals.reduce((sum, signal) => sum + Number(signal.confidence || 0), 0) / signals.length
    : 0;

  return {
    activeSignals: activeSignals.length,
    closedSignals: closedSignals.length,
    totalSignals: signals.length,
    strongSignals: signals.filter((signal) => signal.confidence >= 70).length,
    longSignals: longSignals.length,
    shortSignals: shortSignals.length,
    averageConfidence: Number(avgConfidence.toFixed(1)),
    winRate: closedSignals.length ? Number(((wins.length / closedSignals.length) * 100).toFixed(1)) : 0,
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
      expiries: 0,
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
    } else if (signal.result === "EXPIRED") {
      current.expiries += 1;
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
    expiries: closedSignals.filter((signal) => signal.result === "EXPIRED").length,
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
  if (!signals.length) {
    return signals;
  }

  try {
    const prices = await getPrices([...new Set(signals.map((signal) => signal.coin))]);
    return enrichSignalsWithPrices(signals, prices);
  } catch {
    return signals;
  }
}

router.get("/active", requireAuth, requireSignalAccess, async (req, res) => {
  const signals = await readCollection("signals");
  const filtered = sortByCreatedAtDesc(signals)
    .filter((signal) => signal.status === SIGNAL_STATUS.ACTIVE)
    .filter((signal) => !req.query.coin || signal.coin === String(req.query.coin).toUpperCase());
  const responseSignals = await attachLivePrices(filtered.slice(0, Number(req.query.limit || 50)));

  return res.json({
    signals: responseSignals,
  });
});

router.get("/history", requireAuth, requireSignalAccess, async (req, res) => {
  const signals = await readCollection("signals");
  const filtered = sortByCreatedAtDesc(signals)
    .filter((signal) => signal.status !== SIGNAL_STATUS.ACTIVE)
    .filter((signal) => !req.query.coin || signal.coin === String(req.query.coin).toUpperCase());
  const responseSignals = await attachLivePrices(filtered.slice(0, Number(req.query.limit || 100)));

  return res.json({
    signals: responseSignals,
  });
});

router.get("/stats/overview", requireAuth, requireSignalAccess, async (req, res) => {
  const signals = await readCollection("signals");
  return res.json({
    stats: buildOverview(signals),
  });
});

router.get("/stats/analytics", requireAuth, requireSignalAccess, async (req, res) => {
  const signals = await readCollection("signals");
  return res.json({
    analytics: buildAnalytics(signals),
  });
});

router.get("/stats/performance", requireAuth, requireSignalAccess, async (req, res) => {
  const signals = await readCollection("signals");
  return res.json({
    performance: buildPerformance(signals),
  });
});

router.get("/engine/status", requireAuth, requireSignalAccess, (req, res) => {
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
      return res.json({
        prices: [],
      });
    }

    const prices = await getPrices([...new Set(coins)]);
    const liveUpdatedAt = new Date().toISOString();
    const priceRows = coins.map((coin) => ({
      coin,
      livePrice: Number.isFinite(prices[coin]) ? prices[coin] : null,
      liveUpdatedAt,
    }));

    return res.json({
      prices: priceRows,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/engine/start", requireAuth, requireAdmin, (req, res) => {
  return res.json({
    engine: start(),
  });
});

router.post("/engine/stop", requireAuth, requireAdmin, (req, res) => {
  return res.json({
    engine: stop(),
  });
});

router.post("/scan", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await scanNow({ source: "MANUAL_SCAN" });
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
    return res.status(201).json({ signal });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/demo/seed", requireAuth, requireAdmin, async (req, res) => {
  try {
    const signals = await seedDemoSignals(req.user);
    return res.status(201).json({ signals });
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

    return res.json({ deleted: true, signal: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
