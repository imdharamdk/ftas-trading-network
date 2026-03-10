const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { analyzeCandles } = require("./indicatorEngine");
const { getInstrumentUniverse } = require("./smartInstrumentService");
const { getCandles, getLtp } = require("./smartApiService");

// Sirf 2 timeframes — kam API calls, zyada success rate
const SCAN_TIMEFRAMES = String(process.env.SMART_TRADE_TIMEFRAMES || "1h,1d")
  .split(",").map(i => i.trim()).filter(Boolean);

const MAX_INSTRUMENTS            = Number(process.env.SMART_MAX_INSTRUMENTS || 15);
const MAX_SIGNALS_PER_INSTRUMENT = Number(process.env.SMART_SIGNALS_PER_INSTRUMENT || 1);
const ENGINE_INTERVAL_MS         = Number(process.env.SMART_SCAN_INTERVAL_MS || 600000); // 10 min
const REQUEST_DELAY_MS           = Number(process.env.SMART_REQUEST_DELAY_MS || 1500);   // 1.5s between calls

// Angel One valid intervals for EQ stocks
// FOUR_HOURS is NOT valid for EQ — only futures support it
const TIMEFRAME_INTERVALS = {
  "1m":  { interval: "ONE_MINUTE",     minutes: 1    },
  "5m":  { interval: "FIVE_MINUTE",    minutes: 5    },
  "15m": { interval: "FIFTEEN_MINUTE", minutes: 15   },
  "30m": { interval: "THIRTY_MINUTE",  minutes: 30   },
  "1h":  { interval: "ONE_HOUR",       minutes: 60   },
  "1d":  { interval: "ONE_DAY",        minutes: 1440 },
};

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

const sleep = ms => new Promise(res => setTimeout(res, ms));

function roundPrice(v) {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) >= 1000) return Number(v.toFixed(2));
  if (Math.abs(v) >= 1)    return Number(v.toFixed(3));
  return Number(v.toFixed(5));
}
const clamp = (v, mn, mx) => Math.min(Math.max(v, mn), mx);

function buildTargetPrices(side, entry, risk) {
  const m = [0.55, 1.05, 1.65];
  return side === "LONG"
    ? m.map(x => roundPrice(entry + risk * x))
    : m.map(x => roundPrice(entry - risk * x));
}

async function fetchCandles(instrument, timeframe) {
  const meta = TIMEFRAME_INTERVALS[timeframe];
  if (!meta) return null;

  // Angel One max candles per call limits:
  // 1d  -> 2 years ok
  // 1h  -> 30 days
  // 15m -> 60 days
  const approx = 200;
  const to   = new Date();
  const from = new Date(to.getTime() - meta.minutes * 60 * 1000 * (approx + 10));

  try {
    const rows = await getCandles({
      exchange:    instrument.exchange,
      symbolToken: instrument.token,
      interval:    meta.interval,
      from,
      to,
    });

    if (!Array.isArray(rows) || rows.length < 50) {
      console.warn(`[stockEngine] Few/no candles: ${instrument.tradingSymbol} ${timeframe} → ${Array.isArray(rows) ? rows.length : 0} rows`);
      return null;
    }

    return rows.map(r => ({
      openTime: new Date(r[0]).getTime(),
      open:  Number(r[1]),
      high:  Number(r[2]),
      low:   Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5] || 0),
    }));
  } catch (err) {
    console.warn(`[stockEngine] Candle error ${instrument.tradingSymbol} ${timeframe}: ${err.message}`);
    return null;
  }
}

function buildCandidate(instrument, timeframe, analysis) {
  const { trend = {}, momentum = {}, volatility = {} } = analysis || {};
  const { ema21, ema50, ema200, adx = 0 } = trend;
  const rsi  = momentum.rsi || 50;
  const atr  = volatility.atr || analysis.currentPrice * 0.004;
  const price = analysis.currentPrice;

  if (!Number.isFinite(price) || !Number.isFinite(atr) || !ema21 || !ema50 || !ema200) return null;

  const macdHist      = momentum.macd?.histogram || 0;
  const emaTrendBull  = ema21 > ema50 * 0.998  && ema50 > ema200 * 0.995;
  const emaTrendBear  = ema21 < ema50 * 1.002  && ema50 < ema200 * 1.005;
  const adxOk         = adx >= 13;
  const adxStrong     = adx >= 18;

  let side = null;
  if      (emaTrendBull && adxOk && rsi >= 35 && rsi <= 78) side = "LONG";
  else if (emaTrendBear && adxOk && rsi >= 22 && rsi <= 65) side = "SHORT";
  else if (adxStrong && Math.abs(macdHist) >= 0.25)         side = macdHist >= 0 ? "LONG" : "SHORT";
  else return null;

  const confirmations = [];
  if (adx >= 25)                                                       confirmations.push("ADX strong");
  if ((trend.diPlus||0)  > (trend.diMinus||0) && side === "LONG")    confirmations.push("+DI lead");
  if ((trend.diMinus||0) > (trend.diPlus||0)  && side === "SHORT")   confirmations.push("-DI lead");
  if (Math.abs(macdHist) >= 0.2)                                       confirmations.push("MACD impulse");

  const confidence = clamp(
    (side === "LONG" ? 72 : 70) + confirmations.length * 3 + Math.round((adx - 20) / 2),
    55, 96
  );
  const risk        = clamp(atr * 1.35, price * 0.001, price * 0.05);
  const [tp1,tp2,tp3] = buildTargetPrices(side, price, risk);

  const signal = createSignal({
    coin: instrument.symbol || instrument.tradingSymbol,
    side, confidence, leverage: 1, timeframe,
    entry:    roundPrice(price),
    stopLoss: roundPrice(side === "LONG" ? price - risk : price + risk),
    tp1, tp2, tp3,
    strength: confidence >= 85 ? "STRONG" : "MEDIUM",
    source:   "SMART_ENGINE",
    confirmations,
  });

  signal.scanMeta = {
    instrument: {
      exchange: instrument.exchange, tradingSymbol: instrument.tradingSymbol,
      segment:  instrument.segment,  token: instrument.token,
      lotSize:  instrument.lotSize,  expiry: instrument.expiry || null,
      symbol:   instrument.symbol,
    },
    timeframe, modelVersion: "smart_v3",
  };

  signal.indicatorSnapshot = {
    ema21: roundPrice(ema21), ema50: roundPrice(ema50), ema200: roundPrice(ema200),
    adx: roundPrice(adx), rsi: roundPrice(rsi), atr: roundPrice(atr),
  };

  return signal;
}

async function analyzeInstrument(instrument) {
  const candidates = [];
  for (const tf of SCAN_TIMEFRAMES) {
    await sleep(REQUEST_DELAY_MS); // Rate limit se bachao
    const candles = await fetchCandles(instrument, tf);
    if (!candles) continue;

    const analysis = analyzeCandles(candles);
    if (!analysis) continue;

    analysis.currentPrice = candles[candles.length - 1].close;
    const candidate = buildCandidate(instrument, tf, analysis);
    if (candidate) {
      console.log(`[stockEngine] ✅ ${instrument.tradingSymbol} ${tf} ${candidate.side} conf=${candidate.confidence}`);
      candidates.push(candidate);
    }
  }
  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_SIGNALS_PER_INSTRUMENT);
}

async function persistSignal(candidate) {
  return mutateCollection("stockSignals", records => {
    const dup = records.some(r =>
      r.status === SIGNAL_STATUS.ACTIVE &&
      r.coin === candidate.coin &&
      r.timeframe === candidate.timeframe &&
      r.side === candidate.side
    );
    if (dup) return { records, value: null };
    return { records: [candidate, ...records], value: candidate };
  });
}

async function evaluateActiveSignals() {
  const signals = await readCollection("stockSignals");
  const active  = signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE);
  if (!active.length) return [];

  const priceMap = new Map();
  for (const s of active) {
    const inst = s.scanMeta?.instrument;
    if (!inst || priceMap.has(inst.token)) continue;
    try {
      await sleep(REQUEST_DELAY_MS);
      const ltp   = await getLtp({ exchange: inst.exchange, symbolToken: inst.token });
      const price = Number(ltp?.ltp || ltp?.closingPrice);
      if (Number.isFinite(price)) priceMap.set(inst.token, price);
    } catch (e) {
      console.warn("[stockEngine] LTP failed:", e.message);
    }
  }

  const now = new Date().toISOString();
  const closed = [];

  await mutateCollection("stockSignals", records => records.map(s => {
    if (s.status !== SIGNAL_STATUS.ACTIVE) return s;
    const inst  = s.scanMeta?.instrument;
    if (!inst) return s;
    const price = priceMap.get(inst.token);
    if (!Number.isFinite(price)) return s;

    const hit = result => {
      const u = { ...s, status: SIGNAL_STATUS.CLOSED, result, closePrice: roundPrice(price), closedAt: now, updatedAt: now };
      closed.push(u);
      return u;
    };

    if (s.side === "LONG") {
      if (price >= s.tp3)     return hit("TP3_HIT");
      if (price >= s.tp2)     return hit("TP2_HIT");
      if (price >= s.tp1)     return hit("TP1_HIT");
      if (price <= s.stopLoss) return hit("SL_HIT");
    } else {
      if (price <= s.tp3)     return hit("TP3_HIT");
      if (price <= s.tp2)     return hit("TP2_HIT");
      if (price <= s.tp1)     return hit("TP1_HIT");
      if (price >= s.stopLoss) return hit("SL_HIT");
    }
    return s;
  }));

  return closed;
}

async function scanUniverse() {
  if (engineState.isScanning) return { generated: [], closed: [] };
  engineState.isScanning = true;
  engineState.lastScanAt = new Date().toISOString();
  engineState.lastError  = null;

  try {
    const instruments = getInstrumentUniverse().slice(0, MAX_INSTRUMENTS);
    console.log(`[stockEngine] 🔍 Starting scan: ${instruments.length} stocks | timeframes: ${SCAN_TIMEFRAMES} | delay: ${REQUEST_DELAY_MS}ms`);

    const generated = [];
    for (const inst of instruments) {
      try {
        const candidates = await analyzeInstrument(inst);
        for (const c of candidates) {
          const saved = await persistSignal(c);
          if (saved) generated.push(saved);
        }
      } catch (e) {
        console.warn("[stockEngine] Error:", inst.symbol, e.message);
      }
    }

    const closed = await evaluateActiveSignals();
    engineState.lastGenerated = generated.length;
    engineState.scanCount    += 1;
    console.log(`[stockEngine] ✅ Done: ${generated.length} new signals, ${closed.length} closed`);
    return { generated, closed };
  } catch (e) {
    engineState.lastError = e.message;
    throw e;
  } finally {
    engineState.isScanning = false;
    engineState.lastScanAt = new Date().toISOString();
  }
}

const scanNow = () => scanUniverse();

function start() {
  if (engineState.running || engineState.timer) return getStatus();
  engineState.running = true;
  engineState.timer   = setInterval(
    () => scanUniverse().catch(e => { engineState.lastError = e.message; }),
    engineState.intervalMs
  );
  console.log(`[stockEngine] Engine started — interval: ${engineState.intervalMs / 1000}s`);
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
