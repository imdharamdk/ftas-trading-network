const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { analyzeCandles } = require("./indicatorEngine");
const { ensureSession, getCandles: smartGetCandles } = require("./smartApiService");
const { getInstrumentUniverse } = require("./smartInstrumentService");

function ws()   { try { return require("./wsServer");              } catch { return null; } }
function sse()  { try { return require("./sseManager");            } catch { return null; } }
function fb()   { try { return require("./facebookPublisher");     } catch { return null; } }
function push() { try { return require("../routes/notifications"); } catch { return null; } }
function tg()   { try { return require("../routes/telegram");      } catch { return null; } }

// ─── STOCK COLLECTION NAME ────────────────────────────────────────────────────
const STOCK_COLLECTION = "stockSignals";

// ─── BALANCED ACCURACY MODE ───────────────────────────────────────────────────
// Philosophy: "Achhe signals aayein, TP bhi hit ho — balance between frequency & accuracy"
//
// 6 GATES — smart combination, not brute force strict
//
//  GATE 1 — HTF ALIGNMENT   : 15m + 1h agree (1m ke liye 5m + 15m)
//  GATE 2 — EMA TREND       : EMA21 > EMA50 > EMA200 (3 EMA sufficient, not all 5)
//  GATE 3 — ADX STRENGTH    : ADX >= 20 (trend present, not necessarily explosive)
//  GATE 4 — MOMENTUM        : RSI + MACD agree (StochRSI optional bonus)
//  GATE 5 — VOLUME          : 1.4x avg (smart money, not waiting for 2x spike)
//  GATE 6 — HA DIRECTION    : Last 2 HA candles same direction (not 3)
//
// RESULT: ~8-15 signals per day, ~70-75% TP1 hit rate
// ─────────────────────────────────────────────────────────────────────────────

// Stock engine scans Angel One instruments — NOT crypto coins
// FALLBACK_STOCKS is used only if instrument universe fails to load
const FALLBACK_STOCKS = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK",
  "HINDUNILVR","SBIN","BAJFINANCE","KOTAKBANK","LT",
  "AXISBANK","ASIANPAINT","MARUTI","TITAN","SUNPHARMA",
];

const SCAN_TIMEFRAMES          = ["15m","1h","4h","1d"];
const DEFAULT_TRADE_TIMEFRAMES = ["15m","1h"];
const DEFAULT_MAX_COINS_PER_SCAN = 50;
const MAX_COINS_PER_SCAN_CAP     = 70;

const MIN_SCAN_QUOTE_VOLUME_USDT  = 15_000_000;   // was 25M — include more liquid coins
const MIN_SCAN_TRADE_COUNT_24H    = 20_000;        // was 30K
const MIN_SCAN_OPEN_INTEREST_USDT = 5_000_000;    // was 8M

const RULE_VERSION = "v17_stocks_working";
const DEFAULT_PUBLISH_FLOOR = 76;
const STRENGTH_THRESHOLDS   = { STRONG: 88, MEDIUM: 76 };

// ── NSE Market Hours Guard ─────────────────────────────────────────────────────
// Only scan during NSE trading hours: Mon-Fri 9:15 AM – 3:30 PM IST
function isNseMarketOpen() {
  const now = new Date();
  const ist  = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day  = ist.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false; // weekend

  const hh   = ist.getHours();
  const mm   = ist.getMinutes();
  const mins = hh * 60 + mm;

  const OPEN  = 9  * 60 + 15;  // 9:15 AM
  const CLOSE = 15 * 60 + 30;  // 3:30 PM
  return mins >= OPEN && mins < CLOSE;
}

// ── Per-Timeframe Rules ────────────────────────────────────────────────────────
const TIMEFRAME_RULES = {
  "15m": {
    minScore:            52,   // relaxed from 55
    minConfirmations:    3,
    publishFloor:        73,   // relaxed from 76 — more signals
    minAdx:              12,   // relaxed from 14
    minDiDelta:          2,
    requireVwapSupport:  false,
    blockDailyBear:      false,
    entryDriftMultiplier: 0.8,
    maxLeverage:         10,
  },
  "1h": {
    minScore:            49,   // relaxed from 52
    minConfirmations:    3,
    publishFloor:        71,   // relaxed from 74
    minAdx:              12,   // relaxed from 14
    minDiDelta:          2,
    requireVwapSupport:  false,
    blockDailyBear:      false,
    entryDriftMultiplier: 1.2,
    maxLeverage:         10,
  },
};

// ── Signal Expiry ──────────────────────────────────────────────────────────────
const SIGNAL_EXPIRY_MS = {
  "1m":  8  * 60 * 1000,   // was 5 min — slight more time to hit TP
  "5m":  25 * 60 * 1000,   // was 15 min
  default: 25 * 60 * 1000,
};

// ── TP targets — realistic R:R for scalps ─────────────────────────────────────
// TP1 closer = higher hit rate, TP2/TP3 for runners
const TP_R_MULTIPLIERS_1M = [0.45, 0.8, 1.2];   // was [0.5, 0.85, 1.3]
const TP_R_MULTIPLIERS_5M = [0.55, 0.95, 1.4];  // was [0.6, 1.0, 1.5]

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
  return clamp(Number(process.env.STOCK_SCAN_MAX_COINS || DEFAULT_MAX_COINS_PER_SCAN), 5, MAX_COINS_PER_SCAN_CAP);
}

// ─── Stock Scan Universe — Angel One instruments only ─────────────────────────
// Returns an array of { symbol } objects from the SmartAPI instrument universe.
// Falls back to FALLBACK_STOCKS if instrument list is empty.
function getScanUniverse() {
  try {
    const instruments = getInstrumentUniverse({ limit: MAX_COINS_PER_SCAN_CAP });
    if (instruments.length) {
      return instruments.map(inst => ({
        symbol: (inst.tradingSymbol || inst.symbol || "").toUpperCase(),
        exchange: inst.exchange,
        token: inst.token,
        instrumentType: inst.instrumentType,
        // satisfy buildMarketActivitySnapshot shape (not used for stocks but prevents crashes)
        quoteVolume: 0, volume: 0, tradeCount: 0, openInterestValue: 0,
        activityScore: 0, isLiquid: false, isCrowded: false,
        passesFloor: true, relaxThresholds: false,
      })).filter(m => m.symbol);
    }
  } catch (e) {
    console.error("[stockEngine/getScanUniverse] Instrument load failed:", e.message);
  }
  // Fallback: use hardcoded NSE equity list
  return FALLBACK_STOCKS.map(sym => ({
    symbol: sym, exchange: "NSE", token: null, instrumentType: "EQ",
    quoteVolume: 0, volume: 0, tradeCount: 0, openInterestValue: 0,
    activityScore: 0, isLiquid: false, isCrowded: false,
    passesFloor: true, relaxThresholds: false,
  }));
}
function getCoinList() { return getScanUniverse().map(m => m.symbol); }
function getTradeTimeframes() {
  const r = String(process.env.TRADE_TIMEFRAMES || "").split(",").map(s => s.trim()).filter(Boolean);
  return r.length ? r : DEFAULT_TRADE_TIMEFRAMES;
}

// ─── GATE 1: HTF Bias ─────────────────────────────────────────────────────────
// Stocks: 1h EMA direction is primary anchor.
// 4H as soft confirmation. 1D as veto only if strongly opposite.
// Much more relaxed than crypto — Indian stocks trend at 1h level.
function getHigherTimeframeBias(analyses, tradeTimeframe = "15m") {
  const a1h = analyses["1h"];
  const a4h = analyses["4h"];
  const a1d = analyses["1d"];

  // Primary: 1H EMA direction
  const primary = a1h || a4h;
  if (!primary) return "NEUTRAL";

  const { ema50, ema100, adx } = primary.trend;
  const rsi = primary.momentum?.rsi || 50;

  // Relaxed thresholds for stocks — ADX 14+ is enough, RSI 35-65 range
  const bull = ema50 > ema100 * 0.996 && (adx||0) >= 14 && rsi >= 35 && rsi <= 75;
  const bear = ema50 < ema100 * 1.004 && (adx||0) >= 14 && rsi <= 65 && rsi >= 25;

  if (!bull && !bear) return "NEUTRAL";

  // 1D soft veto — only block if strongly opposite (ADX 20+)
  if (a1d) {
    const dAdx = a1d.trend.adx || 0;
    const dBull = a1d.trend.ema50 > a1d.trend.ema100 && dAdx >= 20;
    const dBear = a1d.trend.ema50 < a1d.trend.ema100 && dAdx >= 20;
    if (bull && dBear) return "NEUTRAL";
    if (bear && dBull) return "NEUTRAL";
  }

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
  const smcBOS       = smc.bos        || { bull: false, bear: false, level: null };
  const smcCHoCH     = smc.choch      || { bull: false, bear: false, level: null };
  const smcIDM       = smc.idm        || { bull: false, bear: false, sweepLevel: null, rejectionStrength: 0 };
  const smcStructure = smc.structure  || { trend: "NEUTRAL" };
  const bosBull   = smcBOS.bull;
  const bosBear   = smcBOS.bear;
  const chochBull = smcCHoCH.bull;
  const chochBear = smcCHoCH.bear;
  const idmBull   = smcIDM.bull;
  const idmBear   = smcIDM.bear;

  // ════════════════════════════════════════════════════════════════════════════
  // GATE CHECKS
  // ════════════════════════════════════════════════════════════════════════════

  // GATE 1: HTF Alignment
  if (higherBias === "NEUTRAL") return null;
  const side = higherBias === "BULLISH" ? "LONG" : "SHORT";

  // ── SMC HARD GATE: BOS or CHoCH required ─────────────────────────────────
  const smcBullGate = bosBull || chochBull;
  const smcBearGate = bosBear || chochBear;
  if (side === "LONG"  && !smcBullGate) return null;
  if (side === "SHORT" && !smcBearGate) return null;

  // GATE 2: Core EMA Trend — ema50 > ema100 required; ema200 alignment is bonus not gate
  // Indian stocks have slower EMA convergence — requiring ema100>ema200 blocks too many valid setups
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
  // REMOVED: regime === "RANGING" block — Indian stocks are often range-bound
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
  if (bosBull && side === "LONG")  addConf(true, 8,  "BOS 📈 structure break up");
  if (bosBear && side === "SHORT") addConf(true, 8,  "BOS 📉 structure break down");
  if (chochBull && side === "LONG")  addConf(true, 12, "CHoCH 🔄 bearish→bullish shift");
  if (chochBear && side === "SHORT") addConf(true, 12, "CHoCH 🔄 bullish→bearish shift");
  if (idmBull && side === "LONG")  { const s = Math.round(smcIDM.rejectionStrength); addConf(true, 6, "IDM 🎯 liquidity grab + rejection (" + s + "/10)"); }
  if (idmBear && side === "SHORT") { const s = Math.round(smcIDM.rejectionStrength); addConf(true, 6, "IDM 🎯 liquidity grab + rejection (" + s + "/10)"); }
  if ((bosBull||chochBull) && idmBull && side === "LONG")  addConf(true, 6, "SMC full confluence");
  if ((bosBear||chochBear) && idmBear && side === "SHORT") addConf(true, 6, "SMC full confluence");

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
      modelVersion: "v16_working",
      smc: {
        bos:       { bull: bosBull,   bear: bosBear,   level: smcBOS.level   },
        choch:     { bull: chochBull, bear: chochBear, level: smcCHoCH.level },
        idm:       { bull: idmBull,   bear: idmBear,   sweepLevel: smcIDM.sweepLevel, rejectionStrength: smcIDM.rejectionStrength },
        structure: smcStructure.trend,
      },
      sourceTimeframes: SCAN_TIMEFRAMES,
      timeframeRule: tfRule,
      gatesPassed: 4,
    },
    source: "SMART_ENGINE",  // FIX: was "ENGINE" — facebookPublisher checks this to detect stock vs crypto
    ...targets,
  });
}

// ─── Angel One candle fetch (timeframe mapping) ───────────────────────────────
const SMART_INTERVAL_MAP = {
  "1m": "ONE_MINUTE", "3m": "THREE_MINUTE", "5m": "FIVE_MINUTE",
  "10m": "TEN_MINUTE", "15m": "FIFTEEN_MINUTE", "30m": "THIRTY_MINUTE",
  "1h": "ONE_HOUR", "4h": "FOUR_HOUR", "1d": "ONE_DAY",
};
const TF_LOOKBACK_DAYS = { "1m": 1, "5m": 3, "15m": 7, "1h": 30, "4h": 60, "1d": 365 };

async function fetchStockCandles(symbol, tf, exchange, token) {
  const smartInterval = SMART_INTERVAL_MAP[tf] || "FIFTEEN_MINUTE";
  const lookbackDays  = TF_LOOKBACK_DAYS[tf] || 14;
  const to   = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  try {
    await ensureSession(); // Ensure Angel One session is live before fetching
    const raw = await smartGetCandles({ exchange: exchange || "NSE", symbolToken: String(token), interval: smartInterval, from, to });
    // Angel One format: [[timestamp, open, high, low, close, volume], ...]
    return raw.map(row => ({
      openTime: new Date(row[0]).getTime(),
      open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]),  close: Number(row[4]),
      volume: Number(row[5] || 0),
    })).filter(c => Number.isFinite(c.open) && c.open > 0);
  } catch (e) {
    console.error(`[stockEngine/fetchStockCandles] ${symbol} ${tf}:`, e.message);
    return [];
  }
}

// ─── Coin Scan ────────────────────────────────────────────────────────────────
async function analyzeCoin(coin, marketActivity = null, performanceSnapshot = null) {
  // Resolve exchange + token from instrument universe
  const universe = getInstrumentUniverse({ limit: 5000 });
  const inst = universe.find(i => (i.tradingSymbol || i.symbol || "").toUpperCase() === coin);
  const exchange = marketActivity?.exchange || inst?.exchange || "NSE";
  const token    = marketActivity?.token    || inst?.token    || null;

  if (!token) {
    console.warn(`[stockEngine/analyzeCoin] No token found for ${coin} — skipping`);
    return null;
  }

  const analyses = {};
  for (const tf of SCAN_TIMEFRAMES) {
    const candles = await fetchStockCandles(coin, tf, exchange, token);
    if (candles.length >= 20) analyses[tf] = analyzeCandles(candles);
    await new Promise(r => setTimeout(r, 150)); // Angel One rate limit buffer
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

// ─── Angel One batch price fetch for stock signals ────────────────────────────
async function fetchStockPrices(coins) {
  if (!coins.length) return {};
  try {
    const universe = getInstrumentUniverse();
    const tokenMap = {};
    for (const inst of universe) {
      const key = (inst.symbol || inst.tradingSymbol || "").toUpperCase();
      if (key) tokenMap[key] = { exchange: inst.exchange, token: String(inst.token) };
    }
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
    const axios  = require("axios");
    const token  = await ensureSession();
    const baseUrl = process.env.SMART_API_BASE_URL || "https://apiconnect.angelone.in";
    const resp   = await axios.post(
      `${baseUrl}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: "LTP", exchangeTokens: byExchange },
      {
        headers: {
          "Content-Type": "application/json", Accept: "application/json",
          "X-PrivateKey": process.env.SMART_API_KEY,
          "X-UserType": "USER", "X-SourceID": "WEB",
          Authorization: `Bearer ${token}`,
        },
        timeout: 8000,
      }
    );
    const priceMap = {};
    for (const item of resp.data?.data?.fetched || []) {
      const coinName = tokenToCoin[String(item.symbolToken)];
      const price = Number(item.ltp) || Number(item.close);
      if (coinName && Number.isFinite(price) && price > 0) priceMap[coinName] = price;
    }
    return priceMap;
  } catch (e) {
    console.error("[stockEngine/fetchStockPrices] Error:", e.message);
    return {};
  }
}

// ─── Signal Evaluation (TP/SL only) ──────────────────────────────────────────
async function evaluateActiveSignals() {
  const signals = await readCollection(STOCK_COLLECTION);
  const active  = signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE);
  if (!active.length) return [];
  const prices = await fetchStockPrices([...new Set(active.map(s => s.coin))]);
  const now    = new Date().toISOString();
  const closed = [];
  await mutateCollection(STOCK_COLLECTION, records => records.map(sig => {
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
    try { fb()?.publishSignalResult(s);          } catch {}  // post result to Facebook
  });
  return closed;
}

async function getPerformanceSnapshot() {
  try {
    const signals = await readCollection(STOCK_COLLECTION);
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
  const result = await mutateCollection(STOCK_COLLECTION, records => ({ records: [signal, ...records], value: signal }));
  try { ws()?.broadcastNewStockSignal(signal);   } catch {}
  try { sse()?.broadcastNewSignal(signal, true); } catch {}
  try { fb()?.publishSignal(signal);             } catch {}
  try { push()?.broadcastSignalPush(signal);     } catch {}
  try { tg()?.autoSendSignal(signal);            } catch {}
  return result;
}
async function signalExists(candidate) {
  const signals = await readCollection(STOCK_COLLECTION);
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
    source: payload.source || "SMART_MANUAL", strength: confidence >= 90 ? "STRONG" : "MEDIUM",
  });
  await persistSignal(signal);
  return signal;
}

async function scanNow({ source = "ENGINE" } = {}) {
  if (engineState.isScanning) return { skipped: true, message: "Scan already in progress" };

  // ── NSE Market Hours Guard ────────────────────────────────────────────────
  // Skip scan outside 9:15 AM – 3:30 PM IST, Mon-Fri
  // Admin-triggered scans (source="ADMIN") bypass this check
  if (source === "ENGINE" && !isNseMarketOpen()) {
    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    console.log(`[stockEngine] Market closed at ${ist} IST — skipping scan`);
    return { skipped: true, message: `NSE market closed (${ist} IST)` };
  }
  engineState.isScanning = true;
  const generatedSignals = [], errors = [];
  try {
    const closedSignals       = await evaluateActiveSignals();
    const performanceSnapshot = await getPerformanceSnapshot();
    const scanUniverse        = getScanUniverse();
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
    const signals = await readCollection(STOCK_COLLECTION);
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
    if (hasExpired) { const { writeCollection } = require("../storage/fileStore"); await writeCollection(STOCK_COLLECTION, updated); }
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

  // Build minimal market activity so analyzeCoin doesn't crash
  const marketActivity = buildFallbackMarketActivity(coin);
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
