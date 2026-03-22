const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { analyzeCandles } = require("./indicatorEngine");
const { getAllTickerStats, getAllFuturesCoins, getKlines, getPrices } = require("./binanceService");
const { getExpiryMs, WIN_RESULTS, LOSS_RESULTS, STRENGTH_THRESHOLDS } = require("../constants");

function ws()   { try { return require("./wsServer");              } catch { return null; } }
function sse()  { try { return require("./sseManager");            } catch { return null; } }
function push() { try { return require("../routes/notifications"); } catch { return null; } }
function tg()   { try { return require("../routes/telegram");      } catch { return null; } }

// ─── CRYPTO COLLECTION NAME ───────────────────────────────────────────────────
const SIGNAL_COLLECTION = "signals";

// ─── CRYPTO SIGNAL ENGINE ────────────────────────────────────────────────────
// Focus: higher frequency with controlled quality.

const SCAN_TIMEFRAMES            = ["1m","5m","15m","30m","1h"];
const DEFAULT_TRADE_TIMEFRAMES   = ["1m","5m","15m","30m"];
const DEFAULT_MAX_COINS_PER_SCAN = 60;
const MAX_COINS_PER_SCAN_CAP     = 120;
const DEFAULT_COIN_SCAN_CONCURRENCY = 4;
const MAX_COIN_SCAN_CONCURRENCY_CAP = 8;
const DEFAULT_TIMEFRAME_FETCH_CONCURRENCY = 2;
const MAX_TIMEFRAME_FETCH_CONCURRENCY_CAP = 3;

const MIN_SCAN_QUOTE_VOLUME_USDT  = 5_000_000;
const MIN_SCAN_TRADE_COUNT_24H    = 10_000;
const MIN_SCAN_OPEN_INTEREST_USDT = 2_000_000;

const RULE_VERSION = "v18_crypto_working";
const SIGNAL_MODEL_VERSION = process.env.CRYPTO_SIGNAL_MODEL_VERSION || "v19_crypto_adaptive_parallel";
const DEFAULT_PUBLISH_FLOOR = 72;
const QUALITY_MODE = String(process.env.CRYPTO_QUALITY_MODE || "BALANCED").toUpperCase();
const ULTRA_MIN_CONFIDENCE = Math.max(80, Number(process.env.CRYPTO_MIN_CONFIDENCE || 90));
const SELF_LEARNING_ENABLED = String(process.env.CRYPTO_SELF_LEARNING_ENABLED || "true").toLowerCase() !== "false";
const AUTONOMOUS_ACTIONS_ENABLED = String(process.env.CRYPTO_AUTONOMOUS_ACTIONS_ENABLED || "true").toLowerCase() !== "false";
const SELF_LEARNING_REFRESH_MS = Math.max(60_000, Number(process.env.CRYPTO_SELF_LEARNING_REFRESH_MS || 10 * 60 * 1000));
const SELF_LEARNING_LOOKBACK = Math.max(120, Number(process.env.CRYPTO_SELF_LEARNING_LOOKBACK || 600));
const SELF_LEARNING_MIN_SAMPLE = Math.max(40, Number(process.env.CRYPTO_SELF_LEARNING_MIN_SAMPLE || 80));
const LOCAL_AI_ENABLED = String(process.env.CRYPTO_LOCAL_AI_ENABLED || "true").toLowerCase() !== "false";
const LOCAL_AI_MIN_SAMPLE = Math.max(40, Number(process.env.CRYPTO_LOCAL_AI_MIN_SAMPLE || 120));
const LOCAL_AI_BLOCK_THRESHOLD = Math.min(Math.max(Number(process.env.CRYPTO_LOCAL_AI_BLOCK_THRESHOLD || 0.32), 0.15), 0.45);
const AUTO_COIN_COOLDOWN_ENABLED = String(process.env.CRYPTO_AUTO_COIN_COOLDOWN_ENABLED || "true").toLowerCase() !== "false";
const AUTO_COIN_COOLDOWN_HOURS = Math.max(1, Number(process.env.CRYPTO_AUTO_COIN_COOLDOWN_HOURS || 24));
const AUTO_COIN_COOLDOWN_WINDOW = Math.max(3, Number(process.env.CRYPTO_AUTO_COIN_COOLDOWN_WINDOW || 5));
const AUTO_COIN_COOLDOWN_MIN_LOSSES = Math.min(AUTO_COIN_COOLDOWN_WINDOW, Math.max(2, Number(process.env.CRYPTO_AUTO_COIN_COOLDOWN_MIN_LOSSES || 3)));
const AUTO_COIN_SIDE_COOLDOWN_ENABLED = String(process.env.CRYPTO_AUTO_COIN_SIDE_COOLDOWN_ENABLED || "true").toLowerCase() !== "false";
const AUTO_COIN_SIDE_COOLDOWN_HOURS = Math.max(1, Number(process.env.CRYPTO_AUTO_COIN_SIDE_COOLDOWN_HOURS || 18));
const AUTO_COIN_SIDE_COOLDOWN_WINDOW = Math.max(3, Number(process.env.CRYPTO_AUTO_COIN_SIDE_COOLDOWN_WINDOW || 5));
const AUTO_COIN_SIDE_COOLDOWN_MIN_LOSSES = Math.min(AUTO_COIN_SIDE_COOLDOWN_WINDOW, Math.max(2, Number(process.env.CRYPTO_AUTO_COIN_SIDE_COOLDOWN_MIN_LOSSES || 3)));
const AUTO_TF_COOLDOWN_ENABLED = String(process.env.CRYPTO_AUTO_TF_COOLDOWN_ENABLED || "true").toLowerCase() !== "false";
const AUTO_TF_COOLDOWN_HOURS = Math.max(1, Number(process.env.CRYPTO_AUTO_TF_COOLDOWN_HOURS || 8));
const AUTO_TF_COOLDOWN_WINDOW = Math.max(3, Number(process.env.CRYPTO_AUTO_TF_COOLDOWN_WINDOW || 6));
const AUTO_TF_COOLDOWN_MIN_LOSSES = Math.min(AUTO_TF_COOLDOWN_WINDOW, Math.max(3, Number(process.env.CRYPTO_AUTO_TF_COOLDOWN_MIN_LOSSES || 4)));
const REENTRY_COOLDOWN_ENABLED = String(process.env.CRYPTO_REENTRY_COOLDOWN_ENABLED || "true").toLowerCase() !== "false";
const REENTRY_COOLDOWN_MINUTES = Math.max(15, Number(process.env.CRYPTO_REENTRY_COOLDOWN_MINUTES || 90));
const SR_ROOM_GUARD_ENABLED = String(process.env.CRYPTO_SR_ROOM_GUARD_ENABLED || "true").toLowerCase() !== "false";
const SR_ROOM_MIN_R = Math.min(2.0, Math.max(0.25, Number(process.env.CRYPTO_SR_ROOM_MIN_R || 0.55)));
const MID_TF_ALIGNMENT_GUARD_ENABLED = String(process.env.CRYPTO_MID_TF_ALIGNMENT_GUARD_ENABLED || "true").toLowerCase() !== "false";
const MID_TF_ALIGNMENT_MIN_ADX = Math.max(8, Number(process.env.CRYPTO_MID_TF_ALIGNMENT_MIN_ADX || 14));
const TF_THROTTLE_MIN_SAMPLE = Math.max(10, Number(process.env.CRYPTO_TF_THROTTLE_MIN_SAMPLE || 20));
const TF_THROTTLE_WEAK_WINRATE = Math.min(55, Math.max(25, Number(process.env.CRYPTO_TF_THROTTLE_WEAK_WINRATE || 40)));
const TF_THROTTLE_BLOCK_WINRATE = Math.min(TF_THROTTLE_WEAK_WINRATE - 1, Math.max(15, Number(process.env.CRYPTO_TF_THROTTLE_BLOCK_WINRATE || 30)));
const TF_THROTTLE_BLOCK_MIN_SAMPLE = Math.max(TF_THROTTLE_MIN_SAMPLE, Number(process.env.CRYPTO_TF_THROTTLE_BLOCK_MIN_SAMPLE || 25));
const VOL_GUARD_ENABLED = String(process.env.CRYPTO_VOL_GUARD_ENABLED || "true").toLowerCase() !== "false";
const VOL_GUARD_LOW_PCT = Math.max(0.02, Number(process.env.CRYPTO_VOL_GUARD_LOW_PCT || 0.08));
const VOL_GUARD_HIGH_PCT = Math.max(VOL_GUARD_LOW_PCT + 0.2, Number(process.env.CRYPTO_VOL_GUARD_HIGH_PCT || 3.2));
const COUNTER_TREND_ENABLED = String(process.env.CRYPTO_COUNTER_TREND_ENABLED || "true").toLowerCase() !== "false";
const COUNTER_TREND_MIN_CONF = Math.min(99, Math.max(88, Number(process.env.CRYPTO_COUNTER_TREND_MIN_CONF || 92)));
const COUNTER_TREND_ADX_MIN = Math.max(14, Number(process.env.CRYPTO_COUNTER_TREND_ADX_MIN || 24));
const COUNTER_TREND_DRAWDOWN_GUARD_ENABLED = String(process.env.CRYPTO_COUNTER_TREND_DRAWDOWN_GUARD_ENABLED || "true").toLowerCase() !== "false";
const COUNTER_TREND_DRAWDOWN_MIN_SAMPLE = Math.max(8, Number(process.env.CRYPTO_COUNTER_TREND_DRAWDOWN_MIN_SAMPLE || 12));
const COUNTER_TREND_DRAWDOWN_WINRATE = Math.min(55, Math.max(30, Number(process.env.CRYPTO_COUNTER_TREND_DRAWDOWN_WINRATE || 48)));
const SIDE_TF_BLOCK_MIN_SAMPLE = Math.max(10, Number(process.env.CRYPTO_SIDE_TF_BLOCK_MIN_SAMPLE || 12));
const SIDE_TF_BLOCK_WINRATE = Math.min(45, Math.max(18, Number(process.env.CRYPTO_SIDE_TF_BLOCK_WINRATE || 33)));
const SIDE_TF_WEAK_WINRATE = Math.min(60, Math.max(SIDE_TF_BLOCK_WINRATE + 5, Number(process.env.CRYPTO_SIDE_TF_WEAK_WINRATE || 45)));

// ── Per-Timeframe Rules ────────────────────────────────────────────────────────
const TIMEFRAME_RULES = {
  "1m": {
    minScore:            44,
    minConfirmations:    3,
    publishFloor:        70,
    minAdx:              10,
    minDiDelta:          2,
    requireVwapSupport:  false,
    blockDailyBear:      false,
    entryDriftMultiplier: 0.5,
    maxLeverage:         20,
  },
  "5m": {
    minScore:            46,
    minConfirmations:    3,
    publishFloor:        72,
    minAdx:              12,
    minDiDelta:          2,
    requireVwapSupport:  false,
    blockDailyBear:      false,
    entryDriftMultiplier: 0.6,
    maxLeverage:         20,
  },
  "15m": {
    minScore:            50,
    minConfirmations:    3,
    publishFloor:        74,
    minAdx:              13,
    minDiDelta:          2,
    requireVwapSupport:  false,
    blockDailyBear:      false,
    entryDriftMultiplier: 0.7,
    maxLeverage:         15,
  },
  "30m": {
    minScore:            52,
    minConfirmations:    3,
    publishFloor:        75,
    minAdx:              14,
    minDiDelta:          2,
    requireVwapSupport:  false,
    blockDailyBear:      false,
    entryDriftMultiplier: 0.8,
    maxLeverage:         15,
  },
  "1h": {
    minScore:            55,
    minConfirmations:    3,
    publishFloor:        76,
    minAdx:              15,
    minDiDelta:          3,
    requireVwapSupport:  false,
    blockDailyBear:      false,
    entryDriftMultiplier: 1.0,
    maxLeverage:         12,
  },
};

// ── TP targets — realistic R:R for scalps ─────────────────────────────────────
// TP1 closer = higher hit rate, TP2/TP3 for runners
const TP_R_MULTIPLIERS_1M = [0.45, 0.8, 1.2];   // was [0.5, 0.85, 1.3]
const TP_R_MULTIPLIERS_5M = [0.55, 0.95, 1.4];  // was [0.6, 1.0, 1.5]

const buildTally   = () => ({ wins: 0, losses: 0 });

const engineState = {
  intervalMs: Number(process.env.CRYPTO_SCAN_INTERVAL_MS || process.env.SCAN_INTERVAL_MS || 60_000),
  isScanning: false, lastError: null, lastGenerated: 0,
  lastScanAt: null, running: false, scanCount: 0,
  timer: null, expiryTimer: null,
  // Admin-controlled coin pause list: { [SYMBOL]: { pausedAt, reason, pausedBy } }
  pausedCoins: {},
  // Auto-managed directional cooldowns: { [COIN:SIDE]: { pausedAt, pausedUntil, ... } }
  pausedCoinSides: {},
  // Auto-managed timeframe cooldowns: { [TF]: { pausedAt, pausedUntil, ... } }
  pausedTimeframes: {},
  selfLearning: {
    enabled: SELF_LEARNING_ENABLED,
    trainedAt: null,
    lastRefreshedAt: 0,
    sampleSize: 0,
    overallWinRate: null,
    globalPublishFloorBoost: 0,
    confidenceScoreDelta: 0,
    byCoin: {},
    bySide: {},
    byTimeframe: {},
    blockedCoins: {},
    version: "slm_v1",
    localModel: {
      enabled: LOCAL_AI_ENABLED,
      version: "local_nb_v1",
      trainedAt: null,
      sampleSize: 0,
      baselineWinRate: null,
      blockedPredictionThreshold: LOCAL_AI_BLOCK_THRESHOLD,
      featureStats: {
        bySide: {},
        byTimeframe: {},
        byCoin: {},
        byConfidenceBucket: {},
      },
    },
    autonomousAuthorityEnabled: AUTONOMOUS_ACTIONS_ENABLED,
    autonomousLastRunAt: 0,
    autonomousActionsApplied: [],
  },
};

// ─── Utils ────────────────────────────────────────────────────────────────────
function roundPrice(v) {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) >= 1000) return Number(v.toFixed(2));
  if (Math.abs(v) >= 1)    return Number(v.toFixed(4));
  return Number(v.toFixed(6));
}
function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }
function toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function winRateFromTally(tally = {}) {
  const wins = Number(tally.wins || 0);
  const losses = Number(tally.losses || 0);
  const total = wins + losses;
  if (!total) return null;
  return (wins / total) * 100;
}
function updateTally(map, key, isWin) {
  if (!key) return;
  if (!map[key]) map[key] = buildTally();
  map[key][isWin ? "wins" : "losses"] += 1;
}
async function mapWithConcurrency(items, limit, worker) {
  const src = Array.isArray(items) ? items : [];
  if (!src.length) return [];
  const max = clamp(Number(limit || 1), 1, src.length);
  const results = new Array(src.length);
  let cursor = 0;
  async function runSlot() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= src.length) return;
      try {
        results[index] = await worker(src[index], index);
      } catch (error) {
        results[index] = { error, index };
      }
    }
  }
  await Promise.all(Array.from({ length: max }, () => runSlot()));
  return results;
}
function getCoinScanConcurrency() {
  return clamp(
    Number(process.env.CRYPTO_SCAN_CONCURRENCY || DEFAULT_COIN_SCAN_CONCURRENCY),
    1,
    MAX_COIN_SCAN_CONCURRENCY_CAP
  );
}
function getTimeframeFetchConcurrency() {
  return clamp(
    Number(process.env.CRYPTO_TIMEFRAME_CONCURRENCY || DEFAULT_TIMEFRAME_FETCH_CONCURRENCY),
    1,
    MAX_TIMEFRAME_FETCH_CONCURRENCY_CAP
  );
}
function buildSignalKey(signal = {}) {
  return `${String(signal.coin || "").toUpperCase()}|${String(signal.side || "").toUpperCase()}|${String(signal.timeframe || "")}`;
}
async function getActiveSignalKeySet() {
  const signals = await readCollection(SIGNAL_COLLECTION);
  return new Set(
    signals
      .filter((s) => s.status === SIGNAL_STATUS.ACTIVE)
      .map((s) => buildSignalKey(s))
  );
}
function formatCompact(v) {
  const n = toNumber(v); if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n/1e9).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1_000)         return `${(n/1e3).toFixed(1)}K`;
  return n.toFixed(0);
}
function buildFallbackMarketActivity(symbol) {
  return { symbol, quoteVolume:0, volume:0, tradeCount:0, openInterestValue:0,
    activityScore:0, isLiquid:false, isCrowded:false, passesFloor:true, relaxThresholds:false };
}
function buildMarketActivitySnapshot(ticker = {}) {
  const symbol = String(ticker.symbol || "").toUpperCase();
  const quoteVolume = toNumber(ticker.quoteVolume);
  const volume = toNumber(ticker.volume);
  const tradeCount = toNumber(ticker.count || ticker.tradeCount);
  const openInterestValue = toNumber(ticker.openInterestValue);
  const hasParticipation = tradeCount > 0 || openInterestValue > 0;
  const liquidityScore     = Math.log10(quoteVolume + 1) * 16 + Math.log10(volume + 1) * 4;
  const participationScore = Math.log10(tradeCount + 1) * 8  + Math.log10(openInterestValue + 1) * 10;
  const isLiquid  = quoteVolume >= 12_000_000 || openInterestValue >= 3_000_000;
  const isCrowded = tradeCount  >= 8_000      || openInterestValue >= 5_000_000;
  const passesFloor = symbol.endsWith("USDT") &&
    quoteVolume >= MIN_SCAN_QUOTE_VOLUME_USDT &&
    (!hasParticipation || tradeCount >= MIN_SCAN_TRADE_COUNT_24H || openInterestValue >= MIN_SCAN_OPEN_INTEREST_USDT);
  return { symbol, quoteVolume, volume, tradeCount, openInterestValue,
    activityScore: liquidityScore + participationScore,
    isLiquid, isCrowded, passesFloor,
    relaxThresholds: isLiquid && (isCrowded || quoteVolume >= 50_000_000) };
}
function getMaxCoinsPerScan() {
  return clamp(Number(process.env.CRYPTO_SCAN_MAX_COINS || DEFAULT_MAX_COINS_PER_SCAN), 10, MAX_COINS_PER_SCAN_CAP);
}
function getConfidenceBucket(confidence) {
  const c = Number(confidence || 0);
  if (c >= 90) return "90+";
  if (c >= 85) return "85-89";
  if (c >= 80) return "80-84";
  if (c >= 75) return "75-79";
  if (c >= 70) return "70-74";
  return "lt70";
}
function logitFromProbability(probability) {
  const p = clamp(Number(probability || 0.5), 0.02, 0.98);
  return Math.log(p / (1 - p));
}
function toSmoothedProbability(tally = {}, alpha = 1) {
  const wins = Number(tally.wins || 0);
  const losses = Number(tally.losses || 0);
  const total = wins + losses;
  if (!total) return 0.5;
  return (wins + alpha) / (total + alpha * 2);
}
function updateLocalFeatureTally(container, key, isWin) {
  if (!key) return;
  if (!container[key]) container[key] = buildTally();
  container[key][isWin ? "wins" : "losses"] += 1;
}
function buildLocalAiModel(resolvedSignals = [], fallbackModel = null) {
  const model = {
    enabled: LOCAL_AI_ENABLED,
    version: "local_nb_v1",
    trainedAt: new Date().toISOString(),
    sampleSize: resolvedSignals.length,
    baselineWinRate: null,
    blockedPredictionThreshold: LOCAL_AI_BLOCK_THRESHOLD,
    featureStats: {
      bySide: {},
      byTimeframe: {},
      byCoin: {},
      byConfidenceBucket: {},
    },
  };

  if (!resolvedSignals.length) {
    if (fallbackModel && typeof fallbackModel === "object") {
      model.enabled = Boolean(fallbackModel.enabled);
    }
    return model;
  }

  const overall = buildTally();
  for (const signal of resolvedSignals) {
    const isWin = WIN_RESULTS.has(signal.result);
    overall[isWin ? "wins" : "losses"] += 1;
    updateLocalFeatureTally(model.featureStats.bySide, String(signal.side || "").toUpperCase(), isWin);
    updateLocalFeatureTally(model.featureStats.byTimeframe, String(signal.timeframe || "").toLowerCase(), isWin);
    updateLocalFeatureTally(model.featureStats.byCoin, String(signal.coin || "").toUpperCase(), isWin);
    updateLocalFeatureTally(model.featureStats.byConfidenceBucket, getConfidenceBucket(signal.confidence), isWin);
  }

  model.baselineWinRate = winRateFromTally(overall);
  return model;
}
function getLocalAiAdjustment(model, { coin, side, timeframe, baseConfidence }) {
  const adjustment = {
    enabled: false,
    modelVersion: model?.version || "local_nb_v1",
    predictedWinProbability: null,
    confidenceDelta: 0,
    publishFloorBoost: 0,
    blockCoin: false,
    reasons: [],
  };

  if (!model?.enabled) return adjustment;
  const sampleSize = Number(model.sampleSize || 0);
  if (sampleSize < LOCAL_AI_MIN_SAMPLE) return adjustment;

  const baselineWinRate = Number(model.baselineWinRate || 0);
  if (!baselineWinRate) return adjustment;

  adjustment.enabled = true;
  const priorProbability = clamp(baselineWinRate / 100, 0.1, 0.9);
  let scoreLogit = logitFromProbability(priorProbability);

  const features = [
    { key: String(side || "").toUpperCase(), map: model.featureStats?.bySide, weight: 0.85, minSample: 10, reason: "side" },
    { key: String(timeframe || "").toLowerCase(), map: model.featureStats?.byTimeframe, weight: 0.9, minSample: 10, reason: "timeframe" },
    { key: String(coin || "").toUpperCase(), map: model.featureStats?.byCoin, weight: 0.55, minSample: 8, reason: "coin" },
    { key: getConfidenceBucket(baseConfidence), map: model.featureStats?.byConfidenceBucket, weight: 0.7, minSample: 8, reason: "confidence_bucket" },
  ];

  for (const feature of features) {
    const tally = feature.map?.[feature.key];
    const total = Number(tally?.wins || 0) + Number(tally?.losses || 0);
    if (!total || total < feature.minSample) continue;
    const featureProbability = toSmoothedProbability(tally, 1);
    const contribution = (logitFromProbability(featureProbability) - logitFromProbability(priorProbability)) * feature.weight;
    scoreLogit += contribution;
    adjustment.reasons.push(feature.reason + ":" + feature.key);
  }

  const predictedWinProbability = sigmoid(scoreLogit);
  adjustment.predictedWinProbability = Number((predictedWinProbability * 100).toFixed(1));

  const delta = (predictedWinProbability - priorProbability) * 40;
  adjustment.confidenceDelta = clamp(Math.round(delta), -7, 7);
  if (predictedWinProbability < 0.43) adjustment.publishFloorBoost = 3;
  else if (predictedWinProbability < 0.5) adjustment.publishFloorBoost = 1;
  else if (predictedWinProbability > 0.62) adjustment.publishFloorBoost = -1;

  if (sampleSize >= LOCAL_AI_MIN_SAMPLE * 2 && predictedWinProbability <= Number(model.blockedPredictionThreshold || LOCAL_AI_BLOCK_THRESHOLD)) {
    adjustment.blockCoin = true;
    adjustment.reasons.push("predicted_low_probability_block");
  }

  return adjustment;
}

// ─── Crypto Scan Universe — Binance/Bybit USDT perpetuals ────────────────────
async function getScanUniverse() {
  try {
    const stats = await getAllTickerStats();
    const markets = (stats || [])
      .map(buildMarketActivitySnapshot)
      .filter(m => m.symbol.endsWith("USDT"));

    if (!markets.length) {
      const coins = await getAllFuturesCoins();
      return (coins || []).map(sym => buildFallbackMarketActivity(sym));
    }

    const filtered = markets.filter(m => m.passesFloor || m.relaxThresholds);
    const ranked = (filtered.length ? filtered : markets)
      .sort((a, b) => b.activityScore - a.activityScore);

    return ranked;
  } catch (e) {
    console.error("[cryptoEngine/getScanUniverse] ticker stats failed:", e.message);
    return [];
  }
}
async function getCoinList() {
  const universe = await getScanUniverse();
  return universe.map(m => m.symbol);
}
function getTradeTimeframes() {
  const r = String(process.env.CRYPTO_TRADE_TIMEFRAMES || process.env.TRADE_TIMEFRAMES || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const base = r.length ? r : DEFAULT_TRADE_TIMEFRAMES;
  if (QUALITY_MODE === "ULTRA") return base.filter(tf => tf !== "1m" && tf !== "5m");
  return base;
}

function toTallyDelta(tally, { weakAt = 42, strongAt = 60, minTotal = 8, maxDelta = 7 } = {}) {
  const wins = Number(tally?.wins || 0);
  const losses = Number(tally?.losses || 0);
  const total = wins + losses;
  if (total < minTotal) return 0;
  const winRate = (wins / total) * 100;
  if (winRate <= weakAt) return -Math.min(maxDelta, Math.max(1, Math.round((weakAt - winRate) / 4)));
  if (winRate >= strongAt) return Math.min(maxDelta - 2, Math.max(1, Math.round((winRate - strongAt) / 6)));
  return 0;
}

async function refreshSelfLearningModel({ force = false } = {}) {
  if (!engineState.selfLearning.enabled) return engineState.selfLearning;

  const now = Date.now();
  if (!force && now - Number(engineState.selfLearning.lastRefreshedAt || 0) < SELF_LEARNING_REFRESH_MS) return engineState.selfLearning;

  try {
    const signals = await readCollection(SIGNAL_COLLECTION);
    const resolved = signals
      .filter((sig) => WIN_RESULTS.has(sig.result) || LOSS_RESULTS.has(sig.result))
      .sort((a, b) => new Date(b.closedAt || b.updatedAt || b.createdAt || 0).getTime() - new Date(a.closedAt || a.updatedAt || a.createdAt || 0).getTime())
      .slice(0, SELF_LEARNING_LOOKBACK);

    const next = {
      enabled: true,
      trainedAt: new Date().toISOString(),
      lastRefreshedAt: now,
      sampleSize: resolved.length,
      overallWinRate: null,
      globalPublishFloorBoost: 0,
      confidenceScoreDelta: 0,
      byCoin: {},
      bySide: {},
      byTimeframe: {},
      blockedCoins: {},
      version: "slm_v1",
      localModel: buildLocalAiModel([], engineState.selfLearning.localModel),
    };

    if (resolved.length < SELF_LEARNING_MIN_SAMPLE) {
      next.localModel = buildLocalAiModel(resolved, engineState.selfLearning.localModel);
      engineState.selfLearning = next;
      return next;
    }

    const overall = buildTally();
    const byCoinTally = {};
    const bySideTally = {};
    const byTimeframeTally = {};

    resolved.forEach((sig) => {
      const isWin = WIN_RESULTS.has(sig.result);
      const key = isWin ? "wins" : "losses";
      overall[key] += 1;
      updateTally(byCoinTally, String(sig.coin || "").toUpperCase(), isWin);
      updateTally(bySideTally, String(sig.side || "").toUpperCase(), isWin);
      updateTally(byTimeframeTally, String(sig.timeframe || "").toLowerCase(), isWin);
    });

    const overallWinRate = winRateFromTally(overall);
    next.overallWinRate = overallWinRate;

    if (overallWinRate !== null) {
      if (overallWinRate < 46) next.globalPublishFloorBoost = 4;
      else if (overallWinRate < 52) next.globalPublishFloorBoost = 2;
      else if (overallWinRate > 62) next.globalPublishFloorBoost = -1;

      if (overallWinRate < 44) next.confidenceScoreDelta = -2;
      else if (overallWinRate > 63) next.confidenceScoreDelta = 1;
    }

    Object.entries(bySideTally).forEach(([key, tally]) => {
      const delta = toTallyDelta(tally, { minTotal: 12, maxDelta: 5 });
      if (delta !== 0) next.bySide[key] = delta;
    });

    Object.entries(byTimeframeTally).forEach(([key, tally]) => {
      const delta = toTallyDelta(tally, { minTotal: 10, maxDelta: 6 });
      if (delta !== 0) next.byTimeframe[key] = delta;
    });

    Object.entries(byCoinTally).forEach(([coin, tally]) => {
      const wins = Number(tally.wins || 0);
      const losses = Number(tally.losses || 0);
      const total = wins + losses;
      if (total < 8) return;
      const wr = total ? (wins / total) * 100 : 0;
      const lossRate = total ? (losses / total) * 100 : 0;
      const delta = toTallyDelta(tally, { minTotal: 8, maxDelta: 8, weakAt: 40, strongAt: 63 });
      if (delta !== 0) next.byCoin[coin] = delta;
      if (total >= 12 && losses >= 8 && lossRate >= 75 && wr <= 25) next.blockedCoins[coin] = true;
    });
    next.localModel = buildLocalAiModel(resolved, engineState.selfLearning.localModel);

    engineState.selfLearning = next;
    return next;
  } catch {
    engineState.selfLearning.lastRefreshedAt = now;
    return engineState.selfLearning;
  }
}

function getSelfLearningAdjustment(model, { coin, side, timeframe }) {
  const adjustment = { scoreDelta: 0, publishFloorBoost: 0, blockCoin: false, reasons: [] };
  if (!model?.enabled || Number(model.sampleSize || 0) < SELF_LEARNING_MIN_SAMPLE) return adjustment;

  const coinKey = String(coin || "").toUpperCase();
  const sideKey = String(side || "").toUpperCase();
  const tfKey = String(timeframe || "").toLowerCase();

  adjustment.scoreDelta += Number(model.confidenceScoreDelta || 0);
  adjustment.publishFloorBoost += Number(model.globalPublishFloorBoost || 0);

  if (model.byCoin?.[coinKey]) {
    adjustment.scoreDelta += Number(model.byCoin[coinKey]);
    adjustment.reasons.push("coin_" + coinKey);
  }
  if (model.bySide?.[sideKey]) {
    adjustment.scoreDelta += Number(model.bySide[sideKey]);
    adjustment.reasons.push("side_" + sideKey.toLowerCase());
  }
  if (model.byTimeframe?.[tfKey]) {
    adjustment.scoreDelta += Number(model.byTimeframe[tfKey]);
    adjustment.reasons.push("tf_" + tfKey);
  }

  if (model.blockedCoins?.[coinKey]) {
    adjustment.blockCoin = true;
    adjustment.reasons.push("blocked_coin");
  }

  adjustment.scoreDelta = clamp(adjustment.scoreDelta, -12, 8);
  adjustment.publishFloorBoost = clamp(adjustment.publishFloorBoost, -2, 6);
  return adjustment;
}

function getAdaptiveQualityConfig(performanceSnapshot, { coin, side, timeframe }) {
  const config = {
    scoreBoost: 0,
    publishFloorBoost: 0,
    minPublishFloorAbs: 0,
    minConfirmationsBoost: 0,
    blockCoin: false,
    reasons: [],
  };

  if (QUALITY_MODE === "ULTRA") {
    if (timeframe === "1m" || timeframe === "5m") {
      config.blockCoin = true;
      config.reasons.push("ultra_mode_low_tf_block");
      return config;
    }
    config.scoreBoost += 8;
    config.publishFloorBoost += 8;
    config.minConfirmationsBoost += 2;
    config.reasons.push("ultra_mode_strict_thresholds");
  }

  if (!performanceSnapshot) return config;

  const overall = performanceSnapshot.overall || buildTally();
  const overallTotal = Number(overall.wins || 0) + Number(overall.losses || 0);
  const overallWinRate = winRateFromTally(overall);
  if (overallTotal >= 25 && overallWinRate !== null && overallWinRate < 52) {
    config.scoreBoost += 2;
    config.publishFloorBoost += 2;
    config.reasons.push("overall_winrate_guard");
  }

  const recent30 = performanceSnapshot.recent30 || { total: 0, winRate: null };
  if (Number(recent30.total || 0) >= 12 && recent30.winRate !== null && Number(recent30.winRate) < 50) {
    config.scoreBoost += 2;
    config.publishFloorBoost += 2;
    config.minPublishFloorAbs = Math.max(config.minPublishFloorAbs, 80);
    config.reasons.push("recent_30_winrate_guard");
  }
  const tfStats = performanceSnapshot[timeframe] || buildTally();
  const tfTotal = Number(tfStats.wins || 0) + Number(tfStats.losses || 0);
  const tfWinRate = winRateFromTally(tfStats);
  if (tfTotal >= TF_THROTTLE_BLOCK_MIN_SAMPLE && tfWinRate !== null && tfWinRate <= TF_THROTTLE_BLOCK_WINRATE) {
    config.blockCoin = true;
    config.reasons.push(`blocked_tf_${timeframe}`);
  } else if (tfTotal >= TF_THROTTLE_MIN_SAMPLE && tfWinRate !== null && tfWinRate <= TF_THROTTLE_WEAK_WINRATE) {
    config.scoreBoost += 3;
    config.publishFloorBoost += 3;
    config.minConfirmationsBoost += 1;
    config.minPublishFloorAbs = Math.max(config.minPublishFloorAbs, 80);
    config.reasons.push(`weak_tf_${timeframe}`);
  }
  const sideTfKey = `${side}:${timeframe}`;
  const sideTfStats = performanceSnapshot.bySideTimeframe?.[sideTfKey];
  const sideTfTotal = Number(sideTfStats?.wins || 0) + Number(sideTfStats?.losses || 0);
  const sideTfWinRate = winRateFromTally(sideTfStats);
  if (sideTfTotal >= SIDE_TF_BLOCK_MIN_SAMPLE && sideTfWinRate !== null && sideTfWinRate <= SIDE_TF_BLOCK_WINRATE) {
    config.blockCoin = true;
    config.reasons.push(`blocked_${sideTfKey.toLowerCase()}`);
  } else if (sideTfTotal >= 8 && sideTfWinRate !== null && sideTfWinRate <= SIDE_TF_WEAK_WINRATE) {
    config.scoreBoost += 5;
    config.publishFloorBoost += 4;
    config.minConfirmationsBoost += 1;
    config.minPublishFloorAbs = Math.max(config.minPublishFloorAbs, 80);
    config.reasons.push(`weak_${sideTfKey.toLowerCase()}`);
  }

  const coinStats = performanceSnapshot.byCoin?.[coin];
  const coinTotal = Number(coinStats?.wins || 0) + Number(coinStats?.losses || 0);
  const coinLossRate = coinTotal ? (Number(coinStats?.losses || 0) / coinTotal) * 100 : null;
  if (coinTotal >= 6 && coinLossRate !== null && coinLossRate >= 70) {
    config.blockCoin = true;
    config.reasons.push("coin_loss_rate_guard");
  }

  const recentLossStreak = Number(performanceSnapshot.recentSlStreakByCoin?.[coin] || 0);
  if (recentLossStreak >= 3) {
    config.blockCoin = true;
    config.reasons.push("coin_recent_sl_streak");
  }

  return config;
}

// ─── GATE 1: HTF Bias ─────────────────────────────────────────────────────────
// Crypto: use a higher timeframe filter, but keep it lenient for more signals.
function getHigherTimeframeBias(analyses, tradeTimeframe = "5m") {
  const pick = (tf) => analyses[tf] || null;

  const primary =
    tradeTimeframe === "1m"  ? (pick("5m")  || pick("15m")) :
    tradeTimeframe === "5m"  ? (pick("15m") || pick("1h"))  :
    tradeTimeframe === "15m" ? (pick("1h")  || pick("30m")) :
    tradeTimeframe === "30m" ? (pick("1h")  || pick("15m")) :
    tradeTimeframe === "1h"  ? (pick("1h")) :
    pick("1h");

  if (!primary) return "NEUTRAL";

  const { ema50, ema100, adx } = primary.trend;
  const rsi = primary.momentum?.rsi || 50;

  const bull = ema50 > ema100 * 0.995 && (adx||0) >= 10 && rsi >= 40 && rsi <= 78;
  const bear = ema50 < ema100 * 1.005 && (adx||0) >= 10 && rsi <= 60 && rsi >= 22;

  if (bull) return "BULLISH";
  if (bear) return "BEARISH";
  return "NEUTRAL";
}

// ─── SL / TP ──────────────────────────────────────────────────────────────────
function calculateTargets(side, analysis, timeframe = "5m") {
  const marketEntry = Number(analysis.currentPrice || 0);
  const atr   = analysis.volatility.atr || analysis.averages.averageRange || marketEntry * 0.003;
  const { low20, high20, previousLow20, previousHigh20 } = analysis.recentSwing;
  const srSup = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes = analysis.srLevels?.resistances?.[0] ?? null;
  const ema21 = Number(analysis?.trend?.ema21 || NaN);
  const vwap  = Number(analysis?.trend?.vwap || NaN);
  const tpMult = timeframe === "1m" ? TP_R_MULTIPLIERS_1M : TP_R_MULTIPLIERS_5M;

  // Pullback entry model: avoid market chasing while keeping fills realistic.
  const pullbackCap = Math.max(atr * 0.18, atr * (timeframe === "1m" ? 0.28 : 0.36));
  let entry = marketEntry;
  if (side === "LONG") {
    const refs = [ema21, vwap].filter(Number.isFinite).filter((v) => v <= marketEntry);
    if (refs.length) {
      const target = refs.reduce((a, b) => a + b, 0) / refs.length;
      entry = clamp(target, marketEntry - pullbackCap, marketEntry);
    }
  } else {
    const refs = [ema21, vwap].filter(Number.isFinite).filter((v) => v >= marketEntry);
    if (refs.length) {
      const target = refs.reduce((a, b) => a + b, 0) / refs.length;
      entry = clamp(target, marketEntry, marketEntry + pullbackCap);
    }
  }

  // Tighter SL band -> better RR
  const slMin  = atr * 0.7;
  const slMax  = atr * 1.6;

  if (side === "LONG") {
    const anchors = [low20, previousLow20, srSup].filter(v => Number.isFinite(v) && v < entry);
    const anchor  = anchors.length ? Math.max(...anchors) : entry - atr * 1.1;
    const risk    = clamp((entry - anchor) + atr * 0.12, slMin, slMax);
    return { entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry - risk),
      tp1: roundPrice(entry + risk * tpMult[0]),
      tp2: roundPrice(entry + risk * tpMult[1]),
      tp3: roundPrice(entry + risk * tpMult[2]) };
  } else {
    const anchors = [high20, previousHigh20, srRes].filter(v => Number.isFinite(v) && v > entry);
    const anchor  = anchors.length ? Math.min(...anchors) : entry + atr * 1.1;
    const risk    = clamp((anchor - entry) + atr * 0.12, slMin, slMax);
    return { entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry + risk),
      tp1: roundPrice(entry - risk * tpMult[0]),
      tp2: roundPrice(entry - risk * tpMult[1]),
      tp3: roundPrice(entry - risk * tpMult[2]) };
  }
}

// ─── Leverage ─────────────────────────────────────────────────────────────────
function calculateLeverage(analysis, confidence, timeframe) {
  const price  = analysis.currentPrice;
  const atr    = analysis.volatility.atr || analysis.averages.averageRange || price * 0.003;
  const atrPct = (atr / price) * 100;
  const base   = clamp(20 / atrPct, 10, 40);
  const bonus  = confidence >= 90 ? 4 : confidence >= 85 ? 2 : 0;
  const tfRule = TIMEFRAME_RULES[timeframe] || {};
  const cap    = Number.isFinite(tfRule.maxLeverage) ? tfRule.maxLeverage : 20;
  return Math.round(clamp(base + bonus, 10, cap));
}
function getVolatilityBand(timeframe = "5m") {
  const tfBands = {
    "1m":  { min: 0.06, max: 1.4 },
    "5m":  { min: 0.08, max: 1.9 },
    "15m": { min: 0.10, max: 2.4 },
    "30m": { min: 0.12, max: 2.9 },
    "1h":  { min: 0.14, max: 3.4 },
  };
  const base = tfBands[timeframe] || tfBands["5m"];
  return {
    min: Math.max(base.min, VOL_GUARD_LOW_PCT),
    max: Math.min(base.max, VOL_GUARD_HIGH_PCT),
  };
}

// ─── GATE 4 helper: Momentum Check ───────────────────────────────────────────
// RSI + MACD must agree; StochRSI is bonus (not hard gate)
function isMomentumAligned(side, analysis, tfRule) {
  const { rsi, rsiRising, rsiFalling, macd, macdHistIncreasing, macdHistDecreasing } = analysis.momentum;
  const minRsi = tfRule.minRsi ?? 37;
  const maxRsi = tfRule.maxRsi ?? 85;
  const requireRsiRising = tfRule.requireRsiRising ?? false;

  if (side === "LONG") {
    // RSI in valid zone — rising is preferred but NOT required (it plateaus in trends)
    const rsiInRange = (rsi||0) >= minRsi && (rsi||0) <= maxRsi;
    const rsiOk = requireRsiRising ? (rsiInRange && rsiRising) : rsiInRange;
    // MACD: histogram positive OR line above signal OR increasing — any one is enough
    const macdOk = (macd?.histogram||0) > 0 || (macd?.MACD||0) > (macd?.signal||0) || macdHistIncreasing;
    return rsiOk && macdOk;
  } else {
    const rsiInRange = (rsi||0) <= (100 - minRsi) && (rsi||0) >= 15;
    const rsiOk = requireRsiRising ? (rsiInRange && rsiFalling) : rsiInRange;
    const macdOk = (macd?.histogram||0) < 0 || (macd?.MACD||0) < (macd?.signal||0) || macdHistDecreasing;
    return rsiOk && macdOk;
  }
}

// ─── GATE 5 helper: Volume Confirmation ───────────────────────────────────────
function isVolumeConfirmed(analysis, multiplier = 1.4) {
  const { currentVolume, averageVolume, volumeTrending } = analysis.volume;
  return (
    currentVolume > averageVolume * multiplier ||
    (currentVolume > averageVolume * 1.2 && volumeTrending)
  );
}

// ─── GATE 6 helper: HA Candle Direction (medium — 2 candles) ─────────────────
function isHaMedium(side, analysis) {
  const { haBullish, haBearish, haStrongBull, haStrongBear } = analysis.trend;
  if (side === "LONG") return haBullish || haStrongBull;
  else                 return haBearish || haStrongBear;
}

// ─── Manipulation Candle Detector ────────────────────────────────────────────
// Only reject obvious manipulation — 65% wick threshold (was 55%)
function hasManipulationCandle(side, analysis) {
  const c   = analysis.candles;
  const atr = analysis.volatility.atr || 1;
  if (!c) return false;
  const range     = (c.high - c.low) || 0.0001;
  const upperWick = (c.high - Math.max(c.open, c.close)) / range;
  const lowerWick = (Math.min(c.open, c.close) - c.low)  / range;
  if (side === "LONG"  && lowerWick > 0.65) return true;
  if (side === "SHORT" && upperWick > 0.65) return true;
  if (range > atr * 3.5) return true; // extreme spike
  return false;
}

// ─── Main Signal Builder ──────────────────────────────────────────────────────
function buildCandidate(coin, timeframe, analysis, higherBias, htf = {}, marketActivity = null, performanceSnapshot = null, selfLearningModel = null) {
  const bullConf = [], bearConf = [];
  let bullScore = 0, bearScore = 0;

  const tfRule       = TIMEFRAME_RULES[timeframe] || {};
  const activeMarket = marketActivity || buildFallbackMarketActivity(coin);
  const price = analysis.currentPrice;

  const { ema9, ema21, ema50, ema100, ema200, vwap, ichimoku, adx, pdi, mdi, psar,
    haBullish, haBearish, haStrongBull, haStrongBear, haNoLowerWick, haNoUpperWick,
    ema50Rising, ema50Falling, ema21Rising, ema21Falling, trix, trixCrossUp, trixCrossDown } = analysis.trend;
  const { rsi, rsiRising, rsiFalling, rsi9, macd, macdHistIncreasing, macdHistDecreasing,
    stochRsi, stochKD, cci, roc, roc5, kstBullish, kstBearish, ao, aoCrossUp, aoCrossDown, williamsR } = analysis.momentum;
  const { volumeSpike, volumeStrong, volumeTrending, obvChange, obvTrending, mfi, forceIndex, currentVolume, averageVolume } = analysis.volume;
  const { bollinger, atr: rawAtr, bbWidth, bbPctB } = analysis.volatility;
  const atr    = rawAtr || analysis.averages.averageRange || price * 0.003;
  const regime = analysis.regime;
  const stochK = stochRsi?.k ?? null;
  const kdK    = stochKD?.k  ?? null;
  const kdD    = stochKD?.d  ?? null;
  const { daily, oneH, fifteenM, thirtyM } = htf;
  const dailyTrend     = daily?.trend || {};
  const dailyBearStack = (dailyTrend.ema50||0) < (dailyTrend.ema100||0) && (dailyTrend.adx||0) >= 16;
  const dailyBullStack = (dailyTrend.ema50||0) > (dailyTrend.ema100||0) && (dailyTrend.adx||0) >= 16;
  const psarBull = Number.isFinite(psar) ? psar < price : false;
  const psarBear = Number.isFinite(psar) ? psar > price : false;
  const oneHBullAligned = Number(oneH?.trend?.ema50 || 0) > Number(oneH?.trend?.ema100 || 0);
  const oneHBearAligned = Number(oneH?.trend?.ema50 || 0) < Number(oneH?.trend?.ema100 || 0);
  const rsiDivBull  = analysis.divergence?.rsi?.bullish        || false;
  const rsiDivBear  = analysis.divergence?.rsi?.bearish        || false;
  const rsiHidBull  = analysis.divergence?.rsi?.hidden_bullish || false;
  const rsiHidBear  = analysis.divergence?.rsi?.hidden_bearish || false;
  const macdDivBull = analysis.divergence?.macd?.bullish       || false;
  const macdDivBear = analysis.divergence?.macd?.bearish       || false;
  const srSup = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes = analysis.srLevels?.resistances?.[0] ?? null;
  const nearSupportSR    = srSup && Math.abs(price - srSup) < atr * 1.2;
  const nearResistanceSR = srRes && Math.abs(price - srRes) < atr * 1.2;

  // ── SMC Fields ────────────────────────────────────────────────────────────
  const smc          = analysis.smc || {};
  const smcCHoCH     = smc.choch      || { bull: false, bear: false, level: null };
  const smcIDM       = smc.idm        || { bull: false, bear: false, sweepLevel: null, rejectionStrength: 0 };
  const smcStructure = smc.structure  || { trend: "NEUTRAL" };
  const idmBull   = smcIDM.bull;
  const idmBear   = smcIDM.bear;

  // ════════════════════════════════════════════════════════════════════════════
  // GATE CHECKS
  // ════════════════════════════════════════════════════════════════════════════

  // GATE 1: HTF Alignment
  if (higherBias === "NEUTRAL") return null;
  const side = higherBias === "BULLISH" ? "LONG" : "SHORT";

  // HARD DIRECTIONAL FILTER: only align with 1H trend direction
  if (side === "LONG" && !oneHBullAligned) return null;
  if (side === "SHORT" && !oneHBearAligned) return null;

  if (REENTRY_COOLDOWN_ENABLED && performanceSnapshot) {
    const key = `${String(coin || "").toUpperCase()}:${String(side || "").toUpperCase()}:${String(timeframe || "").toLowerCase()}`;
    const lastLossAt = Number(performanceSnapshot.lastLossAtByCoinSideTimeframe?.[key] || 0);
    const cooldownMs = REENTRY_COOLDOWN_MINUTES * 60 * 1000;
    if (lastLossAt > 0 && (Date.now() - lastLossAt) < cooldownMs) return null;
  }

  if (MID_TF_ALIGNMENT_GUARD_ENABLED && (timeframe === "1m" || timeframe === "5m")) {
    const midRefs = [fifteenM, thirtyM].filter(Boolean);
    let aligned = 0;
    let checked = 0;
    for (const mid of midRefs) {
      const mTrend = mid?.trend || {};
      const mEma50 = Number(mTrend.ema50 || 0);
      const mEma100 = Number(mTrend.ema100 || 0);
      const mAdx = Number(mTrend.adx || 0);
      if (!mEma50 || !mEma100 || mAdx < MID_TF_ALIGNMENT_MIN_ADX) continue;
      checked += 1;
      const isBull = mEma50 > mEma100;
      const isBear = mEma50 < mEma100;
      if ((side === "LONG" && isBull) || (side === "SHORT" && isBear)) aligned += 1;
    }
    if (checked > 0 && aligned === 0) return null;
  }

  // GATE 2: Core EMA Trend — ema50 > ema100 required; ema200 alignment is bonus not gate
  const coreBullStack = ema50 > ema100 * 0.997;
  const coreBearStack = ema50 < ema100 * 1.003;
  if (side === "LONG"  && !coreBullStack) return null;
  if (side === "SHORT" && !coreBearStack) return null;

  // GATE 3: ADX — trend must exist
  const minAdx     = tfRule.minAdx ?? 20;
  const minDiDelta = tfRule.minDiDelta ?? 4;
  if ((adx||0) < minAdx) return null;
  if (side === "LONG"  && ((pdi||0) - (mdi||0)) < minDiDelta) return null;
  if (side === "SHORT" && ((mdi||0) - (pdi||0)) < minDiDelta) return null;

  // GATE 4: Momentum — RSI + MACD (StochRSI is bonus)
  if (!isMomentumAligned(side, analysis, tfRule)) return null;

  // GATE 5: Volume — soft check (bonus scoring, not hard reject)
  // Volume is already scoring bonus points below; hard gate removed to not block valid setups

  // GATE 6 removed: HA is bonus only (not hard gate — blocks too many valid signals)

  // ── SECONDARY FILTERS ─────────────────────────────────────────────────────
  // VWAP check
  if (tfRule.requireVwapSupport) {
    if (side === "LONG"  && price < vwap) return null;
    if (side === "SHORT" && price > vwap) return null;
  }
  // Daily bear block for LONGs
  if (tfRule.blockDailyBear && side === "LONG" && dailyBearStack) return null;
  // Manipulation candle
  if (hasManipulationCandle(side, analysis)) return null;
  // REMOVED: regime === "RANGING" block — too restrictive for crypto mean-reversion
  // BB extreme zone — don't buy overbought top or sell oversold bottom
  if (bbPctB !== null) {
    if (side === "LONG"  && bbPctB > 0.92) return null;
    if (side === "SHORT" && bbPctB < 0.08) return null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // GATES PASSED — Score the signal
  // ════════════════════════════════════════════════════════════════════════════

  const addConf = (cond, score, msg) => {
    if (!cond) return;
    if (side === "LONG") { bullScore += score; bullConf.push(msg); }
    else                 { bearScore += score; bearConf.push(msg); }
  };

  // Base score for passing gates
  addConf(true, 38, `EMA trend ${side === "LONG" ? "bullish" : "bearish"} (21>50>200)`);
  addConf(true, 14, `ADX ${roundPrice(adx||0)} | ${side === "LONG" ? "+DI" : "-DI"} dominant`);
  addConf(true, 14, `RSI ${roundPrice(rsi||0)} aligned | MACD confirmed`);
  addConf(true, 8,  `Volume ${(currentVolume/Math.max(averageVolume,1)).toFixed(1)}x avg`);
  addConf(true, 6,  `HA ${side === "LONG" ? "bullish" : "bearish"}`);

  // EMA slope bonus (ema21 + ema50 both rising/falling)
  const bullSlope = ema21Rising && ema50Rising;
  const bearSlope = ema21Falling && ema50Falling;
  if (side === "LONG"  && bullSlope) addConf(true, 6, "EMA slopes rising");
  if (side === "SHORT" && bearSlope) addConf(true, 6, "EMA slopes falling");

  // Full 5-EMA perfect stack (bonus, not gate)
  const perfectBullStack = ema9 > ema21 && ema21 > ema50 && ema50 > ema100 && ema100 > ema200;
  const perfectBearStack = ema9 < ema21 && ema21 < ema50 && ema50 < ema100 && ema100 < ema200;
  if (side === "LONG"  && perfectBullStack) addConf(true, 8, "Perfect 5-EMA bull stack ⚡");
  if (side === "SHORT" && perfectBearStack) addConf(true, 8, "Perfect 5-EMA bear stack ⚡");

  // HTF quality bonuses
  if (side === "LONG"  && dailyBullStack) addConf(true, 7, "Daily macro bullish");
  if (side === "SHORT" && !dailyBullStack) addConf(true, 7, "Daily macro bearish");
  if (oneH) {
    const oh = oneH.trend.ema50 > oneH.trend.ema100 ? "BULLISH" : "BEARISH";
    if ((side === "LONG" && oh === "BULLISH") || (side === "SHORT" && oh === "BEARISH"))
      addConf(true, 5, "1H confirming");
  }

  // PSAR
  if (side === "LONG"  && psarBull) addConf(true, 5, "PSAR bullish dots");
  if (side === "SHORT" && psarBear) addConf(true, 5, "PSAR bearish dots");

  // Ichimoku (bonus not gate)
  if (side === "LONG"  && ichimoku?.bullish)    addConf(true, 7, "Ichimoku cloud bullish");
  if (side === "LONG"  && ichimoku?.aboveCloud) addConf(true, 4, "Above Ichimoku cloud");
  if (side === "SHORT" && ichimoku?.bearish)    addConf(true, 7, "Ichimoku cloud bearish");
  if (side === "SHORT" && ichimoku?.belowCloud) addConf(true, 4, "Below Ichimoku cloud");

  // VWAP bonus
  addConf(true, 4, `${side === "LONG" ? "Above" : "Below"} VWAP ${roundPrice(vwap)}`);

  // S/R proximity
  if (side === "LONG"  && nearSupportSR)    addConf(true, 8, `Near support ${roundPrice(srSup)}`);
  if (side === "SHORT" && nearResistanceSR) addConf(true, 8, `Near resistance ${roundPrice(srRes)}`);

  // BB position
  if (bbPctB !== null && bbPctB < 0.35 && side === "LONG")  addConf(true, 5, `BB lower zone (${(bbPctB*100).toFixed(0)}%)`);
  if (bbPctB !== null && bbPctB > 0.65 && side === "SHORT") addConf(true, 5, `BB upper zone (${(bbPctB*100).toFixed(0)}%)`);

  // OBV
  if (side === "LONG"  && obvTrending)              addConf(true, 5, "OBV trending up");
  if (side === "SHORT" && !obvTrending && obvChange < 0) addConf(true, 5, "OBV trending down");

  // Stoch confirmation (bonus)
  const stochK_val = stochK !== null ? stochK : 50;
  const kdK_val    = kdK !== null ? kdK : 50;
  const kdD_val    = kdD !== null ? kdD : 50;
  if (stochK_val < 30 && side === "LONG")  addConf(true, 5, `StochRSI oversold ${stochK_val.toFixed(0)}`);
  if (stochK_val > 70 && side === "SHORT") addConf(true, 5, `StochRSI overbought ${stochK_val.toFixed(0)}`);
  if (kdK_val > kdD_val && side === "LONG")  { bullScore += 3; }
  if (kdK_val < kdD_val && side === "SHORT") { bearScore += 3; }

  // Divergence (high value confirmations)
  if (rsiDivBull  && side === "LONG")  addConf(true, 12, "RSI bullish divergence ⚡");
  if (rsiDivBear  && side === "SHORT") addConf(true, 12, "RSI bearish divergence ⚡");
  if (macdDivBull && side === "LONG")  addConf(true, 8,  "MACD bullish divergence");
  if (macdDivBear && side === "SHORT") addConf(true, 8,  "MACD bearish divergence");
  if (rsiHidBull  && side === "LONG")  addConf(true, 5,  "RSI hidden bull div (trend cont.)");
  if (rsiHidBear  && side === "SHORT") addConf(true, 5,  "RSI hidden bear div (trend cont.)");

  // HA strong bonus
  if (haStrongBull && haNoLowerWick && side === "LONG")  addConf(true, 5, "HA no lower wick (pure bull)");
  if (haStrongBear && haNoUpperWick && side === "SHORT") addConf(true, 5, "HA no upper wick (pure bear)");

  // AO
  if (aoCrossUp   && side === "LONG")  addConf(true, 6, "AO zero-cross up");
  if (aoCrossDown && side === "SHORT") addConf(true, 6, "AO zero-cross down");
  else if ((ao||0) > 0 && side === "LONG")  { bullScore += 3; }
  else if ((ao||0) < 0 && side === "SHORT") { bearScore += 3; }

  // TRIX
  if (trixCrossUp   && side === "LONG")  addConf(true, 4, "TRIX cross+");
  if (trixCrossDown && side === "SHORT") addConf(true, 4, "TRIX cross-");
  else if ((trix||0) > 0 && side === "LONG")  bullScore += 2;
  else if ((trix||0) < 0 && side === "SHORT") bearScore += 2;

  // KST
  if (kstBullish && side === "LONG")  addConf(true, 4, "KST bullish");
  if (kstBearish && side === "SHORT") addConf(true, 4, "KST bearish");

  // CCI
  if (cci !== null && cci > 100  && cci < 200  && side === "LONG")  addConf(true, 4, `CCI ${cci.toFixed(0)}`);
  if (cci !== null && cci < -100 && cci > -200 && side === "SHORT") addConf(true, 4, `CCI ${cci.toFixed(0)}`);

  // Volume surge
  if (volumeStrong) addConf(true, 5, "Volume surge 2x+");
  if (activeMarket.isLiquid)  addConf(true, 4, `24h vol ${formatCompact(activeMarket.quoteVolume)} USDT`);
  if (activeMarket.isCrowded) addConf(true, 4, `${formatCompact(activeMarket.tradeCount)} trades/24h`);

  // MFI
  if (mfi !== null && mfi >= 50 && mfi <= 75 && side === "LONG")  addConf(true, 3, `MFI ${roundPrice(mfi)}`);
  if (mfi !== null && mfi <= 50 && mfi >= 25 && side === "SHORT") addConf(true, 3, `MFI ${roundPrice(mfi)}`);

  // Force index
  if (forceIndex > 0 && side === "LONG")  bullScore += 2;
  if (forceIndex < 0 && side === "SHORT") bearScore += 2;

  // BB squeeze
  if (bbWidth && rawAtr && bbWidth < rawAtr * 2.5) addConf(true, 3, "BB squeeze (breakout pending)");

  // ── SMC Scoring ───────────────────────────────────────────────────────────
  if (idmBull && side === "LONG")  { const s = Math.round(smcIDM.rejectionStrength); addConf(true, 6, "IDM 🎯 liquidity grab + rejection (" + s + "/10)"); }
  if (idmBear && side === "SHORT") { const s = Math.round(smcIDM.rejectionStrength); addConf(true, 6, "IDM 🎯 liquidity grab + rejection (" + s + "/10)"); }

  // Candlestick patterns
  const strongBullPat = ["Morning Star","Morning Doji Star","Three White Soldiers","Bullish Engulfing","Bullish Marubozu","Abandoned Baby (Bull)"];
  const strongBearPat = ["Evening Star","Evening Doji Star","Three Black Crows","Bearish Engulfing","Bearish Marubozu","Downside Tasuki Gap"];
  const patBull  = (analysis.patterns?.bullish || []);
  const patBear  = (analysis.patterns?.bearish || []);
  const confBull = patBull.filter(p => strongBullPat.includes(p));
  const confBear = patBear.filter(p => strongBearPat.includes(p));
  if (confBull.length && side === "LONG")  addConf(true, 10, confBull.join(", "));
  if (confBear.length && side === "SHORT") addConf(true, 10, confBear.join(", "));

  // ROC momentum
  if ((roc||0) > 0  && side === "LONG")  bullScore += 2;
  if ((roc||0) < 0  && side === "SHORT") bearScore += 2;
  if ((roc5||0) > 0 && side === "LONG")  bullScore += 2;
  if ((roc5||0) < 0 && side === "SHORT") bearScore += 2;

  // ── Final publish check ───────────────────────────────────────────────────
  const baseConfidence = side === "LONG" ? bullScore : bearScore;
  const confirmations = side === "LONG" ? bullConf  : bearConf;

  const adaptiveQuality  = getAdaptiveQualityConfig(performanceSnapshot, { coin, side, timeframe });
  const learningAdjustment = getSelfLearningAdjustment(selfLearningModel, { coin, side, timeframe });
  const localAiAdjustment = getLocalAiAdjustment(selfLearningModel?.localModel, { coin, side, timeframe, baseConfidence });
  if (adaptiveQuality.blockCoin || learningAdjustment.blockCoin || localAiAdjustment.blockCoin) return null;

  const confidence = clamp(baseConfidence + learningAdjustment.scoreDelta + localAiAdjustment.confidenceDelta, 0, 100);
  const minScore         = (tfRule.minScore         || 62) + adaptiveQuality.scoreBoost;
  const minConfirmations = (tfRule.minConfirmations || 5)  + adaptiveQuality.minConfirmationsBoost;
  const publishFloorBase = (tfRule.publishFloor     || DEFAULT_PUBLISH_FLOOR) + adaptiveQuality.publishFloorBoost + learningAdjustment.publishFloorBoost + localAiAdjustment.publishFloorBoost;
  const publishFloor     = Math.max(publishFloorBase, Number(adaptiveQuality.minPublishFloorAbs || 0));

  if (confidence < minScore)                   return null;
  if (confirmations.length < minConfirmations) return null;
  if (confidence < publishFloor)               return null;
  if (QUALITY_MODE === "ULTRA") {
    if (confidence < ULTRA_MIN_CONFIDENCE) return null;
    if (!activeMarket.isLiquid) return null;
    if ((adx || 0) < ((tfRule.minAdx || 12) + 3)) return null;
    if (!volumeStrong) return null;
    if (side === "LONG" && !(haStrongBull || ichimoku?.bullish)) return null;
    if (side === "SHORT" && !(haStrongBear || ichimoku?.bearish)) return null;
  }

  // Entry drift check — slightly more lenient
  // IDM entry refinement: tighten SL anchor to sweep level
  if (idmBull && smcIDM.sweepLevel && smcIDM.sweepLevel < analysis.currentPrice) {
    if (analysis.srLevels && analysis.srLevels.supports) {
      analysis.srLevels.supports.unshift(smcIDM.sweepLevel * 0.999);
    }
  }
  if (idmBear && smcIDM.sweepLevel && smcIDM.sweepLevel > analysis.currentPrice) {
    if (analysis.srLevels && analysis.srLevels.resistances) {
      analysis.srLevels.resistances.unshift(smcIDM.sweepLevel * 1.001);
    }
  }

  const targets         = calculateTargets(side, analysis, timeframe);
  const leverage        = calculateLeverage(analysis, confidence, timeframe);
  if (!Number.isFinite(targets.riskPerUnit) || targets.riskPerUnit <= 0) return null;
  let srRoomR = null;
  if (SR_ROOM_GUARD_ENABLED) {
    if (side === "LONG" && Number.isFinite(srRes) && srRes > targets.entry) {
      srRoomR = (srRes - targets.entry) / targets.riskPerUnit;
    } else if (side === "SHORT" && Number.isFinite(srSup) && srSup < targets.entry) {
      srRoomR = (targets.entry - srSup) / targets.riskPerUnit;
    }
    if (srRoomR !== null && srRoomR < SR_ROOM_MIN_R) return null;
  }
  const atrPercent = price > 0 ? (atr / price) * 100 : 0;
  if (VOL_GUARD_ENABLED) {
    const volBand = getVolatilityBand(timeframe);
    if (!Number.isFinite(atrPercent) || atrPercent < volBand.min || atrPercent > volBand.max) return null;
  }
  const driftMultiplier = tfRule.entryDriftMultiplier ?? 0.5;
  const entryDriftLimit = Math.max(atr * driftMultiplier, atr * 0.2);
  if (Math.abs(price - targets.entry) > entryDriftLimit) return null;

  const strength = confidence >= STRENGTH_THRESHOLDS.STRONG ? "STRONG" : "MEDIUM";

  return createSignal({
    coin, side, timeframe, confidence, leverage, strength, confirmations,
    indicatorSnapshot: {
      ema9: roundPrice(ema9), ema21: roundPrice(ema21), ema50: roundPrice(ema50),
      ema100: roundPrice(ema100), ema200: roundPrice(ema200), vwap: roundPrice(vwap),
      adx: roundPrice(adx||0), pdi: roundPrice(pdi||0), mdi: roundPrice(mdi||0),
      psar: roundPrice(psar||0), rsi: roundPrice(rsi||0), rsi9: roundPrice(rsi9||0),
      cci: roundPrice(cci||0), mfi: roundPrice(mfi||0), ao: roundPrice(ao||0),
      williamsR: roundPrice(williamsR||0), trix: roundPrice(trix||0),
      macd: { histogram: roundPrice(macd?.histogram||0), macd: roundPrice(macd?.MACD||0), signal: roundPrice(macd?.signal||0) },
      atr: roundPrice(rawAtr||0), bbPctB: roundPrice(bbPctB||0),
      bollinger: { upper: roundPrice(bollinger?.upper||0), middle: roundPrice(bollinger?.middle||0), lower: roundPrice(bollinger?.lower||0) },
      regime, volumeSpike, volumeStrong, higherBias, effectiveBias: higherBias, leverage,
      rsiDivBull, rsiDivBear, macdDivBull, macdDivBear,
      riskPerUnit: roundPrice(targets.riskPerUnit),
      marketActivity: { quoteVolume: roundPrice(activeMarket.quoteVolume), tradeCount: roundPrice(activeMarket.tradeCount), openInterestValue: roundPrice(activeMarket.openInterestValue), activityScore: roundPrice(activeMarket.activityScore) },
    },
    patternSummary: analysis.patterns,
    scanMeta: {
      higherBias, effectiveBias: higherBias, ruleVersion: RULE_VERSION, publishFloor,
      marketActivityScore: roundPrice(activeMarket.activityScore),
      marketQuoteVolume: roundPrice(activeMarket.quoteVolume),
      marketTradeCount: roundPrice(activeMarket.tradeCount),
      marketOpenInterestValue: roundPrice(activeMarket.openInterestValue),
      atrPercent: roundPrice(atrPercent),
      srRoomR: srRoomR === null ? null : roundPrice(srRoomR),
      modelVersion: SIGNAL_MODEL_VERSION + "+" + engineState.selfLearning.version + "+" + (selfLearningModel?.localModel?.version || "local_nb_v1"),
      qualityGuard: {
        scoreBoost: adaptiveQuality.scoreBoost,
        publishFloorBoost: adaptiveQuality.publishFloorBoost,
        minPublishFloorAbs: adaptiveQuality.minPublishFloorAbs,
        minConfirmationsBoost: adaptiveQuality.minConfirmationsBoost,
        reasons: adaptiveQuality.reasons,
      },
      selfLearning: {
        sampleSize: Number(selfLearningModel?.sampleSize || 0),
        overallWinRate: selfLearningModel?.overallWinRate ?? null,
        confidenceDelta: learningAdjustment.scoreDelta,
        publishFloorBoost: learningAdjustment.publishFloorBoost,
        reasons: learningAdjustment.reasons,
      },
      localAI: {
        enabled: Boolean(localAiAdjustment.enabled),
        modelVersion: localAiAdjustment.modelVersion,
        predictedWinProbability: localAiAdjustment.predictedWinProbability,
        confidenceDelta: localAiAdjustment.confidenceDelta,
        publishFloorBoost: localAiAdjustment.publishFloorBoost,
        reasons: localAiAdjustment.reasons,
      },
      smc: {
        choch:     { bull: false, bear: false, level: smcCHoCH.level },
        idm:       { bull: idmBull,   bear: idmBear,   sweepLevel: smcIDM.sweepLevel, rejectionStrength: smcIDM.rejectionStrength },
        structure: smcStructure.trend,
      },
      sourceTimeframes: SCAN_TIMEFRAMES,
      timeframeRule: tfRule,
      gatesPassed: 4,
    },
    source: "ENGINE",
    ...targets,
  });
}

// ─── Crypto candle fetch (Binance/Bybit) ──────────────────────────────────────
async function fetchCryptoCandles(symbol, tf) {
  try {
    const raw = await getKlines(symbol, tf, 200);
    return (raw || []).filter(c =>
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low)  && Number.isFinite(c.close)
    );
  } catch (e) {
    console.error(`[cryptoEngine/fetchCandles] ${symbol} ${tf}:`, e.message);
    return [];
  }
}

// ─── Coin Scan ────────────────────────────────────────────────────────────────
async function analyzeCoin(coin, marketActivity = null, performanceSnapshot = null, selfLearningModel = null, sidePauseMap = null, timeframePauseMap = null) {
  const analyses = {};
  const timeframeConcurrency = getTimeframeFetchConcurrency();

  await mapWithConcurrency(SCAN_TIMEFRAMES, timeframeConcurrency, async (tf) => {
    const candles = await fetchCryptoCandles(coin, tf);
    if (candles.length >= 20) analyses[tf] = analyzeCandles(candles);
    await sleep(20);
    return true;
  });

  const htf = {
    daily: analyses["1h"] || null,
    twelveH: null,
    fourH: null,
    oneH: analyses["1h"] || null,
    fifteenM: analyses["15m"] || null,
    thirtyM: analyses["30m"] || null,
  };
  const isSidePausedForCoin = (side) => {
    const key = buildCoinSideKey(coin, side);
    if (!key) return false;
    if (sidePauseMap && sidePauseMap[key]) return true;
    return Boolean(isCoinSidePaused(coin, side));
  };
  const isTimeframePausedForScan = (timeframe) => {
    const key = String(timeframe || "").toLowerCase();
    if (!key) return false;
    if (timeframePauseMap && timeframePauseMap[key]) return true;
    return Boolean(isTimeframePaused(key));
  };
  const tradeTimeframes = getTradeTimeframes();
  const candidates = tradeTimeframes
    .flatMap((tf) => {
      if (!analyses[tf]) return [];
      if (isTimeframePausedForScan(tf)) return [];

      const bias = getHigherTimeframeBias(analyses, tf);
      const bySide = {
        LONG: isSidePausedForCoin("LONG") ? null : buildCandidate(coin, tf, analyses[tf], "BULLISH", htf, marketActivity, performanceSnapshot, selfLearningModel),
        SHORT: isSidePausedForCoin("SHORT") ? null : buildCandidate(coin, tf, analyses[tf], "BEARISH", htf, marketActivity, performanceSnapshot, selfLearningModel),
      };

      const picked = [];
      const marketLiquid = Boolean(marketActivity?.isLiquid);
      const recent30 = performanceSnapshot?.recent30 || { total: 0, winRate: null };
      const counterTrendAllowed = !COUNTER_TREND_DRAWDOWN_GUARD_ENABLED || !(
        Number(recent30.total || 0) >= COUNTER_TREND_DRAWDOWN_MIN_SAMPLE &&
        recent30.winRate !== null &&
        Number(recent30.winRate) <= COUNTER_TREND_DRAWDOWN_WINRATE
      );
      if (bias === "BULLISH") {
        if (bySide.LONG) picked.push(bySide.LONG);
        const shortAdx = Number(bySide.SHORT?.indicatorSnapshot?.adx || 0);
        if (COUNTER_TREND_ENABLED && counterTrendAllowed && bySide.SHORT && bySide.SHORT.confidence >= COUNTER_TREND_MIN_CONF && shortAdx >= COUNTER_TREND_ADX_MIN && marketLiquid) {
          picked.push({
            ...bySide.SHORT,
            confidence: Math.max(0, bySide.SHORT.confidence - 5),
            scanMeta: {
              ...(bySide.SHORT.scanMeta || {}),
              counterTrend: true,
              baseBias: bias,
              counterTrendGuard: { minConfidence: COUNTER_TREND_MIN_CONF, minAdx: COUNTER_TREND_ADX_MIN, marketLiquid },
            },
          });
        }
      } else if (bias === "BEARISH") {
        if (bySide.SHORT) picked.push(bySide.SHORT);
        const longAdx = Number(bySide.LONG?.indicatorSnapshot?.adx || 0);
        if (COUNTER_TREND_ENABLED && counterTrendAllowed && bySide.LONG && bySide.LONG.confidence >= COUNTER_TREND_MIN_CONF && longAdx >= COUNTER_TREND_ADX_MIN && marketLiquid) {
          picked.push({
            ...bySide.LONG,
            confidence: Math.max(0, bySide.LONG.confidence - 5),
            scanMeta: {
              ...(bySide.LONG.scanMeta || {}),
              counterTrend: true,
              baseBias: bias,
              counterTrendGuard: { minConfidence: COUNTER_TREND_MIN_CONF, minAdx: COUNTER_TREND_ADX_MIN, marketLiquid },
            },
          });
        }
      } else {
        if (bySide.LONG && bySide.LONG.confidence >= 84) picked.push(bySide.LONG);
        if (bySide.SHORT && bySide.SHORT.confidence >= 84) picked.push(bySide.SHORT);
      }

      return picked;
    })
    .filter(Boolean);

  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.confidence - a.confidence)[0];
}

// ─── Crypto batch price fetch ────────────────────────────────────────────────
async function fetchCryptoPrices(coins) {
  if (!coins.length) return {};
  try {
    return await getPrices(coins);
  } catch (e) {
    console.error("[cryptoEngine/fetchPrices] Error:", e.message);
    return {};
  }
}

// ─── Signal Evaluation (TP/SL only) ──────────────────────────────────────────
async function evaluateActiveSignals() {
  const signals = await readCollection(SIGNAL_COLLECTION);
  const active  = signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE);
  if (!active.length) return [];
  const prices = await fetchCryptoPrices([...new Set(active.map(s => s.coin))]);
  const now    = new Date().toISOString();
  const closed = [];
  await mutateCollection(SIGNAL_COLLECTION, records => records.map(sig => {
    if (sig.status !== SIGNAL_STATUS.ACTIVE) return sig;
    const price = prices[sig.coin];
    if (!Number.isFinite(price)) return sig;
    const hit = r => { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: r, closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; };
    if (sig.side === "LONG") {
      if (price >= sig.tp3)      return hit("TP3_HIT");
      if (price >= sig.tp2)      return hit("TP2_HIT");
      if (price >= sig.tp1)      return hit("TP1_HIT");
      if (price <= sig.stopLoss) return hit("SL_HIT");
    } else {
      if (price <= sig.tp3)      return hit("TP3_HIT");
      if (price <= sig.tp2)      return hit("TP2_HIT");
      if (price <= sig.tp1)      return hit("TP1_HIT");
      if (price >= sig.stopLoss) return hit("SL_HIT");
    }
    return sig;
  }));
  closed.forEach(s => {
    try { ws()?.broadcastStockSignalClosed(s);   } catch {}
    try { sse()?.broadcastSignalClosed(s, true); } catch {}
    // Facebook auto-post removed
  });
  return closed;
}

async function getPerformanceSnapshot() {
  const fallback = {
    overall: buildTally(),
    LONG: buildTally(),
    SHORT: buildTally(),
    "5m": buildTally(),
    "1m": buildTally(),
    byCoin: {},
    bySideTimeframe: {},
    recentSlStreakByCoin: {},
    recent5LossCountByCoin: {},
    recentLossCountByCoinSide: {},
    recentLossCountByTimeframe: {},
    lastLossAtByCoinSideTimeframe: {},
    recent30: { wins: 0, losses: 0, total: 0, winRate: null },
    sampleSize: 0,
  };

  try {
    const signals = await readCollection(SIGNAL_COLLECTION);
    const stats = {
      ...fallback,
      byCoin: {},
      bySideTimeframe: {},
      recentSlStreakByCoin: {},
      recent5LossCountByCoin: {},
      recentLossCountByCoinSide: {},
      recentLossCountByTimeframe: {},
      lastLossAtByCoinSideTimeframe: {},
      recent30: { wins: 0, losses: 0, total: 0, winRate: null },
    };

    const resolved = [];
    for (const sig of signals) {
      const isWin = WIN_RESULTS.has(sig.result);
      const isLoss = LOSS_RESULTS.has(sig.result);
      if (!isWin && !isLoss) continue;
      resolved.push(sig);

      const key = isWin ? "wins" : "losses";
      stats.overall[key] += 1;
      if (stats[sig.side]) stats[sig.side][key] += 1;
      if (!stats[sig.timeframe]) stats[sig.timeframe] = buildTally();
      stats[sig.timeframe][key] += 1;

      updateTally(stats.bySideTimeframe, `${sig.side}:${sig.timeframe}`, isWin);
    }

    const recentResolved = [...resolved]
      .sort((a, b) => {
        const aTs = new Date(a.closedAt || a.updatedAt || a.createdAt || 0).getTime();
        const bTs = new Date(b.closedAt || b.updatedAt || b.createdAt || 0).getTime();
        return bTs - aTs;
      })
      .slice(0, 140);

    const recent30 = recentResolved.slice(0, 30);
    const recent30Wins = recent30.filter((sig) => WIN_RESULTS.has(sig.result)).length;
    const recent30Losses = recent30.filter((sig) => LOSS_RESULTS.has(sig.result)).length;
    const recent30Total = recent30Wins + recent30Losses;
    stats.recent30 = {
      wins: recent30Wins,
      losses: recent30Losses,
      total: recent30Total,
      winRate: recent30Total ? Number(((recent30Wins / recent30Total) * 100).toFixed(1)) : null,
    };
    const byCoinSeries = {};
    const byCoinSideSeries = {};
    const byTimeframeSeries = {};
    const lastLossAtByCoinSideTimeframe = {};
    for (const sig of recentResolved) {
      const coin = String(sig.coin || "").toUpperCase();
      if (!coin) continue;
      const isWin = WIN_RESULTS.has(sig.result);
      updateTally(stats.byCoin, coin, isWin);
      if (!byCoinSeries[coin]) byCoinSeries[coin] = [];
      byCoinSeries[coin].push(sig.result);
      const side = String(sig.side || "").toUpperCase();
      const coinSideKey = side ? `${coin}:${side}` : "";
      if (coinSideKey) {
        if (!byCoinSideSeries[coinSideKey]) byCoinSideSeries[coinSideKey] = [];
        byCoinSideSeries[coinSideKey].push(sig.result);
      }
      const tfKey = String(sig.timeframe || "").toLowerCase();
      if (tfKey) {
        if (!byTimeframeSeries[tfKey]) byTimeframeSeries[tfKey] = [];
        byTimeframeSeries[tfKey].push(sig.result);
      }
      const sideTfKey = side && tfKey ? `${coin}:${side}:${tfKey}` : "";
      if (sideTfKey && isLoss && !lastLossAtByCoinSideTimeframe[sideTfKey]) {
        const ts = new Date(sig.closedAt || sig.updatedAt || sig.createdAt || 0).getTime();
        if (Number.isFinite(ts) && ts > 0) lastLossAtByCoinSideTimeframe[sideTfKey] = ts;
      }
    }

    for (const [coin, series] of Object.entries(byCoinSeries)) {
      let streak = 0;
      for (const result of series) {
        if (LOSS_RESULTS.has(result)) {
          streak += 1;
          continue;
        }
        break;
      }
      stats.recentSlStreakByCoin[coin] = streak;

      const recentWindow = series.slice(0, AUTO_COIN_COOLDOWN_WINDOW);
      const recentLossCount = recentWindow.filter((result) => LOSS_RESULTS.has(result)).length;
      stats.recent5LossCountByCoin[coin] = recentLossCount;
    }

    for (const [coinSideKey, series] of Object.entries(byCoinSideSeries)) {
      const recentWindow = series.slice(0, AUTO_COIN_SIDE_COOLDOWN_WINDOW);
      const recentLossCount = recentWindow.filter((result) => LOSS_RESULTS.has(result)).length;
      stats.recentLossCountByCoinSide[coinSideKey] = recentLossCount;
    }
    for (const [tfKey, series] of Object.entries(byTimeframeSeries)) {
      const recentWindow = series.slice(0, AUTO_TF_COOLDOWN_WINDOW);
      const recentLossCount = recentWindow.filter((result) => LOSS_RESULTS.has(result)).length;
      stats.recentLossCountByTimeframe[tfKey] = recentLossCount;
    }

    stats.lastLossAtByCoinSideTimeframe = lastLossAtByCoinSideTimeframe;
    stats.sampleSize = stats.overall.wins + stats.overall.losses;
    return stats;
  } catch {
    return fallback;
  }
}

// ─── Persist / Manual ────────────────────────────────────────────────────────
async function persistSignal(signal) {
  const result = await mutateCollection(SIGNAL_COLLECTION, records => ({ records: [signal, ...records], value: signal }));
  try { ws()?.broadcastNewSignal(signal);   } catch {}
  try { sse()?.broadcastNewSignal(signal, false); } catch {}
  // Facebook auto-post removed
  try { push()?.broadcastSignalPush(signal);     } catch {}
  try { tg()?.autoSendSignal(signal);            } catch {}
  return result;
}
async function createManualSignal(payload, actor) {
  const confidence = Number(payload.confidence || 75);
  const leverage   = clamp(Number(payload.leverage || 10), 10, 50);
  const signal     = createSignal({
    coin: payload.coin, side: payload.side, timeframe: payload.timeframe || "5m",
    entry: payload.entry, stopLoss: payload.stopLoss, tp1: payload.tp1, tp2: payload.tp2, tp3: payload.tp3,
    confidence, leverage,
    confirmations: Array.isArray(payload.confirmations) ? payload.confirmations : ["Admin signal"],
    indicatorSnapshot: payload.indicatorSnapshot || {}, patternSummary: payload.patternSummary || {},
    scanMeta: { createdBy: actor?.email || "admin", manual: true, ...(payload.scanMeta || {}) },
    source: payload.source || "MANUAL", strength: confidence >= 90 ? "STRONG" : "MEDIUM",
  });
  await persistSignal(signal);
  return signal;
}

function cleanupExpiredAutoPauses(nowMs = Date.now()) {
  for (const [coin, entry] of Object.entries(engineState.pausedCoins || {})) {
    const until = entry && entry.pausedUntil ? new Date(entry.pausedUntil).getTime() : 0;
    if (entry && entry.autoManaged && until && until <= nowMs) {
      delete engineState.pausedCoins[coin];
    }
  }
  for (const [coinSideKey, entry] of Object.entries(engineState.pausedCoinSides || {})) {
    const until = entry && entry.pausedUntil ? new Date(entry.pausedUntil).getTime() : 0;
    if (entry && entry.autoManaged && until && until <= nowMs) {
      delete engineState.pausedCoinSides[coinSideKey];
    }
  }
  for (const [tfKey, entry] of Object.entries(engineState.pausedTimeframes || {})) {
    const until = entry && entry.pausedUntil ? new Date(entry.pausedUntil).getTime() : 0;
    if (entry && entry.autoManaged && until && until <= nowMs) {
      delete engineState.pausedTimeframes[tfKey];
    }
  }
}

function isCoinPaused(symbol) {
  cleanupExpiredAutoPauses();
  const coin = String(symbol || "").toUpperCase();
  return engineState.pausedCoins[coin] || null;
}

function buildCoinSideKey(symbol, side) {
  const coin = String(symbol || "").toUpperCase();
  const dir = String(side || "").toUpperCase();
  if (!coin || !dir) return "";
  return `${coin}:${dir}`;
}

function isCoinSidePaused(symbol, side) {
  cleanupExpiredAutoPauses();
  const key = buildCoinSideKey(symbol, side);
  return key ? (engineState.pausedCoinSides[key] || null) : null;
}

function isTimeframePaused(timeframe) {
  cleanupExpiredAutoPauses();
  const key = String(timeframe || "").toLowerCase();
  return key ? (engineState.pausedTimeframes[key] || null) : null;
}

function applyAutoCoinCooldown(performanceSnapshot) {
  if (!AUTO_COIN_COOLDOWN_ENABLED) return;
  const nowMs = Date.now();
  const untilIso = new Date(nowMs + AUTO_COIN_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
  const lossMap = performanceSnapshot && performanceSnapshot.recent5LossCountByCoin ? performanceSnapshot.recent5LossCountByCoin : {};

  for (const [coinRaw, lossCountRaw] of Object.entries(lossMap)) {
    const coin = String(coinRaw || "").toUpperCase();
    const lossCount = Number(lossCountRaw || 0);
    if (!coin || lossCount < AUTO_COIN_COOLDOWN_MIN_LOSSES) continue;

    const existing = engineState.pausedCoins[coin];
    if (existing && !existing.autoManaged) continue;
    if (existing && existing.autoManaged && existing.pausedUntil) {
      const prevUntil = new Date(existing.pausedUntil).getTime();
      if (Number.isFinite(prevUntil) && prevUntil > nowMs) continue;
    }

    engineState.pausedCoins[coin] = {
      pausedAt: new Date(nowMs).toISOString(),
      pausedUntil: untilIso,
      reason: "Auto cooldown: " + String(lossCount) + "/" + String(AUTO_COIN_COOLDOWN_WINDOW) + " recent closed trades hit SL",
      pausedBy: "ml-model",
      autoManaged: true,
    };
  }
}

function applyAutoCoinSideCooldown(performanceSnapshot) {
  if (!AUTO_COIN_SIDE_COOLDOWN_ENABLED) return;
  const nowMs = Date.now();
  const untilIso = new Date(nowMs + AUTO_COIN_SIDE_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
  const lossMap = performanceSnapshot && performanceSnapshot.recentLossCountByCoinSide ? performanceSnapshot.recentLossCountByCoinSide : {};

  for (const [coinSideRaw, lossCountRaw] of Object.entries(lossMap)) {
    const coinSideKey = String(coinSideRaw || "").toUpperCase();
    const lossCount = Number(lossCountRaw || 0);
    if (!coinSideKey || lossCount < AUTO_COIN_SIDE_COOLDOWN_MIN_LOSSES) continue;

    const existing = engineState.pausedCoinSides[coinSideKey];
    if (existing && existing.autoManaged && existing.pausedUntil) {
      const prevUntil = new Date(existing.pausedUntil).getTime();
      if (Number.isFinite(prevUntil) && prevUntil > nowMs) continue;
    }

    engineState.pausedCoinSides[coinSideKey] = {
      pausedAt: new Date(nowMs).toISOString(),
      pausedUntil: untilIso,
      reason: "Auto side cooldown: " + String(lossCount) + "/" + String(AUTO_COIN_SIDE_COOLDOWN_WINDOW) + " recent closed trades hit SL",
      pausedBy: "ml-model",
      autoManaged: true,
    };
  }
}

function applyAutoTimeframeCooldown(performanceSnapshot) {
  if (!AUTO_TF_COOLDOWN_ENABLED) return;
  const nowMs = Date.now();
  const untilIso = new Date(nowMs + AUTO_TF_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
  const lossMap = performanceSnapshot && performanceSnapshot.recentLossCountByTimeframe ? performanceSnapshot.recentLossCountByTimeframe : {};

  for (const [tfRaw, lossCountRaw] of Object.entries(lossMap)) {
    const tfKey = String(tfRaw || "").toLowerCase();
    const lossCount = Number(lossCountRaw || 0);
    if (!tfKey || lossCount < AUTO_TF_COOLDOWN_MIN_LOSSES) continue;

    const existing = engineState.pausedTimeframes[tfKey];
    if (existing && existing.autoManaged && existing.pausedUntil) {
      const prevUntil = new Date(existing.pausedUntil).getTime();
      if (Number.isFinite(prevUntil) && prevUntil > nowMs) continue;
    }

    engineState.pausedTimeframes[tfKey] = {
      pausedAt: new Date(nowMs).toISOString(),
      pausedUntil: untilIso,
      reason: "Auto timeframe cooldown: " + String(lossCount) + "/" + String(AUTO_TF_COOLDOWN_WINDOW) + " recent closed trades hit SL",
      pausedBy: "ml-model",
      autoManaged: true,
    };
  }
}

async function scanNow({ source = "ENGINE" } = {}) {
  if (engineState.isScanning) return { skipped: true, message: "Scan already in progress" };
  engineState.isScanning = true;

  const generatedSignals = [];
  const errors = [];

  try {
    const closedSignals = await evaluateActiveSignals();
    const performanceSnapshot = await getPerformanceSnapshot();
    applyAutoCoinCooldown(performanceSnapshot);
    applyAutoCoinSideCooldown(performanceSnapshot);
    applyAutoTimeframeCooldown(performanceSnapshot);
    const selfLearningModel = await refreshSelfLearningModel({ force: closedSignals.length > 0 });
    const scanUniverse = await getScanUniverse();
    const coins = scanUniverse.slice(0, getMaxCoinsPerScan());
    const scanConcurrency = getCoinScanConcurrency();
    const activeSignalKeys = await getActiveSignalKeySet();

    const scanResults = await mapWithConcurrency(coins, scanConcurrency, async (market) => {
      const pauseEntry = isCoinPaused(market.symbol);
      if (pauseEntry) {
        const until = pauseEntry.pausedUntil ? " until " + pauseEntry.pausedUntil : "";
        return { coin: market.symbol, skipped: true, message: (pauseEntry.autoManaged ? "Auto-cooled down" : "Paused by admin") + until + " — skipped in scan" };
      }
      const candidate = await analyzeCoin(market.symbol, market, performanceSnapshot, selfLearningModel, engineState.pausedCoinSides, engineState.pausedTimeframes);
      return { coin: market.symbol, candidate };
    });

    for (const result of scanResults) {
      if (!result) continue;
      if (result?.error) {
        errors.push({ coin: coins[result.index]?.symbol || "UNKNOWN", message: result.error.message || "Scan failed" });
        continue;
      }
      if (result.skipped) {
        errors.push({ coin: result.coin, message: result.message });
        continue;
      }
      if (!result.candidate) continue;

      try {
        const candidate = result.candidate;
        candidate.source = source;
        candidate.updatedAt = new Date().toISOString();

        const key = buildSignalKey(candidate);
        if (activeSignalKeys.has(key)) continue;

        generatedSignals.push(await persistSignal(candidate));
        activeSignalKeys.add(key);
      } catch (e) {
        errors.push({ coin: result.coin, message: e.message });
      }
    }

    engineState.lastGenerated = generatedSignals.length;
    engineState.lastScanAt = new Date().toISOString();
    engineState.lastError = errors.length ? `${errors.length} coin scans failed` : null;
    engineState.scanCount += 1;

    return { closedSignals, errors, generatedSignals, scanCount: engineState.scanCount };
  } finally {
    engineState.isScanning = false;
  }
}

function getStatus() {
  return { intervalMs: engineState.intervalMs, isScanning: engineState.isScanning,
    lastError: engineState.lastError, lastGenerated: engineState.lastGenerated,
    lastScanAt: engineState.lastScanAt, running: engineState.running, scanCount: engineState.scanCount };
}

function getSelfLearningStatus() {
  const model = engineState.selfLearning || {};
  const localModel = model.localModel || {};
  return {
    enabled: Boolean(model.enabled),
    trainedAt: model.trainedAt || null,
    sampleSize: Number(model.sampleSize || 0),
    overallWinRate: model.overallWinRate ?? null,
    globalPublishFloorBoost: Number(model.globalPublishFloorBoost || 0),
    confidenceScoreDelta: Number(model.confidenceScoreDelta || 0),
    blockedCoinCount: Object.keys(model.blockedCoins || {}).length,
    blockedCoins: Object.keys(model.blockedCoins || {}),
    version: model.version || "slm_v1",
    localAI: {
      enabled: Boolean(localModel.enabled),
      version: localModel.version || "local_nb_v1",
      trainedAt: localModel.trainedAt || null,
      sampleSize: Number(localModel.sampleSize || 0),
      baselineWinRate: localModel.baselineWinRate ?? null,
      blockedPredictionThreshold: Number(localModel.blockedPredictionThreshold || LOCAL_AI_BLOCK_THRESHOLD),
    },
    autonomousAuthorityEnabled: Boolean(model.autonomousAuthorityEnabled),
    autonomousLastRunAt: Number(model.autonomousLastRunAt || 0),
    autonomousActionsApplied: Array.isArray(model.autonomousActionsApplied) ? model.autonomousActionsApplied.slice(0, 20) : [],
  };
}

function setSelfLearningEnabled(enabled) {
  engineState.selfLearning.enabled = Boolean(enabled);
  return getSelfLearningStatus();
}
function applyAutonomousActions(actions = [], context = {}) {
  const model = engineState.selfLearning || {};
  const now = Date.now();
  if (!model.autonomousAuthorityEnabled) {
    return { applied: [], skippedReason: "AUTONOMOUS_AUTHORITY_DISABLED" };
  }
  if (!Array.isArray(actions) || !actions.length) {
    return { applied: [], skippedReason: "NO_ACTIONS" };
  }
  if (now - Number(model.autonomousLastRunAt || 0) < 60 * 1000) {
    return { applied: [], skippedReason: "THROTTLED" };
  }

  const applied = [];
  const actor = context && context.actor ? context.actor : { email: "ml-model" };

  for (const action of actions) {
    const type = String(action && action.type ? action.type : "").toUpperCase();
    if (!type) continue;

    if (type === "INCREASE_GLOBAL_FLOOR") {
      const by = clamp(Number(action && action.by ? action.by : 1), 1, 3);
      const before = Number(model.globalPublishFloorBoost || 0);
      const after = clamp(before + by, -2, 12);
      if (after !== before) {
        model.globalPublishFloorBoost = after;
        applied.push({ type, before, after, by, reason: action.reason || "Performance recommendation" });
      }
      continue;
    }

    if (type === "PAUSE_COIN") {
      let coin = String(action && action.coin ? action.coin : "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!coin) continue;
      if (!coin.endsWith("USDT")) coin = coin + "USDT";
      if (!engineState.pausedCoins[coin]) {
        pauseCoin(coin, actor, action.reason || "ML auto-action from performance recommendation");
        applied.push({ type, coin, reason: action.reason || "Performance recommendation" });
      }
    }
  }

  model.autonomousLastRunAt = now;
  if (applied.length) {
    const stamped = applied.map((item) => ({ ...item, at: new Date(now).toISOString() }));
    model.autonomousActionsApplied = [...stamped, ...(Array.isArray(model.autonomousActionsApplied) ? model.autonomousActionsApplied : [])].slice(0, 40);
  }

  return { applied, skippedReason: applied.length ? null : "NO_EFFECT" };
}

// ─── Fast Expiry Checker (every 30s) ─────────────────────────────────────────
async function checkAndExpireSignals() {
  try {
    const signals = await readCollection(SIGNAL_COLLECTION);
    if (!signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE).length) return;
    const nowMs = Date.now(), now = new Date().toISOString();
    let hasExpired = false;
    const updated = signals.map(sig => {
      if (sig.status !== SIGNAL_STATUS.ACTIVE) return sig;
      const expiryMs  = getExpiryMs(sig.timeframe);
      const createdMs = sig.createdAt ? new Date(sig.createdAt).getTime() : 0;
      if (nowMs - createdMs > expiryMs) {
        hasExpired = true;
        return { ...sig, status: SIGNAL_STATUS.CLOSED, result: "EXPIRED", closedAt: now, updatedAt: now };
      }
      return sig;
    });
    if (hasExpired) { const { writeCollection } = require("../storage/fileStore"); await writeCollection(SIGNAL_COLLECTION, updated); }
  } catch (e) { engineState.lastError = `Expiry check failed: ${e.message}`; }
}

function start() {
  if (engineState.timer) { engineState.running = true; return getStatus(); }
  engineState.intervalMs  = Number(process.env.CRYPTO_SCAN_INTERVAL_MS || process.env.SCAN_INTERVAL_MS || engineState.intervalMs || 60000);
  engineState.timer        = setInterval(() => { scanNow({ source: "ENGINE" }).catch(e => { engineState.lastError = e.message; }); }, engineState.intervalMs);
  engineState.expiryTimer  = setInterval(() => { checkAndExpireSignals().catch(e => { engineState.lastError = e.message; }); }, 30 * 1000);
  engineState.running      = true;
  scanNow({ source: "ENGINE" }).catch(e => { engineState.lastError = e.message; });
  return getStatus();
}

function stop() {
  if (engineState.timer)       { clearInterval(engineState.timer);       engineState.timer = null; }
  if (engineState.expiryTimer) { clearInterval(engineState.expiryTimer); engineState.expiryTimer = null; }
  engineState.running = false;
  return getStatus();
}

// ─── Admin: Pause / Resume Coins ─────────────────────────────────────────────
function pauseCoin(symbol, actor, reason = "") {
  let coin = String(symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (coin && !coin.endsWith("USDT")) coin = `${coin}USDT`;
  if (!coin) throw new Error("Symbol required");
  engineState.pausedCoins[coin] = {
    pausedAt: new Date().toISOString(),
    pausedUntil: null,
    reason: reason || "Repeated stop losses",
    pausedBy: actor?.email || "admin",
    autoManaged: false,
  };
  return engineState.pausedCoins;
}

function resumeCoin(symbol) {
  let coin = String(symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (coin && !coin.endsWith("USDT")) coin = `${coin}USDT`;
  delete engineState.pausedCoins[coin];
  return engineState.pausedCoins;
}

function getPausedCoins() {
  cleanupExpiredAutoPauses();
  return engineState.pausedCoins;
}

// ─── Admin: Force-generate signal for a specific coin ─────────────────────────
async function generateForCoin(symbol, actor) {
  let coin = String(symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!coin) throw new Error("Symbol required");
  if (!coin.endsWith("USDT")) coin = `${coin}USDT`;

  let marketActivity = buildFallbackMarketActivity(coin);
  try {
    const stats = await getAllTickerStats();
    if (stats && stats.length) {
      const match = stats.find(t => String(t.symbol || "").toUpperCase() === coin);
      if (!match) {
        return { generated: false, message: `Symbol ${coin} not found on USDT perpetuals.` };
      }
      marketActivity = buildMarketActivitySnapshot(match);
    }
  } catch {}
  const performanceSnapshot = await getPerformanceSnapshot();
  const selfLearningModel = await refreshSelfLearningModel({ force: false });

  const candidate = await analyzeCoin(coin, marketActivity, performanceSnapshot, selfLearningModel, engineState.pausedCoinSides, engineState.pausedTimeframes);
  if (!candidate) {
    return { generated: false, message: `No qualifying signal found for ${coin} — indicators may not be aligned.` };
  }
  // Even if a duplicate exists, allow admin-forced generation
  candidate.source    = "ADMIN_SEARCH";
  candidate.updatedAt = new Date().toISOString();
  if (candidate.scanMeta) candidate.scanMeta.createdBy = actor?.email || "admin";
  const signal = await persistSignal(candidate);
  return { generated: true, signal };
}

module.exports = { createManualSignal, evaluateActiveSignals, getCoinList, getStatus, getSelfLearningStatus, setSelfLearningEnabled, applyAutonomousActions, scanNow, start, stop, pauseCoin, resumeCoin, getPausedCoins, generateForCoin };
