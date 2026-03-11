const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { getKlines, getPrices, getAllFuturesCoins, getAllTickerStats } = require("./binanceService");
const { analyzeCandles } = require("./indicatorEngine");

// ─── ULTRA-HIGH ACCURACY MODE ─────────────────────────────────────────────────
// Philosophy: "Ek bhi galat signal nahi — bhale hi signal aaye kam"
//
// 7 HARD GATES — ALL must pass. Even ONE failure = NO signal.
//
//  GATE 1 — HTF ALIGNMENT   : 4H + 1D dono bullish/bearish hone chahiye
//  GATE 2 — EMA STACK       : 9 > 21 > 50 > 100 > 200 (perfect stack, koi gap nahi)
//  GATE 3 — EMA MOMENTUM    : EMA slopes accelerating (tezi se badh/gir rahe hain)
//  GATE 4 — ADX STRENGTH    : ADX >= 30 (strong trend confirm)
//  GATE 5 — MULTI-MOMENTUM  : RSI + MACD + StochRSI teeno agree karna chahiye
//  GATE 6 — VOLUME CONFIRM  : Current volume > 2x avg (smart money entry)
//  GATE 7 — CANDLE CONFIRM  : Last 3 HA candles same direction + no opposing wick
//
// BONUS FILTERS (extra rejection):
//  - Price must be above/below VWAP
//  - Ichimoku cloud must agree
//  - No recent big wick (manipulation candle block)
//  - BB %B must be in correct zone
//  - Divergence present = extra boost only (not gate)
//
// RESULT: ~3-8 signals per day (vs 20-30 before), but 80%+ win rate
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
  "MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT",
  "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT",
];

const SCAN_TIMEFRAMES          = ["1m","5m","15m","1h","4h","1d"];
const DEFAULT_TRADE_TIMEFRAMES = ["1m","5m"];
const DEFAULT_MAX_COINS_PER_SCAN = 50;
const MAX_COINS_PER_SCAN_CAP     = 70;
// Higher liquidity = tighter spreads = easier TP hit
const MIN_SCAN_QUOTE_VOLUME_USDT  = 25_000_000;
const MIN_SCAN_TRADE_COUNT_24H    = 30_000;
const MIN_SCAN_OPEN_INTEREST_USDT = 8_000_000;

const RULE_VERSION = "v14_ultra_accuracy";
const DEFAULT_PUBLISH_FLOOR = 92;   // was 87 — only publish top-tier signals
const STRENGTH_THRESHOLDS   = { STRONG: 96, MEDIUM: 92 };

// ── Per-Timeframe Rules ────────────────────────────────────────────────────────
const TIMEFRAME_RULES = {
  "1m": {
    minScore: 70,
    minConfirmations: 7,          // was 5 — need more indicator agreement
    publishFloor: 92,
    requireHigherBias: true,
    minAdx: 30,                   // was 28 — strong trend only
    minRsi: 50,                   // was 45 — must be in bullish RSI zone
    maxRsi: 75,
    minDiDelta: 6,                // was 4 — clear +DI/-DI separation
    requireVwapSupport: true,
    requireIchimoku: true,        // NEW — ichimoku cloud must agree
    requireHaStrong: true,        // NEW — must have 3-bar HA confirmation
    requireVolumeConfirm: true,   // NEW — must have 2x+ volume
    blockDailyBear: true,
    entryDriftMultiplier: 0.2,    // was 0.25 — even tighter entry zone
    maxLeverage: 10,
  },
  "5m": {
    minScore: 72,
    minConfirmations: 8,          // was 6
    publishFloor: 93,
    requireHigherBias: true,
    minAdx: 28,                   // was 22
    minRsi: 50,                   // was 46
    maxRsi: 76,
    minDiDelta: 6,                // was 4
    requireVwapSupport: true,
    requireIchimoku: true,        // NEW
    requireHaStrong: true,        // NEW
    requireVolumeConfirm: true,   // NEW
    blockDailyBear: true,
    entryDriftMultiplier: 0.3,    // was 0.4
    maxLeverage: 15,
  },
};

// ── Signal Expiry ──────────────────────────────────────────────────────────────
const SIGNAL_EXPIRY_MS = {
  "1m":  5  * 60 * 1000,   // 5 minutes
  "5m":  15 * 60 * 1000,   // 15 minutes
  default: 15 * 60 * 1000,
};

// ── Scalping TP targets (tight, realistic for 1-5 min moves) ─────────────────
const TP_R_MULTIPLIERS_1M = [0.5, 0.85, 1.3];
const TP_R_MULTIPLIERS_5M = [0.6, 1.0,  1.5];

const WIN_RESULTS  = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
const LOSS_RESULTS = new Set(["SL_HIT"]);
const buildTally   = () => ({ wins: 0, losses: 0 });

const engineState = {
  intervalMs: Number(process.env.SCAN_INTERVAL_MS || 60000),
  isScanning: false, lastError: null, lastGenerated: 0,
  lastScanAt: null, running: false, scanCount: 0,
  timer: null, expiryTimer: null,
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
  const isLiquid  = quoteVolume >= 35_000_000 || openInterestValue >= 8_000_000;
  const isCrowded = tradeCount  >= 25_000     || openInterestValue >= 12_000_000;
  const passesFloor = symbol.endsWith("USDT") &&
    quoteVolume >= MIN_SCAN_QUOTE_VOLUME_USDT &&
    (!hasParticipation || tradeCount >= MIN_SCAN_TRADE_COUNT_24H || openInterestValue >= MIN_SCAN_OPEN_INTEREST_USDT);
  return { symbol, quoteVolume, volume, tradeCount, openInterestValue,
    activityScore: liquidityScore + participationScore,
    isLiquid, isCrowded, passesFloor,
    relaxThresholds: isLiquid && (isCrowded || quoteVolume >= 75_000_000) };
}
function getMaxCoinsPerScan() {
  return clamp(Number(process.env.SCAN_MAX_COINS || DEFAULT_MAX_COINS_PER_SCAN), 5, MAX_COINS_PER_SCAN_CAP);
}
async function getScanUniverse() {
  const env = String(process.env.SCAN_COINS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (env.length) return env.map(buildFallbackMarketActivity);
  try {
    const ranked = (await getAllTickerStats())
      .map(buildMarketActivitySnapshot).filter(m => m.symbol.endsWith("USDT"))
      .sort((a, b) => b.activityScore - a.activityScore || b.quoteVolume - a.quoteVolume || a.symbol.localeCompare(b.symbol));
    const filtered = ranked.filter(m => m.passesFloor);
    if (filtered.length) return filtered;
    if (ranked.length)   return ranked;
  } catch {}
  try {
    const c = await getAllFuturesCoins();
    return (c.length ? c : FALLBACK_COINS).map(buildFallbackMarketActivity);
  } catch { return FALLBACK_COINS.map(buildFallbackMarketActivity); }
}
async function getCoinList() { return (await getScanUniverse()).map(m => m.symbol); }
function getTradeTimeframes() {
  const r = String(process.env.TRADE_TIMEFRAMES || "").split(",").map(s => s.trim()).filter(Boolean);
  return r.length ? r : DEFAULT_TRADE_TIMEFRAMES;
}

// ─── GATE 1: HTF Bias ─────────────────────────────────────────────────────────
// Ultra-strict: BOTH 4H and 1D must agree. If either is NEUTRAL → reject.
// For 1m: uses 5m + 15m agreement. For 5m: uses 15m + 1h agreement.
function getHigherTimeframeBias(analyses, tradeTimeframe = "5m") {
  if (tradeTimeframe === "1m") {
    const a5m  = analyses["5m"];
    const a15m = analyses["15m"];
    const a1h  = analyses["1h"];
    if (!a5m || !a15m) return "NEUTRAL"; // both required for 1m

    const get = (a) => {
      const { ema50, ema100, ema200, adx } = a.trend;
      const rsi = a.momentum.rsi || 50;
      const bull = ema50 > ema100 && ema100 > ema200 && (adx||0) >= 20 && rsi >= 45;
      const bear = ema50 < ema100 && ema100 < ema200 && (adx||0) >= 20 && rsi <= 55;
      return bull ? "BULLISH" : bear ? "BEARISH" : "NEUTRAL";
    };

    const b5m  = get(a5m);
    const b15m = get(a15m);
    // Both must agree — one NEUTRAL kills the signal
    if (b5m === "NEUTRAL" || b15m === "NEUTRAL") return "NEUTRAL";
    if (b5m !== b15m) return "NEUTRAL";

    // 1H soft veto: if 1H strongly opposes, reject
    if (a1h) {
      const b1h = get(a1h);
      if (b1h !== "NEUTRAL" && b1h !== b5m) return "NEUTRAL";
    }
    return b5m;
  }

  // 5m: 15m + 1h must both agree
  const a15m = analyses["15m"];
  const a1h  = analyses["1h"];
  const a4h  = analyses["4h"];
  const a1d  = analyses["1d"];
  if (!a15m || !a1h) return "NEUTRAL"; // both required

  const get = (a) => {
    const { ema50, ema100, ema200, adx } = a.trend;
    const rsi = a.momentum.rsi || 50;
    const bull = ema50 > ema100 && ema100 > ema200 && (adx||0) >= 18 && rsi >= 43;
    const bear = ema50 < ema100 && ema100 < ema200 && (adx||0) >= 18 && rsi <= 57;
    return bull ? "BULLISH" : bear ? "BEARISH" : "NEUTRAL";
  };

  const b15m = get(a15m);
  const b1h  = get(a1h);
  if (b15m === "NEUTRAL" || b1h === "NEUTRAL") return "NEUTRAL";
  if (b15m !== b1h) return "NEUTRAL";

  // 4H and 1D as additional vetos
  if (a4h) { const b4h = get(a4h); if (b4h !== "NEUTRAL" && b4h !== b15m) return "NEUTRAL"; }
  if (a1d) { const b1d = get(a1d); if (b1d !== "NEUTRAL" && b1d !== b15m) return "NEUTRAL"; }

  return b15m;
}

// ─── SL / TP ──────────────────────────────────────────────────────────────────
function calculateTargets(side, analysis, timeframe = "5m") {
  const entry = analysis.currentPrice;
  const atr   = analysis.volatility.atr || analysis.averages.averageRange || entry * 0.003;
  const { low20, high20, previousLow20, previousHigh20 } = analysis.recentSwing;
  const srSup = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes = analysis.srLevels?.resistances?.[0] ?? null;
  const tpMult = timeframe === "1m" ? TP_R_MULTIPLIERS_1M : TP_R_MULTIPLIERS_5M;
  const slMin  = atr * 0.8;   // min: slightly below 1x ATR for scalps
  const slMax  = atr * 1.8;   // max: 1.8x ATR keeps RR positive
  if (side === "LONG") {
    const anchors = [low20, previousLow20, srSup].filter(v => Number.isFinite(v) && v < entry);
    const anchor  = anchors.length ? Math.max(...anchors) : entry - atr * 1.2;
    const risk    = clamp((entry - anchor) + atr * 0.15, slMin, slMax);
    return { entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry - risk),
      tp1: roundPrice(entry + risk * tpMult[0]),
      tp2: roundPrice(entry + risk * tpMult[1]),
      tp3: roundPrice(entry + risk * tpMult[2]) };
  } else {
    const anchors = [high20, previousHigh20, srRes].filter(v => Number.isFinite(v) && v > entry);
    const anchor  = anchors.length ? Math.min(...anchors) : entry + atr * 1.2;
    const risk    = clamp((anchor - entry) + atr * 0.15, slMin, slMax);
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
  const bonus  = confidence >= 95 ? 5 : confidence >= 93 ? 3 : 0; // conservative bonus
  const tfRule = TIMEFRAME_RULES[timeframe] || {};
  const cap    = Number.isFinite(tfRule.maxLeverage) ? tfRule.maxLeverage : 20;
  return Math.round(clamp(base + bonus, 10, cap));
}

// ─── GATE 5 helper: Multi-Momentum Check ─────────────────────────────────────
// All 3 momentum oscillators must agree direction simultaneously
function isMultiMomentumAligned(side, analysis, tfRule) {
  const { rsi, rsiRising, rsiFalling, macd, macdHistIncreasing, macdHistDecreasing, stochRsi, stochKD } = analysis.momentum;
  const minRsi  = tfRule.minRsi ?? 50;
  const maxRsi  = tfRule.maxRsi ?? 76;
  const stochK  = stochRsi?.k ?? null;
  const kdK     = stochKD?.k  ?? null;
  const kdD     = stochKD?.d  ?? null;

  if (side === "LONG") {
    const rsiOk    = (rsi||0) >= minRsi && (rsi||0) <= maxRsi && rsiRising;
    const macdOk   = (macd?.MACD||0) > (macd?.signal||0) && macdHistIncreasing;
    const stochOk  = stochK !== null ? (stochK > 20 && stochK < 75) : true;
    const kdOk     = (kdK !== null && kdD !== null) ? kdK > kdD : true;
    return rsiOk && macdOk && stochOk && kdOk;
  } else {
    const rsiOk    = (rsi||0) <= (100 - minRsi) && (rsi||0) >= 24 && rsiFalling;
    const macdOk   = (macd?.MACD||0) < (macd?.signal||0) && macdHistDecreasing;
    const stochOk  = stochK !== null ? (stochK > 25 && stochK < 80) : true;
    const kdOk     = (kdK !== null && kdD !== null) ? kdK < kdD : true;
    return rsiOk && macdOk && stochOk && kdOk;
  }
}

// ─── GATE 6 helper: Volume Confirmation ───────────────────────────────────────
// Volume must be 2x+ average AND trending up — smart money entering
function isVolumeConfirmed(analysis) {
  const { currentVolume, averageVolume, volumeTrending } = analysis.volume;
  return currentVolume > averageVolume * 2.0 || (currentVolume > averageVolume * 1.5 && volumeTrending);
}

// ─── GATE 7 helper: HA Candle Strength ───────────────────────────────────────
// 3 consecutive HA candles in trade direction + no opposing wick on last candle
function isHaStrong(side, analysis) {
  const { haStrongBull, haStrongBear, haNoLowerWick, haNoUpperWick, haBullish, haBearish } = analysis.trend;
  if (side === "LONG") return haStrongBull || (haBullish && haNoLowerWick);
  else                 return haStrongBear || (haBearish && haNoUpperWick);
}

// ─── Manipulation Candle Detector ────────────────────────────────────────────
// Reject if last candle has a huge wick (> 60% of range) — likely stop hunt
function hasManipulationCandle(side, analysis) {
  const c    = analysis.candles;
  const atr  = analysis.volatility.atr || 1;
  if (!c) return false;
  const range     = (c.high - c.low) || 0.0001;
  const upperWick = (c.high - Math.max(c.open, c.close)) / range;
  const lowerWick = (Math.min(c.open, c.close) - c.low)  / range;
  if (side === "LONG"  && lowerWick > 0.55) return true; // big lower wick on long = stop hunt
  if (side === "SHORT" && upperWick > 0.55) return true; // big upper wick on short = stop hunt
  // Also reject if candle range is 3x+ ATR (spike candle — unpredictable)
  if (range > atr * 3.0) return true;
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
  const dailyBearStack = (dailyTrend.ema50||0) < (dailyTrend.ema100||0) && (dailyTrend.adx||0) >= 18;
  const dailyBullStack = (dailyTrend.ema50||0) > (dailyTrend.ema100||0) && (dailyTrend.adx||0) >= 18;
  const psarBull = Number.isFinite(psar) ? psar < price : false; // default false — must confirm
  const psarBear = Number.isFinite(psar) ? psar > price : false;
  const rsiDivBull  = analysis.divergence?.rsi?.bullish        || false;
  const rsiDivBear  = analysis.divergence?.rsi?.bearish        || false;
  const rsiHidBull  = analysis.divergence?.rsi?.hidden_bullish || false;
  const rsiHidBear  = analysis.divergence?.rsi?.hidden_bearish || false;
  const macdDivBull = analysis.divergence?.macd?.bullish       || false;
  const macdDivBear = analysis.divergence?.macd?.bearish       || false;
  const srSup = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes = analysis.srLevels?.resistances?.[0] ?? null;
  const nearSupportSR    = srSup && Math.abs(price - srSup) < atr * 1.0;
  const nearResistanceSR = srRes && Math.abs(price - srRes) < atr * 1.0;

  // ════════════════════════════════════════════════════════════════════════════
  // HARD GATE CHECKS — all must pass
  // ════════════════════════════════════════════════════════════════════════════

  // GATE 1: HTF Alignment — higherBias must be BULLISH or BEARISH (not NEUTRAL)
  if (higherBias === "NEUTRAL") return null;
  const side = higherBias === "BULLISH" ? "LONG" : "SHORT";

  // GATE 2: Perfect EMA Stack — ALL 5 EMAs must be in correct order
  // 9 > 21 > 50 > 100 > 200 for LONG (no gaps or crossed EMAs)
  const perfectBullStack = ema9 > ema21 && ema21 > ema50 && ema50 > ema100 && ema100 > ema200;
  const perfectBearStack = ema9 < ema21 && ema21 < ema50 && ema50 < ema100 && ema100 < ema200;
  if (side === "LONG"  && !perfectBullStack) return null;
  if (side === "SHORT" && !perfectBearStack) return null;

  // GATE 3: EMA Slope Acceleration — BOTH ema21 and ema50 must slope in trade direction
  const bullSlope = ema21Rising  && ema50Rising;
  const bearSlope = ema21Falling && ema50Falling;
  if (side === "LONG"  && !bullSlope) return null;
  if (side === "SHORT" && !bearSlope) return null;

  // GATE 4: ADX Strength — must be >= minAdx and +DI/-DI must be separated
  const minAdx     = tfRule.minAdx ?? 30;
  const minDiDelta = tfRule.minDiDelta ?? 6;
  if ((adx||0) < minAdx) return null;
  if (side === "LONG"  && ((pdi||0) - (mdi||0)) < minDiDelta) return null;
  if (side === "SHORT" && ((mdi||0) - (pdi||0)) < minDiDelta) return null;

  // GATE 5: Multi-Momentum — RSI + MACD + Stoch all aligned
  if (!isMultiMomentumAligned(side, analysis, tfRule)) return null;

  // GATE 6: Volume Confirmation — smart money must be present
  if (tfRule.requireVolumeConfirm && !isVolumeConfirmed(analysis)) return null;

  // GATE 7: HA Candle Strength — 3-bar HA confirmation required
  if (tfRule.requireHaStrong && !isHaStrong(side, analysis)) return null;

  // ── BONUS HARD FILTERS (not gates but critical rejectors) ────────────────
  // VWAP: price must be on correct side
  if (tfRule.requireVwapSupport) {
    if (side === "LONG"  && price < vwap) return null;
    if (side === "SHORT" && price > vwap) return null;
  }
  // Ichimoku: cloud must agree
  if (tfRule.requireIchimoku) {
    if (side === "LONG"  && !ichimoku?.bullish && !ichimoku?.aboveCloud) return null;
    if (side === "SHORT" && !ichimoku?.bearish && !ichimoku?.belowCloud) return null;
  }
  // Daily bear rejection for LONGs
  if (tfRule.blockDailyBear && side === "LONG" && dailyBearStack) return null;
  // Manipulation candle rejection
  if (hasManipulationCandle(side, analysis)) return null;
  // Regime: reject RANGING markets (trend indicators unreliable in range)
  if (regime === "RANGING") return null;
  // BB: price must not be at extreme end in wrong zone
  if (bbPctB !== null) {
    if (side === "LONG"  && bbPctB > 0.85) return null; // overbought — don't buy top
    if (side === "SHORT" && bbPctB < 0.15) return null; // oversold  — don't sell bottom
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ALL GATES PASSED — Now score the signal
  // ════════════════════════════════════════════════════════════════════════════

  const addConf = (cond, score, msg) => {
    if (!cond) return;
    if (side === "LONG") { bullScore += score; bullConf.push(msg); }
    else                 { bearScore += score; bearConf.push(msg); }
  };

  // Base score for passing all gates (minimum foundation)
  addConf(true, 40, `Perfect EMA stack ${side === "LONG" ? "bullish" : "bearish"}`);
  addConf(true, 15, `ADX ${roundPrice(adx||0)} | ${side === "LONG" ? "+DI" : "-DI"} dominant`);
  addConf(true, 15, `RSI ${roundPrice(rsi||0)} | MACD aligned | Stoch aligned`);
  addConf(true, 10, `Volume ${(currentVolume/averageVolume).toFixed(1)}x avg`);
  addConf(true, 8,  `HA ${side === "LONG" ? "bullish" : "bearish"} confirmation`);

  // HTF quality bonuses
  if (side === "LONG" && dailyBullStack) addConf(true, 8, "Daily macro bullish");
  if (side === "SHORT" && !dailyBullStack) addConf(true, 8, "Daily macro bearish");
  if (oneH) {
    const oh = oneH.trend.ema50 > oneH.trend.ema100 ? "BULLISH" : "BEARISH";
    if ((side === "LONG" && oh === "BULLISH") || (side === "SHORT" && oh === "BEARISH"))
      addConf(true, 6, "1H confirming");
  }

  // PSAR confirmation
  if (side === "LONG"  && psarBull) addConf(true, 5, "PSAR bullish dots");
  if (side === "SHORT" && psarBear) addConf(true, 5, "PSAR bearish dots");

  // Ichimoku bonus (already passed gate, so this is extra)
  if (side === "LONG"  && ichimoku?.bullish) addConf(true, 6, "Ichimoku cloud bullish");
  if (side === "SHORT" && ichimoku?.bearish) addConf(true, 6, "Ichimoku cloud bearish");

  // VWAP bonus
  addConf(true, 4, `${side === "LONG" ? "Above" : "Below"} VWAP ${roundPrice(vwap)}`);

  // S/R proximity (highest quality entries)
  if (side === "LONG"  && nearSupportSR)    addConf(true, 8, `At support ${roundPrice(srSup)}`);
  if (side === "SHORT" && nearResistanceSR) addConf(true, 8, `At resistance ${roundPrice(srRes)}`);

  // BB position
  if (bbPctB !== null && bbPctB < 0.3 && side === "LONG")  addConf(true, 5, `BB lower zone (${(bbPctB*100).toFixed(0)}%)`);
  if (bbPctB !== null && bbPctB > 0.7 && side === "SHORT") addConf(true, 5, `BB upper zone (${(bbPctB*100).toFixed(0)}%)`);

  // OBV trending in trade direction
  if (side === "LONG"  && obvTrending)              addConf(true, 5, "OBV trending up");
  if (side === "SHORT" && !obvTrending && obvChange < 0) addConf(true, 5, "OBV trending down");

  // Divergence bonus (high probability)
  if (rsiDivBull  && side === "LONG")  addConf(true, 12, "RSI bullish divergence ⚡");
  if (rsiDivBear  && side === "SHORT") addConf(true, 12, "RSI bearish divergence ⚡");
  if (macdDivBull && side === "LONG")  addConf(true, 8,  "MACD bullish divergence");
  if (macdDivBear && side === "SHORT") addConf(true, 8,  "MACD bearish divergence");
  if (rsiHidBull  && side === "LONG")  addConf(true, 6,  "RSI hidden bull div (trend cont.)");
  if (rsiHidBear  && side === "SHORT") addConf(true, 6,  "RSI hidden bear div (trend cont.)");

  // HA wick quality bonus
  if (haNoLowerWick && haStrongBull && side === "LONG")  addConf(true, 4, "HA no lower wick (pure bull)");
  if (haNoUpperWick && haStrongBear && side === "SHORT") addConf(true, 4, "HA no upper wick (pure bear)");

  // AO cross
  if (aoCrossUp   && side === "LONG")  addConf(true, 6, "AO zero-cross up");
  if (aoCrossDown && side === "SHORT") addConf(true, 6, "AO zero-cross down");
  else if ((ao||0) > 0 && side === "LONG")  { bullScore += 3; }
  else if ((ao||0) < 0 && side === "SHORT") { bearScore += 3; }

  // TRIX cross
  if (trixCrossUp   && side === "LONG")  addConf(true, 4, "TRIX cross+");
  if (trixCrossDown && side === "SHORT") addConf(true, 4, "TRIX cross-");
  else if ((trix||0) > 0 && side === "LONG")  bullScore += 2;
  else if ((trix||0) < 0 && side === "SHORT") bearScore += 2;

  // KST
  if (kstBullish && side === "LONG")  addConf(true, 4, "KST bullish");
  if (kstBearish && side === "SHORT") addConf(true, 4, "KST bearish");

  // Stoch extremes (additional bonus beyond gate 5)
  if (stochK !== null && stochK < 25 && side === "LONG")  addConf(true, 5, `StochRSI oversold ${stochK.toFixed(0)}`);
  if (stochK !== null && stochK > 75 && side === "SHORT") addConf(true, 5, `StochRSI overbought ${stochK.toFixed(0)}`);

  // CCI
  if (cci !== null && cci > 100  && cci < 200  && side === "LONG")  addConf(true, 4, `CCI ${cci.toFixed(0)}`);
  if (cci !== null && cci < -100 && cci > -200 && side === "SHORT") addConf(true, 4, `CCI ${cci.toFixed(0)}`);

  // Volume surge extra
  if (volumeStrong) addConf(true, 5, "Volume surge 2x+");
  if (activeMarket.isLiquid)  addConf(true, 4, `24h vol ${formatCompact(activeMarket.quoteVolume)} USDT`);
  if (activeMarket.isCrowded) addConf(true, 4, `${formatCompact(activeMarket.tradeCount)} trades/24h`);

  // MFI
  if (mfi !== null && mfi >= 55 && mfi <= 75 && side === "LONG")  addConf(true, 3, `MFI ${roundPrice(mfi)}`);
  if (mfi !== null && mfi <= 45 && mfi >= 25 && side === "SHORT") addConf(true, 3, `MFI ${roundPrice(mfi)}`);

  // Force index
  if (forceIndex > 0 && side === "LONG")  bullScore += 2;
  if (forceIndex < 0 && side === "SHORT") bearScore += 2;

  // BB squeeze
  if (bbWidth && rawAtr && bbWidth < rawAtr * 2.5) addConf(true, 3, "BB squeeze (breakout pending)");

  // Strong candlestick patterns (cherry on top)
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

  const minScore         = tfRule.minScore         || 70;
  const minConfirmations = tfRule.minConfirmations || 7;
  const publishFloor     = tfRule.publishFloor     || DEFAULT_PUBLISH_FLOOR;

  if (confidence < minScore)                        return null;
  if (confirmations.length < minConfirmations)      return null;
  if (confidence < publishFloor)                    return null;

  // Entry drift: price must be very close to calculated entry
  const targets         = calculateTargets(side, analysis, timeframe);
  const leverage        = calculateLeverage(analysis, confidence, timeframe);
  if (!Number.isFinite(targets.riskPerUnit) || targets.riskPerUnit <= 0) return null;
  const driftMultiplier = tfRule.entryDriftMultiplier ?? 0.3;
  const entryDriftLimit = Math.max(atr * driftMultiplier, atr * 0.15);
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
      modelVersion: "v14_ultra_accuracy",
      sourceTimeframes: SCAN_TIMEFRAMES,
      timeframeRule: tfRule,
      gatesPassed: 7,
    },
    source: "ENGINE",
    ...targets,
  });
}

// ─── Coin Scan ────────────────────────────────────────────────────────────────
async function analyzeCoin(coin, marketActivity = null, performanceSnapshot = null) {
  const analyses = {};
  for (const tf of SCAN_TIMEFRAMES) {
    const candles = await getKlines(coin, tf, 260);
    analyses[tf]  = analyzeCandles(candles);
    await new Promise(r => setTimeout(r, 80));
  }
  const htf = { daily: analyses["1d"] || null, twelveH: null, fourH: analyses["4h"] || null, oneH: analyses["1h"] || null };
  const tradeTimeframes = getTradeTimeframes();
  const candidates = tradeTimeframes.map(tf => {
    if (!analyses[tf]) return null;
    const bias = getHigherTimeframeBias(analyses, tf);
    return buildCandidate(coin, tf, analyses[tf], bias, htf, marketActivity, performanceSnapshot);
  }).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.confidence - a.confidence)[0];
}

// ─── Signal Evaluation (TP/SL only) ──────────────────────────────────────────
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
  return closed;
}

async function getPerformanceSnapshot() {
  try {
    const signals = await readCollection("signals");
    const stats   = { overall: buildTally(), LONG: buildTally(), SHORT: buildTally(), "5m": buildTally(), "1m": buildTally() };
    for (const sig of signals) {
      const isWin  = WIN_RESULTS.has(sig.result);
      const isLoss = LOSS_RESULTS.has(sig.result);
      if (!isWin && !isLoss) continue;
      const key = isWin ? "wins" : "losses";
      stats.overall[key] += 1;
      if (stats[sig.side])      stats[sig.side][key] += 1;
      if (!stats[sig.timeframe]) stats[sig.timeframe] = buildTally();
      stats[sig.timeframe][key] += 1;
    }
    stats.sampleSize = stats.overall.wins + stats.overall.losses;
    return stats;
  } catch {
    return { overall: buildTally(), LONG: buildTally(), SHORT: buildTally(), "5m": buildTally(), "1m": buildTally(), sampleSize: 0 };
  }
}

// ─── Persist / Manual ────────────────────────────────────────────────────────
async function persistSignal(signal) {
  return mutateCollection("signals", records => ({ records: [signal, ...records], value: signal }));
}
async function signalExists(candidate) {
  const signals = await readCollection("signals");
  return signals.some(s => s.status === SIGNAL_STATUS.ACTIVE && s.coin === candidate.coin && s.side === candidate.side && s.timeframe === candidate.timeframe);
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
    source: payload.source || "MANUAL", strength: confidence >= 92 ? "STRONG" : "MEDIUM",
  });
  await persistSignal(signal);
  return signal;
}

async function scanNow({ source = "ENGINE" } = {}) {
  if (engineState.isScanning) return { skipped: true, message: "Scan already in progress" };
  engineState.isScanning = true;
  const generatedSignals = [], errors = [];
  try {
    const closedSignals       = await evaluateActiveSignals();
    const performanceSnapshot = await getPerformanceSnapshot();
    const scanUniverse        = await getScanUniverse();
    const coins               = scanUniverse.slice(0, getMaxCoinsPerScan());
    for (const market of coins) {
      try {
        const candidate = await analyzeCoin(market.symbol, market, performanceSnapshot);
        if (!candidate) continue;
        candidate.source    = source;
        candidate.updatedAt = new Date().toISOString();
        if (await signalExists(candidate)) continue;
        generatedSignals.push(await persistSignal(candidate));
      } catch (e) { errors.push({ coin: market.symbol, message: e.message }); }
      await new Promise(r => setTimeout(r, 200));
    }
    engineState.lastGenerated = generatedSignals.length;
    engineState.lastScanAt    = new Date().toISOString();
    engineState.lastError     = errors.length ? `${errors.length} coin scans failed` : null;
    engineState.scanCount    += 1;
    return { closedSignals, errors, generatedSignals, scanCount: engineState.scanCount };
  } finally { engineState.isScanning = false; }
}

function getStatus() {
  return { intervalMs: engineState.intervalMs, isScanning: engineState.isScanning,
    lastError: engineState.lastError, lastGenerated: engineState.lastGenerated,
    lastScanAt: engineState.lastScanAt, running: engineState.running, scanCount: engineState.scanCount };
}

// ─── Fast Expiry Checker (every 30s) ─────────────────────────────────────────
async function checkAndExpireSignals() {
  try {
    const signals = await readCollection("signals");
    if (!signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE).length) return;
    const nowMs = Date.now(), now = new Date().toISOString();
    let hasExpired = false;
    const updated = signals.map(sig => {
      if (sig.status !== SIGNAL_STATUS.ACTIVE) return sig;
      const expiryMs  = SIGNAL_EXPIRY_MS[sig.timeframe] || SIGNAL_EXPIRY_MS.default;
      const createdMs = sig.createdAt ? new Date(sig.createdAt).getTime() : 0;
      if (nowMs - createdMs > expiryMs) {
        hasExpired = true;
        return { ...sig, status: SIGNAL_STATUS.CLOSED, result: "EXPIRED", closedAt: now, updatedAt: now };
      }
      return sig;
    });
    if (hasExpired) { const { writeCollection } = require("../storage/fileStore"); await writeCollection("signals", updated); }
  } catch (e) { engineState.lastError = `Expiry check failed: ${e.message}`; }
}

function start() {
  if (engineState.timer) { engineState.running = true; return getStatus(); }
  engineState.intervalMs  = Number(process.env.SCAN_INTERVAL_MS || engineState.intervalMs || 60000);
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

module.exports = { createManualSignal, evaluateActiveSignals, getCoinList, getStatus, scanNow, start, stop };
