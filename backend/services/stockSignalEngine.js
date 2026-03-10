const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { analyzeCandles } = require("./indicatorEngine");
const { getInstrumentUniverse } = require("./smartInstrumentService");
const { getCandles, getLtp } = require("./smartApiService");

// FIX 2: 4h interval Angel One EQ stocks ke liye invalid hai — sirf 15m, 1h, 1d use karo
const SCAN_TIMEFRAMES = String(process.env.SMART_TRADE_TIMEFRAMES || "15m,1h,1d")
  .split(",").map(i => i.trim()).filter(Boolean);

const MAX_INSTRUMENTS          = Number(process.env.SMART_MAX_INSTRUMENTS || 40);
const MAX_SIGNALS_PER_INSTRUMENT = Number(process.env.SMART_SIGNALS_PER_INSTRUMENT || 2);
const ENGINE_INTERVAL_MS       = Number(process.env.SMART_SCAN_INTERVAL_MS || 300000); // 5 min default

const WIN_RESULTS  = new Set(["TP1_HIT", "TP2_HIT", "TP3_HIT"]);
const LOSS_RESULTS = new Set(["SL_HIT"]);

// FIX 2: Angel One ke valid interval strings — FOUR_HOURS EQ ke liye kaam nahi karta
const TIMEFRAME_INTERVALS = {
  "1m":  { interval: "ONE_MINUTE",      minutes: 1    },
  "3m":  { interval: "THREE_MINUTE",    minutes: 3    },
  "5m":  { interval: "FIVE_MINUTE",     minutes: 5    },
  "10m": { interval: "TEN_MINUTE",      minutes: 10   },
  "15m": { interval: "FIFTEEN_MINUTE",  minutes: 15   },
  "30m": { interval: "THIRTY_MINUTE",   minutes: 30   },
  "1h":  { interval: "ONE_HOUR",        minutes: 60   },
  "1d":  { interval: "ONE_DAY",         minutes: 1440 },
  // NOTE: "4h" / FOUR_HOURS -> Angel One EQ stocks pe 400 error deta hai, isliye remove kiya
};

// FIX 1: Requests ke beech delay — Angel One rate limit se bachne ke liye
const REQUEST_DELAY_MS = Number(process.env.SMART_REQUEST_DELAY_MS || 500); // 500ms between calls

const engineState = {
  intervalMs:    ENGINE_INTERVAL_MS,
  isScanning:    false,
  lastError:     null,
  lastGenerated: 0,
  lastScanAt:    null,
  running:       false,
  scanCount:     0,
  timer:         null,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function roundPrice(value) {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) >= 1000) return Number(value.toFixed(2));
  if (Math.abs(value) >= 1)    return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}
function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

function buildTargetPrices(side, entry, risk) {
  const multipliers = [0.55, 1.05, 1.65];
  if (side === "LONG") return multipliers.map(m => roundPrice(entry + risk * m));
  return multipliers.map(m => roundPrice(entry - risk * m));
}

async function fetchCandles(instrument, timeframe, approxCandles = 200) {
  const meta = TIMEFRAME_INTERVALS[timeframe];
  if (!meta) {
    console.warn(`[stockEngine] Unknown timeframe: ${timeframe}`);
    return null;
  }

  const to   = new Date();
  const from = new Date(to.getTime() - meta.minutes * 60 * 1000 * (approxCandles + 20));

  try {
    const rows = await getCandles({
      exchange:    instrument.exchange,
      symbolToken: instrument.token,
      interval:    meta.interval,
      from,
      to,
    });

    if (!Array.isArray(rows) || rows.length < 50) {
      console.warn(`[stockEngine] Insufficient candles ${instrument.tradingSymbol} ${timeframe}: got ${Array.isArray(rows) ? rows.length : 0}`);
      return null;
    }

    return rows.map(row => ({
      openTime: new Date(row[0]).getTime(),
      open:     Number(row[1]),
      high:     Number(row[2]),
      low:      Number(row[3]),
      close:    Number(row[4]),
      volume:   Number(row[5] || 0),
    }));
  } catch (err) {
    // 403 = rate limit, 400 = bad params — dono log karo
    console.warn(`[stockEngine] Candle fetch failed ${instrument.tradingSymbol} ${timeframe}: ${err.message}`);
    return null;
  }
}

function buildCandidate(instrument, timeframe, analysis) {
  const { trend = {}, momentum = {}, volatility = {} } = analysis || {};
  const ema21  = trend.ema21;
  const ema50  = trend.ema50;
  const ema200 = trend.ema200;
  const adx    = trend.adx || 0;
  const rsi    = momentum.rsi || 50;
  const atr    = volatility.atr || analysis.currentPrice * 0.004;
  const price  = analysis.currentPrice;

  if (!Number.isFinite(price) || !Number.isFinite(atr) || !ema21 || !ema50 || !ema200) {
    return null;
  }

  const macdHist     = momentum.macd?.histogram || 0;
  const emaTrendBull = ema21 > ema50 * 0.998 && ema50 > ema200 * 0.995;
  const emaTrendBear = ema21 < ema50 * 1.002 && ema50 < ema200 * 1.005;
  const adxAcceptable = adx >= 13;
  const adxStrong     = adx >= 18;
  const rsiLongOk     = rsi >= 35 && rsi <= 78;
  const rsiShortOk    = rsi >= 22 && rsi <= 65;

  let side = null;
  if      (emaTrendBull && adxAcceptable && rsiLongOk)  side = "LONG";
  else if (emaTrendBear && adxAcceptable && rsiShortOk) side = "SHORT";
  else if (adxStrong && Math.abs(macdHist) >= 0.25)     side = macdHist >= 0 ? "LONG" : "SHORT";
  else return null;

  const confirmations = [];
  if (adx >= 25)                                                         confirmations.push("ADX strong");
  if ((trend.diPlus  || 0) > (trend.diMinus || 0) && side === "LONG")  confirmations.push("+DI lead");
  if ((trend.diMinus || 0) > (trend.diPlus  || 0) && side === "SHORT") confirmations.push("-DI lead");
  if (Math.abs(macdHist) >= 0.2)                                        confirmations.push("MACD impulse");

  const baseConfidence = side === "LONG" ? 72 : 70;
  const confidence     = clamp(baseConfidence + confirmations.length * 3 + Math.round((adx - 20) / 2), 55, 96);
  const risk           = clamp(atr * 1.35, price * 0.001, price * 0.05);
  const [tp1, tp2, tp3] = buildTargetPrices(side, price, risk);

  const signal = createSignal({
    coin:      instrument.symbol || instrument.tradingSymbol,
    side,
    confidence,
    leverage:  1,
    timeframe,
    entry:     roundPrice(price),
    stopLoss:  roundPrice(side === "LONG" ? price - risk : price + risk),
    tp1, tp2, tp3,
    strength:  confidence >= 85 ? "STRONG" : "MEDIUM",
    source:    "SMART_ENGINE",
    confirmations,
  });

  signal.scanMeta = {
    instrument: {
      exchange:      instrument.exchange,
      tradingSymbol: instrument.tradingSymbol,
      segment:       instrument.segment,
      token:         instrument.token,
      lotSize:       instrument.lotSize,
      expiry:        instrument.expiry || null,
      symbol:        instrument.symbol,
    },
    timeframe,
    modelVersion: "smart_v2",
  };

  signal.indicatorSnapshot = {
    ema21:  roundPrice(ema21),
    ema50:  roundPrice(ema50),
    ema200: roundPrice(ema200),
    adx:    roundPrice(adx),
    rsi:    roundPrice(rsi),
    atr:    roundPrice(atr),
  };

  return signal;
}

async function analyzeInstrument(instrument) {
  const candidates = [];
  for (const timeframe of SCAN_TIMEFRAMES) {
    // FIX 1: Har API call ke baad delay — rate limit avoid karne ke liye
    await sleep(REQUEST_DELAY_MS);

    const candles = await fetchCandles(instrument, timeframe);
    if (!candles) continue;

    const analysis = analyzeCandles(candles);
    if (!analysis) continue;

    analysis.currentPrice = candles[candles.length - 1].close;
    const candidate = buildCandidate(instrument, timeframe, analysis);
    if (candidate) {
      console.log(`[stockEngine] ✅ Signal: ${instrument.tradingSymbol} ${timeframe} ${candidate.side} conf=${candidate.confidence}`);
      candidates.push(candidate);
    }
  }
  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(1, MAX_SIGNALS_PER_INSTRUMENT));
}

async function persistSignal(candidate) {
  return mutateCollection("stockSignals", records => {
    const duplicate = records.some(
      r => r.status === SIGNAL_STATUS.ACTIVE &&
           r.coin === candidate.coin &&
           r.timeframe === candidate.timeframe &&
           r.side === candidate.side
    );
    if (duplicate) return { records, value: null };
    return { records: [candidate, ...records], value: candidate };
  });
}

async function evaluateActiveSignals() {
  const signals = await readCollection("stockSignals");
  const active  = signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE);
  if (!active.length) return [];

  const priceMap = new Map();
  for (const signal of active) {
    const instrument = signal.scanMeta?.instrument;
    if (!instrument || priceMap.has(instrument.token)) continue;
    try {
      await sleep(REQUEST_DELAY_MS);
      const ltp   = await getLtp({ exchange: instrument.exchange, symbolToken: instrument.token });
      const price = Number(ltp?.ltp || ltp?.closingPrice);
      if (Number.isFinite(price)) priceMap.set(instrument.token, price);
    } catch (err) {
      console.warn("[stockEngine] LTP fetch failed:", err.message);
    }
  }

  const now    = new Date().toISOString();
  const closed = [];

  await mutateCollection("stockSignals", records =>
    records.map(signal => {
      if (signal.status !== SIGNAL_STATUS.ACTIVE) return signal;
      const instrument = signal.scanMeta?.instrument;
      if (!instrument) return signal;
      const price = priceMap.get(instrument.token);
      if (!Number.isFinite(price)) return signal;

      const hit = result => {
        const updated = { ...signal, status: SIGNAL_STATUS.CLOSED, result, closePrice: roundPrice(price), closedAt: now, updatedAt: now };
        closed.push(updated);
        return updated;
      };

      if (signal.side === "LONG") {
        if (price >= signal.tp3)      return hit("TP3_HIT");
        if (price >= signal.tp2)      return hit("TP2_HIT");
        if (price >= signal.tp1)      return hit("TP1_HIT");
        if (price <= signal.stopLoss) return hit("SL_HIT");
      } else {
        if (price <= signal.tp3)      return hit("TP3_HIT");
        if (price <= signal.tp2)      return hit("TP2_HIT");
        if (price <= signal.tp1)      return hit("TP1_HIT");
        if (price >= signal.stopLoss) return hit("SL_HIT");
      }
      return signal;
    })
  );

  return closed;
}

async function scanUniverse() {
  if (engineState.isScanning) return { generated: [], closed: [] };

  engineState.isScanning = true;
  engineState.lastScanAt  = new Date().toISOString();
  engineState.lastError   = null;

  try {
    const instruments = getInstrumentUniverse().slice(0, MAX_INSTRUMENTS);
    console.log(`[stockEngine] 🔍 Scan started — ${instruments.length} instruments | timeframes: ${SCAN_TIMEFRAMES.join(",")} | delay: ${REQUEST_DELAY_MS}ms`);

    const generated = [];

    for (const instrument of instruments) {
      try {
        const candidates = await analyzeInstrument(instrument);
        for (const candidate of candidates) {
          const persisted = await persistSignal(candidate);
          if (persisted) generated.push(persisted);
        }
      } catch (err) {
        console.warn("[stockEngine] Instrument error:", instrument.symbol, err.message);
      }
    }

    const closed = await evaluateActiveSignals();
    engineState.lastGenerated = generated.length;
    engineState.scanCount    += 1;

    console.log(`[stockEngine] ✅ Scan done — generated: ${generated.length}, closed: ${closed.length}, total instruments: ${instruments.length}`);
    return { generated, closed };
  } catch (err) {
    engineState.lastError = err.message;
    console.error("[stockEngine] Scan failed:", err.message);
    throw err;
  } finally {
    engineState.isScanning = false;
    engineState.lastScanAt  = new Date().toISOString();
  }
}

async function scanNow() { return scanUniverse(); }

function start() {
  if (engineState.running || engineState.timer) return getStatus();
  engineState.running = true;
  engineState.timer   = setInterval(() => {
    scanUniverse().catch(err => {
      engineState.lastError = err.message;
      console.error("[stockEngine] Scheduled scan failed:", err.message);
    });
  }, engineState.intervalMs);
  console.log(`[stockEngine] Engine started, interval: ${engineState.intervalMs}ms`);
  return getStatus();
}

function stop() {
  if (engineState.timer) clearInterval(engineState.timer);
  engineState.timer   = null;
  engineState.running = false;
  return getStatus();
}

function getStatus() {
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

module.exports = { start, stop, scanNow, getStatus, evaluateActiveSignals };
