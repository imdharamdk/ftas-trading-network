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

function getAdaptiveQualityConfig(performanceSnapshot, { coin, side, timeframe }) {
  const config = {
    scoreBoost: 0,
    publishFloorBoost: 0,
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

  const sideTfKey = `${side}:${timeframe}`;
  const sideTfStats = performanceSnapshot.bySideTimeframe?.[sideTfKey];
  const sideTfTotal = Number(sideTfStats?.wins || 0) + Number(sideTfStats?.losses || 0);
  const sideTfWinRate = winRateFromTally(sideTfStats);
  if (sideTfTotal >= 8 && sideTfWinRate !== null && sideTfWinRate < 45) {
    config.scoreBoost += 5;
    config.publishFloorBoost += 4;
    config.minConfirmationsBoost += 1;
    config.reasons.push(`weak_${sideTfKey.toLowerCase()}`);
  } else if (sideTfTotal >= 8 && sideTfWinRate !== null && sideTfWinRate < 55) {
    config.scoreBoost += 2;
    config.publishFloorBoost += 2;
    config.reasons.push(`soft_${sideTfKey.toLowerCase()}`);
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
  const entry = analysis.currentPrice;
  const atr   = analysis.volatility.atr || analysis.averages.averageRange || entry * 0.003;
  const { low20, high20, previousLow20, previousHigh20 } = analysis.recentSwing;
  const srSup = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes = analysis.srLevels?.resistances?.[0] ?? null;
  const tpMult = timeframe === "1m" ? TP_R_MULTIPLIERS_1M : TP_R_MULTIPLIERS_5M;

  // Tighter SL band → better RR
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
function buildCandidate(coin, timeframe, analysis, higherBias, htf = {}, marketActivity = null, performanceSnapshot = null) {
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
  const { daily, oneH } = htf;
  const dailyTrend     = daily?.trend || {};
  const dailyBearStack = (dailyTrend.ema50||0) < (dailyTrend.ema100||0) && (dailyTrend.adx||0) >= 16;
  const dailyBullStack = (dailyTrend.ema50||0) > (dailyTrend.ema100||0) && (dailyTrend.adx||0) >= 16;
  const psarBull = Number.isFinite(psar) ? psar < price : false;
  const psarBear = Number.isFinite(psar) ? psar > price : false;
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
  const confidence    = side === "LONG" ? bullScore : bearScore;
  const confirmations = side === "LONG" ? bullConf  : bearConf;

  const adaptiveQuality  = getAdaptiveQualityConfig(performanceSnapshot, { coin, side, timeframe });
  if (adaptiveQuality.blockCoin) return null;

  const minScore         = (tfRule.minScore         || 62) + adaptiveQuality.scoreBoost;
  const minConfirmations = (tfRule.minConfirmations || 5)  + adaptiveQuality.minConfirmationsBoost;
  const publishFloor     = (tfRule.publishFloor     || DEFAULT_PUBLISH_FLOOR) + adaptiveQuality.publishFloorBoost;

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
      modelVersion: SIGNAL_MODEL_VERSION,
      qualityGuard: {
        scoreBoost: adaptiveQuality.scoreBoost,
        publishFloorBoost: adaptiveQuality.publishFloorBoost,
        minConfirmationsBoost: adaptiveQuality.minConfirmationsBoost,
        reasons: adaptiveQuality.reasons,
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
async function analyzeCoin(coin, marketActivity = null, performanceSnapshot = null) {
  const analyses = {};
  const timeframeConcurrency = getTimeframeFetchConcurrency();

  await mapWithConcurrency(SCAN_TIMEFRAMES, timeframeConcurrency, async (tf) => {
    const candles = await fetchCryptoCandles(coin, tf);
    if (candles.length >= 20) analyses[tf] = analyzeCandles(candles);
    await sleep(20);
    return true;
  });

  const htf = { daily: analyses["1h"] || null, twelveH: null, fourH: null, oneH: analyses["1h"] || null };
  const tradeTimeframes = getTradeTimeframes();
  const candidates = tradeTimeframes
    .map((tf) => {
      if (!analyses[tf]) return null;
      const bias = getHigherTimeframeBias(analyses, tf);
      return buildCandidate(coin, tf, analyses[tf], bias, htf, marketActivity, performanceSnapshot);
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
    sampleSize: 0,
  };

  try {
    const signals = await readCollection(SIGNAL_COLLECTION);
    const stats = {
      ...fallback,
      byCoin: {},
      bySideTimeframe: {},
      recentSlStreakByCoin: {},
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

    const byCoinSeries = {};
    for (const sig of recentResolved) {
      const coin = String(sig.coin || "").toUpperCase();
      if (!coin) continue;
      const isWin = WIN_RESULTS.has(sig.result);
      updateTally(stats.byCoin, coin, isWin);
      if (!byCoinSeries[coin]) byCoinSeries[coin] = [];
      byCoinSeries[coin].push(sig.result);
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
    }

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

async function scanNow({ source = "ENGINE" } = {}) {
  if (engineState.isScanning) return { skipped: true, message: "Scan already in progress" };
  engineState.isScanning = true;

  const generatedSignals = [];
  const errors = [];

  try {
    const closedSignals = await evaluateActiveSignals();
    const performanceSnapshot = await getPerformanceSnapshot();
    const scanUniverse = await getScanUniverse();
    const coins = scanUniverse.slice(0, getMaxCoinsPerScan());
    const scanConcurrency = getCoinScanConcurrency();
    const activeSignalKeys = await getActiveSignalKeySet();

    const scanResults = await mapWithConcurrency(coins, scanConcurrency, async (market) => {
      if (engineState.pausedCoins[market.symbol]) {
        return { coin: market.symbol, skipped: true, message: "Paused by admin — skipped in scan" };
      }
      const candidate = await analyzeCoin(market.symbol, market, performanceSnapshot);
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
    reason: reason || "Repeated stop losses",
    pausedBy: actor?.email || "admin",
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

  const candidate = await analyzeCoin(coin, marketActivity, performanceSnapshot);
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

module.exports = { createManualSignal, evaluateActiveSignals, getCoinList, getStatus, scanNow, start, stop, pauseCoin, resumeCoin, getPausedCoins, generateForCoin };
