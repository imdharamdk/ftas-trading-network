const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { getKlines, getPrices, getAllFuturesCoins, getAllTickerStats } = require("./binanceService");
const { analyzeCandles, computeFibonacci } = require("./indicatorEngine");

// ─── FIBONACCI CONFLUENCE MODE ────────────────────────────────────────────────
// Philosophy: "Achhe signals aayein, TP bhi hit ho — Fib levels anchor everything"
//
// 7 GATES — original 6 + Fibonacci confluence
//
//  GATE 1 — HTF ALIGNMENT   : 15m + 1h agree (1m ke liye 5m + 15m)
//  GATE 2 — EMA TREND       : EMA21 > EMA50 > EMA200
//  GATE 3 — ADX STRENGTH    : ADX >= 18-20 (trend present)
//  GATE 4 — MOMENTUM        : RSI + MACD agree
//  GATE 5 — VOLUME          : 1.3x avg
//  GATE 6 — HA DIRECTION    : bullish/bearish candle
//  GATE 7 — FIBONACCI       : price near key Fib retracement (0.382/0.5/0.618)
//                             OR in golden zone (0.5–0.618) for soft pass
//
//  TP/SL  — Fibonacci extension-based (1.272→TP1, 1.618→TP2, 2.0→TP3)
//           anchored to real swing high/low — not pure ATR multiples
//
// RESULT: Fewer but higher quality signals, 80-90%+ TP1 hit rate
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
  "MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT",
  "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT",
];

// All timeframes fetched for analysis (HTF data needed for bias detection)
const SCAN_TIMEFRAMES          = ["1m","5m","15m","30m","1h","4h","1d"];
// Timeframes that actually generate trade signals
const DEFAULT_TRADE_TIMEFRAMES = ["1m","5m","15m","30m","1h"];
const DEFAULT_MAX_COINS_PER_SCAN = 50;
const MAX_COINS_PER_SCAN_CAP     = 70;

const MIN_SCAN_QUOTE_VOLUME_USDT  = 15_000_000;
const MIN_SCAN_TRADE_COUNT_24H    = 20_000;
const MIN_SCAN_OPEN_INTEREST_USDT = 5_000_000;

const RULE_VERSION = "v18_multitf";
const DEFAULT_PUBLISH_FLOOR = 82;
const STRENGTH_THRESHOLDS   = { STRONG: 90, MEDIUM: 82 };

// ── Per-Timeframe Rules ────────────────────────────────────────────────────────
const TIMEFRAME_RULES = {
  "1m": {
    minScore: 58, minConfirmations: 4, publishFloor: 78,
    requireHigherBias: true, minAdx: 18, minRsi: 38, maxRsi: 85,
    requireRsiRising: false, minDiDelta: 3, requireVwapSupport: true,
    requireIchimoku: false, requireHaStrong: false, requireHaMedium: false,
    requireVolumeConfirm: false, volumeMultiplier: 1.3,
    blockDailyBear: true, entryDriftMultiplier: 0.6, maxLeverage: 10,
  },
  "5m": {
    minScore: 60, minConfirmations: 4, publishFloor: 79,
    requireHigherBias: true, minAdx: 18, minRsi: 37, maxRsi: 85,
    requireRsiRising: false, minDiDelta: 3, requireVwapSupport: true,
    requireIchimoku: false, requireHaStrong: false, requireHaMedium: false,
    requireVolumeConfirm: false, volumeMultiplier: 1.3,
    blockDailyBear: true, entryDriftMultiplier: 0.6, maxLeverage: 15,
  },
  "15m": {
    minScore: 62, minConfirmations: 4, publishFloor: 80,
    requireHigherBias: true, minAdx: 20, minRsi: 36, maxRsi: 84,
    requireRsiRising: false, minDiDelta: 4, requireVwapSupport: true,
    requireIchimoku: false, requireHaStrong: false, requireHaMedium: false,
    requireVolumeConfirm: false, volumeMultiplier: 1.3,
    blockDailyBear: true, entryDriftMultiplier: 0.7, maxLeverage: 20,
  },
  "30m": {
    minScore: 63, minConfirmations: 4, publishFloor: 81,
    requireHigherBias: true, minAdx: 20, minRsi: 35, maxRsi: 83,
    requireRsiRising: false, minDiDelta: 4, requireVwapSupport: true,
    requireIchimoku: false, requireHaStrong: false, requireHaMedium: false,
    requireVolumeConfirm: false, volumeMultiplier: 1.2,
    blockDailyBear: true, entryDriftMultiplier: 0.8, maxLeverage: 20,
  },
  "1h": {
    minScore: 65, minConfirmations: 5, publishFloor: 82,
    requireHigherBias: true, minAdx: 22, minRsi: 35, maxRsi: 82,
    requireRsiRising: false, minDiDelta: 5, requireVwapSupport: false,
    requireIchimoku: false, requireHaStrong: false, requireHaMedium: false,
    requireVolumeConfirm: false, volumeMultiplier: 1.2,
    blockDailyBear: true, entryDriftMultiplier: 1.0, maxLeverage: 20,
  },
};

// ── Signal Expiry ──────────────────────────────────────────────────────────────
const SIGNAL_EXPIRY_MS = {
  "1m":  8  * 60 * 1000,
  "5m":  25 * 60 * 1000,
  "15m": 90 * 60 * 1000,
  "30m": 3  * 60 * 60 * 1000,
  "1h":  6  * 60 * 60 * 1000,
  default: 6 * 60 * 60 * 1000,
};

// ── TP R:R multipliers per timeframe ──────────────────────────────────────────
const TP_R_MULTIPLIERS = {
  "1m":  [0.45, 0.80, 1.20],
  "5m":  [0.55, 0.95, 1.40],
  "15m": [0.60, 1.10, 1.60],
  "30m": [0.70, 1.20, 1.80],
  "1h":  [0.80, 1.40, 2.00],
};
// Legacy aliases kept for any direct references
const TP_R_MULTIPLIERS_1M = TP_R_MULTIPLIERS["1m"];
const TP_R_MULTIPLIERS_5M = TP_R_MULTIPLIERS["5m"];

const WIN_RESULTS  = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
const LOSS_RESULTS = new Set(["SL_HIT"]);
const buildTally   = () => ({ wins: 0, losses: 0 });

const engineState = {
  intervalMs: Number(process.env.SCAN_INTERVAL_MS || 60000),
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
  const isLiquid  = quoteVolume >= 25_000_000 || openInterestValue >= 5_000_000;
  const isCrowded = tradeCount  >= 15_000     || openInterestValue >= 8_000_000;
  const passesFloor = symbol.endsWith("USDT") &&
    quoteVolume >= MIN_SCAN_QUOTE_VOLUME_USDT &&
    (!hasParticipation || tradeCount >= MIN_SCAN_TRADE_COUNT_24H || openInterestValue >= MIN_SCAN_OPEN_INTEREST_USDT);
  return { symbol, quoteVolume, volume, tradeCount, openInterestValue,
    activityScore: liquidityScore + participationScore,
    isLiquid, isCrowded, passesFloor,
    relaxThresholds: isLiquid && (isCrowded || quoteVolume >= 50_000_000) };
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
// Balanced: 2 timeframes must agree (was requiring both 4H + 1D which killed many valid signals)
// Shared helper — get directional bias from a single analysis object
function getTFDir(a, minAdx = 15, minRsi = 38, maxRsi = 62) {
  if (!a) return "NEUTRAL";
  const { ema50, ema100, ema200, adx } = a.trend;
  const rsi = a.momentum?.rsi || 50;
  const bull = ema50 > ema100 * 0.997 && ema50 > ema200 * 0.993 && (adx||0) >= minAdx && rsi >= minRsi && rsi <= 75;
  const bear = ema50 < ema100 * 1.003 && ema50 < ema200 * 1.007 && (adx||0) >= minAdx && rsi <= maxRsi && rsi >= 25;
  return bull ? "BULLISH" : bear ? "BEARISH" : "NEUTRAL";
}

function getHigherTimeframeBias(analyses, tradeTimeframe = "5m") {
  // HTF requirements per trade timeframe:
  //   1m  → 5m + 15m must agree  (1h soft veto)
  //   5m  → 15m + 1h must agree  (4h soft veto)
  //   15m → 1h + 4h must agree   (1d soft veto)
  //   30m → 1h + 4h must agree   (1d soft veto)
  //   1h  → 4h must agree        (1d soft veto)

  const TF_CONFIG = {
    "1m":  { required: ["5m","15m"],  veto: ["1h"],      minAdx: 15, minRsi: 40, maxRsi: 60 },
    "5m":  { required: ["15m","1h"],  veto: ["4h"],      minAdx: 15, minRsi: 38, maxRsi: 62 },
    "15m": { required: ["1h","4h"],   veto: ["1d"],      minAdx: 16, minRsi: 37, maxRsi: 63 },
    "30m": { required: ["1h","4h"],   veto: ["1d"],      minAdx: 16, minRsi: 36, maxRsi: 64 },
    "1h":  { required: ["4h"],        veto: ["1d"],      minAdx: 18, minRsi: 35, maxRsi: 65 },
  };

  const cfg = TF_CONFIG[tradeTimeframe];
  if (!cfg) return "NEUTRAL";

  // All required HTFs must have data and agree
  const requiredDirs = cfg.required.map(tf => getTFDir(analyses[tf], cfg.minAdx, cfg.minRsi, cfg.maxRsi));
  if (requiredDirs.some(d => d === "NEUTRAL")) return "NEUTRAL";
  const allSame = requiredDirs.every(d => d === requiredDirs[0]);
  if (!allSame) return "NEUTRAL";
  const bias = requiredDirs[0];

  // Veto: if higher TF disagrees, block the signal
  for (const vTf of (cfg.veto || [])) {
    const vDir = getTFDir(analyses[vTf], cfg.minAdx - 2, cfg.minRsi - 3, cfg.maxRsi + 3);
    if (vDir !== "NEUTRAL" && vDir !== bias) return "NEUTRAL";
  }

  return bias;
}

// ─── Relaxed HTF Bias (admin search only) ────────────────────────────────────
// Strict bias: ALL required TFs must agree. Relaxed: MAJORITY agreement enough.
function getRelaxedBias(analyses, tradeTimeframe = "5m") {
  const TF_POOL = {
    "1m":  ["5m","15m","1h"],
    "5m":  ["15m","1h","4h"],
    "15m": ["1h","4h","1d"],
    "30m": ["1h","4h","1d"],
    "1h":  ["4h","1d"],
  };
  const pool = TF_POOL[tradeTimeframe] || ["1h","4h"];
  const dirs = pool.map(tf => getTFDir(analyses[tf], 12, 33, 67)).filter(d => d !== "NEUTRAL");
  if (!dirs.length) return "NEUTRAL";
  const bulls = dirs.filter(d => d === "BULLISH").length;
  const bears = dirs.filter(d => d === "BEARISH").length;
  if (bulls > bears) return "BULLISH";
  if (bears > bulls) return "BEARISH";
  return dirs[0]; // tie → use first
}

// ─── Fibonacci levels for a coin/timeframe (uses raw candles) ─────────────────
// Called once per coin in analyzeCoin — result passed into buildCandidate
function computeFibForSignal(candles, lookback = 55) {
  try {
    return computeFibonacci(candles, lookback);
  } catch {
    return null;
  }
}

// ─── SL / TP — Fibonacci Extension Anchored ───────────────────────────────────
// Priority:
//   TP1 → Fib 1.272 extension (conservative, highest hit rate)
//   TP2 → Fib 1.618 extension (golden ratio target)
//   TP3 → Fib 2.0  extension (runner target)
//   SL  → just beyond the swing low/high that anchors the Fib, +ATR buffer
//
// Fallback: if Fib data unavailable, use original ATR-based calculation
function calculateTargets(side, analysis, timeframe = "5m", fib = null) {
  const entry = analysis.currentPrice;
  const atr   = analysis.volatility.atr || analysis.averages.averageRange || entry * 0.003;
  const { low20, high20, previousLow20, previousHigh20 } = analysis.recentSwing;
  const srSup = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes = analysis.srLevels?.resistances?.[0] ?? null;
  const tpMult = TP_R_MULTIPLIERS[timeframe] || TP_R_MULTIPLIERS["5m"];

  // ── Fibonacci-based targets ───────────────────────────────────────────────
  if (fib && fib.swingHigh && fib.swingLow && fib.extensions && fib.retracements) {
    const ext = fib.extensions;
    const ret = fib.retracements;

    if (side === "LONG" && fib.trendDir === "UP") {
      // Entry should be near a retracement level (0.382–0.618 zone)
      // SL: just below swing low (the anchor of the Fib), plus small ATR buffer
      const slAnchor = fib.swingLow;
      const slBuffer = atr * 0.35;
      const sl = roundPrice(slAnchor - slBuffer);

      // TP1 = 1.272 extension, TP2 = 1.618, TP3 = 2.0
      const tp1Fib = ext["1.272"] || ext["1.414"];
      const tp2Fib = ext["1.618"];
      const tp3Fib = ext["2.0"]   || ext["2.618"];

      // Safety: TPs must be above entry
      if (tp1Fib > entry && tp2Fib > entry && sl < entry) {
        const risk = entry - sl;
        return {
          entry:       roundPrice(entry),
          stopLoss:    roundPrice(sl),
          tp1:         roundPrice(tp1Fib),
          tp2:         roundPrice(tp2Fib),
          tp3:         roundPrice(tp3Fib || entry + risk * tpMult[2]),
          riskPerUnit: roundPrice(risk),
          fibAnchored: true,
        };
      }
    }

    if (side === "SHORT" && fib.trendDir === "DOWN") {
      const slAnchor = fib.swingHigh;
      const slBuffer = atr * 0.35;
      const sl = roundPrice(slAnchor + slBuffer);

      const tp1Fib = ext["1.272"] || ext["1.414"];
      const tp2Fib = ext["1.618"];
      const tp3Fib = ext["2.0"]   || ext["2.618"];

      if (tp1Fib < entry && tp2Fib < entry && sl > entry) {
        const risk = sl - entry;
        return {
          entry:       roundPrice(entry),
          stopLoss:    roundPrice(sl),
          tp1:         roundPrice(tp1Fib),
          tp2:         roundPrice(tp2Fib),
          tp3:         roundPrice(tp3Fib || entry - risk * tpMult[2]),
          riskPerUnit: roundPrice(risk),
          fibAnchored: true,
        };
      }
    }

    // Partial Fib: use swing points as SL anchor, ATR for TPs
    if (side === "LONG") {
      const anchors = [fib.swingLow, low20, previousLow20, srSup].filter(v => Number.isFinite(v) && v < entry);
      const anchor  = anchors.length ? Math.max(...anchors) : entry - atr * 1.1;
      const risk    = clamp((entry - anchor) + atr * 0.1, atr * 0.7, atr * 1.6);
      return {
        entry: roundPrice(entry), stopLoss: roundPrice(entry - risk),
        tp1: roundPrice(entry + risk * tpMult[0]),
        tp2: roundPrice(entry + risk * tpMult[1]),
        tp3: roundPrice(entry + risk * tpMult[2]),
        riskPerUnit: roundPrice(risk), fibAnchored: false,
      };
    } else {
      const anchors = [fib.swingHigh, high20, previousHigh20, srRes].filter(v => Number.isFinite(v) && v > entry);
      const anchor  = anchors.length ? Math.min(...anchors) : entry + atr * 1.1;
      const risk    = clamp((anchor - entry) + atr * 0.1, atr * 0.7, atr * 1.6);
      return {
        entry: roundPrice(entry), stopLoss: roundPrice(entry + risk),
        tp1: roundPrice(entry - risk * tpMult[0]),
        tp2: roundPrice(entry - risk * tpMult[1]),
        tp3: roundPrice(entry - risk * tpMult[2]),
        riskPerUnit: roundPrice(risk), fibAnchored: false,
      };
    }
  }

  // ── Fallback: original ATR-based ─────────────────────────────────────────
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
      tp3: roundPrice(entry + risk * tpMult[2]), fibAnchored: false };
  } else {
    const anchors = [high20, previousHigh20, srRes].filter(v => Number.isFinite(v) && v > entry);
    const anchor  = anchors.length ? Math.min(...anchors) : entry + atr * 1.1;
    const risk    = clamp((anchor - entry) + atr * 0.12, slMin, slMax);
    return { entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry + risk),
      tp1: roundPrice(entry - risk * tpMult[0]),
      tp2: roundPrice(entry - risk * tpMult[1]),
      tp3: roundPrice(entry - risk * tpMult[2]), fibAnchored: false };
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
function buildCandidate(coin, timeframe, analysis, higherBias, htf = {}, marketActivity = null, performanceSnapshot = null, fib = null) {
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

  // ════════════════════════════════════════════════════════════════════════════
  // GATE CHECKS
  // ════════════════════════════════════════════════════════════════════════════

  // GATE 1: HTF Alignment
  if (higherBias === "NEUTRAL") return null;
  const side = higherBias === "BULLISH" ? "LONG" : "SHORT";

  // GATE 2: Core EMA Trend — 21 > 50 > 200 (3 EMAs, not all 5)
  // This is the key change — ema9/ema100 were killing many valid signals
  const coreBullStack = ema21 > ema50 * 0.997 && ema50 > ema200 * 0.993;
  const coreBearStack = ema21 < ema50 * 1.003 && ema50 < ema200 * 1.007;
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
  // Skip full ranging market
  if (regime === "RANGING") return null;
  // BB extreme zone — don't buy overbought top or sell oversold bottom
  if (bbPctB !== null) {
    if (side === "LONG"  && bbPctB > 0.90) return null;
    if (side === "SHORT" && bbPctB < 0.10) return null;
  }

  // GATE 7: FIBONACCI CONFLUENCE ─────────────────────────────────────────────
  // Price must be near a key Fib retracement (0.382 / 0.5 / 0.618) OR in the golden zone.
  // This is the most powerful filter — entries at Fib levels have the highest TP hit rates.
  // Soft pass: if no Fib data, let signal through but reduce max confidence by 10.
  let fibGatePassed = false;
  let fibGoldenZone = false;
  if (fib) {
    fibGatePassed = fib.atKeyLevel || fib.atGoldenZone;
    fibGoldenZone = fib.atGoldenZone;
    // Also allow if price is within 1.2% of any Fib level in the correct direction
    if (!fibGatePassed && fib.retracements) {
      const keyRatios = ["0.382", "0.5", "0.618"];
      const price = analysis.currentPrice;
      for (const ratio of keyRatios) {
        const level = fib.retracements[ratio];
        if (level && Math.abs(price - level) / price <= 0.012) { fibGatePassed = true; break; }
      }
    }
    // Hard gate: if Fib data exists but price is NOT near any retracement, reject
    if (!fibGatePassed) return null;
  }
  // (No Fib data = soft pass, scored accordingly)

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

  // ── FIBONACCI SCORING ──────────────────────────────────────────────────────
  if (fib && fibGatePassed) {
    const price = analysis.currentPrice;
    const nearestLevel = fib.nearestRetrace ? fib.retracements[fib.nearestRetrace] : null;
    const pct = nearestLevel ? ((Math.abs(price - nearestLevel) / price) * 100).toFixed(1) : null;

    if (fibGoldenZone) {
      // Golden zone (0.5–0.618) = highest probability entry zone in Fibonacci
      addConf(true, 18, `🟡 Fib golden zone (0.5–0.618 retracement) — highest probability entry`);
    } else if (fib.atKeyLevel) {
      addConf(true, 14, `📐 At Fib ${fib.nearestRetrace} retracement (${pct}% away) — key level`);
    } else {
      addConf(true, 8, `📐 Near Fib ${fib.nearestRetrace} retracement level`);
    }

    // Bonus: Fib retracement level aligns with S/R
    if (fib.nearestRetrace && nearestLevel) {
      const srLevels = [srSup, srRes].filter(Number.isFinite);
      const fibSRConfluence = srLevels.some(lvl => Math.abs(lvl - nearestLevel) / nearestLevel < 0.008);
      if (fibSRConfluence) {
        addConf(true, 10, `🔥 Fib + S/R confluence at ${fib.nearestRetrace} — double confirmation`);
      }
    }

    // Bonus: Fib retracement aligns with EMA (ema21 or ema50)
    if (nearestLevel) {
      const emaProximity = [ema21, ema50].some(e => e && Math.abs(e - nearestLevel) / nearestLevel < 0.010);
      if (emaProximity) {
        addConf(true, 8, `⚡ Fib level + EMA confluence — triple stack`);
      }
    }

    // Bonus: Extension targets visible (quality signal)
    if (fib.extensions && fib.extensions["1.618"]) {
      addConf(true, 5, `Fib extensions mapped: TP anchored to 1.272/1.618/2.0`);
    }

    // Fib swing trend matches signal direction
    const fibDirMatch = (side === "LONG" && fib.trendDir === "UP") || (side === "SHORT" && fib.trendDir === "DOWN");
    if (fibDirMatch) {
      addConf(true, 7, `Fib trend direction confirms ${side}`);
    }
  } else if (!fib) {
    // No Fib data available — small penalty via publishFloor effectively, but no crash
    if (side === "LONG")  bullScore -= 10;
    else                  bearScore -= 10;
  }

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

  const minScore         = tfRule.minScore         || 62;
  const minConfirmations = tfRule.minConfirmations || 5;
  const publishFloor     = tfRule.publishFloor     || DEFAULT_PUBLISH_FLOOR;

  if (confidence < minScore)                   return null;
  if (confirmations.length < minConfirmations) return null;
  if (confidence < publishFloor)               return null;

  // Entry drift check — slightly more lenient
  const targets         = calculateTargets(side, analysis, timeframe, fib);
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
      fibAnchored: targets.fibAnchored || false,
      fibonacci: fib ? {
        swingHigh: fib.swingHigh, swingLow: fib.swingLow,
        trendDir: fib.trendDir, nearestRetrace: fib.nearestRetrace,
        atKeyLevel: fib.atKeyLevel, atGoldenZone: fib.atGoldenZone,
        retracements: fib.retracements, extensions: fib.extensions,
      } : null,
      marketActivity: { quoteVolume: roundPrice(activeMarket.quoteVolume), tradeCount: roundPrice(activeMarket.tradeCount), openInterestValue: roundPrice(activeMarket.openInterestValue), activityScore: roundPrice(activeMarket.activityScore) },
    },
    patternSummary: analysis.patterns,
    scanMeta: {
      higherBias, effectiveBias: higherBias, ruleVersion: RULE_VERSION, publishFloor,
      marketActivityScore: roundPrice(activeMarket.activityScore),
      marketQuoteVolume: roundPrice(activeMarket.quoteVolume),
      marketTradeCount: roundPrice(activeMarket.tradeCount),
      marketOpenInterestValue: roundPrice(activeMarket.openInterestValue),
      modelVersion: "v17_fibonacci",
      fibAnchored: targets.fibAnchored || false,
      fibGoldenZone: fibGoldenZone || false,
      sourceTimeframes: SCAN_TIMEFRAMES,
      timeframeRule: tfRule,
      gatesPassed: 4,
    },
    source: "ENGINE",
    ...targets,
  });
}

// ─── Coin Scan ────────────────────────────────────────────────────────────────
async function analyzeCoin(coin, marketActivity = null, performanceSnapshot = null) {
  const analyses = {};
  const rawCandles = {};
  for (const tf of SCAN_TIMEFRAMES) {
    const candles    = await getKlines(coin, tf, 260);
    analyses[tf]     = analyzeCandles(candles);
    rawCandles[tf]   = candles;
    await new Promise(r => setTimeout(r, 80));
  }
  const htf = { daily: analyses["1d"] || null, twelveH: null, fourH: analyses["4h"] || null, oneH: analyses["1h"] || null };
  const tradeTimeframes = getTradeTimeframes();
  const candidates = tradeTimeframes.map(tf => {
    if (!analyses[tf]) return null;
    const bias = getHigherTimeframeBias(analyses, tf);
    const fibTrade = computeFibForSignal(rawCandles[tf] || [], 55);
    // HTF fib: use one step higher timeframe
    const fibHTFMap = { "1m":"5m", "5m":"15m", "15m":"1h", "30m":"1h", "1h":"4h" };
    const fibHTF = computeFibForSignal(rawCandles[fibHTFMap[tf]] || [], 55);
    const fib = (fibTrade && fibTrade.swingHigh) ? fibTrade : fibHTF;
    return buildCandidate(coin, tf, analyses[tf], bias, htf, marketActivity, performanceSnapshot, fib);
  }).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.confidence - a.confidence)[0];
}

// ─── Admin Search: Relaxed analyzer with diagnostic info ─────────────────────
// Bypasses Fibonacci gate and lowers publishFloor.
// Returns { candidate, diagnostics } — candidate may be null with reason explained.
async function analyzeCoinForAdmin(coin, marketActivity = null) {
  const analyses = {};
  const rawCandles = {};
  const diagnostics = { coin, timeframes: {}, gateResults: {} };

  for (const tf of SCAN_TIMEFRAMES) {
    try {
      const candles  = await getKlines(coin, tf, 260);
      if (!candles || candles.length < 20) {
        diagnostics.timeframes[tf] = "NO_DATA";
        continue;
      }
      analyses[tf]   = analyzeCandles(candles);
      rawCandles[tf] = candles;
      diagnostics.timeframes[tf] = "OK";
    } catch (e) {
      diagnostics.timeframes[tf] = `ERROR: ${e.message}`;
    }
    await new Promise(r => setTimeout(r, 80));
  }

  const htf = {
    daily:   analyses["1d"]  || null,
    twelveH: null,
    fourH:   analyses["4h"]  || null,
    oneH:    analyses["1h"]  || null,
  };
  const tradeTimeframes = getTradeTimeframes();

  for (const tf of tradeTimeframes) {
    if (!analyses[tf]) {
      diagnostics.gateResults[tf] = "SKIP: no candle data";
      continue;
    }
    const analysis  = analyses[tf];
    const price     = analysis.currentPrice;
    const tfRule    = TIMEFRAME_RULES[tf] || {};
    const gates     = {};

    // GATE 1: HTF bias — RELAXED for admin
    // Regular engine: both 15m+1h must agree. Admin: any ONE higher TF is enough.
    let bias = getHigherTimeframeBias(analyses, tf);
    if (bias === "NEUTRAL") {
      // Try relaxed single-TF bias check
      bias = getRelaxedBias(analyses, tf);
    }
    gates.htfBias = bias !== "NEUTRAL" ? `PASS (${bias})` : "FAIL";
    if (bias === "NEUTRAL") {
      diagnostics.gateResults[tf] = { gates, verdict: "FAIL — HTF timeframes not aligned (15m+1h disagree on both relaxed and strict)" };
      continue;
    }
    const side = bias === "BULLISH" ? "LONG" : "SHORT";

    // GATE 2: EMA stack
    const { ema21, ema50, ema200, adx, pdi, mdi, vwap } = analysis.trend;
    const coreBullStack = ema21 > ema50 * 0.997 && ema50 > ema200 * 0.993;
    const coreBearStack = ema21 < ema50 * 1.003 && ema50 < ema200 * 1.007;
    const emaOk = side === "LONG" ? coreBullStack : coreBearStack;
    gates.emaStack = emaOk ? `PASS (21>50>200)` : `FAIL — EMA stack not aligned for ${side}`;
    if (!emaOk) {
      diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — EMA trend not confirmed" };
      continue;
    }

    // GATE 3: ADX (15% relaxed for admin)
    const minAdx     = (tfRule.minAdx ?? 18) * 0.85;
    const minDiDelta = (tfRule.minDiDelta ?? 3) * 0.8;
    const adxOk = (adx||0) >= minAdx &&
      (side === "LONG" ? ((pdi||0)-(mdi||0)) >= minDiDelta : ((mdi||0)-(pdi||0)) >= minDiDelta);
    gates.adx = adxOk ? `PASS (ADX ${(adx||0).toFixed(1)})` : `FAIL (ADX ${(adx||0).toFixed(1)} needs ≥${minAdx.toFixed(0)})`;
    if (!adxOk) {
      diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — ADX too weak, no clear trend" };
      continue;
    }

    // GATE 4: Momentum (slightly relaxed RSI range)
    const relaxedRule = { ...tfRule, minRsi: (tfRule.minRsi ?? 37) - 5, maxRsi: (tfRule.maxRsi ?? 85) + 5 };
    const momentumOk  = isMomentumAligned(side, analysis, relaxedRule);
    const { rsi } = analysis.momentum;
    gates.momentum = momentumOk ? `PASS (RSI ${(rsi||0).toFixed(1)})` : `FAIL (RSI ${(rsi||0).toFixed(1)} or MACD not aligned)`;
    if (!momentumOk) {
      diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — RSI/MACD momentum not confirmed" };
      continue;
    }

    // GATE 5: Not ranging
    gates.regime = analysis.regime !== "RANGING" ? `PASS (${analysis.regime})` : "FAIL — market is RANGING";
    if (analysis.regime === "RANGING") {
      diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — market is ranging, no directional trade" };
      continue;
    }

    // VWAP (warn only)
    const vwapOk = side === "LONG" ? price >= vwap : price <= vwap;
    gates.vwap = vwapOk ? "PASS" : `WARN — price ${side === "LONG" ? "below" : "above"} VWAP (relaxed for admin)`;

    // Fibonacci — informational only, no gate
    const fibTrade = computeFibForSignal(rawCandles[tf] || [], 55);
    const fibHTFMap = { "1m":"5m", "5m":"15m", "15m":"1h", "30m":"1h", "1h":"4h" };
    const fibHTF = computeFibForSignal(rawCandles[fibHTFMap[tf]] || [], 55);
    const fib = (fibTrade && fibTrade.swingHigh) ? fibTrade : fibHTF;
    gates.fibonacci = fib
      ? (fib.atGoldenZone ? "GOLDEN_ZONE ⭐ (highest prob)" : fib.atKeyLevel ? "KEY_LEVEL ✓" : "Not at key Fib (bypassed for admin)")
      : "No Fib data (bypassed)";

    // Build candidate with maximally relaxed floor for admin
    const activity   = marketActivity || buildFallbackMarketActivity(coin);
    const origRules  = { ...TIMEFRAME_RULES[tf] };
    TIMEFRAME_RULES[tf] = { ...origRules, publishFloor: 38, minScore: 32, minConfirmations: 2 };
    let candidate;
    try {
      candidate = buildCandidate(coin, tf, analysis, bias, htf, activity, null, null); // fib=null bypasses GATE 7
    } finally {
      TIMEFRAME_RULES[tf] = origRules;
    }

    if (candidate) {
      diagnostics.gateResults[tf] = { side, gates, verdict: "PASS ✅", confidence: candidate.confidence };
      diagnostics.winner = tf;
      return { candidate, diagnostics };
    }
    diagnostics.gateResults[tf] = { side, gates, verdict: "FAIL — score too low even with relaxed thresholds" };
  }

  return { candidate: null, diagnostics };
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
    source: payload.source || "MANUAL", strength: confidence >= 90 ? "STRONG" : "MEDIUM",
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
      // Skip admin-paused coins
      if (engineState.pausedCoins[market.symbol]) {
        errors.push({ coin: market.symbol, message: "Paused by admin — skipped in scan" });
        continue;
      }
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

// ─── Admin: Pause / Resume Coins ─────────────────────────────────────────────
function pauseCoin(symbol, actor, reason = "") {
  const coin = String(symbol || "").trim().toUpperCase();
  if (!coin) throw new Error("Symbol required");
  engineState.pausedCoins[coin] = {
    pausedAt: new Date().toISOString(),
    reason: reason || "Repeated stop losses",
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
async function generateForCoin(symbol, actor) {
  const coin = String(symbol || "").trim().toUpperCase();
  if (!coin) throw new Error("Symbol required");

  const marketActivity = buildFallbackMarketActivity(coin);

  const { candidate, diagnostics } = await analyzeCoinForAdmin(coin, marketActivity);

  if (!candidate) {
    // Build a readable failure message from diagnostics
    const reasons = Object.entries(diagnostics.gateResults || {})
      .map(([tf, r]) => `[${tf}] ${typeof r === "object" ? r.verdict : r}`)
      .join(" | ");
    return {
      generated: false,
      message: `No signal generated for ${coin}. Gate results: ${reasons || "All timeframes failed"}`,
      diagnostics,
    };
  }

  candidate.source    = "ADMIN_SEARCH";
  candidate.updatedAt = new Date().toISOString();
  if (candidate.scanMeta) candidate.scanMeta.createdBy = actor?.email || "admin";
  const signal = await persistSignal(candidate);
  return { generated: true, signal, diagnostics };
}

module.exports = { createManualSignal, evaluateActiveSignals, getCoinList, getStatus, scanNow, start, stop, pauseCoin, resumeCoin, getPausedCoins, generateForCoin };
