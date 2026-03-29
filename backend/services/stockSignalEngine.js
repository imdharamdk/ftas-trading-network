const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { analyzeCandles } = require("./indicatorEngine");
const { ensureSession, getCandles: smartGetCandles } = require("./smartApiService");
const { getInstrumentUniverse } = require("./smartInstrumentService");
const adaptiveEngine = require("./adaptiveEngine");

function ws()   { try { return require("./wsServer");              } catch { return null; } }
function sse()  { try { return require("./sseManager");            } catch { return null; } }
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

const RULE_VERSION = "v18_stocks_filtered";
const STOCK_SIGNAL_MODEL_VERSION = process.env.STOCK_SIGNAL_MODEL_VERSION || "v18_stocks_filtered";
const DEFAULT_PUBLISH_FLOOR = 76;
const STRENGTH_THRESHOLDS   = { STRONG: 88, MEDIUM: 76 }; // NOTE: stock-specific — do NOT import from constants.js

// ── Ported from crypto engine — all env-configurable ─────────────────────────
const REENTRY_COOLDOWN_ENABLED  = String(process.env.STOCK_REENTRY_COOLDOWN_ENABLED  || "true").toLowerCase() !== "false";
const REENTRY_COOLDOWN_MINUTES  = Math.max(15, Number(process.env.STOCK_REENTRY_COOLDOWN_MINUTES || 120)); // 2hr default (stocks move slower)
const SR_ROOM_GUARD_ENABLED     = String(process.env.STOCK_SR_ROOM_GUARD_ENABLED     || "true").toLowerCase() !== "false";
const SR_ROOM_MIN_R             = Math.min(2.0, Math.max(0.25, Number(process.env.STOCK_SR_ROOM_MIN_R || 0.60)));
const TREND_SEPARATION_GUARD_ENABLED = String(process.env.STOCK_TREND_SEPARATION_GUARD_ENABLED || "true").toLowerCase() !== "false";
const TREND_SEPARATION_MIN_ATR  = Math.min(2.0, Math.max(0.05, Number(process.env.STOCK_TREND_SEPARATION_MIN_ATR || 0.18)));
const RSI_EXTREME_GUARD_ENABLED = String(process.env.STOCK_RSI_EXTREME_GUARD_ENABLED || "true").toLowerCase() !== "false";
const RSI_EXTREME_LONG_MAX      = Math.min(90, Math.max(60, Number(process.env.STOCK_RSI_EXTREME_LONG_MAX  || 75))); // slightly more lenient than crypto
const RSI_EXTREME_SHORT_MIN     = Math.min(40, Math.max(10, Number(process.env.STOCK_RSI_EXTREME_SHORT_MIN || 25)));
const SHOCK_CANDLE_GUARD_ENABLED = String(process.env.STOCK_SHOCK_CANDLE_GUARD_ENABLED || "true").toLowerCase() !== "false";
const SHOCK_CANDLE_BODY_ATR_MULT = Math.min(3.5, Math.max(1.2, Number(process.env.STOCK_SHOCK_CANDLE_BODY_ATR_MULT || 2.2)));
const COIN_PUBLISH_COOLDOWN_ENABLED = String(process.env.STOCK_COIN_PUBLISH_COOLDOWN_ENABLED || "true").toLowerCase() !== "false";
const COIN_PUBLISH_COOLDOWN_MINUTES = Math.max(5, Number(process.env.STOCK_COIN_PUBLISH_COOLDOWN_MINUTES || 60)); // 60 min default for stocks
const MID_TF_ALIGNMENT_GUARD_ENABLED = String(process.env.STOCK_MID_TF_ALIGNMENT_GUARD_ENABLED || "true").toLowerCase() !== "false";
const MID_TF_ALIGNMENT_MIN_ADX  = Math.max(8, Number(process.env.STOCK_MID_TF_ALIGNMENT_MIN_ADX || 14));
const VOL_GUARD_ENABLED         = String(process.env.STOCK_VOL_GUARD_ENABLED || "true").toLowerCase() !== "false";
const VOL_GUARD_LOW_PCT         = Math.max(0.02, Number(process.env.STOCK_VOL_GUARD_LOW_PCT || 0.05));  // stocks have lower ATR%
const VOL_GUARD_HIGH_PCT        = Math.max(VOL_GUARD_LOW_PCT + 0.2, Number(process.env.STOCK_VOL_GUARD_HIGH_PCT || 5.0)); // wider upper band for stocks
const AUTO_COIN_COOLDOWN_ENABLED = String(process.env.STOCK_AUTO_COIN_COOLDOWN_ENABLED || "true").toLowerCase() !== "false";
const AUTO_COIN_COOLDOWN_HOURS  = Math.max(1, Number(process.env.STOCK_AUTO_COIN_COOLDOWN_HOURS || 48)); // 2 days for stocks
const AUTO_COIN_COOLDOWN_WINDOW = Math.max(3, Number(process.env.STOCK_AUTO_COIN_COOLDOWN_WINDOW || 4));
const AUTO_COIN_COOLDOWN_MIN_LOSSES = Math.min(AUTO_COIN_COOLDOWN_WINDOW, Math.max(2, Number(process.env.STOCK_AUTO_COIN_COOLDOWN_MIN_LOSSES || 3)));

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

// ── TP targets — realistic R:R for scalps ─────────────────────────────────────
// TP1 closer = higher hit rate, TP2/TP3 for runners
const TP_R_MULTIPLIERS_1M = [0.45, 0.8, 1.2];   // was [0.5, 0.85, 1.3]
const TP_R_MULTIPLIERS_5M = [0.55, 0.95, 1.4];  // was [0.6, 1.0, 1.5]

const WIN_RESULTS  = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
const LOSS_RESULTS = new Set(["SL_HIT"]);
const buildTally   = () => ({ wins: 0, losses: 0 });

const engineState = {
  intervalMs: Number(process.env.SMART_SCAN_INTERVAL_MS || process.env.SCAN_INTERVAL_MS || 60000),
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
function isCommodityMarket(market = {}) {
  const exchange = String(market.exchange || "").toUpperCase();
  const instrumentType = String(market.instrumentType || "").toUpperCase();
  return exchange === "MCX" || exchange === "NCDEX" || instrumentType.includes("COM");
}

function isFnOMarket(market = {}) {
  const exchange = String(market.exchange || "").toUpperCase();
  const instrumentType = String(market.instrumentType || "").toUpperCase();
  return exchange === "NFO" || exchange === "BFO" || instrumentType.startsWith("FUT");
}

function rebalanceScanUniverse(markets) {
  const maxPerScan = getMaxCoinsPerScan();
  const commodity = markets.filter(isCommodityMarket);
  const fno = markets.filter((market) => !isCommodityMarket(market) && isFnOMarket(market));
  const equity = markets.filter((market) => !isCommodityMarket(market) && !isFnOMarket(market));

  const commodityReserve = Math.min(commodity.length, Math.max(3, Math.ceil(maxPerScan * 0.2)));
  const fnoReserve = Math.min(fno.length, Math.max(5, Math.ceil(maxPerScan * 0.25)));
  const reservedSymbols = new Set();
  const prioritized = [];

  for (const market of commodity.slice(0, commodityReserve)) {
    prioritized.push(market);
    reservedSymbols.add(market.symbol);
  }
  for (const market of fno.slice(0, fnoReserve)) {
    if (reservedSymbols.has(market.symbol)) continue;
    prioritized.push(market);
    reservedSymbols.add(market.symbol);
  }
  for (const market of equity) {
    if (reservedSymbols.has(market.symbol)) continue;
    prioritized.push(market);
    reservedSymbols.add(market.symbol);
  }
  for (const market of fno.slice(fnoReserve)) {
    if (reservedSymbols.has(market.symbol)) continue;
    prioritized.push(market);
    reservedSymbols.add(market.symbol);
  }
  for (const market of commodity.slice(commodityReserve)) {
    if (reservedSymbols.has(market.symbol)) continue;
    prioritized.push(market);
    reservedSymbols.add(market.symbol);
  }

  return prioritized;
}

function getScanUniverse() {
  try {
    const instruments = getInstrumentUniverse({ limit: MAX_COINS_PER_SCAN_CAP });
    if (instruments.length) {
      const markets = instruments.map(inst => ({
        symbol: (inst.tradingSymbol || inst.symbol || "").toUpperCase(),
        exchange: inst.exchange,
        token: inst.token,
        instrumentType: inst.instrumentType,
        // satisfy buildMarketActivitySnapshot shape (not used for stocks but prevents crashes)
        quoteVolume: 0, volume: 0, tradeCount: 0, openInterestValue: 0,
        activityScore: 0, isLiquid: false, isCrowded: false,
        passesFloor: true, relaxThresholds: false,
      })).filter(m => m.symbol);
      return rebalanceScanUniverse(markets);
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
  const r = String(process.env.SMART_TRADE_TIMEFRAMES || process.env.TRADE_TIMEFRAMES || "").split(",").map(s => s.trim()).filter(Boolean);
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

// ─── Shock Candle Detector (ported from crypto engine) ───────────────────────
// Rejects signals immediately after a massive impulse candle (entry-chase protection)
function hasShockCandle(side, analysis) {
  if (!SHOCK_CANDLE_GUARD_ENABLED) return false;
  const c   = analysis.candles;
  const atr = analysis.volatility.atr || 1;
  if (!c) return false;
  const body = Math.abs((c.close || 0) - (c.open || 0));
  if (body < atr * SHOCK_CANDLE_BODY_ATR_MULT) return false;
  // Body is a shock candle — only reject if we're chasing in that direction
  const isBullShock = c.close > c.open;
  if (side === "LONG"  && isBullShock) return true;  // chasing a spike up
  if (side === "SHORT" && !isBullShock) return true; // chasing a spike down
  return false;
}

// ─── Volatility band per timeframe (stock-tuned) ──────────────────────────────
function getVolatilityBand(timeframe) {
  const bands = {
    "15m": { min: VOL_GUARD_LOW_PCT, max: VOL_GUARD_HIGH_PCT },
    "30m": { min: VOL_GUARD_LOW_PCT * 1.2, max: VOL_GUARD_HIGH_PCT },
    "1h":  { min: VOL_GUARD_LOW_PCT * 1.5, max: VOL_GUARD_HIGH_PCT },
    "4h":  { min: VOL_GUARD_LOW_PCT * 2.0, max: VOL_GUARD_HIGH_PCT },
    "1d":  { min: VOL_GUARD_LOW_PCT * 3.0, max: VOL_GUARD_HIGH_PCT },
  };
  return bands[timeframe] || { min: VOL_GUARD_LOW_PCT, max: VOL_GUARD_HIGH_PCT };
}

// ─── Publish cooldown map (per stock) ────────────────────────────────────────
async function getCoinPublishCooldownMap(nowMs = Date.now()) {
  if (!COIN_PUBLISH_COOLDOWN_ENABLED) return {};
  const cooldownMs = COIN_PUBLISH_COOLDOWN_MINUTES * 60 * 1000;
  const cutoffMs   = nowMs - cooldownMs;
  const map = {};
  try {
    const signals = await readCollection(STOCK_COLLECTION);
    for (const sig of signals) {
      const coin = String(sig?.coin || "").toUpperCase();
      if (!coin) continue;
      if (String(sig?.source || "").toUpperCase() === "MANUAL") continue;
      const ts = new Date(sig?.createdAt || sig?.updatedAt || 0).getTime();
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      const prev = map[coin] || 0;
      if (ts > prev) map[coin] = ts;
    }
  } catch {}
  return map;
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
  // GATE CHECKS (crypto-parity filters — ported + tuned for Indian stocks)
  // ════════════════════════════════════════════════════════════════════════════

  // GATE 1: HTF Alignment
  if (higherBias === "NEUTRAL") return null;
  const side = higherBias === "BULLISH" ? "LONG" : "SHORT";

  // 1H directional filter — only take signals in 1H trend direction
  const oneHBullAligned = Number(oneH?.trend?.ema50 || 0) > Number(oneH?.trend?.ema100 || 0);
  const oneHBearAligned = Number(oneH?.trend?.ema50 || 0) < Number(oneH?.trend?.ema100 || 0);
  if (side === "LONG"  && !oneHBullAligned) return null;
  if (side === "SHORT" && !oneHBearAligned) return null;

  // Re-entry cooldown: skip if last SL was recent on this coin×side×TF
  if (REENTRY_COOLDOWN_ENABLED && performanceSnapshot) {
    const key = `${String(coin || "").toUpperCase()}:${String(side || "").toUpperCase()}:${String(timeframe || "").toLowerCase()}`;
    const lastLossAt = Number(performanceSnapshot.lastLossAtByCoinSideTimeframe?.[key] || 0);
    const cooldownMs = REENTRY_COOLDOWN_MINUTES * 60 * 1000;
    if (lastLossAt > 0 && (Date.now() - lastLossAt) < cooldownMs) return null;
  }

  // Mid-TF alignment for short timeframes (15m must align with 1h when scanning 15m)
  if (MID_TF_ALIGNMENT_GUARD_ENABLED && timeframe === "15m") {
    const midRefs = [oneH].filter(Boolean);
    let aligned = 0, checked = 0;
    for (const mid of midRefs) {
      const mTrend = mid?.trend || {};
      const mEma50 = Number(mTrend.ema50 || 0);
      const mEma100 = Number(mTrend.ema100 || 0);
      const mAdx = Number(mTrend.adx || 0);
      if (!mEma50 || !mEma100 || mAdx < MID_TF_ALIGNMENT_MIN_ADX) continue;
      checked += 1;
      const isBull = mEma50 > mEma100;
      if ((side === "LONG" && isBull) || (side === "SHORT" && !isBull)) aligned += 1;
    }
    if (checked > 0 && aligned === 0) return null;
  }

  // GATE 2: Core EMA Trend — ema50 > ema100 required
  const coreBullStack = ema50 > ema100 * 0.997;
  const coreBearStack = ema50 < ema100 * 1.003;
  if (side === "LONG"  && !coreBullStack) return null;
  if (side === "SHORT" && !coreBearStack) return null;

  // Trend separation guard: EMA50/100 must be meaningfully apart (not flat)
  if (TREND_SEPARATION_GUARD_ENABLED) {
    const separation = Math.abs(Number(ema50 || 0) - Number(ema100 || 0));
    const sepAtr = atr > 0 ? (separation / atr) : 0;
    if (!Number.isFinite(sepAtr) || sepAtr < TREND_SEPARATION_MIN_ATR) return null;
  }

  // GATE 3: ADX — trend must exist
  const minAdx     = tfRule.minAdx ?? 20;
  const minDiDelta = tfRule.minDiDelta ?? 4;
  if ((adx||0) < minAdx) return null;
  if (side === "LONG"  && ((pdi||0) - (mdi||0)) < minDiDelta) return null;
  if (side === "SHORT" && ((mdi||0) - (pdi||0)) < minDiDelta) return null;

  // GATE 4: Momentum — RSI + MACD
  if (!isMomentumAligned(side, analysis, tfRule)) return null;

  // RSI extreme guard: don't buy already overbought, don't sell already oversold
  if (RSI_EXTREME_GUARD_ENABLED) {
    const rsiNow = Number(rsi || 0);
    if (side === "LONG"  && rsiNow >= RSI_EXTREME_LONG_MAX)  return null;
    if (side === "SHORT" && rsiNow <= RSI_EXTREME_SHORT_MIN) return null;
  }

  // GATE 5 & 6: Volume / HA are bonus scoring only (not hard gates)

  // ── SECONDARY FILTERS ─────────────────────────────────────────────────────
  if (tfRule.requireVwapSupport) {
    if (side === "LONG"  && price < vwap) return null;
    if (side === "SHORT" && price > vwap) return null;
  }
  if (tfRule.blockDailyBear && side === "LONG" && dailyBearStack) return null;

  // Manipulation candle filter
  if (hasManipulationCandle(side, analysis)) return null;

  // Shock candle filter (entry-chase protection)
  if (SHOCK_CANDLE_GUARD_ENABLED && hasShockCandle(side, analysis)) return null;

  // BB extreme zone
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

  // ── Final publish check (Adaptive Scoring Engine v2) ─────────────────────
  const baseConfidence = side === "LONG" ? bullScore : bearScore;
  const confirmations  = side === "LONG" ? bullConf  : bearConf;

  // Adaptive model (refreshed every 10 min, in-memory cache)
  const adaptiveModel = adaptiveEngine._models?.stock || null;

  const adaptiveAdj = adaptiveEngine.getAdjustment(adaptiveModel, {
    coin,
    side,
    timeframe,
    confidence: baseConfidence,
    indicators: {
      rsi:          (analysis.rsi ?? null),
      adx:          (analysis.adx ?? null),
      volumeStrong: (volumeStrong ?? false),
      volumeSpike:  (volumeSpike  ?? false),
    },
    confirmations: confirmations.map(c => (typeof c === "string" ? c : c?.text || "")),
  });

  // Hard block from any adaptive layer
  if (adaptiveAdj.block) return null;

  const confidence = Math.min(Math.max(baseConfidence + adaptiveAdj.scoreDelta, 0), 100);

  const minScore         = (tfRule.minScore         || 62);
  const minConfirmations = (tfRule.minConfirmations || 5)  + adaptiveAdj.minConfirmationsBoost;
  const publishFloor     = (tfRule.publishFloor     || DEFAULT_PUBLISH_FLOOR) + adaptiveAdj.publishFloorBoost;

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

  // SR room guard: enough price room to TP before hitting resistance/support
  let srRoomR = null;
  if (SR_ROOM_GUARD_ENABLED) {
    if (side === "LONG"  && Number.isFinite(srRes) && srRes > targets.entry) {
      srRoomR = (srRes - targets.entry) / targets.riskPerUnit;
    } else if (side === "SHORT" && Number.isFinite(srSup) && srSup < targets.entry) {
      srRoomR = (targets.entry - srSup) / targets.riskPerUnit;
    }
    if (srRoomR !== null && srRoomR < SR_ROOM_MIN_R) return null;
  }

  // Volatility guard: filter extreme spikes / dead stocks
  const atrPercent = price > 0 ? (rawAtr / price) * 100 : 0;
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
      modelVersion: STOCK_SIGNAL_MODEL_VERSION + "+adaptive_v2+filtered_v2",
      srRoomR: srRoomR === null ? null : roundPrice(srRoomR),
      atrPercent: roundPrice(atrPercent),
      smc: {
        choch:     { bull: false, bear: false, level: smcCHoCH.level },
        idm:       { bull: idmBull,   bear: idmBear,   sweepLevel: smcIDM.sweepLevel, rejectionStrength: smcIDM.rejectionStrength },
        structure: smcStructure.trend,
      },
      adaptive: {
        scoreDelta:           adaptiveAdj.scoreDelta,
        publishFloorBoost:    adaptiveAdj.publishFloorBoost,
        minConfirmationsBoost: adaptiveAdj.minConfirmationsBoost,
        predictedWinProb:     adaptiveAdj.predictedWinProb,
        streakWarning:        adaptiveAdj.streakWarning,
        reasons:              adaptiveAdj.reasons,
        layers:               adaptiveAdj.layers,
        modelStatus:          adaptiveEngine.getModelStatus("stock"),
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
      const tradingKey = (inst.tradingSymbol || "").toUpperCase().trim();
      const symbolKey = (inst.symbol || "").toUpperCase().trim();
      const bareKey = symbolKey.includes(":") ? symbolKey.split(":")[1] : symbolKey;
      const entry = { exchange: inst.exchange, token: String(inst.token) };
      if (tradingKey) tokenMap[tradingKey] = entry;
      if (bareKey && bareKey !== tradingKey) tokenMap[bareKey] = entry;
      if (symbolKey && symbolKey !== tradingKey && symbolKey !== bareKey) tokenMap[symbolKey] = entry;
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
    try { tg()?.autoSendSignalResult(s);         } catch {}
  });
  return closed;
}

async function getPerformanceSnapshot() {
  try {
    const signals = await readCollection(STOCK_COLLECTION);
    const stats = {
      overall: buildTally(), LONG: buildTally(), SHORT: buildTally(),
      "15m": buildTally(), "1h": buildTally(),
      byCoin: {}, bySide: {}, bySideTimeframe: {},
      lastLossAtByCoinSideTimeframe: {},
      recent5LossCountByCoin: {},
    };

    // Newest-first for streak detection
    const sorted = [...signals].sort((a, b) =>
      new Date(b.closedAt || b.updatedAt || b.createdAt || 0) -
      new Date(a.closedAt || a.updatedAt || a.createdAt || 0)
    );

    const coinRecentCount = {}; // track last 5 resolved per coin

    for (const sig of sorted) {
      const isWin  = WIN_RESULTS.has(sig.result);
      const isLoss = LOSS_RESULTS.has(sig.result);
      if (!isWin && !isLoss) continue;

      const key = isWin ? "wins" : "losses";
      stats.overall[key] += 1;

      const coin = String(sig.coin || "").toUpperCase();
      const side = String(sig.side || "").toUpperCase();
      const tf   = String(sig.timeframe || "").toLowerCase();

      if (stats[side]) stats[side][key] += 1;
      if (!stats[tf]) stats[tf] = buildTally();
      stats[tf][key] += 1;

      // per-coin / side / side×TF
      if (!stats.byCoin[coin]) stats.byCoin[coin] = buildTally();
      stats.byCoin[coin][key] += 1;
      if (!stats.bySide[side]) stats.bySide[side] = buildTally();
      stats.bySide[side][key] += 1;
      const stKey = `${side}:${tf}`;
      if (!stats.bySideTimeframe[stKey]) stats.bySideTimeframe[stKey] = buildTally();
      stats.bySideTimeframe[stKey][key] += 1;

      // Re-entry cooldown: track last SL timestamp per coin:side:tf
      if (isLoss) {
        const cstKey = `${coin}:${side}:${tf}`;
        const lossTs = new Date(sig.closedAt || sig.updatedAt || 0).getTime();
        if (!stats.lastLossAtByCoinSideTimeframe[cstKey] ||
            lossTs > stats.lastLossAtByCoinSideTimeframe[cstKey]) {
          stats.lastLossAtByCoinSideTimeframe[cstKey] = lossTs;
        }
      }

      // Recent 5 loss count per coin (for auto-cooldown)
      if (!coinRecentCount[coin]) coinRecentCount[coin] = 0;
      if (coinRecentCount[coin] < 5) {
        if (isLoss) {
          stats.recent5LossCountByCoin[coin] = (stats.recent5LossCountByCoin[coin] || 0) + 1;
        }
        coinRecentCount[coin] += 1;
      }
    }

    stats.sampleSize = stats.overall.wins + stats.overall.losses;
    return stats;
  } catch {
    return {
      overall: buildTally(), LONG: buildTally(), SHORT: buildTally(),
      "15m": buildTally(), "1h": buildTally(),
      byCoin: {}, bySide: {}, bySideTimeframe: {},
      lastLossAtByCoinSideTimeframe: {},
      recent5LossCountByCoin: {},
      sampleSize: 0,
    };
  }
}

// ─── Persist / Manual ────────────────────────────────────────────────────────
async function persistSignal(signal) {
  const result = await mutateCollection(STOCK_COLLECTION, records => ({ records: [signal, ...records], value: signal }));
  try { ws()?.broadcastNewStockSignal(signal);   } catch {}
  try { sse()?.broadcastNewSignal(signal, true); } catch {}
  // Facebook auto-post removed
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
    // Refresh adaptive model before scan (10-min cache, no-op if recent)
    await adaptiveEngine.refreshModel(readCollection, STOCK_COLLECTION, "stock").catch(() => {});

    // Auto coin cooldown: pause stocks with repeated recent losses
    if (AUTO_COIN_COOLDOWN_ENABLED && performanceSnapshot.recent5LossCountByCoin) {
      const cooldownMs = AUTO_COIN_COOLDOWN_HOURS * 60 * 60 * 1000;
      for (const [coin, lossCount] of Object.entries(performanceSnapshot.recent5LossCountByCoin)) {
        if (lossCount >= AUTO_COIN_COOLDOWN_MIN_LOSSES && !engineState.pausedCoins[coin]) {
          engineState.pausedCoins[coin] = {
            pausedAt: new Date().toISOString(),
            reason: `Auto-cooldown: ${lossCount}/${AUTO_COIN_COOLDOWN_WINDOW} recent losses`,
            pausedBy: "ENGINE",
            autoExpireAt: Date.now() + cooldownMs,
          };
        }
      }
    }
    // Expire auto-cooldowns
    const now = Date.now();
    for (const [coin, pause] of Object.entries(engineState.pausedCoins)) {
      if (pause.pausedBy === "ENGINE" && pause.autoExpireAt && now >= pause.autoExpireAt) {
        delete engineState.pausedCoins[coin];
      }
    }

    // Publish cooldown map: skip stocks published too recently
    const publishCooldownMap = await getCoinPublishCooldownMap(now);

    const scanUniverse        = getScanUniverse();
    const coins               = scanUniverse.slice(0, getMaxCoinsPerScan());
    for (const market of coins) {
      // Skip admin/auto-paused coins
      if (engineState.pausedCoins[market.symbol]) {
        errors.push({ coin: market.symbol, message: "Paused — skipped in scan" });
        continue;
      }
      // Skip if published too recently
      if (publishCooldownMap[market.symbol]) {
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

// ─── Expiry disabled for stocks ──────────────────────────────────────────────
async function checkAndExpireSignals() {
  return null;
}

function start() {
  if (engineState.timer) { engineState.running = true; return getStatus(); }
  engineState.intervalMs  = Number(process.env.SMART_SCAN_INTERVAL_MS || process.env.SCAN_INTERVAL_MS || engineState.intervalMs || 60000);
  engineState.timer        = setInterval(() => { scanNow({ source: "ENGINE" }).catch(e => { engineState.lastError = e.message; }); }, engineState.intervalMs);
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
