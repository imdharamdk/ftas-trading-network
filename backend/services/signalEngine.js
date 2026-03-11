const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { getKlines, getPrices, getAllFuturesCoins, getAllTickerStats } = require("./binanceService");
const { analyzeCandles } = require("./indicatorEngine");

// Fallback list if Binance exchangeInfo API fails
const FALLBACK_COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
  "MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT",
  "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT",
];

// ── SCALPING MODE: Only 1m and 5m trade signals ──────────────────────────────
const SCAN_TIMEFRAMES            = ["1m","5m","15m","1h","4h","1d"];
const DEFAULT_TRADE_TIMEFRAMES   = ["1m","5m"];
const DEFAULT_MAX_COINS_PER_SCAN = 50;
const MAX_COINS_PER_SCAN_CAP     = 80;
const MIN_SCAN_QUOTE_VOLUME_USDT = 15_000_000;
const MIN_SCAN_TRADE_COUNT_24H   = 20_000;
const MIN_SCAN_OPEN_INTEREST_USDT = 5_000_000;

const RULE_VERSION = "v13_scalping";
const DEFAULT_PUBLISH_FLOOR = 87;
const STRENGTH_THRESHOLDS = { STRONG: 93, MEDIUM: 87 };

const TIMEFRAME_RULES = {
  "1m": {
    minScore: 62,
    minConfirmations: 5,
    publishFloor: 87,
    requireHigherBias: true,
    minAdx: 28,
    minRsi: 45,
    maxRsi: 78,
    minDiDelta: 4,
    requireVwapSupport: true,
    blockDailyBear: true,
    intradayOverride: false,
    entryDriftMultiplier: 0.25,
    maxLeverage: 10,
    isScalp: true,
    candleExpiry: 1,
  },
  "5m": {
    minScore: 65,
    minConfirmations: 6,
    publishFloor: 90,
    requireHigherBias: true,
    minAdx: 22,
    minRsi: 46,
    maxRsi: 80,
    minDiDelta: 4,
    requireVwapSupport: true,
    blockDailyBear: true,
    intradayOverride: false,
    entryDriftMultiplier: 0.4,
    maxLeverage: 15,
    isScalp: true,
    candleExpiry: 5,
  },
};

// ── Signal Expiry ─────────────────────────────────────────────────────────────
// 1m signal = 5 minutes
// 5m signal = 15 minutes
const SIGNAL_EXPIRY_MS = {
  "1m":  5  * 60 * 1000,
  "5m":  15 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h":  60 * 60 * 1000,
  default: 15 * 60 * 1000,
};

const WIN_RESULTS  = new Set(["TP1_HIT","TP2_HIT","TP3_HIT"]);
const LOSS_RESULTS = new Set(["SL_HIT"]);
const buildTally   = () => ({ wins: 0, losses: 0 });

const engineState = {
  intervalMs: Number(process.env.SCAN_INTERVAL_MS || 60000),
  isScanning: false, lastError: null, lastGenerated: 0,
  lastScanAt: null, running: false, scanCount: 0,
  timer: null,
  expiryTimer: null,
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
  return { symbol, quoteVolume: 0, volume: 0, tradeCount: 0, openInterestValue: 0,
    activityScore: 0, isLiquid: false, isCrowded: false, passesFloor: true, relaxThresholds: false };
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
  const isLiquid  = quoteVolume >= 35_000_000 || openInterestValue >= 8_000_000;
  const isCrowded = tradeCount >= 25_000 || openInterestValue >= 12_000_000;
  const passesFloor =
    symbol.endsWith("USDT") &&
    quoteVolume >= MIN_SCAN_QUOTE_VOLUME_USDT &&
    (!hasParticipationMetric || tradeCount >= MIN_SCAN_TRADE_COUNT_24H || openInterestValue >= MIN_SCAN_OPEN_INTEREST_USDT);
  return { symbol, quoteVolume, volume, tradeCount, openInterestValue,
    activityScore: liquidityScore + participationScore, isLiquid, isCrowded, passesFloor,
    relaxThresholds: isLiquid && (isCrowded || quoteVolume >= 75_000_000) };
}
function getMaxCoinsPerScan() {
  return clamp(Number(process.env.SCAN_MAX_COINS || DEFAULT_MAX_COINS_PER_SCAN), 5, MAX_COINS_PER_SCAN_CAP);
}
async function getScanUniverse() {
  const envOverride = String(process.env.SCAN_COINS || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (envOverride.length) return envOverride.map(buildFallbackMarketActivity);
  try {
    const ranked = (await getAllTickerStats())
      .map(buildMarketActivitySnapshot)
      .filter(m => m.symbol.endsWith("USDT"))
      .sort((a, b) => b.activityScore - a.activityScore || b.quoteVolume - a.quoteVolume || a.symbol.localeCompare(b.symbol));
    const filtered = ranked.filter(m => m.passesFloor);
    if (filtered.length) return filtered;
    if (ranked.length)   return ranked;
  } catch {}
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
  return scanUniverse.map(m => m.symbol);
}
function getTradeTimeframes() {
  const raw = String(process.env.TRADE_TIMEFRAMES || "").split(",").map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_TRADE_TIMEFRAMES;
}

// ─── HTF Bias ─────────────────────────────────────────────────────────────────
// 1m scalping → 5m is primary bias, 15m is veto
// 5m scalping → 15m/1h is primary bias, 1d is macro veto
function getHigherTimeframeBias(analyses, tradeTimeframe = "5m") {
  if (tradeTimeframe === "1m") {
    const a5m  = analyses["5m"];
    const a15m = analyses["15m"];
    if (!a5m) return "NEUTRAL";
    const { ema50, ema100, ema200, adx } = a5m.trend;
    const rsi = a5m.momentum.rsi || 50;
    const fiveMBull = ema50 > ema100 && ema100 > ema200 && (adx||0) >= 18 && rsi >= 42;
    const fiveMBear = ema50 < ema100 && ema100 < ema200 && (adx||0) >= 18 && rsi <= 58;
    if (!fiveMBull && !fiveMBear) return "NEUTRAL";
    if (a5m.regime === "RANGING" && (adx||0) < 20) return "NEUTRAL";
    if (a15m) {
      const m15Bull = a15m.trend.ema50 > a15m.trend.ema100 && (a15m.trend.adx||0) >= 20;
      const m15Bear = a15m.trend.ema50 < a15m.trend.ema100 && (a15m.trend.adx||0) >= 20;
      if (fiveMBull && m15Bear) return "NEUTRAL";
      if (fiveMBear && m15Bull) return "NEUTRAL";
    }
    if (fiveMBull) return "BULLISH";
    if (fiveMBear) return "BEARISH";
    return "NEUTRAL";
  }
  // 5m scalp
  const a15m = analyses["15m"];
  const a1h  = analyses["1h"];
  const a1d  = analyses["1d"];
  const primary = a15m || a1h;
  if (!primary) return "NEUTRAL";
  const { ema50, ema100, ema200, adx } = primary.trend;
  const rsi = primary.momentum.rsi || 50;
  const bull = ema50 > ema100 && ema100 > ema200 && (adx||0) >= 15 && rsi >= 40;
  const bear = ema50 < ema100 && ema100 < ema200 && (adx||0) >= 15 && rsi <= 60;
  if (!bull && !bear) return "NEUTRAL";
  if (primary.regime === "RANGING" && (adx||0) < 16) return "NEUTRAL";
  if (a1d) {
    const dStrongBull = a1d.trend.ema50 > a1d.trend.ema100 && (a1d.trend.adx||0) >= 22;
    const dStrongBear = a1d.trend.ema50 < a1d.trend.ema100 && (a1d.trend.adx||0) >= 22;
    if (bull && dStrongBear) return "NEUTRAL";
    if (bear && dStrongBull) return "NEUTRAL";
  }
  if (bull) return "BULLISH";
  if (bear) return "BEARISH";
  return "NEUTRAL";
}

// ─── SL/TP (Scalping) ─────────────────────────────────────────────────────────
// 1m: TP1=0.5R, TP2=0.9R, TP3=1.4R  — quick tight targets
// 5m: TP1=0.6R, TP2=1.0R, TP3=1.6R  — slightly wider
// SL: max 2x ATR (tight for scalping)
const TP_R_MULTIPLIERS_1M = [0.5, 0.9, 1.4];
const TP_R_MULTIPLIERS_5M = [0.6, 1.0, 1.6];

function calculateTargets(side, analysis, timeframe = "5m") {
  const entry = analysis.currentPrice;
  const atr   = analysis.volatility.atr || analysis.averages.averageRange || entry * 0.003;
  const { low20, high20, previousLow20, previousHigh20 } = analysis.recentSwing;
  const srSup = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes = analysis.srLevels?.resistances?.[0] ?? null;
  const tpMult = timeframe === "1m" ? TP_R_MULTIPLIERS_1M : TP_R_MULTIPLIERS_5M;
  const slMin  = atr * 1.0;
  const slMax  = atr * 2.0;
  if (side === "LONG") {
    const anchors = [low20, previousLow20, srSup].filter(v => Number.isFinite(v) && v < entry);
    const anchor  = anchors.length ? Math.max(...anchors) : entry - atr * 1.5;
    const risk    = clamp((entry - anchor) + atr * 0.2, slMin, slMax);
    return { entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry - risk),
      tp1: roundPrice(entry + risk * tpMult[0]),
      tp2: roundPrice(entry + risk * tpMult[1]),
      tp3: roundPrice(entry + risk * tpMult[2]) };
  } else {
    const anchors = [high20, previousHigh20, srRes].filter(v => Number.isFinite(v) && v > entry);
    const anchor  = anchors.length ? Math.min(...anchors) : entry + atr * 1.5;
    const risk    = clamp((anchor - entry) + atr * 0.2, slMin, slMax);
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
  const bonus  = confidence >= 90 ? 10 : confidence >= 85 ? 7 : confidence >= 80 ? 5 : confidence >= 75 ? 3 : 0;
  const tfRule = TIMEFRAME_RULES[timeframe] || {};
  const cap    = Number.isFinite(tfRule.maxLeverage) ? tfRule.maxLeverage : 50;
  return Math.round(clamp(base + bonus, 10, cap));
}

// ─── Pullback Completion ──────────────────────────────────────────────────────
function isPullbackComplete(side, analysis) {
  const { ema21, ema50, vwap } = analysis.trend;
  const { rsi, rsiRising, rsiFalling, macdHistIncreasing, macdHistDecreasing, stochRsi } = analysis.momentum;
  const price  = analysis.currentPrice;
  const atr    = analysis.volatility.atr || price * 0.003;
  const stochK = stochRsi?.k ?? null;
  const nearEma21  = Math.abs(price - ema21) < atr * 1.5;
  const nearEma50  = Math.abs(price - ema50) < atr * 2.0;
  const nearVwap   = Math.abs(price - vwap)  < atr * 1.5;
  const srSup = analysis.srLevels?.supports?.[0];
  const srRes = analysis.srLevels?.resistances?.[0];
  const nearSR = side === "LONG"
    ? (srSup && Math.abs(price - srSup) < atr * 1.0)
    : (srRes && Math.abs(price - srRes) < atr * 1.0);
  const nearLevel = nearEma21 || nearEma50 || nearVwap || nearSR;
  if (side === "LONG") {
    const rsiOk   = (rsi||0) >= 40 && (rsi||0) <= 82 && (rsiRising || (rsi||0) > 50);
    const stochOk = stochK !== null ? stochK < 65 && stochK > 15 : true;
    return nearLevel && rsiOk && macdHistIncreasing && stochOk;
  } else {
    const rsiOk   = (rsi||100) <= 60 && (rsi||100) >= 18 && (rsiFalling || (rsi||100) < 50);
    const stochOk = stochK !== null ? stochK > 35 && stochK < 85 : true;
    return nearLevel && rsiOk && macdHistDecreasing && stochOk;
  }
}

// ─── Volume Breakout ──────────────────────────────────────────────────────────
function isVolumeBreakout(side, analysis) {
  const { currentVolume, averageVolume } = analysis.volume;
  const { ema50, ema100, ema200, adx }   = analysis.trend;
  const price       = analysis.currentPrice;
  const avgPrice    = analysis.averages.averagePrice;
  const suddenVol   = currentVolume > averageVolume * 2.2;
  const strongBody  = (analysis.candleQuality?.bodyRatio || 0) > 0.45;
  const trendingAdx = (adx||0) >= 20;
  if (side === "LONG") return price > avgPrice && suddenVol && strongBody && trendingAdx && ema50 > ema100 && ema100 > ema200;
  else                 return price < avgPrice && suddenVol && strongBody && trendingAdx && ema50 < ema100 && ema100 < ema200;
}

// ─── Signal Builder ───────────────────────────────────────────────────────────
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
  const { daily, twelveH, oneH } = htf;
  const bullRsiFloor       = tfRule.minRsi ?? 40;
  const bullRsiCeil        = tfRule.maxRsi ?? 82;
  const requireVwapSupport = tfRule.requireVwapSupport || false;
  const minAdx             = tfRule.minAdx ?? 0;
  const minDiDelta         = tfRule.minDiDelta ?? 0;
  const dailyTrend         = daily?.trend || {};
  const dailyBearStack     = (dailyTrend.ema50||0) < (dailyTrend.ema100||0) && (dailyTrend.adx||0) >= 18;
  const psarBull = Number.isFinite(psar) ? psar < price : true;
  const psarBear = Number.isFinite(psar) ? psar > price : true;
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

  if (regime === "RANGING") {
    if (!rsiDivBull && !rsiDivBear && !macdDivBull && !macdDivBear) return null;
  }

  const bullTrend = ema50 > ema100 && ema100 > ema200 && (price > ema21 || price > ema50);
  const bearTrend = ema50 < ema100 && ema100 < ema200 && (price < ema21 || price < ema50);
  const bullSlope = ema50Rising || ema21Rising;
  const bearSlope = ema50Falling || ema21Falling;
  const bullMomentum =
    (rsi||0) >= bullRsiFloor && (rsi||0) <= bullRsiCeil &&
    (macd?.MACD||0) > (macd?.signal||0) &&
    (rsiRising || (rsi||0) > Math.max(bullRsiFloor, 50)) &&
    (!requireVwapSupport || (Number.isFinite(vwap) && price >= vwap)) &&
    (!minAdx || (adx||0) >= minAdx) &&
    (!minDiDelta || ((pdi||0) - (mdi||0)) >= minDiDelta);
  const bearMomentum =
    (rsi||0) <= 60 && (rsi||0) >= 18 &&
    (macd?.MACD||0) < (macd?.signal||0) &&
    (rsiFalling || (rsi||0) < 50);
  const bullPB    = isPullbackComplete("LONG",  analysis);
  const bearPB    = isPullbackComplete("SHORT", analysis);
  const bullBO    = isVolumeBreakout("LONG",    analysis);
  const bearBO    = isVolumeBreakout("SHORT",   analysis);
  const bullEntry = bullPB || bullBO;
  const bearEntry = bearPB || bearBO;

  // intraday override disabled for scalping (requireHigherBias=true enforces it)
  const allowIntradayBull = false;
  const allowIntradayBear = false;
  const requiresHigherBias = tfRule.requireHigherBias === true;
  const bullBiasAligned = (!tfRule.blockDailyBear || !dailyBearStack) &&
    (higherBias === "BULLISH" || (!requiresHigherBias && allowIntradayBull));
  const bearBiasAligned = higherBias === "BEARISH" || (!requiresHigherBias && allowIntradayBear);
  const effectiveBias   = higherBias !== "NEUTRAL" ? higherBias : "NEUTRAL";

  const bullDivOverride = (rsiDivBull || macdDivBull) && bullTrend && bullMomentum && bullEntry;
  const bearDivOverride = (rsiDivBear || macdDivBear) && bearTrend && bearMomentum && bearEntry;
  const bullValid = bullBiasAligned && bullTrend && bullMomentum && bullEntry && (bullSlope || bullDivOverride);
  const bearValid = bearBiasAligned && bearTrend && bearMomentum && bearEntry && (bearSlope || bearDivOverride);
  if (!bullValid && !bearValid) return null;

  // ── Scoring ──────────────────────────────────────────────────────────────
  if (bullTrend) { bullScore += 18; bullConf.push(`EMA ${roundPrice(ema50)}>${roundPrice(ema100)}>${roundPrice(ema200)} bullish`); }
  if (bearTrend) { bearScore += 18; bearConf.push(`EMA ${roundPrice(ema50)}<${roundPrice(ema100)}<${roundPrice(ema200)} bearish`); }
  if (bullSlope) { bullScore += 8;  bullConf.push("EMA21+50 rising slope"); }
  if (bearSlope) { bearScore += 8;  bearConf.push("EMA21+50 falling slope"); }
  if (bullMomentum) { bullScore += 14; bullConf.push(`RSI ${(rsi||0).toFixed(1)} rising | MACD+`); }
  if (bearMomentum) { bearScore += 14; bearConf.push(`RSI ${(rsi||0).toFixed(1)} falling | MACD-`); }
  if (bullPB) { bullScore += 16; bullConf.push("Pullback complete — level bounce + RSI turn"); }
  if (bearPB) { bearScore += 16; bearConf.push("Bounce complete — level rejection + RSI turn"); }
  if (bullBO) { bullScore += 16; bullConf.push(`Vol breakout ${(currentVolume/averageVolume).toFixed(1)}x`); }
  if (bearBO) { bearScore += 16; bearConf.push(`Vol breakdown ${(currentVolume/averageVolume).toFixed(1)}x`); }
  if (higherBias === "BULLISH") { bullScore += 10; bullConf.push(`HTF bullish bias (ADX ${roundPrice(adx||0)})`); }
  if (higherBias === "BEARISH") { bearScore += 10; bearConf.push(`HTF bearish bias (ADX ${roundPrice(adx||0)})`); }
  if (rsiDivBull && bullValid)  { bullScore += 14; bullConf.push("RSI bullish divergence ⚡"); }
  if (rsiDivBear && bearValid)  { bearScore += 14; bearConf.push("RSI bearish divergence ⚡"); }
  if (macdDivBull && bullValid) { bullScore += 10; bullConf.push("MACD bullish divergence"); }
  if (macdDivBear && bearValid) { bearScore += 10; bearConf.push("MACD bearish divergence"); }
  if (rsiHidBull && bullValid)  { bullScore += 8;  bullConf.push("RSI hidden bullish div"); }
  if (rsiHidBear && bearValid)  { bearScore += 8;  bearConf.push("RSI hidden bearish div"); }
  if (haStrongBull && bullValid) { bullScore += 8; bullConf.push("HA 3-bar strong bull"); }
  else if (haBullish && bullValid) { bullScore += 5; bullConf.push("Heikin-Ashi bullish"); }
  if (haStrongBear && bearValid) { bearScore += 8; bearConf.push("HA 3-bar strong bear"); }
  else if (haBearish && bearValid) { bearScore += 5; bearConf.push("Heikin-Ashi bearish"); }
  if (haNoLowerWick && haStrongBull && bullValid) { bullScore += 4; bullConf.push("HA no lower wick"); }
  if (haNoUpperWick && haStrongBear && bearValid) { bearScore += 4; bearConf.push("HA no upper wick"); }
  if (nearSupportSR    && bullValid) { bullScore += 7; bullConf.push(`Near support ${roundPrice(srSup)}`); }
  if (nearResistanceSR && bearValid) { bearScore += 7; bearConf.push(`Near resistance ${roundPrice(srRes)}`); }
  if (bbPctB !== null && bbPctB < 0.35 && bullValid) { bullScore += 5; bullConf.push(`BB lower zone (${(bbPctB*100).toFixed(0)}%)`); }
  if (bbPctB !== null && bbPctB > 0.65 && bearValid) { bearScore += 5; bearConf.push(`BB upper zone (${(bbPctB*100).toFixed(0)}%)`); }
  if (obvTrending && bullValid) { bullScore += 5; bullConf.push("OBV trending up"); }
  if (!obvTrending && bearValid && obvChange < 0) { bearScore += 5; bearConf.push("OBV trending down"); }
  if (macdHistIncreasing && bullValid) { bullScore += 5; bullConf.push("MACD hist accelerating+"); }
  if (macdHistDecreasing && bearValid) { bearScore += 5; bearConf.push("MACD hist accelerating-"); }
  if (price > vwap && bullValid) { bullScore += 5; bullConf.push(`Above VWAP ${roundPrice(vwap)}`); }
  if (price < vwap && bearValid) { bearScore += 5; bearConf.push(`Below VWAP ${roundPrice(vwap)}`); }
  if (psarBull && bullValid) { bullScore += 5; bullConf.push("PSAR bullish"); }
  if (psarBear && bearValid) { bearScore += 5; bearConf.push("PSAR bearish"); }
  if ((adx||0) >= 20 && (pdi||0) > (mdi||0) && bullValid) { bullScore += 6; bullConf.push(`ADX ${roundPrice(adx)} +DI>`); }
  if ((adx||0) >= 20 && (mdi||0) > (pdi||0) && bearValid) { bearScore += 6; bearConf.push(`ADX ${roundPrice(adx)} -DI>`); }
  if (ichimoku?.bullish && bullValid) { bullScore += 6; bullConf.push("Ichimoku bullish"); }
  if (ichimoku?.bearish && bearValid) { bearScore += 6; bearConf.push("Ichimoku bearish"); }
  if (aoCrossUp   && bullValid) { bullScore += 6; bullConf.push("AO cross up"); }
  if (aoCrossDown && bearValid) { bearScore += 6; bearConf.push("AO cross down"); }
  else if ((ao||0) > 0 && bullValid) bullScore += 3;
  else if ((ao||0) < 0 && bearValid) bearScore += 3;
  if (trixCrossUp   && bullValid) { bullScore += 4; bullConf.push("TRIX cross+"); }
  if (trixCrossDown && bearValid) { bearScore += 4; bearConf.push("TRIX cross-"); }
  else if ((trix||0) > 0 && bullValid) bullScore += 2;
  else if ((trix||0) < 0 && bearValid) bearScore += 2;
  if (kstBullish && bullValid) { bullScore += 4; bullConf.push("KST bullish"); }
  if (kstBearish && bearValid) { bearScore += 4; bearConf.push("KST bearish"); }
  if (kdK !== null && kdD !== null && kdK > kdD && kdK < 80 && bullValid) { bullScore += 4; bullConf.push("StochKD cross up"); }
  if (kdK !== null && kdD !== null && kdK < kdD && kdK > 20 && bearValid) { bearScore += 4; bearConf.push("StochKD cross down"); }
  if (stochK !== null && stochK < 30 && bullValid) { bullScore += 4; bullConf.push(`StochRSI oversold ${stochK.toFixed(0)}`); }
  if (stochK !== null && stochK > 70 && bearValid) { bearScore += 4; bearConf.push(`StochRSI overbought ${stochK.toFixed(0)}`); }
  if (cci !== null && cci > 100  && cci < 250  && bullValid) { bullScore += 4; bullConf.push(`CCI ${cci.toFixed(0)}`); }
  if (cci !== null && cci < -100 && cci > -250 && bearValid) { bearScore += 4; bearConf.push(`CCI ${cci.toFixed(0)}`); }
  if ((williamsR||0) > -70 && (williamsR||0) < -20 && bullValid) bullScore += 3;
  if ((williamsR||0) < -30 && (williamsR||0) > -80 && bearValid) bearScore += 3;
  if (volumeStrong  && bullValid) { bullScore += 5; bullConf.push("Volume surge 2x+"); }
  if (volumeStrong  && bearValid) { bearScore += 5; bearConf.push("Volume surge 2x+"); }
  if (volumeTrending && bullValid) { bullScore += 3; bullConf.push("Volume increasing"); }
  if (volumeTrending && bearValid) { bearScore += 3; bearConf.push("Volume increasing"); }
  if (activeMarket.isLiquid && bullValid) { bullScore += 4; bullConf.push(`Vol ${formatCompact(activeMarket.quoteVolume)} USDT`); }
  if (activeMarket.isLiquid && bearValid) { bearScore += 4; bearConf.push(`Vol ${formatCompact(activeMarket.quoteVolume)} USDT`); }
  if (activeMarket.isCrowded && bullValid) { bullScore += 4; bullConf.push(`${formatCompact(activeMarket.tradeCount)} trades/24h`); }
  if (activeMarket.isCrowded && bearValid) { bearScore += 4; bearConf.push(`${formatCompact(activeMarket.tradeCount)} trades/24h`); }
  if (mfi !== null && mfi >= 50 && mfi <= 72 && bullValid) { bullScore += 3; bullConf.push(`MFI ${roundPrice(mfi)}`); }
  if (mfi !== null && mfi <= 50 && mfi >= 28 && bearValid) { bearScore += 3; bearConf.push(`MFI ${roundPrice(mfi)}`); }
  if (forceIndex > 0 && bullValid) bullScore += 2;
  if (forceIndex < 0 && bearValid) bearScore += 2;
  if (bbWidth && rawAtr && bbWidth < rawAtr * 2.5) {
    if (bullValid) { bullScore += 3; bullConf.push("BB squeeze"); }
    if (bearValid) { bearScore += 3; bearConf.push("BB squeeze"); }
  }
  const strongBullPat = ["Morning Star","Morning Doji Star","Three White Soldiers","Bullish Engulfing","Piercing Line","Tweezer Bottom","Bullish Marubozu","Abandoned Baby (Bull)"];
  const strongBearPat = ["Evening Star","Evening Doji Star","Three Black Crows","Bearish Engulfing","Dark Cloud Cover","Tweezer Top","Bearish Marubozu","Downside Tasuki Gap"];
  const patBull  = (analysis.patterns?.bullish || []);
  const patBear  = (analysis.patterns?.bearish || []);
  const confBull = patBull.filter(p => strongBullPat.includes(p));
  const confBear = patBear.filter(p => strongBearPat.includes(p));
  if (confBull.length && bullValid)     { bullScore += 10; bullConf.push(confBull.join(", ")); }
  else if (patBull.length && bullValid) { bullScore += 4;  bullConf.push(patBull.slice(0,2).join(", ")); }
  if (confBear.length && bearValid)     { bearScore += 10; bearConf.push(confBear.join(", ")); }
  else if (patBear.length && bearValid) { bearScore += 4;  bearConf.push(patBear.slice(0,2).join(", ")); }
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
  if ((roc||0) > 0 && bullValid)  bullScore += 2;
  if ((roc||0) < 0 && bearValid)  bearScore += 2;
  if ((roc5||0) > 0 && bullValid) bullScore += 2;
  if ((roc5||0) < 0 && bearValid) bearScore += 2;
  if ((rsi9||0) > 52 && bullValid) bullScore += 2;
  if ((rsi9||0) < 48 && bearValid) bearScore += 2;

  const BASE_MIN_SCORE = activeMarket.relaxThresholds ? 51 : 55;
  const BASE_MIN_CONF  = activeMarket.relaxThresholds ? 3  : 4;
  const minScore         = Math.max(BASE_MIN_SCORE, tfRule.minScore || 0);
  const minConfirmations = Math.max(BASE_MIN_CONF,  tfRule.minConfirmations || 0);
  const side             = bullValid && !bearValid ? "LONG" : !bullValid && bearValid ? "SHORT" : bullScore >= bearScore ? "LONG" : "SHORT";
  const confidence       = side === "LONG" ? bullScore : bearScore;
  const confirmations    = side === "LONG" ? bullConf  : bearConf;
  if (confidence < minScore || confirmations.length < minConfirmations) return null;
  if (tfRule.requireHigherBias) {
    if (side === "LONG"  && higherBias !== "BULLISH") return null;
    if (side === "SHORT" && higherBias !== "BEARISH") return null;
  }
  const targets  = calculateTargets(side, analysis, timeframe);
  const leverage = calculateLeverage(analysis, confidence, timeframe);
  if (!Number.isFinite(targets.riskPerUnit) || targets.riskPerUnit <= 0) return null;
  const driftMultiplier = tfRule.entryDriftMultiplier ?? 0.4;
  const entryDriftLimit = Math.max(atr * driftMultiplier, atr * 0.2);
  if (Math.abs(price - targets.entry) > entryDriftLimit) return null;
  const publishFloor = tfRule.publishFloor ?? DEFAULT_PUBLISH_FLOOR;
  if (confidence < publishFloor) return null;
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
      higherBias, effectiveBias, ruleVersion: RULE_VERSION, publishFloor,
      marketActivityScore: roundPrice(activeMarket.activityScore),
      marketQuoteVolume: roundPrice(activeMarket.quoteVolume),
      marketTradeCount: roundPrice(activeMarket.tradeCount),
      marketOpenInterestValue: roundPrice(activeMarket.openInterestValue),
      modelVersion: "v13_scalping",
      sourceTimeframes: SCAN_TIMEFRAMES,
      performanceSnapshot: performanceSnapshot ? {
        sampleSize: performanceSnapshot.sampleSize,
        long: performanceSnapshot.LONG,
        short: performanceSnapshot.SHORT,
      } : null,
      timeframeRule: tfRule,
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
  const tradeTimeframes = getTradeTimeframes();
  // Build bias for each trade timeframe separately
  const htf = {
    daily:   analyses["1d"]  || null,
    twelveH: analyses["12h"] || null,
    fourH:   analyses["4h"]  || null,
    oneH:    analyses["1h"]  || null,
  };
  const candidates = tradeTimeframes
    .map(tf => {
      if (!analyses[tf]) return null;
      const bias = getHigherTimeframeBias(analyses, tf); // pass trade TF for correct bias
      return buildCandidate(coin, tf, analyses[tf], bias, htf, marketActivity, performanceSnapshot);
    })
    .filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.confidence - a.confidence)[0];
}

// ─── Signal Evaluation (TP/SL only) ──────────────────────────────────────────
// Expiry is handled by checkAndExpireSignals() every 30 seconds.
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
    const stats = { overall: buildTally(), LONG: buildTally(), SHORT: buildTally(), "5m": buildTally(), "1m": buildTally() };
    for (const sig of signals) {
      const isWin  = WIN_RESULTS.has(sig.result);
      const isLoss = LOSS_RESULTS.has(sig.result);
      if (!isWin && !isLoss) continue; // EXPIRED excluded
      const key = isWin ? "wins" : "losses";
      stats.overall[key] += 1;
      if (stats[sig.side]) stats[sig.side][key] += 1;
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
  const signal = createSignal({
    coin: payload.coin, side: payload.side, timeframe: payload.timeframe || "5m",
    entry: payload.entry, stopLoss: payload.stopLoss, tp1: payload.tp1, tp2: payload.tp2, tp3: payload.tp3,
    confidence, leverage,
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
// 1m signal expires in 5 min, 5m in 15 min — checked precisely every 30 seconds
async function checkAndExpireSignals() {
  try {
    const signals = await readCollection("signals");
    const active  = signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE);
    if (!active.length) return;
    const nowMs = Date.now();
    const now   = new Date().toISOString();
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
    if (hasExpired) {
      const { writeCollection } = require("../storage/fileStore");
      await writeCollection("signals", updated);
    }
  } catch (e) {
    engineState.lastError = `Expiry check failed: ${e.message}`;
  }
}

function start() {
  if (engineState.timer) { engineState.running = true; return getStatus(); }
  engineState.intervalMs = Number(process.env.SCAN_INTERVAL_MS || engineState.intervalMs || 60000);
  engineState.timer = setInterval(() => {
    scanNow({ source: "ENGINE" }).catch(e => { engineState.lastError = e.message; });
  }, engineState.intervalMs);
  // Separate fast expiry timer — runs every 30 seconds
  engineState.expiryTimer = setInterval(() => {
    checkAndExpireSignals().catch(e => { engineState.lastError = e.message; });
  }, 30 * 1000);
  engineState.running = true;
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
