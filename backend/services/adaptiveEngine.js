/**
 * FTAS Adaptive Scoring Engine — adaptiveEngine.js
 * =================================================
 * "Intelligence = Learning + Adapting + Improving"
 *
 * A shared ML-style adaptive scoring module for BOTH crypto and stock engines.
 * Previously only signalEngine.js had self-learning (SLM v1 + Local NB).
 * stockSignalEngine.js had ZERO adaptive scoring — only static thresholds.
 *
 * This module provides:
 *
 *  ┌─ LAYER 1: Statistical Self-Learning (SLM v2) ──────────────────────────┐
 *  │  Win/loss tallies by coin, side, timeframe, pattern combo              │
 *  │  → scoreDelta, publishFloorBoost, coin blocking                       │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *  ┌─ LAYER 2: Local Naive Bayes (LocalNB v2) ───────────────────────────────┐
 *  │  Feature-based win probability: side × timeframe × coin × confidence  │
 *  │  + NEW: indicator cluster features (RSI zone, ADX band, volume tier)  │
 *  │  → predictedWinProbability, confidenceDelta, block                    │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *  ┌─ LAYER 3: Adaptive Quality Guard (AQG v2) ──────────────────────────────┐
 *  │  Drawdown-aware floor raises. Per side×timeframe combo guards.        │
 *  │  + NEW: momentum regime detection (hot/cold streaks per coin)         │
 *  │  → scoreBoost, publishFloorBoost, minConfirmationsBoost               │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *  ┌─ LAYER 4: Pattern Success Tracker (PST — NEW) ──────────────────────────┐
 *  │  Track win rate of each indicator combination / pattern                │
 *  │  → patternScoreDelta (reward patterns that historically win)          │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 * Usage (both engines):
 *   const adaptive = require("./adaptiveEngine");
 *   const model = await adaptive.refreshModel(collection, engineKey);
 *   const adj   = adaptive.getAdjustment(model, { coin, side, timeframe, confidence, indicators });
 *   if (adj.block) return null;
 *   const finalConf = clamp(baseConfidence + adj.scoreDelta, 0, 100);
 *   const floor = baseFloor + adj.publishFloorBoost;
 *
 * engineKey: "crypto" | "stock"  — keeps models isolated
 */

// ─── Math Helpers ─────────────────────────────────────────────────────────────
function clamp(v, mn, mx) { return Math.min(Math.max(Number(v) || 0, mn), mx); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function logit(p) { const safe = clamp(p, 0.02, 0.98); return Math.log(safe / (1 - safe)); }

function winRateFromTally(tally = {}) {
  const w = Number(tally.wins || 0);
  const l = Number(tally.losses || 0);
  const t = w + l;
  return t ? (w / t) * 100 : null;
}

function smoothedProb(tally = {}, alpha = 1) {
  const w = Number(tally.wins || 0);
  const l = Number(tally.losses || 0);
  const t = w + l;
  return t ? (w + alpha) / (t + alpha * 2) : 0.5;
}

function updateTally(map, key, isWin) {
  if (!key) return;
  if (!map[key]) map[key] = { wins: 0, losses: 0 };
  map[key][isWin ? "wins" : "losses"] += 1;
}

// Delta from tally: negative if underperforming, positive if outperforming
function tallyDelta(tally, { weakAt = 42, strongAt = 60, minTotal = 8, maxDelta = 7 } = {}) {
  const w = Number(tally?.wins || 0);
  const l = Number(tally?.losses || 0);
  const total = w + l;
  if (total < minTotal) return 0;
  const wr = (w / total) * 100;
  if (wr <= weakAt)   return -Math.min(maxDelta, Math.max(1, Math.round((weakAt - wr) / 4)));
  if (wr >= strongAt) return  Math.min(maxDelta - 2, Math.max(1, Math.round((wr - strongAt) / 6)));
  return 0;
}

// ─── Feature Buckets ──────────────────────────────────────────────────────────
function confidenceBucket(c) {
  const n = Number(c || 0);
  if (n >= 90) return "90+";
  if (n >= 85) return "85-89";
  if (n >= 80) return "80-84";
  if (n >= 75) return "75-79";
  if (n >= 70) return "70-74";
  return "lt70";
}

function rsiBucket(rsi) {
  const r = Number(rsi || 50);
  if (r >= 70) return "overbought";
  if (r <= 30) return "oversold";
  if (r >= 55) return "bullish_zone";
  if (r <= 45) return "bearish_zone";
  return "neutral";
}

function adxBucket(adx) {
  const a = Number(adx || 0);
  if (a >= 35) return "strong_trend";
  if (a >= 20) return "moderate_trend";
  if (a >= 12) return "weak_trend";
  return "ranging";
}

function volumeBucket(volumeStrong, volumeSpike) {
  if (volumeSpike) return "spike";
  if (volumeStrong) return "strong";
  return "normal";
}

// Pattern combo key: top 3 confirmations sorted alphabetically for consistency
function patternKey(confirmations = []) {
  const sorted = [...confirmations]
    .map(c => String(c || "").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase())
    .filter(Boolean)
    .sort()
    .slice(0, 3);
  return sorted.join("|") || "none";
}

// Streak detection: last N signals for a coin — how many consecutive wins/losses
function detectStreak(recentForCoin = []) {
  if (!recentForCoin.length) return { streak: 0, type: "none" };
  const WIN_SET  = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
  const LOSS_SET = new Set(["SL_HIT"]);
  let streak = 0;
  const firstResult = recentForCoin[0].result;
  const isWin = WIN_SET.has(firstResult);
  const isLoss = LOSS_SET.has(firstResult);
  if (!isWin && !isLoss) return { streak: 0, type: "none" };
  const type = isWin ? "win" : "loss";
  for (const sig of recentForCoin) {
    if (type === "win"  && WIN_SET.has(sig.result))  streak++;
    else if (type === "loss" && LOSS_SET.has(sig.result)) streak++;
    else break;
  }
  return { streak, type };
}

// ─── In-Memory Model Store — isolated per engineKey ──────────────────────────
const _models = {}; // { crypto: AdaptiveModel, stock: AdaptiveModel }
const _refreshedAt = {}; // { crypto: timestamp, stock: timestamp }

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const MIN_SAMPLE = 40;       // need at least this many resolved signals
const LOCAL_AI_MIN_SAMPLE = 60;
const LOOKBACK = 600;         // max resolved signals to train on
const BLOCK_THRESHOLD = 0.30; // block if predicted win prob <= 30%
const BLOCK_MIN_SAMPLE = 80;  // need more data before blocking

// ─── LAYER 4: Pattern Success Tracker ─────────────────────────────────────────
function buildPatternTracker(resolvedSignals) {
  const byPattern = {};
  for (const sig of resolvedSignals) {
    const WIN_SET  = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
    const LOSS_SET = new Set(["SL_HIT"]);
    const isWin  = WIN_SET.has(sig.result);
    const isLoss = LOSS_SET.has(sig.result);
    if (!isWin && !isLoss) continue;
    const confirmations = Array.isArray(sig.confirmations) ? sig.confirmations : [];
    const key = patternKey(confirmations);
    updateTally(byPattern, key, isWin);
  }
  return byPattern;
}

function getPatternDelta(patternTracker = {}, confirmations = []) {
  const key = patternKey(confirmations);
  const tally = patternTracker[key];
  if (!tally) return 0;
  const total = (tally.wins || 0) + (tally.losses || 0);
  if (total < 6) return 0; // not enough data for this pattern combo
  return tallyDelta(tally, { weakAt: 40, strongAt: 62, minTotal: 6, maxDelta: 5 });
}

// ─── LAYER 1+2: Build Full Model ─────────────────────────────────────────────
function buildAdaptiveModel(resolvedSignals = [], prevModel = null, engineKey = "crypto") {
  const WIN_SET  = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
  const LOSS_SET = new Set(["SL_HIT"]);

  const model = {
    engineKey,
    version: "adaptive_v2",
    trainedAt: new Date().toISOString(),
    sampleSize: resolvedSignals.length,

    // Layer 1: SLM
    slm: {
      overallWinRate: null,
      globalPublishFloorBoost: 0,
      globalScoreDelta: 0,
      byCoin: {},
      bySide: {},
      byTimeframe: {},
      bySideTimeframe: {},  // NEW: combo key e.g. "LONG:15m"
      blockedCoins: {},
    },

    // Layer 2: Local NB
    localNB: {
      enabled: true,
      baselineWinRate: null,
      sampleSize: 0,
      features: {
        bySide: {},
        byTimeframe: {},
        byCoin: {},
        byConfidenceBucket: {},
        byRsiBucket: {},      // NEW
        byAdxBucket: {},      // NEW
        byVolumeBucket: {},   // NEW
      },
    },

    // Layer 3: Streak tracker per coin (recent 5 resolved signals)
    streaks: {},  // { [COIN]: { streak, type } }

    // Layer 4: Pattern tracker
    patternTracker: {},
  };

  if (!resolvedSignals.length) return model;

  // ── SLM (Layer 1) ─────────────────────────────────────────────────────────
  const overall = { wins: 0, losses: 0 };
  const byCoin = {}, bySide = {}, byTF = {}, bySideTF = {};

  // Streak: group last 5 resolved per coin
  const coinRecent = {};

  for (const sig of resolvedSignals) {
    const isWin  = WIN_SET.has(sig.result);
    const isLoss = LOSS_SET.has(sig.result);
    if (!isWin && !isLoss) continue;

    overall[isWin ? "wins" : "losses"] += 1;

    const coin = String(sig.coin || "").toUpperCase();
    const side = String(sig.side || "").toUpperCase();
    const tf   = String(sig.timeframe || "").toLowerCase();
    const stKey = `${side}:${tf}`;

    updateTally(byCoin, coin, isWin);
    updateTally(bySide, side, isWin);
    updateTally(byTF, tf, isWin);
    updateTally(bySideTF, stKey, isWin);

    // Streak — only keep last 5 per coin (array is already newest-first)
    if (!coinRecent[coin]) coinRecent[coin] = [];
    if (coinRecent[coin].length < 5) coinRecent[coin].push(sig);
  }

  const overallWR = winRateFromTally(overall);
  model.slm.overallWinRate = overallWR;
  model.slm.sampleSize = overall.wins + overall.losses;

  if (overallWR !== null) {
    if (overallWR < 44) { model.slm.globalPublishFloorBoost = 5; model.slm.globalScoreDelta = -2; }
    else if (overallWR < 48) { model.slm.globalPublishFloorBoost = 3; model.slm.globalScoreDelta = -1; }
    else if (overallWR < 52) { model.slm.globalPublishFloorBoost = 2; }
    else if (overallWR > 65) { model.slm.globalPublishFloorBoost = -1; model.slm.globalScoreDelta = 1; }
  }

  Object.entries(bySide).forEach(([k, t]) => {
    const d = tallyDelta(t, { minTotal: 12, maxDelta: 5 });
    if (d !== 0) model.slm.bySide[k] = d;
  });
  Object.entries(byTF).forEach(([k, t]) => {
    const d = tallyDelta(t, { minTotal: 10, maxDelta: 6 });
    if (d !== 0) model.slm.byTimeframe[k] = d;
  });
  Object.entries(bySideTF).forEach(([k, t]) => {
    const d = tallyDelta(t, { minTotal: 8, maxDelta: 5 });
    if (d !== 0) model.slm.bySideTimeframe[k] = d;
  });
  Object.entries(byCoin).forEach(([coin, tally]) => {
    const total = (tally.wins || 0) + (tally.losses || 0);
    const wr = total ? (tally.wins / total) * 100 : 0;
    const d = tallyDelta(tally, { minTotal: 8, maxDelta: 8, weakAt: 40, strongAt: 63 });
    if (d !== 0) model.slm.byCoin[coin] = d;
    if (total >= 15 && tally.losses >= 10 && wr <= 25) {
      model.slm.blockedCoins[coin] = true;
    }
  });

  // Streaks (Layer 3)
  for (const [coin, signals] of Object.entries(coinRecent)) {
    model.streaks[coin] = detectStreak(signals);
  }

  // ── Local NB (Layer 2) ────────────────────────────────────────────────────
  if (resolvedSignals.length >= LOCAL_AI_MIN_SAMPLE) {
    const nbOverall = { wins: 0, losses: 0 };
    for (const sig of resolvedSignals) {
      const isWin  = WIN_SET.has(sig.result);
      const isLoss = LOSS_SET.has(sig.result);
      if (!isWin && !isLoss) continue;
      nbOverall[isWin ? "wins" : "losses"] += 1;

      const coin = String(sig.coin || "").toUpperCase();
      const side = String(sig.side || "").toUpperCase();
      const tf   = String(sig.timeframe || "").toLowerCase();
      const conf = Number(sig.confidence || 0);

      // Core features
      updateTally(model.localNB.features.bySide, side, isWin);
      updateTally(model.localNB.features.byTimeframe, tf, isWin);
      updateTally(model.localNB.features.byCoin, coin, isWin);
      updateTally(model.localNB.features.byConfidenceBucket, confidenceBucket(conf), isWin);

      // NEW indicator features from indicatorSnapshot
      const snap = sig.indicatorSnapshot || {};
      updateTally(model.localNB.features.byRsiBucket, rsiBucket(snap.rsi), isWin);
      updateTally(model.localNB.features.byAdxBucket, adxBucket(snap.adx), isWin);
      updateTally(model.localNB.features.byVolumeBucket, volumeBucket(snap.volumeStrong, snap.volumeSpike), isWin);
    }
    model.localNB.baselineWinRate = winRateFromTally(nbOverall);
    model.localNB.sampleSize = nbOverall.wins + nbOverall.losses;
  } else {
    // Not enough data — copy prev if available
    if (prevModel?.localNB) model.localNB = { ...prevModel.localNB, trainedAt: new Date().toISOString() };
  }

  // Pattern tracker (Layer 4)
  model.patternTracker = buildPatternTracker(resolvedSignals);

  return model;
}

// ─── Refresh Model from DB ────────────────────────────────────────────────────
async function refreshModel(readCollectionFn, collectionName, engineKey = "crypto") {
  const now = Date.now();
  const lastRefresh = _refreshedAt[engineKey] || 0;
  if (_models[engineKey] && (now - lastRefresh) < REFRESH_INTERVAL_MS) {
    return _models[engineKey];
  }

  try {
    const WIN_SET  = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
    const LOSS_SET = new Set(["SL_HIT"]);

    const all = await readCollectionFn(collectionName);
    const resolved = all
      .filter(sig => WIN_SET.has(sig.result) || LOSS_SET.has(sig.result))
      .sort((a, b) => {
        const ta = new Date(b.closedAt || b.updatedAt || b.createdAt || 0).getTime();
        const tb = new Date(a.closedAt || a.updatedAt || a.createdAt || 0).getTime();
        return ta - tb; // newest first
      })
      .slice(0, LOOKBACK);

    const prev = _models[engineKey] || null;
    _models[engineKey] = buildAdaptiveModel(resolved, prev, engineKey);
    _refreshedAt[engineKey] = now;
    console.log(`[adaptiveEngine/${engineKey}] Model refreshed — ${resolved.length} resolved signals, WR=${_models[engineKey].slm.overallWinRate?.toFixed(1) ?? "N/A"}%`);
    return _models[engineKey];
  } catch (err) {
    console.error(`[adaptiveEngine/${engineKey}] Refresh failed:`, err.message);
    return _models[engineKey] || buildAdaptiveModel([], null, engineKey);
  }
}

// ─── Core: Get Full Adjustment ────────────────────────────────────────────────
/**
 * getAdjustment(model, context)
 *
 * context: {
 *   coin        — string   e.g. "BTCUSDT" or "RELIANCE"
 *   side        — "LONG" | "SHORT"
 *   timeframe   — "1m" | "5m" | "15m" | "1h" etc
 *   confidence  — number (base score before adjustment)
 *   indicators  — { rsi, adx, volumeStrong, volumeSpike } (optional, for NB)
 *   confirmations — string[] (for pattern tracker)
 * }
 *
 * Returns: {
 *   scoreDelta           — apply to base confidence
 *   publishFloorBoost    — add to publish floor
 *   minConfirmationsBoost — add to min confirmations required
 *   block                — boolean — hard block this signal
 *   predictedWinProb     — 0–100 float (from NB model), or null
 *   streakWarning        — boolean (3+ loss streak)
 *   reasons              — string[] explaining adjustments
 *   layers               — breakdown per layer for scanMeta
 * }
 */
function getAdjustment(model, context = {}) {
  const result = {
    scoreDelta: 0,
    publishFloorBoost: 0,
    minConfirmationsBoost: 0,
    block: false,
    predictedWinProb: null,
    streakWarning: false,
    reasons: [],
    layers: {
      slm: { scoreDelta: 0, publishFloorBoost: 0, block: false, reasons: [] },
      localNB: { enabled: false, predictedWinProb: null, confidenceDelta: 0, publishFloorBoost: 0, block: false },
      aqg: { scoreBoost: 0, publishFloorBoost: 0, minConfirmationsBoost: 0, block: false, reasons: [] },
      pst: { scoreDelta: 0, reasons: [] },
    },
  };

  if (!model) return result;

  const coin = String(context.coin || "").toUpperCase();
  const side = String(context.side || "").toUpperCase();
  const tf   = String(context.timeframe || "").toLowerCase();
  const conf = Number(context.confidence || 0);
  const indicators = context.indicators || {};
  const confirmations = context.confirmations || [];

  // ── LAYER 1: SLM ──────────────────────────────────────────────────────────
  const slm = model.slm || {};

  if (Number(slm.sampleSize || 0) >= MIN_SAMPLE) {
    let slmScore = Number(slm.globalScoreDelta || 0);
    let slmFloor = Number(slm.globalPublishFloorBoost || 0);
    const slmReasons = [];

    if (slm.bySide?.[side]) {
      slmScore += Number(slm.bySide[side]);
      slmReasons.push(`side_${side.toLowerCase()}`);
    }
    if (slm.byTimeframe?.[tf]) {
      slmScore += Number(slm.byTimeframe[tf]);
      slmReasons.push(`tf_${tf}`);
    }
    const stKey = `${side}:${tf}`;
    if (slm.bySideTimeframe?.[stKey]) {
      slmScore += Number(slm.bySideTimeframe[stKey]);
      slmReasons.push(`combo_${stKey.toLowerCase()}`);
    }
    if (slm.byCoin?.[coin]) {
      slmScore += Number(slm.byCoin[coin]);
      slmReasons.push(`coin_${coin}`);
    }
    if (slm.blockedCoins?.[coin]) {
      result.block = true;
      result.layers.slm.block = true;
      result.reasons.push("slm_coin_blocked");
      return result; // hard block — skip all other layers
    }

    slmScore = clamp(slmScore, -12, 8);
    slmFloor = clamp(slmFloor, -2, 6);

    result.scoreDelta += slmScore;
    result.publishFloorBoost += slmFloor;
    result.layers.slm = { scoreDelta: slmScore, publishFloorBoost: slmFloor, block: false, reasons: slmReasons };
    result.reasons.push(...slmReasons.map(r => `slm:${r}`));
  }

  // ── LAYER 2: Local NB ─────────────────────────────────────────────────────
  const nb = model.localNB || {};
  if (nb.enabled && nb.baselineWinRate !== null && Number(nb.sampleSize || 0) >= LOCAL_AI_MIN_SAMPLE) {
    const priorProb = clamp(nb.baselineWinRate / 100, 0.1, 0.9);
    let scoreLogit = logit(priorProb);
    const nbReasons = [];

    const features = [
      { key: side,                         map: nb.features?.bySide,             weight: 0.85, minSample: 10 },
      { key: tf,                           map: nb.features?.byTimeframe,        weight: 0.90, minSample: 10 },
      { key: coin,                         map: nb.features?.byCoin,             weight: 0.55, minSample: 8  },
      { key: confidenceBucket(conf),       map: nb.features?.byConfidenceBucket, weight: 0.70, minSample: 8  },
      { key: rsiBucket(indicators.rsi),    map: nb.features?.byRsiBucket,        weight: 0.60, minSample: 8  },
      { key: adxBucket(indicators.adx),   map: nb.features?.byAdxBucket,        weight: 0.55, minSample: 8  },
      { key: volumeBucket(indicators.volumeStrong, indicators.volumeSpike), map: nb.features?.byVolumeBucket, weight: 0.50, minSample: 8 },
    ];

    for (const feature of features) {
      const tally = feature.map?.[feature.key];
      const total = Number(tally?.wins || 0) + Number(tally?.losses || 0);
      if (!total || total < feature.minSample) continue;
      const fp = smoothedProb(tally, 1);
      const contribution = (logit(fp) - logit(priorProb)) * feature.weight;
      scoreLogit += contribution;
      nbReasons.push(feature.key);
    }

    const predictedProb = sigmoid(scoreLogit);
    const predictedWinProb = Number((predictedProb * 100).toFixed(1));
    result.predictedWinProb = predictedWinProb;
    result.layers.localNB.enabled = true;
    result.layers.localNB.predictedWinProb = predictedWinProb;

    const delta = (predictedProb - priorProb) * 40;
    const nbDelta = clamp(Math.round(delta), -7, 7);
    let nbFloor = 0;
    if (predictedProb < 0.43)      nbFloor = 3;
    else if (predictedProb < 0.50) nbFloor = 1;
    else if (predictedProb > 0.62) nbFloor = -1;

    // Hard block: only if enough data AND very low predicted prob
    if (Number(nb.sampleSize) >= BLOCK_MIN_SAMPLE && predictedProb <= BLOCK_THRESHOLD) {
      result.block = true;
      result.layers.localNB.block = true;
      result.reasons.push("nb_low_win_probability");
      return result;
    }

    result.scoreDelta += nbDelta;
    result.publishFloorBoost += nbFloor;
    result.layers.localNB.confidenceDelta = nbDelta;
    result.layers.localNB.publishFloorBoost = nbFloor;
    result.reasons.push(...nbReasons.map(r => `nb:${r}`));
  }

  // ── LAYER 3: AQG (Adaptive Quality Guard) ─────────────────────────────────
  const slmData = model.slm || {};
  const sampleSize = Number(slmData.sampleSize || 0);
  const aqgReasons = [];
  let aqgScore = 0, aqgFloor = 0, aqgConf = 0;

  if (sampleSize >= MIN_SAMPLE) {
    const wr = slmData.overallWinRate;
    if (wr !== null) {
      // Overall drawdown guard
      if (wr < 46) { aqgScore += 2; aqgFloor += 2; aqgReasons.push("overall_drawdown"); }

      // Per side×timeframe weakness
      const stKey = `${side}:${tf}`;
      // Reconstruct tally for the side×tf combo from bySideTimeframe delta
      // (we use the raw delta value as a proxy: negative = weak, very negative = block)
      const stDelta = Number(model.slm.bySideTimeframe?.[stKey] || 0);
      if (stDelta <= -6) {
        result.block = true;
        result.layers.aqg.block = true;
        result.reasons.push(`aqg_blocked_${stKey.toLowerCase()}`);
        return result;
      } else if (stDelta <= -3) {
        aqgScore += 4;
        aqgFloor += 3;
        aqgConf  += 1;
        aqgReasons.push(`weak_${stKey.toLowerCase()}`);
      }
    }
  }

  // ── Streak guard (hot/cold) — Layer 3 extension ───────────────────────────
  const streakInfo = model.streaks?.[coin];
  if (streakInfo && streakInfo.streak >= 3) {
    if (streakInfo.type === "loss") {
      // 3+ loss streak on this coin — raise bar
      result.streakWarning = true;
      aqgFloor += 3;
      aqgConf  += 1;
      aqgReasons.push(`loss_streak_${streakInfo.streak}`);
    } else if (streakInfo.type === "win" && streakInfo.streak >= 4) {
      // Hot streak — slight confidence boost (market understanding)
      aqgScore -= 1; // floor slightly lower (we trust this coin more)
      aqgReasons.push(`win_streak_${streakInfo.streak}`);
    }
  }

  result.scoreDelta           += -aqgScore; // aqgScore raises bar = negative score delta
  result.publishFloorBoost    += aqgFloor;
  result.minConfirmationsBoost += aqgConf;
  result.layers.aqg = { scoreBoost: aqgScore, publishFloorBoost: aqgFloor, minConfirmationsBoost: aqgConf, block: false, reasons: aqgReasons };
  result.reasons.push(...aqgReasons.map(r => `aqg:${r}`));

  // ── LAYER 4: Pattern Tracker ───────────────────────────────────────────────
  const patternDelta = getPatternDelta(model.patternTracker || {}, confirmations);
  if (patternDelta !== 0) {
    result.scoreDelta += patternDelta;
    result.layers.pst = { scoreDelta: patternDelta, reasons: [`pattern:${patternKey(confirmations)}`] };
    result.reasons.push(`pst:${patternDelta > 0 ? "winning_pattern" : "losing_pattern"}`);
  }

  // Final clamp
  result.scoreDelta = clamp(result.scoreDelta, -15, 10);
  result.publishFloorBoost = clamp(result.publishFloorBoost, -2, 8);
  result.minConfirmationsBoost = clamp(result.minConfirmationsBoost, 0, 2);

  return result;
}

// ─── Status / Debug ───────────────────────────────────────────────────────────
function getModelStatus(engineKey = "crypto") {
  const model = _models[engineKey];
  if (!model) return { trained: false, engineKey };
  return {
    trained: true,
    engineKey,
    trainedAt: model.trainedAt,
    sampleSize: model.slm?.sampleSize ?? 0,
    overallWinRate: model.slm?.overallWinRate ?? null,
    localNBEnabled: model.localNB?.enabled ?? false,
    localNBSample: model.localNB?.sampleSize ?? 0,
    patternCount: Object.keys(model.patternTracker || {}).length,
    streakCoins: Object.keys(model.streaks || {}).length,
    version: model.version,
  };
}

// Force re-train (admin action)
async function forceRefresh(readCollectionFn, collectionName, engineKey = "crypto") {
  _refreshedAt[engineKey] = 0;
  return refreshModel(readCollectionFn, collectionName, engineKey);
}

module.exports = {
  refreshModel,
  getAdjustment,
  getModelStatus,
  forceRefresh,
  // exposed for testing
  buildAdaptiveModel,
  patternKey,
  confidenceBucket,
  rsiBucket,
  adxBucket,
};
