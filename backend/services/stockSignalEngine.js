const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { analyzeCandles } = require("./indicatorEngine");
const { getInstrumentUniverse } = require("./smartInstrumentService");
const { getCandles, getLtp } = require("./smartApiService");

const SCAN_TIMEFRAMES = String(process.env.SMART_TRADE_TIMEFRAMES || "5m,15m,1h,4h")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const MAX_INSTRUMENTS = Number(process.env.SMART_MAX_INSTRUMENTS || 80);
const MAX_SIGNALS_PER_INSTRUMENT = Number(process.env.SMART_SIGNALS_PER_INSTRUMENT || 2);
const ENGINE_INTERVAL_MS = Number(process.env.SMART_SCAN_INTERVAL_MS || process.env.SCAN_INTERVAL_MS || 120000);
const WIN_RESULTS = new Set(["TP1_HIT", "TP2_HIT", "TP3_HIT"]);
const LOSS_RESULTS = new Set(["SL_HIT"]);

const TIMEFRAME_INTERVALS = {
  "5m":  { interval: "FIVE_MINUTE", minutes: 5 },
  "15m": { interval: "FIFTEEN_MINUTE", minutes: 15 },
  "30m": { interval: "THIRTY_MINUTE", minutes: 30 },
  "1h":  { interval: "ONE_HOUR", minutes: 60 },
  "4h":  { interval: "FOUR_HOURS", minutes: 240 },
  "1d":  { interval: "ONE_DAY", minutes: 1440 },
};

const engineState = {
  intervalMs: ENGINE_INTERVAL_MS,
  isScanning: false,
  lastError: null,
  lastGenerated: 0,
  lastScanAt: null,
  running: false,
  scanCount: 0,
  timer: null,
};

function roundPrice(value) {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) >= 1000) return Number(value.toFixed(2));
  if (Math.abs(value) >= 1) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buildTargetPrices(side, entry, risk) {
  const multipliers = [0.55, 1.05, 1.65];
  if (side === "LONG") {
    return multipliers.map((multiplier) => roundPrice(entry + risk * multiplier));
  }
  return multipliers.map((multiplier) => roundPrice(entry - risk * multiplier));
}

async function fetchCandles(instrument, timeframe, approxCandles = 260) {
  const meta = TIMEFRAME_INTERVALS[timeframe];
  if (!meta) return null;
  const to = new Date();
  const from = new Date(to.getTime() - meta.minutes * 60 * 1000 * (approxCandles + 20));
  const rows = await getCandles({
    exchange: instrument.exchange,
    symbolToken: instrument.token,
    interval: meta.interval,
    from,
    to,
  });

  if (!Array.isArray(rows) || rows.length < 120) {
    return null;
  }

  return rows.map((row) => ({
    openTime: new Date(row[0]).getTime(),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] || 0),
  }));
}

function buildCandidate(instrument, timeframe, analysis) {
  const { trend = {}, momentum = {}, volatility = {} } = analysis || {};
  const ema21 = trend.ema21;
  const ema50 = trend.ema50;
  const ema200 = trend.ema200;
  const adx = trend.adx || 0;
  const rsi = momentum.rsi || 50;
  const atr = volatility.atr || analysis.currentPrice * 0.004;
  const price = analysis.currentPrice;

  if (!Number.isFinite(price) || !Number.isFinite(atr) || !ema21 || !ema50 || !ema200) {
    return null;
  }

  const macdHist = momentum.macd?.histogram || 0;
  const emaTrendBull = ema21 > ema50 * 0.998 && ema50 > ema200 * 0.995;
  const emaTrendBear = ema21 < ema50 * 1.002 && ema50 < ema200 * 1.005;
  const adxAcceptable = adx >= 13;
  const adxStrong = adx >= 18;
  const rsiLongOk = rsi >= 35 && rsi <= 78;
  const rsiShortOk = rsi >= 22 && rsi <= 65;
  let side = null;

  if (emaTrendBull && adxAcceptable && rsiLongOk) {
    side = "LONG";
  } else if (emaTrendBear && adxAcceptable && rsiShortOk) {
    side = "SHORT";
  } else if (adxStrong && Math.abs(macdHist) >= 0.25) {
    side = macdHist >= 0 ? "LONG" : "SHORT";
  } else {
    return null;
  }

  const confirmations = [];
  if (adx >= 25) confirmations.push("ADX strong");
  if ((trend.diPlus || 0) > (trend.diMinus || 0) && side === "LONG") confirmations.push("+DI lead");
  if ((trend.diMinus || 0) > (trend.diPlus || 0) && side === "SHORT") confirmations.push("-DI lead");
  if (Math.abs(macdHist) >= 0.2) confirmations.push("MACD impulse");

  const baseConfidence = side === "LONG" ? 72 : 70;
  const confidence = clamp(baseConfidence + confirmations.length * 3 + Math.round((adx - 20) / 2), 55, 96);
  const risk = clamp(atr * 1.35, price * 0.001, price * 0.05);
  const [tp1, tp2, tp3] = buildTargetPrices(side, price, risk);

  const signal = createSignal({
    coin: instrument.symbol || instrument.tradingSymbol,
    side,
    confidence,
    leverage: 1,
    timeframe,
    entry: roundPrice(price),
    stopLoss: roundPrice(side === "LONG" ? price - risk : price + risk),
    tp1,
    tp2,
    tp3,
    strength: confidence >= 85 ? "STRONG" : "MEDIUM",
    source: "SMART_ENGINE",
    confirmations,
  });

  signal.scanMeta = {
    instrument: {
      exchange: instrument.exchange,
      tradingSymbol: instrument.tradingSymbol,
      segment: instrument.segment,
      token: instrument.token,
      lotSize: instrument.lotSize,
      expiry: instrument.expiry || null,
      symbol: instrument.symbol,
    },
    timeframe,
    modelVersion: "smart_v1",
  };

  signal.indicatorSnapshot = {
    ema21: roundPrice(ema21),
    ema50: roundPrice(ema50),
    ema200: roundPrice(ema200),
    adx: roundPrice(adx),
    rsi: roundPrice(rsi),
    atr: roundPrice(atr),
  };

  return signal;
}

async function analyzeInstrument(instrument) {
  const candidates = [];
  for (const timeframe of SCAN_TIMEFRAMES) {
    const candles = await fetchCandles(instrument, timeframe);
    if (!candles) continue;
    const analysis = analyzeCandles(candles);
    analysis.currentPrice = candles[candles.length - 1].close;
    const candidate = buildCandidate(instrument, timeframe, analysis);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, Math.max(1, MAX_SIGNALS_PER_INSTRUMENT));
}

async function persistSignal(candidate) {
  return mutateCollection("stockSignals", (records) => {
    const duplicate = records.some(
      (record) =>
        record.status === SIGNAL_STATUS.ACTIVE &&
        record.coin === candidate.coin &&
        record.timeframe === candidate.timeframe &&
        record.side === candidate.side,
    );
    if (duplicate) {
      return { records, value: null };
    }
    return {
      records: [candidate, ...records],
      value: candidate,
    };
  });
}

async function evaluateActiveSignals() {
  const signals = await readCollection("stockSignals");
  const active = signals.filter((signal) => signal.status === SIGNAL_STATUS.ACTIVE);
  if (!active.length) return [];

  const priceMap = new Map();
  for (const signal of active) {
    const instrument = signal.scanMeta?.instrument;
    if (!instrument || priceMap.has(instrument.token)) continue;
    try {
      const ltp = await getLtp({ exchange: instrument.exchange, symbolToken: instrument.token });
      const price = Number(ltp?.ltp || ltp?.closingPrice);
      if (Number.isFinite(price)) {
        priceMap.set(instrument.token, price);
      }
    } catch (error) {
      console.warn("[stockEngine] Failed to fetch LTP:", error.message);
    }
  }

  const now = new Date().toISOString();
  const closed = [];

  await mutateCollection("stockSignals", (records) => {
    return records.map((signal) => {
      if (signal.status !== SIGNAL_STATUS.ACTIVE) {
        return signal;
      }
      const instrument = signal.scanMeta?.instrument;
      if (!instrument) return signal;
      const price = priceMap.get(instrument.token);
      if (!Number.isFinite(price)) return signal;

      const hit = (result) => {
        const updated = {
          ...signal,
          status: SIGNAL_STATUS.CLOSED,
          result,
          closePrice: roundPrice(price),
          closedAt: now,
          updatedAt: now,
        };
        closed.push(updated);
        return updated;
      };

      if (signal.side === "LONG") {
        if (price >= signal.tp3) return hit("TP3_HIT");
        if (price >= signal.tp2) return hit("TP2_HIT");
        if (price >= signal.tp1) return hit("TP1_HIT");
        if (price <= signal.stopLoss) return hit("SL_HIT");
      } else {
        if (price <= signal.tp3) return hit("TP3_HIT");
        if (price <= signal.tp2) return hit("TP2_HIT");
        if (price <= signal.tp1) return hit("TP1_HIT");
        if (price >= signal.stopLoss) return hit("SL_HIT");
      }
      return signal;
    });
  });

  return closed;
}

async function scanUniverse() {
  if (engineState.isScanning) {
    return { generated: [], closed: [] };
  }

  engineState.isScanning = true;
  engineState.lastScanAt = new Date().toISOString();
  engineState.lastError = null;

  try {
    const instruments = getInstrumentUniverse().slice(0, MAX_INSTRUMENTS);
    const generated = [];

    for (const instrument of instruments) {
      try {
        const candidates = await analyzeInstrument(instrument);
        if (!candidates.length) continue;
        for (const candidate of candidates) {
          const persisted = await persistSignal(candidate);
          if (persisted) {
            generated.push(persisted);
          }
        }
      } catch (error) {
        console.warn("[stockEngine] Instrument scan failed:", instrument.symbol, error.message);
      }
    }

    const closed = await evaluateActiveSignals();
    engineState.lastGenerated = generated.length;
    engineState.scanCount += 1;
    return { generated, closed };
  } catch (error) {
    engineState.lastError = error.message;
    throw error;
  } finally {
    engineState.isScanning = false;
    engineState.lastScanAt = new Date().toISOString();
  }
}

async function scanNow() {
  return scanUniverse();
}

function start() {
  if (engineState.running || engineState.timer) return getStatus();
  engineState.running = true;
  engineState.timer = setInterval(() => {
    scanUniverse().catch((error) => console.error("[stockEngine] Scheduled scan failed:", error.message));
  }, engineState.intervalMs);
  return getStatus();
}

function stop() {
  if (engineState.timer) {
    clearInterval(engineState.timer);
  }
  engineState.timer = null;
  engineState.running = false;
  return getStatus();
}

function getStatus() {
  // FIX: timer is a circular Timeout object — JSON.stringify crash karta hai isko
  // Isliye sirf serializable fields return karo
  return {
    intervalMs:    engineState.intervalMs,
    isScanning:    engineState.isScanning,
    lastError:     engineState.lastError,
    lastGenerated: engineState.lastGenerated,
    lastScanAt:    engineState.lastScanAt,
    running:       engineState.running,
    scanCount:     engineState.scanCount,
  };
}

module.exports = {
  start,
  stop,
  scanNow,
  getStatus,
  evaluateActiveSignals,
};
