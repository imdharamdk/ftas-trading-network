const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { getKlines, getPrices, getAllFuturesCoins, getAllTickerStats } = require("./binanceService");
const { analyzeCandles, computeFibonacci } = require("./indicatorEngine");

// Lazy-load to avoid circular dependency
function ws()  { try { return require("./wsServer");  } catch { return null; } }
function sse() { try { return require("./sseManager"); } catch { return null; } }
// Fallback list if Binance exchangeInfo API fails
const FALLBACK_COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
  "MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT",
  "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT",
];

const SCAN_TIMEFRAMES            = ["5m","15m","30m","1h","4h","12h","1d"];
const DEFAULT_TRADE_TIMEFRAMES   = ["5m","15m","30m","1h"];
const DEFAULT_MAX_COINS_PER_SCAN = 70;
const MAX_COINS_PER_SCAN_CAP     = 100;
const MIN_SCAN_QUOTE_VOLUME_USDT = 8_000_000;
const MIN_SCAN_TRADE_COUNT_24H   = 10_000;
const MIN_SCAN_OPEN_INTEREST_USDT = 3_500_000;

const RULE_VERSION = "v13_precision";
const DEFAULT_PUBLISH_FLOOR = 83;
const STRENGTH_THRESHOLDS = { STRONG: 90, MEDIUM: 83 };

// ─── Per-Timeframe Rules ───────────────────────────────────────────────────────
// v13 changes:
//  5m  — raise publishFloor 86→88, add requireHtfBullOrNeutral guard,
//         requireVolumeConfirm so low-volume signals are skipped
//  15m — add minAdx 18, minRsi 40, tighten score to 57, add VWAP support
//  30m — NEW timeframe: sweet spot between 15m scalp and 1h swing
//  1h  — relax minScore 52→50, raise publishFloor 82→84 (quality > quantity)
const TIMEFRAME_RULES = {
  "5m": {
    minScore: 60,
    minConfirmations: 5,
    publishFloor: 88,           // was 86 — extra strict on scalps
    requireHigherBias: false,
    minAdx: 22,
    minRsi: 43,
    maxRsi: 80,
    minDiDelta: 3,
    requireVwapSupport: true,
    requireVolumeConfirm: true, // NEW: must have volumeStrong or volumeSpike
    blockDailyBear: true,
    intradayOverride: false,
    entryDriftMultiplier: 0.5,
    maxLeverage: 25,
  },
  "15m": {
    minScore: 57,               // was 55
    minConfirmations: 4,
    publishFloor: 85,           // was 84
    requireHigherBias: true,
    minAdx: 18,                 // NEW: momentum gate
    minRsi: 40,                 // NEW: no overbought entry
    maxRsi: 78,
    requireVwapSupport: true,   // NEW
    blockDailyBear: true,       // NEW
    entryDriftMultiplier: 0.65,
    maxLeverage: 35,
  },
  "30m": {                      // NEW TIMEFRAME
    minScore: 55,
    minConfirmations: 4,
    publishFloor: 84,
    requireHigherBias: true,
    minAdx: 20,
    minRsi: 38,
    maxRsi: 76,
    requireVwapSupport: false,
    blockDailyBear: true,
    entryDriftMultiplier: 0.75,
    maxLeverage: 30,
  },
  "1h": {
    minScore: 50,               // was 52 — 1h signals are rarer, accept slightly lower
    minConfirmations: 3,
    publishFloor: 84,           // was 82 — but gate higher to avoid noise
    requireHigherBias: true,
    minAdx: 16,                 // NEW
    entryDriftMultiplier: 0.8,
    maxLeverage: 20,
  },
};
const RELAXED_PUBLISH_DELTA = Number(process.env.RELAXED_PUBLISH_DELTA || 8);
const RELAXED_MIN_SCORE_DELTA = Number(process.env.RELAXED_MIN_SCORE_DELTA || 5);
const RELAXED_ENTRY_DRIFT_BOOST = Number(process.env.RELAXED_ENTRY_DRIFT_BOOST || 0.45);
const RESCUE_SCAN_LIMIT = Number(process.env.RESCUE_SCAN_LIMIT || 15);
const WIN_RESULTS = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
const LOSS_RESULTS = new Set(["SL_HIT"]);
const buildTally = () => ({ wins: 0, losses: 0 });
const BASE_ANCHOR_REQUIREMENTS = { "5m": 2, "15m": 3, "1h": 3 };
function getBaseAnchorRequirement(timeframe) {
  return BASE_ANCHOR_REQUIREMENTS[timeframe] || 3;
}
function getWinRate(bucket) {
  if (!bucket) return null;
  const wins = Number(bucket.wins || 0);
  const losses = Number(bucket.losses || 0);
  const total = wins + losses;
  if (!total) return null;
  return wins / total;
}
function getPerformanceAdjustments(performanceSnapshot, timeframe, side) {
  const adjustments = {
    floorDelta: 0,
    minScoreDelta: 0,
    confirmationDelta: 0,
    anchorDelta: 0,
    reasons: [],
  };
  if (!performanceSnapshot || performanceSnapshot.sampleSize < 4) return adjustments;
  const buckets = [];
  if (performanceSnapshot.overall) buckets.push({ stats: performanceSnapshot.overall, label: "overall", weight: 1.5 });
  if (performanceSnapshot[timeframe]) buckets.push({ stats: performanceSnapshot[timeframe], label: timeframe, weight: 1.2 });
  if (side && performanceSnapshot[side]) buckets.push({ stats: performanceSnapshot[side], label: side, weight: 1.0 });

  for (const bucket of buckets) {
    const winRate = getWinRate(bucket.stats);
    const total = Number(bucket.stats.wins || 0) + Number(bucket.stats.losses || 0);
    if (winRate === null || total < 4) continue;
    if (winRate <= 0.42) {
      adjustments.floorDelta      += 2 * bucket.weight;
      adjustments.minScoreDelta   += 2 * bucket.weight;
      adjustments.confirmationDelta += 1;
      adjustments.anchorDelta     += 1;
      adjustments.reasons.push(`${bucket.label} win ${Math.round(winRate * 100)}% tighten`);
    } else if (winRate >= 0.6) {
      adjustments.floorDelta    -= 2 * bucket.weight;
      adjustments.minScoreDelta -= 1 * bucket.weight;
      adjustments.reasons.push(`${bucket.label} win ${Math.round(winRate * 100)}% relax`);
    }
  }

  adjustments.floorDelta = clamp(adjustments.floorDelta, -8, 10);
  adjustments.minScoreDelta = clamp(adjustments.minScoreDelta, -4, 8);
  adjustments.confirmationDelta = clamp(adjustments.confirmationDelta, 0, 3);
  adjustments.anchorDelta = clamp(adjustments.anchorDelta, 0, 3);
  return adjustments;
}

const engineState = {
  intervalMs: Number(process.env.SCAN_INTERVAL_MS || 300000), // 5 min default
  isScanning: false, lastError: null, lastGenerated: 0,
  lastScanAt: null, running: false, scanCount: 0, timer: null,
  // Admin-controlled pause list: { [SYMBOL]: { pausedAt, reason, pausedBy } }
  pausedCoins: {},
};

// ─── Utils ────────────────────────────────────────────────────────────────────
function roundPrice(v) {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) >= 1000) return Number(v.toFixed(2));
  if (Math.abs(v) >= 1)    return Number(v.toFixed(4));
  return Number(v.toFixed(6));
}
function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }
function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
function formatCompact(value) {
  const numeric = toNumber(value);
  if (!numeric) return "0";
  if (numeric >= 1_000_000_000) return `${(numeric / 1_000_000_000).toFixed(1)}B`;
  if (numeric >= 1_000_000)     return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000)         return `${(numeric / 1_000).toFixed(1)}K`;
  return numeric.toFixed(0);
}
function buildFallbackMarketActivity(symbol) {
  return {
    symbol,
    quoteVolume: 0,
    volume: 0,
    tradeCount: 0,
    openInterestValue: 0,
    activityScore: 0,
    isLiquid: false,
    isCrowded: false,
    passesFloor: true,
    relaxThresholds: false,
  };
}
function buildMarketActivitySnapshot(ticker = {}) {
  const symbol = String(ticker.symbol || "").toUpperCase();
  const quoteVolume = toNumber(ticker.quoteVolume);
  const volume = toNumber(ticker.volume);
  const tradeCount = toNumber(ticker.count || ticker.tradeCount);
  const openInterestValue = toNumber(ticker.openInterestValue);
  const hasParticipationMetric = tradeCount > 0 || openInterestValue > 0;
  const liquidityScore = Math.log10(quoteVolume + 1) * 16 + Math.log10(volume + 1) * 4;
  const participationScore = Math.log10(tradeCount + 1) * 8 + Math.log10(openInterestValue + 1) * 10;
  const isLiquid = quoteVolume >= 35_000_000 || openInterestValue >= 8_000_000;
  const isCrowded = tradeCount >= 25_000 || openInterestValue >= 12_000_000;
  const passesFloor =
    symbol.endsWith("USDT") &&
    quoteVolume >= MIN_SCAN_QUOTE_VOLUME_USDT &&
    (!hasParticipationMetric || tradeCount >= MIN_SCAN_TRADE_COUNT_24H || openInterestValue >= MIN_SCAN_OPEN_INTEREST_USDT);

  return {
    symbol,
    quoteVolume,
    volume,
    tradeCount,
    openInterestValue,
    activityScore: liquidityScore + participationScore,
    isLiquid,
    isCrowded,
    passesFloor,
    relaxThresholds: isLiquid && (isCrowded || quoteVolume >= 75_000_000),
  };
}
function getMaxCoinsPerScan() {
  return clamp(Number(process.env.SCAN_MAX_COINS || DEFAULT_MAX_COINS_PER_SCAN), 5, MAX_COINS_PER_SCAN_CAP);
}
// Dynamic coin list — fetches ALL active USDT perpetual pairs from Binance.
// Falls back to env override (SCAN_COINS) or hardcoded list if API fails.
async function getScanUniverse() {
  const envOverride = String(process.env.SCAN_COINS || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (envOverride.length) return envOverride.map(buildFallbackMarketActivity);

  try {
    const ranked = (await getAllTickerStats())
      .map(buildMarketActivitySnapshot)
      .filter((market) => market.symbol.endsWith("USDT"))
      .sort((left, right) =>
        right.activityScore - left.activityScore ||
        right.quoteVolume - left.quoteVolume ||
        right.tradeCount - left.tradeCount ||
        left.symbol.localeCompare(right.symbol)
      );

    const filtered = ranked.filter((market) => market.passesFloor);
    if (filtered.length) return filtered;
    if (ranked.length) return ranked;
  } catch {
    // Fall back to symbol-only coin discovery below.
  }

  try {
    const allCoins = await getAllFuturesCoins();
    const coins = allCoins.length ? allCoins : FALLBACK_COINS;
    return coins.map(buildFallbackMarketActivity);
  } catch {
    return FALLBACK_COINS.map(buildFallbackMarketActivity);
  }
}
async function getCoinList() {
  const scanUniverse = await getScanUniverse();
  return scanUniverse.map((market) => market.symbol);
}
function getTradeTimeframes() {
  const raw = String(process.env.TRADE_TIMEFRAMES || "").split(",").map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_TRADE_TIMEFRAMES;
}

// ─── HTF Bias ─────────────────────────────────────────────────────────────────
// v13: 4H is primary. 1H is now a secondary vote (not just a fallback).
// If 4H is NEUTRAL but 1H + 12H agree → accept that direction with lower ADX bar.
// 1D veto remains — strong daily trend against the bias = NEUTRAL.
function getHigherTimeframeBias(analyses) {
  const a4h  = analyses["4h"];
  const a1d  = analyses["1d"];
  const a1h  = analyses["1h"];
  const a12h = analyses["12h"];

  const primary = a4h || a1h;
  if (!primary) return "NEUTRAL";

  const ema50  = primary.trend.ema50;
  const ema100 = primary.trend.ema100;
  const ema200 = primary.trend.ema200;
  const adx    = primary.trend.adx || 0;
  const rsi    = primary.momentum.rsi || 50;

  const fourHBull = ema50 > ema100 && ema100 > ema200 && adx >= 10 && rsi >= 38;
  const fourHBear = ema50 < ema100 && ema100 < ema200 && adx >= 10 && rsi <= 62;

  // 1D macro veto — strong opposing trend = override to NEUTRAL
  if (a1d) {
    const dStrongBull = a1d.trend.ema50 > a1d.trend.ema100 && (a1d.trend.adx || 0) >= 22;
    const dStrongBear = a1d.trend.ema50 < a1d.trend.ema100 && (a1d.trend.adx || 0) >= 22;
    if (fourHBull && dStrongBear) return "NEUTRAL";
    if (fourHBear && dStrongBull) return "NEUTRAL";
  }

  if (fourHBull) return "BULLISH";
  if (fourHBear) return "BEARISH";

  // 4H neutral — check regime
  if (primary.regime === "RANGING" && adx < 16) return "NEUTRAL";

  // Secondary vote: 1H + 12H agreement → accept with lower ADX bar (12)
  if (a1h && a12h) {
    const h1Bull  = a1h.trend.ema50  > a1h.trend.ema100  && (a1h.trend.adx  || 0) >= 12 && (a1h.momentum.rsi  || 50) >= 40;
    const h1Bear  = a1h.trend.ema50  < a1h.trend.ema100  && (a1h.trend.adx  || 0) >= 12 && (a1h.momentum.rsi  || 50) <= 60;
    const h12Bull = a12h.trend.ema50 > a12h.trend.ema100 && (a12h.trend.adx || 0) >= 12;
    const h12Bear = a12h.trend.ema50 < a12h.trend.ema100 && (a12h.trend.adx || 0) >= 12;
    if (h1Bull && h12Bull) return "BULLISH";
    if (h1Bear && h12Bear) return "BEARISH";
  }

  return "NEUTRAL";
}

// ─── SL/TP ────────────────────────────────────────────────────────────────────
// v13: Per-timeframe TP multipliers.
//  5m/15m/30m scalps: TP1 tighter (0.55) = higher hit rate on quick moves
//  1h swings: TP1 slightly looser (0.7), TP3 extended (2.0) = better R:R
// SL uses nearest S/R + ATR buffer (unchanged, working well).
const TP_R_MULTIPLIERS_SCALP  = [0.55, 1.1, 1.75];  // 5m / 15m / 30m
const TP_R_MULTIPLIERS_SWING  = [0.70, 1.3, 2.0];   // 1h

function getTpMultipliers(timeframe) {
  return ["1h","4h"].includes(timeframe) ? TP_R_MULTIPLIERS_SWING : TP_R_MULTIPLIERS_SCALP;
}

function calculateTargets(side, analysis, timeframe = "5m") {
  const entry  = analysis.currentPrice;
  const atr    = analysis.volatility.atr || analysis.averages.averageRange || entry * 0.003;
  const { low20, high20, previousLow20, previousHigh20 } = analysis.recentSwing;
  const srSup  = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes  = analysis.srLevels?.resistances?.[0] ?? null;
  const tpMult = getTpMultipliers(timeframe);

  if (side === "LONG") {
    const anchors = [low20, previousLow20, srSup].filter(v => Number.isFinite(v) && v < entry);
    const anchor  = anchors.length ? Math.max(...anchors) : entry - atr * 2;
    const raw     = (entry - anchor) + atr * 0.3;
    const risk    = clamp(raw, atr * 1.5, atr * 3.5);
    return {
      entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry - risk),
      tp1: roundPrice(entry + risk * tpMult[0]),
      tp2: roundPrice(entry + risk * tpMult[1]),
      tp3: roundPrice(entry + risk * tpMult[2]),
    };
  } else {
    const anchors = [high20, previousHigh20, srRes].filter(v => Number.isFinite(v) && v > entry);
    const anchor  = anchors.length ? Math.min(...anchors) : entry + atr * 2;
    const raw     = (anchor - entry) + atr * 0.3;
    const risk    = clamp(raw, atr * 1.5, atr * 3.5);
    return {
      entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry + risk),
      tp1: roundPrice(entry - risk * tpMult[0]),
      tp2: roundPrice(entry - risk * tpMult[1]),
      tp3: roundPrice(entry - risk * tpMult[2]),
    };
  }
}

// ─── Leverage ─────────────────────────────────────────────────────────────────
function calculateLeverage(analysis, confidence, timeframe) {
  const price  = analysis.currentPrice;
  const atr    = analysis.volatility.atr || analysis.averages.averageRange || price * 0.003;
  const atrPct = (atr / price) * 100;
  const base   = clamp(20 / atrPct, 10, 40);
  const bonus  = confidence >= 90 ? 10 : confidence >= 85 ? 7 : confidence >= 80 ? 5 : confidence >= 75 ? 3 : 0;
  const tfRule = TIMEFRAME_RULES[timeframe] || {};
  const leveraged = base + bonus;
  const cap = Number.isFinite(tfRule.maxLeverage) ? tfRule.maxLeverage : 50;
  return Math.round(clamp(leveraged, 10, cap));
}

// ─── Pullback Completion ──────────────────────────────────────────────────────
// Checks that price has pulled back to a key level AND is NOW turning around.
// Key improvement: checks RSI is RISING (not just in range) and MACD histogram
// is increasing — these confirm the TURN, not just the level.
function isPullbackComplete(side, analysis) {
  const { ema21, ema50, vwap }                           = analysis.trend;
  const { rsi, rsiRising, rsiFalling, macdHistIncreasing, macdHistDecreasing, stochRsi } = analysis.momentum;
  const price = analysis.currentPrice;
  const atr   = analysis.volatility.atr || price * 0.003;
  const stochK = stochRsi?.k ?? null;

  const nearEma21 = Math.abs(price - ema21) < atr * 1.5;
  const nearEma50 = Math.abs(price - ema50) < atr * 2.0;
  const nearVwap  = Math.abs(price - vwap)  < atr * 1.5;
  const atSupport = nearEma21 || nearEma50 || nearVwap;

  // Also check S/R levels
  const srSup = analysis.srLevels?.supports?.[0];
  const srRes = analysis.srLevels?.resistances?.[0];
  const nearSR = side === "LONG"
    ? (srSup && Math.abs(price - srSup) < atr * 1.0)
    : (srRes && Math.abs(price - srRes) < atr * 1.0);

  const nearLevel = atSupport || nearSR;

  if (side === "LONG") {
    const rsiOk    = (rsi || 0) >= 40 && (rsi || 0) <= 82 && (rsiRising || (rsi || 0) > 50); // aligned with Gate 3
    const macdOk   = macdHistIncreasing;                                          // MACD turning up
    const stochOk  = stochK !== null ? stochK < 65 && stochK > 15 : true;
    return nearLevel && rsiOk && macdOk && stochOk;
  } else {
    const rsiOk    = (rsi || 100) <= 60 && (rsi || 100) >= 18 && (rsiFalling || (rsi || 100) < 50); // aligned with Gate 3
    const macdOk   = macdHistDecreasing;
    const stochOk  = stochK !== null ? stochK > 35 && stochK < 85 : true;
    return nearLevel && rsiOk && macdOk && stochOk;
  }
}

// ─── Volume Breakout ──────────────────────────────────────────────────────────
// Price > 20-avg + sudden volume surge (1.8x) + EMA stack confirmed.
// Extra: candle body must be strong (>40% body ratio) = conviction candle.
function isVolumeBreakout(side, analysis) {
  const { currentVolume, averageVolume } = analysis.volume;
  const { ema50, ema100, ema200 }        = analysis.trend;
  const price      = analysis.currentPrice;
  const avgPrice   = analysis.averages.averagePrice;
  const suddenVol  = currentVolume > averageVolume * 1.8;
  const strongBody = (analysis.candleQuality?.bodyRatio || 0) > 0.4;

  if (side === "LONG") {
    return price > avgPrice && suddenVol && strongBody && ema50 > ema100 && ema100 > ema200;
  } else {
    return price < avgPrice && suddenVol && strongBody && ema50 < ema100 && ema100 < ema200;
  }
}

// ─── Signal Builder ───────────────────────────────────────────────────────────
//
// v9 improvements over v8:
//
//  1. DIVERGENCE BONUS — RSI/MACD bullish divergence = high probability reversal
//                        Adds significant confidence when detected
//
//  2. MARKET REGIME FILTER — skip signals in RANGING markets unless divergence exists
//                            Range markets mean EMA signals are unreliable
//
//  3. CANDLE QUALITY — body ratio check, no-wick HA = strong conviction
//
//  4. EMA SLOPE — EMAs must be rising (LONG) or falling (SHORT), not flat
//                 Prevents entries at EMA turning points (whipsaws)
//
//  5. OBV TREND — OBV trending up/down confirms smart money participation
//
//  6. BB %B — entry near lower band (LONG) or upper band (SHORT) = mean reversion
//
//  7. S/R LEVEL PROXIMITY — bonus when price is near detected S/R level
//
function buildCandidate(coin, timeframe, analysis, higherBias, htf = {}, marketActivity = null, performanceSnapshot = null, options = {}) {
  const bullConf = [], bearConf = [];
  let bullScore = 0, bearScore = 0;

  const tfRule = TIMEFRAME_RULES[timeframe] || {};
  const activeMarket = marketActivity || buildFallbackMarketActivity(coin);
  const price = analysis.currentPrice;
  const isRelaxed = Boolean(options.relaxed);
  const rescueMode = Boolean(options.rescueMode);
  const relaxedFloorDrop = isRelaxed ? Number(options.relaxFloor ?? RELAXED_PUBLISH_DELTA) : 0;
  const relaxedScoreDrop = isRelaxed ? Number(options.relaxScore ?? RELAXED_MIN_SCORE_DELTA) : 0;
  const relaxedConfirmDrop = isRelaxed ? 1 : 0;
  const entryDriftBonus = isRelaxed ? Number(options.entryDriftBoost ?? RELAXED_ENTRY_DRIFT_BOOST) : 0;
  const baseMinScore = Math.max(tfRule.minScore || 0, activeMarket.relaxThresholds ? 51 : 55);
  const baseMinConfirmations = Math.max(tfRule.minConfirmations || 0, activeMarket.relaxThresholds ? 3 : 4);
  const baseAnchorRequirement = tfRule.minAnchors ?? getBaseAnchorRequirement(timeframe);
  const perfAdjustments = {
    LONG: getPerformanceAdjustments(performanceSnapshot, timeframe, "LONG"),
    SHORT: getPerformanceAdjustments(performanceSnapshot, timeframe, "SHORT"),
  };
  const minScoreBySide = {
    LONG: clamp(baseMinScore + perfAdjustments.LONG.minScoreDelta - relaxedScoreDrop, 45, 99),
    SHORT: clamp(baseMinScore + perfAdjustments.SHORT.minScoreDelta - relaxedScoreDrop, 45, 99),
  };
  const minConfBySide = {
    LONG: Math.max(3, baseMinConfirmations + perfAdjustments.LONG.confirmationDelta - relaxedConfirmDrop),
    SHORT: Math.max(3, baseMinConfirmations + perfAdjustments.SHORT.confirmationDelta - relaxedConfirmDrop),
  };
  const publishFloorBase = tfRule.publishFloor ?? DEFAULT_PUBLISH_FLOOR;
  const publishFloorBySide = {
    LONG: clamp(publishFloorBase + perfAdjustments.LONG.floorDelta - relaxedFloorDrop, 70, 99),
    SHORT: clamp(publishFloorBase + perfAdjustments.SHORT.floorDelta - relaxedFloorDrop, 70, 99),
  };
  const anchorRequirementBySide = {
    LONG: Math.max(1, baseAnchorRequirement + perfAdjustments.LONG.anchorDelta - (isRelaxed ? 1 : 0)),
    SHORT: Math.max(1, baseAnchorRequirement + perfAdjustments.SHORT.anchorDelta - (isRelaxed ? 1 : 0)),
  };
  const {
    ema9, ema21, ema50, ema100, ema200,
    vwap, ichimoku, adx, pdi, mdi, psar,
    haBullish, haBearish, haStrongBull, haStrongBear, haNoLowerWick, haNoUpperWick,
    ema50Rising, ema50Falling, ema21Rising, ema21Falling,
    trix, trixCrossUp, trixCrossDown,
  } = analysis.trend;
  const {
    rsi, rsiRising, rsiFalling, rsi9,
    macd, macdHistIncreasing, macdHistDecreasing,
    stochRsi, stochKD, cci, roc, roc5,
    kstBullish, kstBearish, ao, aoCrossUp, aoCrossDown, williamsR,
  } = analysis.momentum;
  const {
    volumeSpike, volumeStrong, volumeTrending,
    obvChange, obvTrending, mfi, forceIndex,
    currentVolume, averageVolume,
  } = analysis.volume;
  const { bollinger, atr: rawAtr, bbWidth, bbPctB } = analysis.volatility;
  const atr    = rawAtr || analysis.averages.averageRange || price * 0.003;
  const regime = analysis.regime;
  const stochK = stochRsi?.k ?? null;
  const kdK    = stochKD?.k  ?? null;
  const kdD    = stochKD?.d  ?? null;
  const { daily, twelveH, oneH, thirtyM } = htf;
  const bullRsiFloor = tfRule.minRsi ?? 40;
  const bullRsiCeil  = tfRule.maxRsi ?? 82;
  const requireVwapSupport   = tfRule.requireVwapSupport   || false;
  const requireVolumeConfirm = tfRule.requireVolumeConfirm || false; // v13: new gate
  const minAdx       = tfRule.minAdx ?? 0;
  const minDiDelta   = tfRule.minDiDelta ?? 0;
  const dailyTrend = daily?.trend || {};
  const dailyBearStack = (dailyTrend.ema50 || 0) < (dailyTrend.ema100 || 0) && (dailyTrend.adx || 0) >= 18;
  const psarBull = Number.isFinite(psar) ? psar < price : true;
  const psarBear = Number.isFinite(psar) ? psar > price : true;

  // Divergences
  const rsiDivBull  = analysis.divergence?.rsi?.bullish       || false;
  const rsiDivBear  = analysis.divergence?.rsi?.bearish       || false;
  const rsiHidBull  = analysis.divergence?.rsi?.hidden_bullish || false;
  const rsiHidBear  = analysis.divergence?.rsi?.hidden_bearish || false;
  const macdDivBull = analysis.divergence?.macd?.bullish      || false;
  const macdDivBear = analysis.divergence?.macd?.bearish      || false;

  // S/R proximity
  const srSup = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes = analysis.srLevels?.resistances?.[0] ?? null;
  const nearSupportSR    = srSup && Math.abs(price - srSup) < atr * 1.2;
  const nearResistanceSR = srRes && Math.abs(price - srRes) < atr * 1.2;

  // ── REGIME FILTER ─────────────────────────────────────────────────────────
  // In a ranging market, skip unless there is a divergence setup
  if (regime === "RANGING") {
    if (!rsiDivBull && !rsiDivBear && !macdDivBull && !macdDivBear) return null;
  }

  // ── GATE 1: EMA Stack ────────────────────────────────────────────────────
  const bullTrend = ema50 > ema100 && ema100 > ema200 && (price > ema21 || price > ema50);
  const bearTrend = ema50 < ema100 && ema100 < ema200 && (price < ema21 || price < ema50);

  // ── GATE 2: EMA Slope — EMAs must be moving in trade direction ────────────
  // Prevents entering at a flat/turning EMA (whipsaw zone)
  const bullSlope = ema50Rising || ema21Rising;
  const bearSlope = ema50Falling || ema21Falling;

  // ── GATE 3: Momentum — RSI in range + MACD + RSI direction ───────────────
  const bullMomentum =
    (rsi || 0) >= bullRsiFloor &&
    (rsi || 0) <= bullRsiCeil &&
    (macd?.MACD || 0) > (macd?.signal || 0) &&
    (rsiRising || (rsi || 0) > Math.max(bullRsiFloor, 50)) &&
    (!requireVwapSupport || (Number.isFinite(vwap) && price >= vwap)) &&
    (!minAdx || (adx || 0) >= minAdx) &&
    (!minDiDelta || ((pdi || 0) - (mdi || 0)) >= minDiDelta) &&
    (!requireVolumeConfirm || volumeStrong || volumeSpike); // v13: volume gate for 5m
  const bearMomentum =
    (rsi || 0) <= 60 && (rsi || 0) >= 18 &&
    (macd?.MACD || 0) < (macd?.signal || 0) &&
    (rsiFalling || (rsi || 0) < 50) &&
    (!requireVolumeConfirm || volumeStrong || volumeSpike);

  // ── GATE 4: Entry ─────────────────────────────────────────────────────────
  const bullPB = isPullbackComplete("LONG",  analysis);
  const bearPB = isPullbackComplete("SHORT", analysis);
  const bullBO = isVolumeBreakout("LONG",    analysis);
  const bearBO = isVolumeBreakout("SHORT",   analysis);
  const bullEntry = bullPB || bullBO;
  const bearEntry = bearPB || bearBO;
  const oneHDirection = oneH?.trend?.direction || "NEUTRAL";
  const oneHAdx = oneH?.trend?.adx || 0;
  const oneHRsi = oneH?.momentum?.rsi || 50;
  const intradayOverrideEnabled = tfRule.intradayOverride !== false;
  const allowIntradayBull =
    intradayOverrideEnabled &&
    higherBias === "NEUTRAL" &&
    activeMarket.relaxThresholds &&
    ["5m","15m"].includes(timeframe) &&
    oneHDirection === "BULLISH" &&
    oneHAdx >= (tfRule.minAdxIntraday ?? 16) &&
    oneHRsi >= (tfRule.minIntradayRsi ?? 48) &&
    !dailyBearStack &&
    (bullBO || volumeStrong || volumeTrending);
  const allowIntradayBear =
    intradayOverrideEnabled &&
    higherBias === "NEUTRAL" &&
    activeMarket.relaxThresholds &&
    ["5m","15m"].includes(timeframe) &&
    oneHDirection === "BEARISH" &&
    oneHAdx >= (tfRule.minAdxIntraday ?? 16) &&
    oneHRsi <= (tfRule.maxIntradayRsi ?? 52) &&
    (bearBO || volumeStrong || volumeTrending);
  const requiresHigherBias = tfRule.requireHigherBias === true;
  const bullBiasAligned = (!tfRule.blockDailyBear || !dailyBearStack) && (higherBias === "BULLISH" || (!requiresHigherBias && allowIntradayBull));
  const bearBiasAligned = higherBias === "BEARISH" || (!requiresHigherBias && allowIntradayBear);
  const effectiveBias =
    higherBias !== "NEUTRAL"
      ? higherBias
      : allowIntradayBull
        ? "BULLISH"
        : allowIntradayBear
          ? "BEARISH"
          : "NEUTRAL";
  const collectAnchors = (side) => {
    const anchors = new Set();
    if (side === "LONG") {
      if (bullPB) anchors.add("pullback_completion");
      if (bullBO) anchors.add("volume_breakout");
      if (volumeStrong || volumeSpike) anchors.add("volume_surge");
      if (nearSupportSR) anchors.add("sr_alignment");
      if (rsiDivBull || macdDivBull || rsiHidBull) anchors.add("divergence");
      if (haStrongBull || haNoLowerWick) anchors.add("ha_strength");
      if (higherBias === "BULLISH" || allowIntradayBull) anchors.add("htf_alignment");
      if (bbPctB !== null && bbPctB < 0.35) anchors.add("bollinger_value");
      if (psarBull) anchors.add("psar_trend");
    } else {
      if (bearPB) anchors.add("pullback_completion");
      if (bearBO) anchors.add("volume_breakout");
      if (volumeStrong || volumeSpike) anchors.add("volume_surge");
      if (nearResistanceSR) anchors.add("sr_alignment");
      if (rsiDivBear || macdDivBear || rsiHidBear) anchors.add("divergence");
      if (haStrongBear || haNoUpperWick) anchors.add("ha_strength");
      if (higherBias === "BEARISH" || allowIntradayBear) anchors.add("htf_alignment");
      if (bbPctB !== null && bbPctB > 0.65) anchors.add("bollinger_value");
      if (psarBear) anchors.add("psar_trend");
    }
    return Array.from(anchors);
  };
  const bullAnchorLabels = collectAnchors("LONG");
  const bearAnchorLabels = collectAnchors("SHORT");
  const bullAnchors = bullAnchorLabels.length;
  const bearAnchors = bearAnchorLabels.length;

  // ── Divergence override — can allow entry even without slope gate ─────────
  // Classic divergence is so high probability it overrides the slope gate
  const bullDivOverride = (rsiDivBull || macdDivBull) && bullTrend && bullMomentum && bullEntry;
  const bearDivOverride = (rsiDivBear || macdDivBear) && bearTrend && bearMomentum && bearEntry;

  const bullValid =
    bullBiasAligned && bullTrend && bullMomentum && bullEntry &&
    (bullSlope || bullDivOverride) &&
    bullAnchors >= anchorRequirementBySide.LONG;
  const bearValid =
    bearBiasAligned && bearTrend && bearMomentum && bearEntry &&
    (bearSlope || bearDivOverride) &&
    bearAnchors >= anchorRequirementBySide.SHORT;

  if (!bullValid && !bearValid) return null;

  // ── Base Scoring ──────────────────────────────────────────────────────────
  if (bullTrend)    { bullScore += 18; bullConf.push(`EMA ${roundPrice(ema50)}>${roundPrice(ema100)}>${roundPrice(ema200)} bullish`); }
  if (bearTrend)    { bearScore += 18; bearConf.push(`EMA ${roundPrice(ema50)}<${roundPrice(ema100)}<${roundPrice(ema200)} bearish`); }
  if (bullSlope)    { bullScore += 8;  bullConf.push("EMA21+50 rising slope"); }
  if (bearSlope)    { bearScore += 8;  bearConf.push("EMA21+50 falling slope"); }
  if (bullMomentum) { bullScore += 14; bullConf.push(`RSI ${(rsi||0).toFixed(1)} rising | MACD+`); }
  if (bearMomentum) { bearScore += 14; bearConf.push(`RSI ${(rsi||0).toFixed(1)} falling | MACD-`); }
  if (bullPB)       { bullScore += 16; bullConf.push("Pullback complete — level bounce + RSI turn"); }
  if (bearPB)       { bearScore += 16; bearConf.push("Bounce complete — level rejection + RSI turn"); }
  if (bullBO)       { bullScore += 16; bullConf.push(`Vol breakout ${(currentVolume/averageVolume).toFixed(1)}x | Price>avg ${roundPrice(analysis.averages.averagePrice)}`); }
  if (bearBO)       { bearScore += 16; bearConf.push(`Vol breakdown ${(currentVolume/averageVolume).toFixed(1)}x | Price<avg ${roundPrice(analysis.averages.averagePrice)}`); }
  if (higherBias === "BULLISH") { bullScore += 10; bullConf.push(`4H bullish bias (ADX ${roundPrice(adx||0)})`); }
  if (higherBias === "BEARISH") { bearScore += 10; bearConf.push(`4H bearish bias (ADX ${roundPrice(adx||0)})`); }
  if (allowIntradayBull) { bullScore += 8; bullConf.push("1H intraday bias on crowded market"); }
  if (allowIntradayBear) { bearScore += 8; bearConf.push("1H intraday bias on crowded market"); }

  // ── Divergence Bonuses (HIGH VALUE) ──────────────────────────────────────
  if (rsiDivBull && bullValid)  { bullScore += 14; bullConf.push("RSI bullish divergence ⚡"); }
  if (rsiDivBear && bearValid)  { bearScore += 14; bearConf.push("RSI bearish divergence ⚡"); }
  if (macdDivBull && bullValid) { bullScore += 10; bullConf.push("MACD bullish divergence"); }
  if (macdDivBear && bearValid) { bearScore += 10; bearConf.push("MACD bearish divergence"); }
  if (rsiHidBull && bullValid)  { bullScore += 8;  bullConf.push("RSI hidden bullish div (trend continuation)"); }
  if (rsiHidBear && bearValid)  { bearScore += 8;  bearConf.push("RSI hidden bearish div (trend continuation)"); }

  // ── Heikin-Ashi quality ───────────────────────────────────────────────────
  if (haStrongBull && bullValid) { bullScore += 8;  bullConf.push("HA 3-bar strong bull"); }
  else if (haBullish && bullValid) { bullScore += 5; bullConf.push("Heikin-Ashi bullish"); }
  if (haStrongBear && bearValid) { bearScore += 8;  bearConf.push("HA 3-bar strong bear"); }
  else if (haBearish && bearValid) { bearScore += 5; bearConf.push("Heikin-Ashi bearish"); }
  if (haNoLowerWick && haStrongBull && bullValid) { bullScore += 4; bullConf.push("HA no lower wick (pure bull)"); }
  if (haNoUpperWick && haStrongBear && bearValid) { bearScore += 4; bearConf.push("HA no upper wick (pure bear)"); }

  // ── S/R Level Proximity ───────────────────────────────────────────────────
  if (nearSupportSR    && bullValid) { bullScore += 7; bullConf.push(`Near support ${roundPrice(srSup)}`); }
  if (nearResistanceSR && bearValid) { bearScore += 7; bearConf.push(`Near resistance ${roundPrice(srRes)}`); }

  // ── BB %B position ────────────────────────────────────────────────────────
  // LONG: price near lower band (oversold within trend) = mean reversion entry
  // SHORT: price near upper band (overbought within trend) = mean reversion entry
  if (bbPctB !== null && bbPctB < 0.35 && bullValid) { bullScore += 5; bullConf.push(`BB lower zone (${(bbPctB*100).toFixed(0)}%)`); }
  if (bbPctB !== null && bbPctB > 0.65 && bearValid) { bearScore += 5; bearConf.push(`BB upper zone (${(bbPctB*100).toFixed(0)}%)`); }

  // ── OBV trend confirmation ────────────────────────────────────────────────
  if (obvTrending && bullValid) { bullScore += 5; bullConf.push("OBV trending up (smart money)"); }
  if (!obvTrending && bearValid && obvChange < 0) { bearScore += 5; bearConf.push("OBV trending down (smart money)"); }

  // ── MACD histogram acceleration ───────────────────────────────────────────
  if (macdHistIncreasing && bullValid) { bullScore += 5; bullConf.push("MACD hist accelerating+"); }
  if (macdHistDecreasing && bearValid) { bearScore += 5; bearConf.push("MACD hist accelerating-"); }

  // ── VWAP ─────────────────────────────────────────────────────────────────
  if (price > vwap && bullValid) { bullScore += 5; bullConf.push(`Above VWAP ${roundPrice(vwap)}`); }
  if (price < vwap && bearValid) { bearScore += 5; bearConf.push(`Below VWAP ${roundPrice(vwap)}`); }

  // ── PSAR ─────────────────────────────────────────────────────────────────
  if (psarBull && bullValid) { bullScore += 5; bullConf.push("PSAR bullish dots"); }
  if (psarBear && bearValid) { bearScore += 5; bearConf.push("PSAR bearish dots"); }

  // ── ADX on execution TF ───────────────────────────────────────────────────
  if ((adx||0) >= 20 && (pdi||0) > (mdi||0) && bullValid) { bullScore += 6; bullConf.push(`ADX ${roundPrice(adx)} +DI>${roundPrice(mdi)}`); }
  if ((adx||0) >= 20 && (mdi||0) > (pdi||0) && bearValid) { bearScore += 6; bearConf.push(`ADX ${roundPrice(adx)} -DI>${roundPrice(pdi)}`); }

  // ── Ichimoku ──────────────────────────────────────────────────────────────
  if (ichimoku?.bullish && bullValid) { bullScore += 6; bullConf.push("Ichimoku cloud bullish"); }
  if (ichimoku?.bearish && bearValid) { bearScore += 6; bearConf.push("Ichimoku cloud bearish"); }

  // ── AO ────────────────────────────────────────────────────────────────────
  if (aoCrossUp   && bullValid) { bullScore += 6; bullConf.push("AO zero-cross up"); }
  if (aoCrossDown && bearValid) { bearScore += 6; bearConf.push("AO zero-cross down"); }
  else if ((ao||0) > 0 && bullValid) bullScore += 3;
  else if ((ao||0) < 0 && bearValid) bearScore += 3;

  // ── TRIX ─────────────────────────────────────────────────────────────────
  if (trixCrossUp   && bullValid) { bullScore += 4; bullConf.push("TRIX cross+"); }
  if (trixCrossDown && bearValid) { bearScore += 4; bearConf.push("TRIX cross-"); }
  else if ((trix||0) > 0 && bullValid) bullScore += 2;
  else if ((trix||0) < 0 && bearValid) bearScore += 2;

  // ── KST ──────────────────────────────────────────────────────────────────
  if (kstBullish && bullValid) { bullScore += 4; bullConf.push("KST bullish"); }
  if (kstBearish && bearValid) { bearScore += 4; bearConf.push("KST bearish"); }

  // ── StochKD + StochRSI ────────────────────────────────────────────────────
  if (kdK !== null && kdD !== null && kdK > kdD && kdK < 80 && bullValid) { bullScore += 4; bullConf.push("StochKD cross up"); }
  if (kdK !== null && kdD !== null && kdK < kdD && kdK > 20 && bearValid) { bearScore += 4; bearConf.push("StochKD cross down"); }
  if (stochK !== null && stochK < 30 && bullValid) { bullScore += 4; bullConf.push(`StochRSI oversold ${stochK.toFixed(0)}`); }
  if (stochK !== null && stochK > 70 && bearValid) { bearScore += 4; bearConf.push(`StochRSI overbought ${stochK.toFixed(0)}`); }

  // ── CCI ───────────────────────────────────────────────────────────────────
  if (cci !== null && cci > 100  && cci < 250  && bullValid) { bullScore += 4; bullConf.push(`CCI ${cci.toFixed(0)}`); }
  if (cci !== null && cci < -100 && cci > -250 && bearValid) { bearScore += 4; bearConf.push(`CCI ${cci.toFixed(0)}`); }

  // ── Williams R ────────────────────────────────────────────────────────────
  if ((williamsR||0) > -70 && (williamsR||0) < -20 && bullValid) bullScore += 3;
  if ((williamsR||0) < -30 && (williamsR||0) > -80 && bearValid) bearScore += 3;

  // ── Volume extras ─────────────────────────────────────────────────────────
  if (volumeStrong  && bullValid) { bullScore += 5; bullConf.push("Volume surge 2x+"); }
  if (volumeStrong  && bearValid) { bearScore += 5; bearConf.push("Volume surge 2x+"); }
  if (volumeTrending && bullValid) { bullScore += 3; bullConf.push("Volume increasing"); }
  if (volumeTrending && bearValid) { bearScore += 3; bearConf.push("Volume increasing"); }
  if (activeMarket.isLiquid && bullValid) { bullScore += 4; bullConf.push(`24h quote vol ${formatCompact(activeMarket.quoteVolume)} USDT`); }
  if (activeMarket.isLiquid && bearValid) { bearScore += 4; bearConf.push(`24h quote vol ${formatCompact(activeMarket.quoteVolume)} USDT`); }
  if (activeMarket.isCrowded && bullValid) {
    const participation = activeMarket.tradeCount > 0
      ? `${formatCompact(activeMarket.tradeCount)} trades/24h`
      : `OI ${formatCompact(activeMarket.openInterestValue)} USDT`;
    bullScore += 4;
    bullConf.push(`Crowded market ${participation}`);
  }
  if (activeMarket.isCrowded && bearValid) {
    const participation = activeMarket.tradeCount > 0
      ? `${formatCompact(activeMarket.tradeCount)} trades/24h`
      : `OI ${formatCompact(activeMarket.openInterestValue)} USDT`;
    bearScore += 4;
    bearConf.push(`Crowded market ${participation}`);
  }
  if (mfi !== null && mfi >= 50 && mfi <= 72 && bullValid) { bullScore += 3; bullConf.push(`MFI ${roundPrice(mfi)}`); }
  if (mfi !== null && mfi <= 50 && mfi >= 28 && bearValid) { bearScore += 3; bearConf.push(`MFI ${roundPrice(mfi)}`); }
  if (forceIndex > 0 && bullValid) bullScore += 2;
  if (forceIndex < 0 && bearValid) bearScore += 2;

  // ── BB squeeze ────────────────────────────────────────────────────────────
  if (bbWidth && rawAtr && bbWidth < rawAtr * 2.5) {
    if (bullValid) { bullScore += 3; bullConf.push("BB squeeze"); }
    if (bearValid) { bearScore += 3; bearConf.push("BB squeeze"); }
  }

  // ── Candlestick patterns ──────────────────────────────────────────────────
  const strongBullPat = ["Morning Star","Morning Doji Star","Three White Soldiers","Bullish Engulfing","Piercing Line","Tweezer Bottom","Bullish Marubozu","Abandoned Baby (Bull)"];
  const strongBearPat = ["Evening Star","Evening Doji Star","Three Black Crows","Bearish Engulfing","Dark Cloud Cover","Tweezer Top","Bearish Marubozu","Downside Tasuki Gap"];
  const patBull = (analysis.patterns?.bullish || []);
  const patBear = (analysis.patterns?.bearish || []);
  const confBull = patBull.filter(p => strongBullPat.includes(p));
  const confBear = patBear.filter(p => strongBearPat.includes(p));
  if (confBull.length && bullValid)    { bullScore += 10; bullConf.push(confBull.join(", ")); }
  else if (patBull.length && bullValid) { bullScore += 4;  bullConf.push(patBull.slice(0,2).join(", ")); }
  if (confBear.length && bearValid)    { bearScore += 10; bearConf.push(confBear.join(", ")); }
  else if (patBear.length && bearValid) { bearScore += 4;  bearConf.push(patBear.slice(0,2).join(", ")); }

  // ── HTF bonus ────────────────────────────────────────────────────────────
  // NOTE: 4H bias is already captured in higherBias score above.
  // Only 12H, 1D, and 1H are added here as independent confirmations.
  if (twelveH) {
    const ok = twelveH.trend.ema50 > twelveH.trend.ema100 ? "BULLISH" : "BEARISH";
    if (ok === effectiveBias) {
      if (effectiveBias === "BULLISH") { bullScore += 6; bullConf.push("12H trend aligned"); }
      else                             { bearScore += 6; bearConf.push("12H trend aligned"); }
    }
  }
  if (daily) {
    const ok = daily.trend.ema50 > daily.trend.ema100 ? "BULLISH" : "BEARISH";
    if (ok === effectiveBias) {
      if (effectiveBias === "BULLISH") { bullScore += 8; bullConf.push("Daily macro aligned"); }
      else                             { bearScore += 8; bearConf.push("Daily macro aligned"); }
    } else if (effectiveBias !== "NEUTRAL") {
      if (effectiveBias === "BULLISH") bullScore -= 5;
      else                             bearScore -= 5;
    }
  }
  if (oneH) {
    const oh1 = oneH.trend.ema50 > oneH.trend.ema100 ? "BULLISH" : "BEARISH";
    if (oh1 === effectiveBias) {
      if (effectiveBias === "BULLISH") { bullScore += 5; bullConf.push("1H confirming"); }
      else                             { bearScore += 5; bearConf.push("1H confirming"); }
    }
  }

  // ── 30m confirming (useful for 5m/15m entries) ────────────────────────────
  if (thirtyM && ["5m","15m"].includes(timeframe)) {
    const oh30 = thirtyM.trend.ema50 > thirtyM.trend.ema100 ? "BULLISH" : "BEARISH";
    if (oh30 === effectiveBias) {
      if (effectiveBias === "BULLISH") { bullScore += 4; bullConf.push("30m confirming"); }
      else                             { bearScore += 4; bearConf.push("30m confirming"); }
    }
  }

  // ── ROC ──────────────────────────────────────────────────────────────────
  if ((roc||0) > 0 && bullValid) bullScore += 2;
  if ((roc||0) < 0 && bearValid) bearScore += 2;
  if ((roc5||0) > 0 && bullValid) bullScore += 2;
  if ((roc5||0) < 0 && bearValid) bearScore += 2;
  if ((rsi9||0) > 52 && bullValid) bullScore += 2;
  if ((rsi9||0) < 48 && bearValid) bearScore += 2;

  // ── Final ────────────────────────────────────────────────────────────────
  const side        = bullValid && !bearValid ? "LONG" : !bullValid && bearValid ? "SHORT" : bullScore >= bearScore ? "LONG" : "SHORT";
  const confidence  = side === "LONG" ? bullScore : bearScore;
  const confirmations = side === "LONG" ? bullConf : bearConf;
  const minScoreRequirement = minScoreBySide[side] ?? minScoreBySide.LONG;
  const minConfirmationRequirement = minConfBySide[side] ?? minConfBySide.LONG;
  if (confidence < minScoreRequirement || confirmations.length < minConfirmationRequirement) return null;
  if (tfRule.requireHigherBias) {
    if (side === "LONG" && higherBias !== "BULLISH") return null;
    if (side === "SHORT" && higherBias !== "BEARISH") return null;
  }

  const targets  = calculateTargets(side, analysis, timeframe);
  const leverage = calculateLeverage(analysis, confidence, timeframe);
  if (!Number.isFinite(targets.riskPerUnit) || targets.riskPerUnit <= 0) return null;
  const driftMultiplier = (tfRule.entryDriftMultiplier ?? 0.6) + entryDriftBonus;
  const entryDriftLimit = Math.max(atr * driftMultiplier, atr * 0.25);
  if (Math.abs(price - targets.entry) > entryDriftLimit) return null;
  const publishFloor = publishFloorBySide[side] ?? publishFloorBase;
  if (confidence < publishFloor) return null;
  const strength = confidence >= STRENGTH_THRESHOLDS.STRONG ? "STRONG" : "MEDIUM";
  const anchorCount = side === "LONG" ? bullAnchors : bearAnchors;
  const anchorRequirement = anchorRequirementBySide[side] ?? anchorRequirementBySide.LONG;
  const qualityAnchors = side === "LONG" ? bullAnchorLabels : bearAnchorLabels;
  const adaptiveNotes = perfAdjustments[side]?.reasons || [];

  return createSignal({
    coin, side, timeframe, confidence, leverage,
    strength,
    confirmations,
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
      regime, volumeSpike, volumeStrong, higherBias, effectiveBias, leverage,
      rsiDivBull, rsiDivBear, macdDivBull, macdDivBear,
      riskPerUnit: roundPrice(targets.riskPerUnit),
      marketActivity: {
        quoteVolume: roundPrice(activeMarket.quoteVolume),
        tradeCount: roundPrice(activeMarket.tradeCount),
        openInterestValue: roundPrice(activeMarket.openInterestValue),
        activityScore: roundPrice(activeMarket.activityScore),
      },
    },
    patternSummary: analysis.patterns,
    scanMeta: {
      higherBias,
      effectiveBias,
      ruleVersion: RULE_VERSION,
      publishFloor,
      marketActivityScore: roundPrice(activeMarket.activityScore),
      marketQuoteVolume: roundPrice(activeMarket.quoteVolume),
      marketTradeCount: roundPrice(activeMarket.tradeCount),
      marketOpenInterestValue: roundPrice(activeMarket.openInterestValue),
      modelVersion: "v13_precision",
      sourceTimeframes: SCAN_TIMEFRAMES,
      performanceSnapshot: performanceSnapshot ? {
        sampleSize: performanceSnapshot.sampleSize,
        long: performanceSnapshot.LONG,
        short: performanceSnapshot.SHORT,
        tf5m: performanceSnapshot["5m"],
      } : null,
      timeframeRule: tfRule,
      adaptiveNotes,
      anchorCount,
      anchorRequirement,
      qualityAnchors,
      relaxedMode: isRelaxed,
      rescueMode,
    },
    source: "ENGINE",
    ...targets,
  });
}

// ─── Coin Scan ────────────────────────────────────────────────────────────────
async function analyzeCoin(coin, marketActivity = null, performanceSnapshot = null, options = {}) {
  const analyses = {};

  // Sequential (not parallel) to avoid rate limiting Bybit
  for (const tf of SCAN_TIMEFRAMES) {
    const candles = await getKlines(coin, tf, 260);
    analyses[tf]  = analyzeCandles(candles);
    await new Promise(r => setTimeout(r, 80)); // 80ms gap between requests
  }

  const higherBias = getHigherTimeframeBias(analyses);
  const htf = {
    daily:  analyses["1d"]  || null,
    twelveH: analyses["12h"] || null,
    fourH:  analyses["4h"]  || null,
    oneH:   analyses["1h"]  || null,
    thirtyM: analyses["30m"] || null,
  };

  const candidates = getTradeTimeframes()
    .map(tf => analyses[tf] ? buildCandidate(coin, tf, analyses[tf], higherBias, htf, marketActivity, performanceSnapshot, options) : null)
    .filter(Boolean);

  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.confidence - a.confidence)[0];
}

// ─── Signal Evaluation ───────────────────────────────────────────────────────
async function evaluateActiveSignals() {
  const signals = await readCollection("signals");
  const active  = signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE);
  if (!active.length) return [];
  const prices = await getPrices([...new Set(active.map(s => s.coin))]);
  const now    = new Date().toISOString();
  const closed = [];
  await mutateCollection("signals", records => records.map(sig => {
    if (sig.status !== SIGNAL_STATUS.ACTIVE) return sig;
    const price = prices[sig.coin];
    if (!Number.isFinite(price)) return sig;
    const hit = result => { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result, closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; };
    if (sig.side === "LONG") {
      if (price >= sig.tp3)   return hit("TP3_HIT");
      if (price >= sig.tp2)   return hit("TP2_HIT");
      if (price >= sig.tp1)   return hit("TP1_HIT");
      if (price <= sig.stopLoss) return hit("SL_HIT");
    } else {
      if (price <= sig.tp3)   return hit("TP3_HIT");
      if (price <= sig.tp2)   return hit("TP2_HIT");
      if (price <= sig.tp1)   return hit("TP1_HIT");
      if (price >= sig.stopLoss) return hit("SL_HIT");
    }
    return sig;
  }));
  // Broadcast each closed signal via WebSocket
  closed.forEach(s => {
    try { ws()?.broadcastSignalClosed(s);  } catch {}
    try { sse()?.broadcastSignalClosed(s); } catch {}
  });
  return closed;
}

async function getPerformanceSnapshot() {
  try {
    const signals = await readCollection("signals");
    const stats = {
      overall: buildTally(),
      LONG: buildTally(),
      SHORT: buildTally(),
      "5m": buildTally(),
    };
    for (const sig of signals) {
      const isWin = WIN_RESULTS.has(sig.result);
      const isLoss = LOSS_RESULTS.has(sig.result);
      if (!isWin && !isLoss) continue;
      const key = isWin ? "wins" : "losses";
      stats.overall[key] += 1;
      if (stats[sig.side]) stats[sig.side][key] += 1;
      if (!stats[sig.timeframe]) stats[sig.timeframe] = buildTally();
      stats[sig.timeframe][key] += 1;
    }
    stats.sampleSize = stats.overall.wins + stats.overall.losses;
    return stats;
  } catch {
    return {
      overall: buildTally(),
      LONG: buildTally(),
      SHORT: buildTally(),
      "5m": buildTally(),
      sampleSize: 0,
    };
  }
}

// ─── Persist / Manual / Demo ─────────────────────────────────────────────────
async function persistSignal(signal) {
  const result = await mutateCollection("signals", records => ({ records: [signal, ...records], value: signal }));
  try { ws()?.broadcastNewSignal(signal);  } catch {}
  try { sse()?.broadcastNewSignal(signal); } catch {}
  return result;
}
async function signalExists(candidate) {
  const signals = await readCollection("signals");
  return signals.some(s => s.status === SIGNAL_STATUS.ACTIVE && s.coin === candidate.coin && s.side === candidate.side && s.timeframe === candidate.timeframe);
}
async function createManualSignal(payload, actor) {
  const confidence = Number(payload.confidence || 75);
  const leverage = clamp(Number(payload.leverage || 10), 10, 50);
  const signal = createSignal({
    coin: payload.coin, side: payload.side, timeframe: payload.timeframe || "5m",
    entry: payload.entry, stopLoss: payload.stopLoss, tp1: payload.tp1, tp2: payload.tp2, tp3: payload.tp3,
    confidence,
    leverage,
    confirmations: Array.isArray(payload.confirmations) ? payload.confirmations : ["Admin signal"],
    indicatorSnapshot: payload.indicatorSnapshot || {}, patternSummary: payload.patternSummary || {},
    scanMeta: { createdBy: actor?.email || "admin", manual: true, ...(payload.scanMeta || {}) },
    source: payload.source || "MANUAL",
    strength: confidence >= 70 ? "STRONG" : "MEDIUM",
  });
  await persistSignal(signal);
  return signal;
}
async function scanNow({ source = "ENGINE" } = {}) {
  if (engineState.isScanning) return { skipped:true, message:"Scan already in progress" };
  engineState.isScanning = true;
  const generatedSignals = [], errors = [];
  try {
    const closedSignals = await evaluateActiveSignals();
    const performanceSnapshot = await getPerformanceSnapshot();
    const scanUniverse = await getScanUniverse();
    const primaryLimit = getMaxCoinsPerScan();
    const coins = scanUniverse.slice(0, primaryLimit);
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const attempt = async (market, options = {}) => {
      try {
        const candidate = await analyzeCoin(market.symbol, market, performanceSnapshot, options);
        if (!candidate) return false;
        candidate.source = source;
        candidate.updatedAt = new Date().toISOString();
        candidate.scanMeta = {
          ...(candidate.scanMeta || {}),
          relaxedMode: candidate.scanMeta?.relaxedMode || Boolean(options.relaxed),
          rescueMode: candidate.scanMeta?.rescueMode || Boolean(options.rescueMode),
          rescueIteration: candidate.scanMeta?.rescueIteration || Boolean(options.rescueMode),
        };
        if (await signalExists(candidate)) return false;
        generatedSignals.push(await persistSignal(candidate));
        return true;
      } catch (e) {
        errors.push({ coin: market.symbol, message: e.message });
        return false;
      }
    };

    for (const market of coins) {
      if (engineState.pausedCoins[market.symbol]) {
        errors.push({ coin: market.symbol, message: "Paused by admin" });
        continue;
      }
      await attempt(market);
      await sleep(300); // 300ms between coins — reduced from 200ms to ease Bybit rate limits
    }

    if (!generatedSignals.length) {
      const relaxedOptions = {
        relaxed: true,
        rescueMode: true,
        relaxFloor: RELAXED_PUBLISH_DELTA,
        relaxScore: RELAXED_MIN_SCORE_DELTA,
        entryDriftBoost: RELAXED_ENTRY_DRIFT_BOOST,
      };
      const fallbackRange = Math.min(scanUniverse.length, Math.max(primaryLimit, RESCUE_SCAN_LIMIT));
      const rescueCoins = scanUniverse
        .filter(m => m.passesFloor || m.relaxThresholds)
        .slice(0, fallbackRange);
      for (const market of rescueCoins) {
        const created = await attempt(market, relaxedOptions);
        await sleep(250);
        if (created) break;
      }
    }
    engineState.lastGenerated = generatedSignals.length;
    engineState.lastScanAt    = new Date().toISOString();
    engineState.lastError     = errors.length ? `${errors.length} coin scans failed` : null;
    engineState.scanCount    += 1;
    return { closedSignals, errors, generatedSignals, scanCount: engineState.scanCount };
  } finally { engineState.isScanning = false; }
}
function getStatus() {
  return { intervalMs: engineState.intervalMs, isScanning: engineState.isScanning, lastError: engineState.lastError, lastGenerated: engineState.lastGenerated, lastScanAt: engineState.lastScanAt, running: engineState.running, scanCount: engineState.scanCount };
}
function start() {
  if (engineState.timer) { engineState.running = true; return getStatus(); }
  engineState.intervalMs = Number(process.env.SCAN_INTERVAL_MS || engineState.intervalMs || 300000);
  engineState.timer = setInterval(() => { scanNow({ source:"ENGINE" }).catch(e => { engineState.lastError = e.message; }); }, engineState.intervalMs);
  engineState.running = true;
  scanNow({ source:"ENGINE" }).catch(e => { engineState.lastError = e.message; });
  return getStatus();
}
function stop() {
  if (engineState.timer) { clearInterval(engineState.timer); engineState.timer = null; }
  engineState.running = false;
  return getStatus();
}
// ─── Admin: Pause / Resume coins ─────────────────────────────────────────────
function pauseCoin(symbol, actor, reason = "") {
  const coin = String(symbol || "").trim().toUpperCase();
  if (!coin) throw new Error("Symbol required");
  engineState.pausedCoins[coin] = {
    pausedAt: new Date().toISOString(),
    reason:   reason || "Repeated stop losses",
    pausedBy: actor?.email || "admin",
  };
  return engineState.pausedCoins;
}

function resumeCoin(symbol) {
  const coin = String(symbol || "").trim().toUpperCase();
  delete engineState.pausedCoins[coin];
  return engineState.pausedCoins;
}

function getPausedCoins() {
  return engineState.pausedCoins;
}

// ─── Admin: Force-generate signal for a specific coin ─────────────────────────
// Uses relaxed thresholds + bypasses Fibonacci gate so admin always gets a result
// Returns { generated, signal?, message, diagnostics }
async function generateForCoin(symbol, actor) {
  const coin = String(symbol || "").trim().toUpperCase();
  if (!coin) throw new Error("Symbol required");

  const marketActivity = buildFallbackMarketActivity(coin);
  const { candidate, diagnostics } = await analyzeCoinForAdmin(coin, marketActivity);

  if (!candidate) {
    const reasons = Object.entries(diagnostics.gateResults || {})
      .map(([tf, r]) => `[${tf}] ${typeof r === "object" ? r.verdict : r}`)
      .join(" | ");
    return {
      generated: false,
      message: `No signal for ${coin}. Gate results: ${reasons || "All timeframes failed"}`,
      diagnostics,
    };
  }

  candidate.source    = "ADMIN_SEARCH";
  candidate.updatedAt = new Date().toISOString();
  if (candidate.scanMeta) candidate.scanMeta.createdBy = actor?.email || "admin";
  const signal = await persistSignal(candidate);
  return { generated: true, signal, diagnostics };
}

// Relaxed analyzer: majority HTF agreement enough, Fib gate skipped, lower publishFloor
async function analyzeCoinForAdmin(coin, marketActivity = null) {
  const analyses  = {};
  const diagnostics = { coin, timeframes: {}, gateResults: {} };

  for (const tf of SCAN_TIMEFRAMES) {
    try {
      const candles = await getKlines(coin, tf, 260);
      if (!candles || candles.length < 20) { diagnostics.timeframes[tf] = "NO_DATA"; continue; }
      analyses[tf]  = analyzeCandles(candles);
      diagnostics.timeframes[tf] = "OK";
    } catch (e) { diagnostics.timeframes[tf] = `ERROR: ${e.message}`; }
    await new Promise(r => setTimeout(r, 80));
  }

  const htf = {
    daily:   analyses["1d"]  || null,
    twelveH: analyses["12h"] || null,
    fourH:   analyses["4h"]  || null,
    oneH:    analyses["1h"]  || null,
    thirtyM: analyses["30m"] || null,
  };

  for (const tf of getTradeTimeframes()) {
    if (!analyses[tf]) { diagnostics.gateResults[tf] = "SKIP: no data"; continue; }

    const analysis = analyses[tf];
    const price    = analysis.currentPrice;
    const gates    = {};

    // GATE 1: HTF bias — try strict first, then relaxed majority vote
    let bias = getHigherTimeframeBias(analyses);
    if (bias === "NEUTRAL") {
      // Relaxed: check 4h, 1h, 12h — majority wins
      const pool = [analyses["4h"], analyses["1h"], analyses["12h"]].filter(Boolean);
      const dirs = pool.map(a => {
        const { ema50, ema100, adx } = a.trend;
        const rsi = a.momentum?.rsi || 50;
        if (ema50 > ema100 * 0.998 && (adx||0) >= 12 && rsi >= 33 && rsi <= 75) return "BULLISH";
        if (ema50 < ema100 * 1.002 && (adx||0) >= 12 && rsi <= 67 && rsi >= 25) return "BEARISH";
        return "NEUTRAL";
      }).filter(d => d !== "NEUTRAL");
      const bulls = dirs.filter(d => d === "BULLISH").length;
      const bears = dirs.filter(d => d === "BEARISH").length;
      if (bulls > bears) bias = "BULLISH";
      else if (bears > bulls) bias = "BEARISH";
    }
    gates.htfBias = bias !== "NEUTRAL" ? `PASS (${bias})` : "FAIL";
    if (bias === "NEUTRAL") { diagnostics.gateResults[tf] = { gates, verdict: "FAIL — HTF not aligned" }; continue; }
    const side = bias === "BULLISH" ? "LONG" : "SHORT";

    // GATE 2: EMA stack
    const { ema21, ema50, ema200, adx, pdi, mdi } = analysis.trend;
    const emaOk = side === "LONG"
      ? (ema21||0) > (ema50||0) * 0.997 && (ema50||0) > (ema200||0) * 0.993
      : (ema21||0) < (ema50||0) * 1.003 && (ema50||0) < (ema200||0) * 1.007;
    gates.ema = emaOk ? "PASS" : `FAIL (EMA stack not aligned for ${side})`;
    if (!emaOk) { diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — EMA trend" }; continue; }

    // GATE 3: ADX (relaxed -20%)
    const minAdxRelaxed = ((TIMEFRAME_RULES[tf]?.minAdx ?? 20) * 0.80);
    const adxOk = (adx||0) >= minAdxRelaxed;
    gates.adx = adxOk ? `PASS (ADX ${(adx||0).toFixed(1)})` : `FAIL (${(adx||0).toFixed(1)} < ${minAdxRelaxed.toFixed(0)})`;
    if (!adxOk) { diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — ADX too weak" }; continue; }

    // GATE 4: Not ranging
    gates.regime = analysis.regime !== "RANGING" ? `PASS (${analysis.regime})` : "FAIL — RANGING market";
    if (analysis.regime === "RANGING") { diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — ranging market" }; continue; }

    // Build with relaxed floor (Fib gate skipped via options.skipFib)
    const activity   = marketActivity || buildFallbackMarketActivity(coin);
    const origRules  = { ...(TIMEFRAME_RULES[tf] || {}) };
    TIMEFRAME_RULES[tf] = { ...origRules, publishFloor: 40, minScore: 35, minConfirmations: 2 };
    let candidate;
    try {
      candidate = buildCandidate(coin, tf, analysis, bias, htf, activity, null, { skipFib: true });
    } finally {
      TIMEFRAME_RULES[tf] = origRules;
    }

    if (candidate) {
      diagnostics.gateResults[tf] = { side, gates, verdict: "PASS ✅", confidence: candidate.confidence };
      diagnostics.winner = tf;
      return { candidate, diagnostics };
    }
    diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — score too low even relaxed" };
  }

  return { candidate: null, diagnostics };
}

module.exports = { createManualSignal, evaluateActiveSignals, getCoinList, getStatus, scanNow, start, stop, pauseCoin, resumeCoin, getPausedCoins, generateForCoin };
