const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { getKlines, getPrices, getAllFuturesCoins } = require("./binanceService");
const { analyzeCandles } = require("./indicatorEngine");

// Fallback list if Binance exchangeInfo API fails
const FALLBACK_COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
  "MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT",
  "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT",
];

const SCAN_TIMEFRAMES          = ["5m","15m","1h","4h","12h","1d"];
const DEFAULT_TRADE_TIMEFRAMES = ["5m","15m"];

const SIGNAL_EXPIRY_MS = {
  "5m":  60  * 60 * 1000,
  "15m": 4   * 60 * 60 * 1000,
  "1h":  16  * 60 * 60 * 1000,
  "4h":  72  * 60 * 60 * 1000,
  "12h": 7   * 24 * 60 * 60 * 1000,   // 7 days
  "1d":  21  * 24 * 60 * 60 * 1000,   // 21 days
};

const engineState = {
  intervalMs: Number(process.env.SCAN_INTERVAL_MS || 60000),
  isScanning: false, lastError: null, lastGenerated: 0,
  lastScanAt: null, running: false, scanCount: 0, timer: null,
};

// ─── Utils ────────────────────────────────────────────────────────────────────
function roundPrice(v) {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) >= 1000) return Number(v.toFixed(2));
  if (Math.abs(v) >= 1)    return Number(v.toFixed(4));
  return Number(v.toFixed(6));
}
function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }
// Dynamic coin list — fetches ALL active USDT perpetual pairs from Binance.
// Falls back to env override (SCAN_COINS) or hardcoded list if API fails.
async function getCoinList() {
  const envOverride = String(process.env.SCAN_COINS || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (envOverride.length) return envOverride;

  try {
    const allCoins = await getAllFuturesCoins();
    return allCoins.length ? allCoins : FALLBACK_COINS;
  } catch {
    return FALLBACK_COINS;
  }
}
function getTradeTimeframes() {
  const raw = String(process.env.TRADE_TIMEFRAMES || "").split(",").map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_TRADE_TIMEFRAMES;
}

// ─── HTF Bias ─────────────────────────────────────────────────────────────────
// 4H EMA stack = primary direction anchor.
// 1D = macro veto if strongly opposite.
// 12H = optional strengthener.
function getHigherTimeframeBias(analyses) {
  const a4h  = analyses["4h"];
  const a12h = analyses["12h"];
  const a1d  = analyses["1d"];
  if (!a4h) return "NEUTRAL";

  const fourHBull = a4h.trend.ema50 > a4h.trend.ema100 && a4h.trend.ema100 > a4h.trend.ema200 && (a4h.trend.adx || 0) >= 15 && (a4h.momentum.rsi || 0) >= 40;
  const fourHBear = a4h.trend.ema50 < a4h.trend.ema100 && a4h.trend.ema100 < a4h.trend.ema200 && (a4h.trend.adx || 0) >= 15 && (a4h.momentum.rsi || 100) <= 60;

  if (!fourHBull && !fourHBear) return "NEUTRAL";

  // Regime check: if 4H is in RANGING regime and no strong ADX, skip
  if (a4h.regime === "RANGING" && (a4h.trend.adx || 0) < 20) return "NEUTRAL";

  // 1D veto: daily strongly opposing blocks the trade
  if (a1d) {
    const dStrongBull = a1d.trend.ema50 > a1d.trend.ema100 && (a1d.trend.adx || 0) >= 20;
    const dStrongBear = a1d.trend.ema50 < a1d.trend.ema100 && (a1d.trend.adx || 0) >= 20;
    if (fourHBull && dStrongBear) return "NEUTRAL";
    if (fourHBear && dStrongBull) return "NEUTRAL";
  }

  if (fourHBull) return "BULLISH";
  if (fourHBear) return "BEARISH";
  return "NEUTRAL";
}

// ─── SL/TP ────────────────────────────────────────────────────────────────────
// SL below nearest S/R + ATR buffer.
// TP scaled at 1.2 / 2.0 / 3.0 R — forces asymmetric R:R.
function calculateTargets(side, analysis) {
  const entry  = analysis.currentPrice;
  const atr    = analysis.volatility.atr || analysis.averages.averageRange || entry * 0.003;
  const { low20, high20, previousLow20, previousHigh20 } = analysis.recentSwing;
  const srSup  = analysis.srLevels?.supports?.[0]    ?? null;
  const srRes  = analysis.srLevels?.resistances?.[0] ?? null;

  if (side === "LONG") {
    // SL: below the strongest nearby support (S/R level OR swing low, whichever is closer to entry)
    const anchors = [low20, previousLow20, srSup].filter(v => Number.isFinite(v) && v < entry);
    const anchor  = anchors.length ? Math.max(...anchors) : entry - atr * 2;
    const raw     = (entry - anchor) + atr * 0.3;
    const risk    = clamp(raw, atr * 1.8, atr * 4.5);
    return {
      entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry - risk),
      tp1: roundPrice(entry + risk * 1.2),
      tp2: roundPrice(entry + risk * 2.0),
      tp3: roundPrice(entry + risk * 3.0),
    };
  } else {
    const anchors = [high20, previousHigh20, srRes].filter(v => Number.isFinite(v) && v > entry);
    const anchor  = anchors.length ? Math.min(...anchors) : entry + atr * 2;
    const raw     = (anchor - entry) + atr * 0.3;
    const risk    = clamp(raw, atr * 1.8, atr * 4.5);
    return {
      entry: roundPrice(entry), riskPerUnit: roundPrice(risk),
      stopLoss: roundPrice(entry + risk),
      tp1: roundPrice(entry - risk * 1.2),
      tp2: roundPrice(entry - risk * 2.0),
      tp3: roundPrice(entry - risk * 3.0),
    };
  }
}

// ─── Leverage ─────────────────────────────────────────────────────────────────
function calculateLeverage(analysis, confidence) {
  const price  = analysis.currentPrice;
  const atr    = analysis.volatility.atr || analysis.averages.averageRange || price * 0.003;
  const atrPct = (atr / price) * 100;
  const base   = clamp(2 / atrPct, 3, 15);
  const bonus  = confidence >= 90 ? 2 : confidence >= 80 ? 1 : 0;
  return Math.round(clamp(base + bonus, 3, 20));
}

// ─── Pullback Completion ──────────────────────────────────────────────────────
// Checks that price has pulled back to a key level AND is NOW turning around.
// Key improvement: checks RSI is RISING (not just in range) and MACD histogram
// is increasing — these confirm the TURN, not just the level.
function isPullbackComplete(side, analysis) {
  const { ema21, ema50, vwap }                           = analysis.trend;
  const { rsi, rsiRising, rsiFalling, macd, macdHistIncreasing, macdHistDecreasing, stochRsi } = analysis.momentum;
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
    const rsiOk    = (rsi || 0) >= 45 && (rsi || 0) <= 78 && rsiRising;         // aligned with Gate 3 bullMomentum range
    const macdOk   = macdHistIncreasing;                                          // MACD turning up
    const stochOk  = stochK !== null ? stochK < 65 && stochK > 15 : true;
    return nearLevel && rsiOk && macdOk && stochOk;
  } else {
    const rsiOk    = (rsi || 100) <= 55 && (rsi || 100) >= 22 && rsiFalling;    // aligned with Gate 3 bearMomentum range
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
function buildCandidate(coin, timeframe, analysis, higherBias, htf = {}) {
  const bullConf = [], bearConf = [];
  let bullScore = 0, bearScore = 0;

  const price = analysis.currentPrice;
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
    adlChange, currentVolume, averageVolume,
  } = analysis.volume;
  const { bollinger, atr: rawAtr, bbWidth, bbPctB } = analysis.volatility;
  const atr    = rawAtr || analysis.averages.averageRange || price * 0.003;
  const regime = analysis.regime;
  const stochK = stochRsi?.k ?? null;
  const kdK    = stochKD?.k  ?? null;
  const kdD    = stochKD?.d  ?? null;
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
  const bullTrend = ema50 > ema100 && ema100 > ema200 && price > ema50;
  const bearTrend = ema50 < ema100 && ema100 < ema200 && price < ema50;

  // ── GATE 2: EMA Slope — EMAs must be moving in trade direction ────────────
  // Prevents entering at a flat/turning EMA (whipsaw zone)
  const bullSlope = ema50Rising && ema21Rising;
  const bearSlope = ema50Falling && ema21Falling;

  // ── GATE 3: Momentum — RSI in range + MACD + RSI direction ───────────────
  const bullMomentum =
    (rsi || 0) >= 45 && (rsi || 0) <= 78 &&
    (macd?.MACD || 0) > (macd?.signal || 0) &&
    rsiRising;
  const bearMomentum =
    (rsi || 0) <= 55 && (rsi || 0) >= 22 &&
    (macd?.MACD || 0) < (macd?.signal || 0) &&
    rsiFalling;

  // ── GATE 4: Entry ─────────────────────────────────────────────────────────
  const bullPB = isPullbackComplete("LONG",  analysis);
  const bearPB = isPullbackComplete("SHORT", analysis);
  const bullBO = isVolumeBreakout("LONG",    analysis);
  const bearBO = isVolumeBreakout("SHORT",   analysis);
  const bullEntry = bullPB || bullBO;
  const bearEntry = bearPB || bearBO;

  // ── Divergence override — can allow entry even without slope gate ─────────
  // Classic divergence is so high probability it overrides the slope gate
  const bullDivOverride = (rsiDivBull || macdDivBull) && bullTrend && bullMomentum && bullEntry;
  const bearDivOverride = (rsiDivBear || macdDivBear) && bearTrend && bearMomentum && bearEntry;

  const bullValid =
    higherBias === "BULLISH" && bullTrend && bullMomentum && bullEntry &&
    (bullSlope || bullDivOverride);
  const bearValid =
    higherBias === "BEARISH" && bearTrend && bearMomentum && bearEntry &&
    (bearSlope || bearDivOverride);

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
  const { daily, twelveH, oneH } = htf;
  if (twelveH) {
    const ok = twelveH.trend.ema50 > twelveH.trend.ema100 ? "BULLISH" : "BEARISH";
    if (ok === higherBias) {
      if (higherBias === "BULLISH") { bullScore += 6; bullConf.push("12H trend aligned"); }
      else                          { bearScore += 6; bearConf.push("12H trend aligned"); }
    }
  }
  if (daily) {
    const ok = daily.trend.ema50 > daily.trend.ema100 ? "BULLISH" : "BEARISH";
    if (ok === higherBias) {
      if (higherBias === "BULLISH") { bullScore += 8; bullConf.push("Daily macro aligned"); }
      else                          { bearScore += 8; bearConf.push("Daily macro aligned"); }
    } else {
      if (higherBias === "BULLISH") bullScore -= 5;
      else                          bearScore -= 5;
    }
  }
  if (oneH) {
    const oh1 = oneH.trend.ema50 > oneH.trend.ema100 ? "BULLISH" : "BEARISH";
    if (oh1 === higherBias) {
      if (higherBias === "BULLISH") { bullScore += 5; bullConf.push("1H confirming"); }
      else                          { bearScore += 5; bearConf.push("1H confirming"); }
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
  const MIN_SCORE = 65;
  const MIN_CONF  = 5;

  const side        = bullValid && !bearValid ? "LONG" : !bullValid && bearValid ? "SHORT" : bullScore >= bearScore ? "LONG" : "SHORT";
  const confidence  = side === "LONG" ? bullScore : bearScore;
  const confirmations = side === "LONG" ? bullConf : bearConf;

  if (confidence < MIN_SCORE || confirmations.length < MIN_CONF) return null;

  const targets  = calculateTargets(side, analysis);
  const leverage = calculateLeverage(analysis, confidence);
  if (!Number.isFinite(targets.riskPerUnit) || targets.riskPerUnit <= 0) return null;

  return createSignal({
    coin, side, timeframe, confidence, leverage,
    strength: confidence >= 90 ? "STRONG" : confidence >= 75 ? "MEDIUM" : "WEAK",
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
      regime, volumeSpike, volumeStrong, higherBias, leverage,
      rsiDivBull, rsiDivBear, macdDivBull, macdDivBear,
      riskPerUnit: roundPrice(targets.riskPerUnit),
    },
    patternSummary: analysis.patterns,
    scanMeta: { higherBias, modelVersion: "v9_smart", sourceTimeframes: SCAN_TIMEFRAMES },
    source: "ENGINE",
    ...targets,
  });
}

// ─── Coin Scan ────────────────────────────────────────────────────────────────
async function analyzeCoin(coin) {
  const analyses = {};
  await Promise.all(
    SCAN_TIMEFRAMES.map(async tf => {
      const candles = await getKlines(coin, tf, 260);
      analyses[tf] = analyzeCandles(candles);
    })
  );
  const higherBias = getHigherTimeframeBias(analyses);
  const htf = { daily: analyses["1d"]||null, twelveH: analyses["12h"]||null, fourH: analyses["4h"]||null, oneH: analyses["1h"]||null };
  const candidates = getTradeTimeframes()
    .map(tf => analyses[tf] ? buildCandidate(coin, tf, analyses[tf], higherBias, htf) : null)
    .filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a,b) => b.confidence - a.confidence)[0];
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
    const age    = Date.now() - new Date(sig.createdAt).getTime();
    const expiry = SIGNAL_EXPIRY_MS[sig.timeframe] || SIGNAL_EXPIRY_MS["15m"];
    if (age > expiry) {
      const u = { ...sig, status: SIGNAL_STATUS.CANCELLED, result: "EXPIRED", closedAt: now, updatedAt: now };
      closed.push(u); return u;
    }
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
  return closed;
}

// ─── Persist / Manual / Demo ─────────────────────────────────────────────────
async function persistSignal(signal) {
  return mutateCollection("signals", records => ({ records: [signal, ...records], value: signal }));
}
async function signalExists(candidate) {
  const signals = await readCollection("signals");
  return signals.some(s => s.status === SIGNAL_STATUS.ACTIVE && s.coin === candidate.coin && s.side === candidate.side && s.timeframe === candidate.timeframe);
}
async function createManualSignal(payload, actor) {
  const signal = createSignal({
    coin: payload.coin, side: payload.side, timeframe: payload.timeframe || "5m",
    entry: payload.entry, stopLoss: payload.stopLoss, tp1: payload.tp1, tp2: payload.tp2, tp3: payload.tp3,
    confidence: Number(payload.confidence || 75),
    confirmations: Array.isArray(payload.confirmations) ? payload.confirmations : ["Admin signal"],
    indicatorSnapshot: payload.indicatorSnapshot || {}, patternSummary: payload.patternSummary || {},
    scanMeta: { createdBy: actor?.email || "admin", manual: true, ...(payload.scanMeta || {}) },
    source: payload.source || "MANUAL",
    strength: Number(payload.confidence || 75) >= 70 ? "STRONG" : "MEDIUM",
  });
  await persistSignal(signal);
  return signal;
}
async function seedDemoSignals(actor) {
  const fallback = { BTCUSDT: 65000, ETHUSDT: 3500, SOLUSDT: 150 };
  let live = {};
  try { live = await getPrices(Object.keys(fallback)); } catch {}
  const prices = { ...fallback, ...live };
  const templates = [
    { coin:"BTCUSDT", confidence:78, side:"LONG",  timeframe:"5m" },
    { coin:"ETHUSDT", confidence:74, side:"LONG",  timeframe:"15m" },
    { coin:"SOLUSDT", confidence:72, side:"SHORT", timeframe:"5m" },
  ];
  const created = [];
  for (const t of templates) {
    if (await signalExists(t)) continue;
    const e = roundPrice(prices[t.coin]);
    const setup = t.side === "LONG"
      ? { entry:e, stopLoss:roundPrice(e*0.982), tp1:roundPrice(e*1.009), tp2:roundPrice(e*1.018), tp3:roundPrice(e*1.030) }
      : { entry:e, stopLoss:roundPrice(e*1.018), tp1:roundPrice(e*0.991), tp2:roundPrice(e*0.982), tp3:roundPrice(e*0.970) };
    created.push(await createManualSignal({ ...t, ...setup, confirmations:["Demo signal","Dashboard preview","Admin generated","Preview mode"], indicatorSnapshot:{demo:true}, patternSummary:{bullish:[],bearish:[],neutral:[]}, scanMeta:{demo:true}, source:"DEMO" }, actor));
  }
  return created;
}
async function scanNow({ source = "ENGINE" } = {}) {
  if (engineState.isScanning) return { skipped:true, message:"Scan already in progress" };
  engineState.isScanning = true;
  const generatedSignals = [], errors = [];
  try {
    const closedSignals = await evaluateActiveSignals();
    const coins = await getCoinList();
    for (const coin of coins) {
      try {
        const candidate = await analyzeCoin(coin);
        if (!candidate) continue;
        candidate.source = source; candidate.updatedAt = new Date().toISOString();
        if (await signalExists(candidate)) continue;
        generatedSignals.push(await persistSignal(candidate));
      } catch (e) { errors.push({ coin, message: e.message }); }
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
  engineState.intervalMs = Number(process.env.SCAN_INTERVAL_MS || engineState.intervalMs || 60000);
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
module.exports = { createManualSignal, evaluateActiveSignals, getCoinList, getStatus, scanNow, seedDemoSignals, start, stop };
