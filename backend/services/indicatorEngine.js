const ti = require("technicalindicators");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function last(arr, fallback = null) {
  return arr && arr.length ? arr[arr.length - 1] : fallback;
}

function prev(arr, fallback = null) {
  return arr && arr.length >= 2 ? arr[arr.length - 2] : fallback;
}

function average(values) {
  if (!values || !values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sum(values) {
  return (values || []).reduce((s, v) => s + v, 0);
}

function safeCalc(name, input) {
  const ind = ti[name];
  if (!ind || typeof ind.calculate !== "function") return [];
  try { return ind.calculate(input); } catch { return []; }
}

// ─── VWAP (daily session reset) ──────────────────────────────────────────────

function calculateVWAP(candles) {
  const now = Date.now();
  const startOfUtcDay = now - (now % (24 * 60 * 60 * 1000));
  const session = candles.filter((c) => c.openTime >= startOfUtcDay);
  const src = session.length >= 5 ? session : candles.slice(-20);
  let pv = 0, vol = 0;
  src.forEach((c) => {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
  });
  return vol ? pv / vol : last(src.map((c) => c.close), null);
}

// ─── Ichimoku (manual — library version needs more periods) ──────────────────

function calculateIchimoku(candles) {
  if (candles.length < 52) return { bullish: false, bearish: false, conversionLine: null, baseLine: null, spanA: null, spanB: null };
  const s9  = candles.slice(-9);
  const s26 = candles.slice(-26);
  const s52 = candles.slice(-52);
  const conversionLine = (Math.max(...s9.map(c => c.high))  + Math.min(...s9.map(c => c.low)))  / 2;
  const baseLine       = (Math.max(...s26.map(c => c.high)) + Math.min(...s26.map(c => c.low))) / 2;
  const spanA = (conversionLine + baseLine) / 2;
  const spanB = (Math.max(...s52.map(c => c.high)) + Math.min(...s52.map(c => c.low))) / 2;
  const close = candles[candles.length - 1].close;
  return {
    conversionLine, baseLine, spanA, spanB,
    bullish: close > Math.max(spanA, spanB) && conversionLine > baseLine,
    bearish: close < Math.min(spanA, spanB) && conversionLine < baseLine,
  };
}

// ─── OBV, ADL, Force Index (manual — library versions match) ─────────────────

function calculateOBV(closes, volumes) {
  const vals = [0];
  for (let i = 1; i < closes.length; i++) {
    const p = vals[i - 1];
    if (closes[i] > closes[i - 1])      vals.push(p + volumes[i]);
    else if (closes[i] < closes[i - 1]) vals.push(p - volumes[i]);
    else                                 vals.push(p);
  }
  return vals;
}

function calculateADL(candles) {
  let running = 0;
  return candles.map((c) => {
    const range = c.high - c.low || 1;
    running += ((c.close - c.low) - (c.high - c.close)) / range * c.volume;
    return running;
  });
}

function calculateForceIndex(closes, volumes) {
  const raw = [];
  for (let i = 1; i < closes.length; i++) raw.push((closes[i] - closes[i - 1]) * volumes[i]);
  const ema = safeCalc("EMA", { period: 13, values: raw });
  return last(ema, last(raw, 0));
}

// ─── Heikin-Ashi conversion ───────────────────────────────────────────────────

function toHeikinAshi(candles) {
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen  = i === 0 ? (c.open + c.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh  = Math.max(c.high, haOpen, haClose);
    const haLow   = Math.min(c.low,  haOpen, haClose);
    ha.push({ open: haOpen, high: haHigh, low: haLow, close: haClose, volume: c.volume, openTime: c.openTime });
  }
  return ha;
}

// ─── Candlestick patterns via library ────────────────────────────────────────

function detectPatterns(candles) {
  const input = {
    open:  candles.map(c => c.open),
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
  };

  const bullishChecks = [
    ["bullishengulfingpattern",  "Bullish Engulfing"],
    ["bullishharami",            "Bullish Harami"],
    ["bullishharamicross",       "Bullish Harami Cross"],
    ["bullishinvertedhammer",    "Bullish Inverted Hammer"],
    ["bullishhammer",            "Bullish Hammer"],
    ["bullishmarubozu",          "Bullish Marubozu"],
    ["bullishspinningtop",       "Bullish Spinning Top"],
    ["piercingline",             "Piercing Line"],
    ["morningstar",              "Morning Star"],
    ["morningdojistar",          "Morning Doji Star"],
    ["threewhitesoldiers",       "Three White Soldiers"],
    ["tweezerbottom",            "Tweezer Bottom"],
    ["dragonflydoji",            "Dragonfly Doji"],
    ["hammerpattern",            "Hammer Pattern"],
    ["abandonedbaby",            "Abandoned Baby (Bull)"],
  ];

  const bearishChecks = [
    ["bearishengulfingpattern",  "Bearish Engulfing"],
    ["bearishharami",            "Bearish Harami"],
    ["bearishharamicross",       "Bearish Harami Cross"],
    ["bearishinvertedhammer",    "Bearish Inverted Hammer"],
    ["bearishhammer",            "Bearish Hammer"],
    ["bearishmarubozu",          "Bearish Marubozu"],
    ["bearishspinningtop",       "Bearish Spinning Top"],
    ["darkcloudcover",           "Dark Cloud Cover"],
    ["eveningstar",              "Evening Star"],
    ["eveningdojistar",          "Evening Doji Star"],
    ["threeblackcrows",          "Three Black Crows"],
    ["tweezertop",               "Tweezer Top"],
    ["gravestonedoji",           "Gravestone Doji"],
    ["shootingstar",             "Shooting Star"],
    ["hangingman",               "Hanging Man"],
    ["downsidetasukigap",        "Downside Tasuki Gap"],
  ];

  function check(name, input) {
    const cls = ti[name];
    if (!cls) return false;
    try {
      // Some patterns expose .hasPattern(), others expose .pattern()
      if (typeof cls.hasPattern === "function") return cls.hasPattern(input);
      if (typeof cls.pattern === "function")    return cls.pattern(input).length > 0;
      if (typeof cls.calculate === "function") {
        const res = cls.calculate(input);
        return Array.isArray(res) ? res[res.length - 1] : Boolean(res);
      }
    } catch { return false; }
    return false;
  }

  const bullish = bullishChecks.filter(([name]) => check(name, input)).map(([, label]) => label);
  const bearish = bearishChecks.filter(([name]) => check(name, input)).map(([, label]) => label);

  // Doji is neutral
  const neutral = [];
  const dojiCls = ti["doji"];
  try {
    if (dojiCls && typeof dojiCls.hasPattern === "function" && dojiCls.hasPattern(input)) neutral.push("Doji");
  } catch {}

  return { bullish, bearish, neutral };
}

// ─── Main analysis ────────────────────────────────────────────────────────────

function analyzeCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 210) return null;

  const opens   = candles.map(c => c.open);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  // ── Trend ────────────────────────────────────────────────────────────────
  const ema9   = last(safeCalc("EMA", { period: 9,   values: closes }), null);
  const ema21  = last(safeCalc("EMA", { period: 21,  values: closes }), null);
  const ema50  = last(safeCalc("EMA", { period: 50,  values: closes }), null);
  const ema100 = last(safeCalc("EMA", { period: 100, values: closes }), null);
  const ema200 = last(safeCalc("EMA", { period: 200, values: closes }), null);
  const wma20  = last(safeCalc("WMA", { period: 20,  values: closes }), null);
  const sma20  = last(safeCalc("SMA", { period: 20,  values: closes }), null);

  // WEMA (Wilder's) — uses period 14
  const wema14 = last(safeCalc("WEMA", { period: 14, values: closes }), null);

  const trixArr = safeCalc("TRIX", { period: 18, values: closes });
  const trix    = last(trixArr, null);
  const trixPrev= prev(trixArr, null);

  const adxRaw = last(safeCalc("ADX", { period: 14, high: highs, low: lows, close: closes }), {});
  const adx = adxRaw.adx ?? null;
  const pdi = adxRaw.pdi ?? null;
  const mdi = adxRaw.mdi ?? null;

  const psar = last(safeCalc("PSAR", { high: highs, low: lows, step: 0.02, max: 0.2 }), null);

  const vwap     = calculateVWAP(candles);
  const ichimoku = calculateIchimoku(candles);

  // Typical Price series
  const typicalPrices = candles.map(c => (c.high + c.low + c.close) / 3);

  // ── Momentum ─────────────────────────────────────────────────────────────
  const rsi  = last(safeCalc("RSI",  { period: 14, values: closes }), null);
  const rsi9 = last(safeCalc("RSI",  { period: 9,  values: closes }), null);
  const roc  = last(safeCalc("ROC",  { period: 12, values: closes }), null);
  const roc5 = last(safeCalc("ROC",  { period: 5,  values: closes }), null);

  const macdArr = safeCalc("MACD", {
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const macd = last(macdArr, {});

  const stochRsi = last(safeCalc("StochasticRSI", {
    values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3,
  }), {});

  // Stochastic KD (classic)
  const stochKD = last(safeCalc("Stochastic", {
    high: highs, low: lows, close: closes, period: 14, signalPeriod: 3,
  }), {});

  const cci = last(safeCalc("CCI", { period: 20, high: highs, low: lows, close: closes }), null);

  const kstArr = safeCalc("KST", {
    values: closes,
    rocPer1: 10, rocPer2: 13, rocPer3: 14, rocPer4: 15,
    smaPer1: 10, smaPer2: 13, smaPer3: 14, smaPer4: 9,
    signalPeriod: 9,
  });
  const kst = last(kstArr, {});

  // Awesome Oscillator — SMA5 of midpoints minus SMA34 of midpoints
  const midpoints = highs.map((h, i) => (h + lows[i]) / 2);
  const aoSma5    = safeCalc("SMA", { period: 5,  values: midpoints });
  const aoSma34   = safeCalc("SMA", { period: 34, values: midpoints });
  const aoOffset  = aoSma5.length - aoSma34.length;
  const aoAligned5  = aoSma5.slice(Math.max(aoOffset, 0));
  const aoAligned34 = aoSma34.slice(Math.max(-aoOffset, 0));
  const aoSize = Math.min(aoAligned5.length, aoAligned34.length);
  const aoSeries = [];
  for (let i = 0; i < aoSize; i++) aoSeries.push(aoAligned5[i] - aoAligned34[i]);
  const ao     = last(aoSeries, null);
  const aoPrev = prev(aoSeries, null);

  // Williams R
  const williamsR = last(safeCalc("WilliamsR", { period: 14, high: highs, low: lows, close: closes }), null);

  // ── Volume ────────────────────────────────────────────────────────────────
  const mfi = last(safeCalc("MFI", { period: 14, high: highs, low: lows, close: closes, volume: volumes }), null);

  const obvSeries  = calculateOBV(closes, volumes);
  const adlSeries  = calculateADL(candles);
  const obv        = last(obvSeries, 0);
  const adl        = last(adlSeries, 0);
  const obvChange  = obv - (obvSeries[obvSeries.length - 2] || obv);
  const adlChange  = adl - (adlSeries[adlSeries.length - 2] || adl);
  const forceIndex = calculateForceIndex(closes, volumes);

  const currentVolume  = last(volumes, 0);
  const averageVolume  = average(volumes.slice(-20));
  const volumeSpike    = currentVolume > averageVolume * 1.5;
  const volumeStrong   = currentVolume > averageVolume * 2.0;

  // Volume Profile (VP) — simplified: use last 50 candles price buckets
  const vpCandles = candles.slice(-50);
  const vpResult  = safeCalc("VolumeProfile", {
    quoteAsset: vpCandles.map(c => c.volume * c.close),
    baseAsset:  vpCandles.map(c => c.volume),
    noOfBars:   12,
  });
  const vpPOC = vpResult.length ? vpResult.reduce((a, b) => (b.volumeProfile > a.volumeProfile ? b : a), vpResult[0])?.rangeHigh : null;

  // ── Volatility ────────────────────────────────────────────────────────────
  const atr = last(safeCalc("ATR", { period: 14, high: highs, low: lows, close: closes }), null);

  const bollinger = last(safeCalc("BollingerBands", { period: 20, stdDev: 2, values: closes }), {});
  const bbWidth   = bollinger.upper && bollinger.lower ? bollinger.upper - bollinger.lower : null;

  const stdDev = last(safeCalc("SD", { period: 20, values: closes }), null);

  // ── Heikin-Ashi trend confirmation ────────────────────────────────────────
  const ha        = toHeikinAshi(candles);
  const haLast    = ha[ha.length - 1];
  const haPrev    = ha[ha.length - 2];
  const haBullish = haLast && haLast.close > haLast.open && haPrev && haPrev.close > haPrev.open;
  const haBearish = haLast && haLast.close < haLast.open && haPrev && haPrev.close < haPrev.open;

  // ── Patterns ──────────────────────────────────────────────────────────────
  const patterns = detectPatterns(candles.slice(-10));

  // ── Derived values ────────────────────────────────────────────────────────
  const currentPrice    = last(closes, null);
  const averagePrice    = average(closes.slice(-20));
  const averageRange    = average(candles.slice(-20).map(c => c.high - c.low));

  const trixCrossUp   = trix !== null && trixPrev !== null && trix > 0 && trixPrev <= 0;
  const trixCrossDown = trix !== null && trixPrev !== null && trix < 0 && trixPrev >= 0;

  const kstBullish = kst.kst !== undefined && kst.signal !== undefined && kst.kst > kst.signal;
  const kstBearish = kst.kst !== undefined && kst.signal !== undefined && kst.kst < kst.signal;

  const aoCrossUp   = ao !== null && aoPrev !== null && ao > 0 && aoPrev <= 0;
  const aoCrossDown = ao !== null && aoPrev !== null && ao < 0 && aoPrev >= 0;

  return {
    currentPrice,
    trend: {
      ema9, ema21, ema50, ema100, ema200,
      wma20, sma20, wema14,
      trix, trixCrossUp, trixCrossDown,
      vwap, ichimoku,
      adx, pdi, mdi,
      psar,
      haBullish, haBearish,
      direction:
        currentPrice > ema50 && ema50 > ema100 && ema100 > ema200
          ? "BULLISH"
          : currentPrice < ema50 && ema50 < ema100 && ema100 < ema200
            ? "BEARISH"
            : "NEUTRAL",
    },
    momentum: {
      rsi, rsi9,
      macd, stochRsi, stochKD,
      cci, roc, roc5,
      kst, kstBullish, kstBearish,
      ao, aoPrev, aoCrossUp, aoCrossDown,
      williamsR,
    },
    volume: {
      currentVolume, averageVolume,
      volumeSpike, volumeStrong,
      obv, obvChange,
      adl, adlChange,
      mfi, forceIndex,
      vpPOC,
    },
    volatility: {
      atr, bollinger, bbWidth, stdDev,
    },
    recentSwing: {
      high:          Math.max(...highs.slice(-50)),
      high20:        Math.max(...highs.slice(-20)),
      low:           Math.min(...lows.slice(-50)),
      low20:         Math.min(...lows.slice(-20)),
      previousHigh20: Math.max(...highs.slice(-21, -1)),
      previousLow20:  Math.min(...lows.slice(-21, -1)),
    },
    candles: {
      open:  last(opens,  null),
      high:  last(highs,  null),
      low:   last(lows,   null),
      close: currentPrice,
    },
    averages: {
      averagePrice,
      averageRange,
      totalVolume: sum(volumes.slice(-20)),
    },
    patterns,
  };
}

module.exports = { analyzeCandles };
