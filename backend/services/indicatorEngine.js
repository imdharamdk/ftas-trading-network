const ti = require("technicalindicators");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function last(arr, fallback = null) { return arr && arr.length ? arr[arr.length - 1] : fallback; }
function prev(arr, fallback = null) { return arr && arr.length >= 2 ? arr[arr.length - 2] : fallback; }
function nthLast(arr, n, fallback = null) { return arr && arr.length >= n ? arr[arr.length - n] : fallback; }
function average(values) { return values && values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0; }
function sum(values) { return (values || []).reduce((s, v) => s + v, 0); }

function safeCalc(name, input) {
  const ind = ti[name];
  if (!ind || typeof ind.calculate !== "function") return [];
  try { return ind.calculate(input); } catch { return []; }
}

// ─── VWAP (daily session reset) ──────────────────────────────────────────────
function calculateVWAP(candles) {
  const now = Date.now();
  const startOfDay = now - (now % (24 * 60 * 60 * 1000));
  const session = candles.filter(c => c.openTime >= startOfDay);
  const src = session.length >= 5 ? session : candles.slice(-20);
  let pv = 0, vol = 0;
  src.forEach(c => { const tp = (c.high + c.low + c.close) / 3; pv += tp * c.volume; vol += c.volume; });
  return vol ? pv / vol : last(src.map(c => c.close), null);
}

// ─── Ichimoku ─────────────────────────────────────────────────────────────────
function calculateIchimoku(candles) {
  if (candles.length < 52) return { bullish: false, bearish: false, conversionLine: null, baseLine: null, spanA: null, spanB: null };
  const s9  = candles.slice(-9);
  const s26 = candles.slice(-26);
  const s52 = candles.slice(-52);
  const conv = (Math.max(...s9.map(c => c.high))  + Math.min(...s9.map(c => c.low)))  / 2;
  const base = (Math.max(...s26.map(c => c.high)) + Math.min(...s26.map(c => c.low))) / 2;
  const spanA = (conv + base) / 2;
  const spanB = (Math.max(...s52.map(c => c.high)) + Math.min(...s52.map(c => c.low))) / 2;
  const close = candles[candles.length - 1].close;
  return {
    conversionLine: conv, baseLine: base, spanA, spanB,
    bullish: close > Math.max(spanA, spanB) && conv > base,
    bearish: close < Math.min(spanA, spanB) && conv < base,
    aboveCloud: close > Math.max(spanA, spanB),
    belowCloud: close < Math.min(spanA, spanB),
  };
}

// ─── OBV, ADL, Force Index ────────────────────────────────────────────────────
function calculateOBV(closes, volumes) {
  const vals = [0];
  for (let i = 1; i < closes.length; i++) {
    const p = vals[i - 1];
    vals.push(closes[i] > closes[i-1] ? p + volumes[i] : closes[i] < closes[i-1] ? p - volumes[i] : p);
  }
  return vals;
}
function calculateADL(candles) {
  let r = 0;
  return candles.map(c => { const range = c.high - c.low || 1; r += ((c.close - c.low) - (c.high - c.close)) / range * c.volume; return r; });
}
function calculateForceIndex(closes, volumes) {
  const raw = [];
  for (let i = 1; i < closes.length; i++) raw.push((closes[i] - closes[i-1]) * volumes[i]);
  return last(safeCalc("EMA", { period: 13, values: raw }), last(raw, 0));
}

// ─── RSI Divergence ───────────────────────────────────────────────────────────
// Detects classic price/RSI divergence over last N candles.
// Bullish divergence: price makes lower low BUT RSI makes higher low → reversal up
// Bearish divergence: price makes higher high BUT RSI makes lower high → reversal down
function detectDivergence(closes, rsiValues, lookback = 20) {
  if (closes.length < lookback || rsiValues.length < lookback) {
    return { bullish: false, bearish: false, hidden_bullish: false, hidden_bearish: false };
  }

  const pSlice   = closes.slice(-lookback);
  const rSlice   = rsiValues.slice(-lookback);
  const pCurrent = pSlice[pSlice.length - 1];
  const rCurrent = rSlice[rSlice.length - 1];

  // Find swing lows and highs in price
  let pPrevLow = Infinity, pPrevHigh = -Infinity;
  let rAtPPrevLow = null, rAtPPrevHigh = null;

  for (let i = 1; i < pSlice.length - 1; i++) {
    if (pSlice[i] < pSlice[i-1] && pSlice[i] < pSlice[i+1]) {
      if (pSlice[i] < pPrevLow) { pPrevLow = pSlice[i]; rAtPPrevLow = rSlice[i]; }
    }
    if (pSlice[i] > pSlice[i-1] && pSlice[i] > pSlice[i+1]) {
      if (pSlice[i] > pPrevHigh) { pPrevHigh = pSlice[i]; rAtPPrevHigh = rSlice[i]; }
    }
  }

  // Classic bullish divergence: price lower low, RSI higher low
  const bullDiv = rAtPPrevLow !== null &&
    pCurrent <= pPrevLow * 1.003 &&        // price near/at new low
    rCurrent > rAtPPrevLow + 3;            // RSI meaningfully higher

  // Classic bearish divergence: price higher high, RSI lower high
  const bearDiv = rAtPPrevHigh !== null &&
    pCurrent >= pPrevHigh * 0.997 &&       // price near/at new high
    rCurrent < rAtPPrevHigh - 3;           // RSI meaningfully lower

  // Hidden bullish: price higher low, RSI lower low (trend continuation in uptrend)
  const hiddenBull = rAtPPrevLow !== null &&
    pCurrent > pPrevLow &&
    rCurrent < rAtPPrevLow - 3;

  // Hidden bearish: price lower high, RSI higher high (trend continuation in downtrend)
  const hiddenBear = rAtPPrevHigh !== null &&
    pCurrent < pPrevHigh &&
    rCurrent > rAtPPrevHigh + 3;

  return { bullish: bullDiv, bearish: bearDiv, hidden_bullish: hiddenBull, hidden_bearish: hiddenBear };
}

// ─── MACD Divergence ─────────────────────────────────────────────────────────
function detectMacdDivergence(closes, macdValues, lookback = 20) {
  if (!macdValues || macdValues.length < lookback) return { bullish: false, bearish: false };
  const pSlice = closes.slice(-lookback);
  const mSlice = macdValues.slice(-lookback).map(m => m.histogram || 0);
  const pCurr  = pSlice[pSlice.length - 1];
  const mCurr  = mSlice[mSlice.length - 1];

  let pLow = Infinity, mAtLow = null, pHigh = -Infinity, mAtHigh = null;
  for (let i = 1; i < pSlice.length - 1; i++) {
    if (pSlice[i] < pSlice[i-1] && pSlice[i] < pSlice[i+1] && pSlice[i] < pLow) { pLow = pSlice[i]; mAtLow = mSlice[i]; }
    if (pSlice[i] > pSlice[i-1] && pSlice[i] > pSlice[i+1] && pSlice[i] > pHigh) { pHigh = pSlice[i]; mAtHigh = mSlice[i]; }
  }

  return {
    bullish: mAtLow !== null && pCurr <= pLow * 1.003 && mCurr > mAtLow,
    bearish: mAtHigh !== null && pCurr >= pHigh * 0.997 && mCurr < mAtHigh,
  };
}

// ─── Market Regime ────────────────────────────────────────────────────────────
// Detect if market is TRENDING, RANGING, or VOLATILE
// This prevents applying trend-following logic to a ranging market
function detectMarketRegime(closes, highs, lows, atr, adx) {
  if (!atr || !closes.length) return "UNKNOWN";

  // ADX-based: >25 = trending, <20 = ranging
  if (adx) {
    if (adx >= 28) return "TRENDING";
    if (adx <= 18) return "RANGING";
  }

  // Fallback: Price range vs ATR
  const range20 = Math.max(...highs.slice(-20)) - Math.min(...lows.slice(-20));
  const atr20   = atr * 20;
  if (range20 > atr20 * 1.5) return "TRENDING";
  if (range20 < atr20 * 0.6) return "RANGING";

  return "NEUTRAL";
}

// ─── Support / Resistance levels ─────────────────────────────────────────────
// Simple pivot-based S/R — finds recent swing high/lows and clusters them.
// Results are sorted by proximity to the current price so index [0] is nearest.
function detectSRLevels(candles, lookback = 50) {
  const c = candles.slice(-lookback);
  const currentPrice = c[c.length - 1].close;
  const supports = [], resistances = [];

  for (let i = 2; i < c.length - 2; i++) {
    // Swing low
    if (c[i].low < c[i-1].low && c[i].low < c[i-2].low &&
        c[i].low < c[i+1].low && c[i].low < c[i+2].low) {
      supports.push(c[i].low);
    }
    // Swing high
    if (c[i].high > c[i-1].high && c[i].high > c[i-2].high &&
        c[i].high > c[i+1].high && c[i].high > c[i+2].high) {
      resistances.push(c[i].high);
    }
  }

  // Sort by proximity to current price — nearest level is index [0]
  const byProximity = (a, b) => Math.abs(a - currentPrice) - Math.abs(b - currentPrice);

  return {
    supports:    supports.sort(byProximity).slice(0, 3),
    resistances: resistances.sort(byProximity).slice(0, 3),
  };
}

// ─── Candle Quality ───────────────────────────────────────────────────────────
// Body-to-range ratio — strong candles have large body vs total range
// Also detects candle direction and wick structure
function analyzeCandleQuality(candles) {
  if (!candles.length) return { bodyRatio: 0.5, bullish: false, bearish: false, hammered: false };
  const last2 = candles.slice(-3);
  const scores = last2.map(c => {
    const range  = c.high - c.low || 0.0001;
    const body   = Math.abs(c.close - c.open);
    const upper  = c.high - Math.max(c.open, c.close);
    const lower  = Math.min(c.open, c.close) - c.low;
    return { bodyRatio: body / range, bullCandle: c.close > c.open, upperWick: upper / range, lowerWick: lower / range };
  });

  const avgBodyRatio = average(scores.map(s => s.bodyRatio));
  const recentBull   = scores.filter(s => s.bullCandle).length > scores.length / 2;
  const recentBear   = !recentBull;
  // Hammer: small body near top, long lower wick (bullish reversal signal)
  const lastS        = scores[scores.length - 1];
  const hammered     = lastS.lowerWick > 0.5 && lastS.bodyRatio < 0.35;
  const shootingStar = lastS.upperWick > 0.5 && lastS.bodyRatio < 0.35;

  return { bodyRatio: avgBodyRatio, bullish: recentBull, bearish: recentBear, hammered, shootingStar };
}

// ─── Heikin-Ashi ─────────────────────────────────────────────────────────────
function toHeikinAshi(candles) {
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const c    = candles[i];
    const haC  = (c.open + c.high + c.low + c.close) / 4;
    const haO  = i === 0 ? (c.open + c.close) / 2 : (ha[i-1].open + ha[i-1].close) / 2;
    const haH  = Math.max(c.high, haO, haC);
    const haL  = Math.min(c.low,  haO, haC);
    ha.push({ open: haO, high: haH, low: haL, close: haC, volume: c.volume, openTime: c.openTime });
  }
  return ha;
}

// ─── Candlestick Patterns ────────────────────────────────────────────────────
function detectPatterns(candles) {
  const input = {
    open:  candles.map(c => c.open),
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
  };

  const bullishChecks = [
    ["bullishengulfingpattern", "Bullish Engulfing"],
    ["bullishharami",           "Bullish Harami"],
    ["bullishharamicross",      "Bullish Harami Cross"],
    ["bullishinvertedhammer",   "Bullish Inverted Hammer"],
    ["bullishhammer",           "Bullish Hammer"],
    ["bullishmarubozu",         "Bullish Marubozu"],
    ["bullishspinningtop",      "Bullish Spinning Top"],
    ["piercingline",            "Piercing Line"],
    ["morningstar",             "Morning Star"],
    ["morningdojistar",         "Morning Doji Star"],
    ["threewhitesoldiers",      "Three White Soldiers"],
    ["tweezerbottom",           "Tweezer Bottom"],
    ["dragonflydoji",           "Dragonfly Doji"],
    ["hammerpattern",           "Hammer Pattern"],
    ["abandonedbaby",           "Abandoned Baby (Bull)"],
  ];

  const bearishChecks = [
    ["bearishengulfingpattern", "Bearish Engulfing"],
    ["bearishharami",           "Bearish Harami"],
    ["bearishharamicross",      "Bearish Harami Cross"],
    ["bearishinvertedhammer",   "Bearish Inverted Hammer"],
    ["bearishhammer",           "Bearish Hammer"],
    ["bearishmarubozu",         "Bearish Marubozu"],
    ["bearishspinningtop",      "Bearish Spinning Top"],
    ["darkcloudcover",          "Dark Cloud Cover"],
    ["eveningstar",             "Evening Star"],
    ["eveningdojistar",         "Evening Doji Star"],
    ["threeblackcrows",         "Three Black Crows"],
    ["tweezertop",              "Tweezer Top"],
    ["gravestonedoji",          "Gravestone Doji"],
    ["shootingstar",            "Shooting Star"],
    ["hangingman",              "Hanging Man"],
    ["downsidetasukigap",       "Downside Tasuki Gap"],
  ];

  function check(name, input) {
    const cls = ti[name];
    if (!cls) return false;
    try {
      if (typeof cls.hasPattern === "function") return cls.hasPattern(input);
      if (typeof cls.pattern   === "function") return cls.pattern(input).length > 0;
      if (typeof cls.calculate === "function") {
        const res = cls.calculate(input);
        return Array.isArray(res) ? res[res.length - 1] : Boolean(res);
      }
    } catch { return false; }
    return false;
  }

  const bullish = bullishChecks.filter(([n]) => check(n, input)).map(([, l]) => l);
  const bearish = bearishChecks.filter(([n]) => check(n, input)).map(([, l]) => l);
  const neutral = [];
  try {
    if (ti.doji?.hasPattern?.(input)) neutral.push("Doji");
  } catch {
    return { bullish, bearish, neutral };
  }

  return { bullish, bearish, neutral };
}

// ─── Main Analysis ────────────────────────────────────────────────────────────
function analyzeCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 100) return null;

  const opens   = candles.map(c => c.open);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  // ── Trend EMAs ────────────────────────────────────────────────────────────
  const ema9   = last(safeCalc("EMA", { period: 9,   values: closes }), null);
  const ema21  = last(safeCalc("EMA", { period: 21,  values: closes }), null);
  const ema50  = last(safeCalc("EMA", { period: 50,  values: closes }), null);
  const ema100 = last(safeCalc("EMA", { period: 100, values: closes }), null);
  const ema200 = last(safeCalc("EMA", { period: 200, values: closes }), null);
  const wma20  = last(safeCalc("WMA", { period: 20,  values: closes }), null);
  const sma20  = last(safeCalc("SMA", { period: 20,  values: closes }), null);
  const wema14 = last(safeCalc("WEMA",{ period: 14,  values: closes }), null);

  // EMA slopes (current vs 3 candles ago) — is the EMA rising or falling?
  const ema50Series  = safeCalc("EMA", { period: 50,  values: closes });
  const ema21Series  = safeCalc("EMA", { period: 21,  values: closes });
  const ema50Slope   = ema50Series.length >= 4  ? ema50Series[ema50Series.length-1]  - ema50Series[ema50Series.length-4]  : 0;
  const ema21Slope   = ema21Series.length >= 4  ? ema21Series[ema21Series.length-1]  - ema21Series[ema21Series.length-4]  : 0;
  const ema50Rising  = ema50Slope > 0;
  const ema50Falling = ema50Slope < 0;
  const ema21Rising  = ema21Slope > 0;
  const ema21Falling = ema21Slope < 0;

  const trixArr  = safeCalc("TRIX", { period: 18, values: closes });
  const trix     = last(trixArr, null);
  const trixPrev = prev(trixArr, null);

  const adxRaw = last(safeCalc("ADX", { period: 14, high: highs, low: lows, close: closes }), {});
  const adx = adxRaw.adx ?? null;
  const pdi = adxRaw.pdi ?? null;
  const mdi = adxRaw.mdi ?? null;

  const psar = last(safeCalc("PSAR", { high: highs, low: lows, step: 0.02, max: 0.2 }), null);

  const vwap     = calculateVWAP(candles);
  const ichimoku = calculateIchimoku(candles);

  // ── Momentum ──────────────────────────────────────────────────────────────
  const rsiSeries = safeCalc("RSI", { period: 14, values: closes });
  const rsi       = last(rsiSeries, null);
  const rsiPrev   = prev(rsiSeries, null);
  const rsiPrev3  = nthLast(rsiSeries, 4, null);
  // RSI slope direction: is RSI rising or falling?
  const rsiRising  = rsi !== null && rsiPrev !== null && rsi > rsiPrev;
  const rsiFalling = rsi !== null && rsiPrev !== null && rsi < rsiPrev;

  const rsi9 = last(safeCalc("RSI", { period: 9, values: closes }), null);
  const roc  = last(safeCalc("ROC", { period: 12, values: closes }), null);
  const roc5 = last(safeCalc("ROC", { period: 5,  values: closes }), null);

  const macdArr = safeCalc("MACD", { values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const macd     = last(macdArr, {});
  const macdPrev = prev(macdArr, {});
  // MACD histogram increasing = momentum accelerating
  const macdHistIncreasing = (macd.histogram || 0) > (macdPrev.histogram || 0);
  const macdHistDecreasing = (macd.histogram || 0) < (macdPrev.histogram || 0);

  const stochRsi = last(safeCalc("StochasticRSI", { values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 }), {});
  const stochKD  = last(safeCalc("Stochastic", { high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 }), {});
  const cci      = last(safeCalc("CCI", { period: 20, high: highs, low: lows, close: closes }), null);

  const kstArr = safeCalc("KST", { values: closes, rocPer1:10, rocPer2:13, rocPer3:14, rocPer4:15, smaPer1:10, smaPer2:13, smaPer3:14, smaPer4:9, signalPeriod:9 });
  const kst    = last(kstArr, {});

  const midpoints  = highs.map((h, i) => (h + lows[i]) / 2);
  const aoSma5     = safeCalc("SMA", { period: 5,  values: midpoints });
  const aoSma34    = safeCalc("SMA", { period: 34, values: midpoints });
  const aoOffset   = aoSma5.length - aoSma34.length;
  const aoA5       = aoSma5.slice(Math.max(aoOffset, 0));
  const aoA34      = aoSma34.slice(Math.max(-aoOffset, 0));
  const aoSize     = Math.min(aoA5.length, aoA34.length);
  const aoSeries   = [];
  for (let i = 0; i < aoSize; i++) aoSeries.push(aoA5[i] - aoA34[i]);
  const ao     = last(aoSeries, null);
  const aoPrev = prev(aoSeries, null);

  const williamsR = last(safeCalc("WilliamsR", { period: 14, high: highs, low: lows, close: closes }), null);

  // ── Volume ────────────────────────────────────────────────────────────────
  const mfi = last(safeCalc("MFI", { period: 14, high: highs, low: lows, close: closes, volume: volumes }), null);

  const obvSeries = calculateOBV(closes, volumes);
  const adlSeries = calculateADL(candles);
  const obv       = last(obvSeries, 0);
  const adl       = last(adlSeries, 0);
  const obvChange = obv - (obvSeries[obvSeries.length - 2] || obv);
  const adlChange = adl - (adlSeries[adlSeries.length - 2] || adl);
  // OBV trend: is OBV rising consistently over last 5 bars?
  const obvTrending = obvSeries.length >= 5 &&
    obvSeries[obvSeries.length-1] > obvSeries[obvSeries.length-5];

  const forceIndex = calculateForceIndex(closes, volumes);

  const currentVolume = last(volumes, 0);
  const avgVol20      = average(volumes.slice(-20));
  const avgVol5       = average(volumes.slice(-5));
  const volumeSpike   = currentVolume > avgVol20 * 1.5;
  const volumeStrong  = currentVolume > avgVol20 * 2.0;
  // Volume trend: recent 5-bar avg higher than 20-bar avg = increasing participation
  const volumeTrending = avgVol5 > avgVol20 * 1.1;

  const vpResult = safeCalc("VolumeProfile", { quoteAsset: candles.slice(-50).map(c => c.volume * c.close), baseAsset: candles.slice(-50).map(c => c.volume), noOfBars: 12 });
  const vpPOC    = vpResult.length ? vpResult.reduce((a, b) => b.volumeProfile > a.volumeProfile ? b : a, vpResult[0])?.rangeHigh : null;

  // ── Volatility ────────────────────────────────────────────────────────────
  const atr       = last(safeCalc("ATR", { period: 14, high: highs, low: lows, close: closes }), null);
  const bollinger = last(safeCalc("BollingerBands", { period: 20, stdDev: 2, values: closes }), {});
  const bbWidth   = bollinger.upper && bollinger.lower ? bollinger.upper - bollinger.lower : null;
  const stdDev    = last(safeCalc("SD", { period: 20, values: closes }), null);

  // BB %B — where is price within the bands? (0=lower, 0.5=middle, 1=upper)
  const bbPctB = bollinger.upper && bollinger.lower
    ? (last(closes, 0) - bollinger.lower) / (bollinger.upper - bollinger.lower)
    : null;

  // ── Heikin-Ashi ───────────────────────────────────────────────────────────
  const ha        = toHeikinAshi(candles);
  const haLast    = ha[ha.length - 1];
  const haPrev    = ha[ha.length - 2];
  const haLast3   = ha.slice(-3);
  const haBullish = haLast?.close > haLast?.open && haPrev?.close > haPrev?.open;
  const haBearish = haLast?.close < haLast?.open && haPrev?.close < haPrev?.open;
  // Strong HA trend: 3 consecutive same-direction candles
  const haStrongBull = haLast3.every(c => c.close > c.open);
  const haStrongBear = haLast3.every(c => c.close < c.open);
  // HA no lower wick = strong bull; no upper wick = strong bear
  // Use ATR-relative tolerance: wick is "negligible" if smaller than 5% of ATR
  const haAtr = last(safeCalc("ATR", { period: 14, high: ha.map(c => c.high), low: ha.map(c => c.low), close: ha.map(c => c.close) }), null);
  const haWickTolerance = haAtr ? haAtr * 0.05 : (haLast ? (haLast.high - haLast.low) * 0.05 : 0);
  const haNoLowerWick = haLast && (Math.min(haLast.open, haLast.close) - haLast.low) <= haWickTolerance;
  const haNoUpperWick = haLast && (haLast.high - Math.max(haLast.open, haLast.close)) <= haWickTolerance;

  // ── Divergences ───────────────────────────────────────────────────────────
  const rsiDivergence  = detectDivergence(closes, rsiSeries, 30);
  const macdDivergence = detectMacdDivergence(closes, macdArr, 30);

  // ── Market Regime ─────────────────────────────────────────────────────────
  const regime = detectMarketRegime(closes, highs, lows, atr, adx);

  // ── Support/Resistance ───────────────────────────────────────────────────
  const srLevels = detectSRLevels(candles, 50);

  // ── Candle Quality ────────────────────────────────────────────────────────
  const candleQuality = analyzeCandleQuality(candles.slice(-5));

  // ── Patterns ─────────────────────────────────────────────────────────────
  const patterns = detectPatterns(candles.slice(-10));

  // ── Derived ──────────────────────────────────────────────────────────────
  const currentPrice = last(closes, null);
  const averagePrice = average(closes.slice(-20));
  const averageRange = average(candles.slice(-20).map(c => c.high - c.low));

  const trixCrossUp   = trix !== null && trixPrev !== null && trix > 0 && trixPrev <= 0;
  const trixCrossDown = trix !== null && trixPrev !== null && trix < 0 && trixPrev >= 0;
  const kstBullish    = kst.kst !== undefined && kst.signal !== undefined && kst.kst > kst.signal;
  const kstBearish    = kst.kst !== undefined && kst.signal !== undefined && kst.kst < kst.signal;
  const aoCrossUp     = ao !== null && aoPrev !== null && ao > 0 && aoPrev <= 0;
  const aoCrossDown   = ao !== null && aoPrev !== null && ao < 0 && aoPrev >= 0;

  return {
    currentPrice,
    trend: {
      ema9, ema21, ema50, ema100, ema200,
      wma20, sma20, wema14,
      ema50Rising, ema50Falling, ema21Rising, ema21Falling,
      trix, trixCrossUp, trixCrossDown,
      vwap, ichimoku,
      adx, pdi, mdi,
      psar,
      haBullish, haBearish, haStrongBull, haStrongBear, haNoLowerWick, haNoUpperWick,
      direction:
        currentPrice > ema50 && ema50 > ema100 && ema100 > ema200 ? "BULLISH" :
        currentPrice < ema50 && ema50 < ema100 && ema100 < ema200 ? "BEARISH" : "NEUTRAL",
    },
    momentum: {
      rsi, rsiPrev, rsiPrev3, rsiRising, rsiFalling,
      rsi9, macd, macdPrev, macdHistIncreasing, macdHistDecreasing,
      stochRsi, stochKD,
      cci, roc, roc5,
      kst, kstBullish, kstBearish,
      ao, aoPrev, aoCrossUp, aoCrossDown,
      williamsR,
    },
    volume: {
      currentVolume, averageVolume: avgVol20,
      volumeSpike, volumeStrong, volumeTrending,
      obv, obvChange, obvTrending,
      adl, adlChange,
      mfi, forceIndex,
      vpPOC,
    },
    volatility: {
      atr, bollinger, bbWidth, bbPctB, stdDev,
    },
    divergence: {
      rsi: rsiDivergence,
      macd: macdDivergence,
    },
    regime,
    srLevels,
    candleQuality,
    recentSwing: {
      high:          Math.max(...highs.slice(-50)),
      high20:        Math.max(...highs.slice(-20)),
      low:           Math.min(...lows.slice(-50)),
      low20:         Math.min(...lows.slice(-20)),
      previousHigh20: Math.max(...highs.slice(-21, -1)),
      previousLow20:  Math.min(...lows.slice(-21, -1)),
    },
    candles: {
      open: last(opens, null), high: last(highs, null),
      low:  last(lows,  null), close: currentPrice,
    },
    averages: { averagePrice, averageRange, totalVolume: sum(volumes.slice(-20)) },
    patterns,
  };
}

// ─── Fibonacci Retracement & Extension Levels ─────────────────────────────────
// Uses the most significant swing high/low in recent candles (lookback configurable).
// Returns retracement levels (0.236, 0.382, 0.5, 0.618, 0.786) and
// extension levels (1.0, 1.272, 1.414, 1.618, 2.0, 2.618) relative to the swing.
//
// For a BULLISH move  → swing low to swing high  (price retraced from swing high down)
// For a BEARISH move  → swing high to swing low  (price retraced from swing low up)
//
// Returns:
//   swingHigh, swingLow     — the detected swing points
//   retracements            — { level: price } map  (e.g. "0.618": 42100)
//   extensions              — { level: price } map  (e.g. "1.618": 48200)
//   nearestRetrace          — closest retracement level to current price
//   nearestRetraceDistance  — distance as % of swing range
//   atKeyLevel              — true if price is within 0.8% of a key Fib level (0.382/0.5/0.618)
//   atGoldenZone            — true if price is between 0.5 and 0.618 (highest probability zone)
//   trendDir                — "UP" (bullish swing) or "DOWN" (bearish swing)
function computeFibonacci(candles, lookback = 50) {
  const FIB_RETRACEMENTS = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
  const FIB_EXTENSIONS   = [1.0, 1.272, 1.414, 1.618, 2.0, 2.618];
  const KEY_LEVELS       = new Set(["0.382", "0.5", "0.618"]);
  const PROXIMITY_PCT    = 0.008; // 0.8% proximity window

  const slice = candles.slice(-lookback);
  if (slice.length < 5) {
    return { swingHigh: null, swingLow: null, retracements: {}, extensions: {},
      nearestRetrace: null, nearestRetraceDistance: null, atKeyLevel: false, atGoldenZone: false, trendDir: null };
  }

  // Find absolute swing high and low in the lookback window
  let swingHigh = -Infinity, swingHighIdx = 0;
  let swingLow  =  Infinity, swingLowIdx  = 0;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i].high > swingHigh) { swingHigh = slice[i].high; swingHighIdx = i; }
    if (slice[i].low  < swingLow)  { swingLow  = slice[i].low;  swingLowIdx  = i; }
  }

  const currentPrice = slice[slice.length - 1].close;
  const range = swingHigh - swingLow;
  if (range <= 0) {
    return { swingHigh, swingLow, retracements: {}, extensions: {},
      nearestRetrace: null, nearestRetraceDistance: null, atKeyLevel: false, atGoldenZone: false, trendDir: null };
  }

  // Determine trend direction by which swing came LAST (more recent)
  // trendDir "UP"   = swing low appeared before swing high → bullish leg
  // trendDir "DOWN" = swing high appeared before swing low → bearish leg
  const trendDir = swingHighIdx > swingLowIdx ? "UP" : "DOWN";

  // Compute retracement levels
  // UP trend  → retraces DOWN from swingHigh  → level = swingHigh - ratio * range
  // DOWN trend → retraces UP from swingLow    → level = swingLow  + ratio * range
  const retracements = {};
  for (const ratio of FIB_RETRACEMENTS) {
    const key = String(ratio);
    retracements[key] = trendDir === "UP"
      ? roundP(swingHigh - ratio * range)
      : roundP(swingLow  + ratio * range);
  }

  // Compute extension levels
  // UP trend  → extends ABOVE swingHigh → level = swingHigh + (ratio - 1) * range
  // DOWN trend → extends BELOW swingLow  → level = swingLow  - (ratio - 1) * range
  const extensions = {};
  for (const ratio of FIB_EXTENSIONS) {
    const key = String(ratio);
    extensions[key] = trendDir === "UP"
      ? roundP(swingLow  + ratio * range)
      : roundP(swingHigh - ratio * range);
  }

  // Find nearest retracement level to current price
  let nearestRetrace = null, nearestRetraceDistance = Infinity;
  for (const [key, level] of Object.entries(retracements)) {
    const dist = Math.abs(currentPrice - level) / range;
    if (dist < nearestRetraceDistance) { nearestRetraceDistance = dist; nearestRetrace = key; }
  }

  // atKeyLevel: price within 0.8% of 0.382, 0.5, or 0.618
  const atKeyLevel = nearestRetrace !== null &&
    KEY_LEVELS.has(nearestRetrace) &&
    Math.abs(currentPrice - retracements[nearestRetrace]) / currentPrice <= PROXIMITY_PCT;

  // Golden zone: price between 0.5 and 0.618 retracement
  const fib50  = retracements["0.5"];
  const fib618 = retracements["0.618"];
  const [zoneLo, zoneHi] = trendDir === "UP"
    ? [Math.min(fib50, fib618), Math.max(fib50, fib618)]
    : [Math.min(fib50, fib618), Math.max(fib50, fib618)];

  // Expand zone slightly (±0.3% buffer) so price just above/below still counts
  const atGoldenZone = currentPrice >= zoneLo * 0.997 && currentPrice <= zoneHi * 1.003;

  return {
    swingHigh: roundP(swingHigh), swingLow: roundP(swingLow),
    range: roundP(range), trendDir,
    retracements, extensions,
    nearestRetrace, nearestRetraceDistance: roundP(nearestRetraceDistance),
    atKeyLevel, atGoldenZone,
  };
}

function roundP(v) {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) >= 1000) return Number(v.toFixed(2));
  if (Math.abs(v) >= 1)    return Number(v.toFixed(4));
  return Number(v.toFixed(6));
}

module.exports = { analyzeCandles, computeFibonacci };
