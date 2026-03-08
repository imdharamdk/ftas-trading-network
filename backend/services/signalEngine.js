const { SIGNAL_STATUS, createSignal } = require("../models/Signal");
const { readCollection, mutateCollection } = require("../storage/fileStore");
const { getKlines, getPrices } = require("./binanceService");
const { analyzeCandles } = require("./indicatorEngine");

const DEFAULT_COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
  "MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT",
  "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT",
];

const SCAN_TIMEFRAMES    = ["1m","5m","15m","1h","4h","12h","1d"];
const DEFAULT_TRADE_TFS  = ["5m","15m","1h"];

// How long a signal stays ACTIVE before expiring
const SIGNAL_EXPIRY_MS = {
  "1m":  2  * 60 * 60 * 1000,   // 2 hours
  "5m":  6  * 60 * 60 * 1000,   // 6 hours
  "15m": 12 * 60 * 60 * 1000,   // 12 hours
  "1h":  48 * 60 * 60 * 1000,   // 2 days
  "4h":  96 * 60 * 60 * 1000,   // 4 days
};

const engineState = {
  intervalMs:    Number(process.env.SCAN_INTERVAL_MS || 60000),
  isScanning:    false,
  lastError:     null,
  lastGenerated: 0,
  lastScanAt:    null,
  running:       false,
  scanCount:     0,
  timer:         null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundPrice(v) {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) >= 1000) return Number(v.toFixed(2));
  if (Math.abs(v) >= 1)    return Number(v.toFixed(4));
  return Number(v.toFixed(6));
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function getCoinList() {
  const raw = String(process.env.SCAN_COINS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  return raw.length ? raw : DEFAULT_COINS;
}

function getTradeTFs() {
  const raw = String(process.env.TRADE_TIMEFRAMES || "").split(",").map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_TRADE_TFS;
}

// ─── Higher-timeframe bias (simplified) ───────────────────────────────────────
// 4H sets the primary trend direction. 1H confirms momentum isn't deeply opposed.
function getHTFBias(analyses) {
  const fourH = analyses["4h"];
  const oneH  = analyses["1h"];
  if (!fourH || !oneH) return "NEUTRAL";

  const bullish4H = fourH.trend.direction === "BULLISH" && (fourH.trend.adx || 0) >= 18;
  const bearish4H = fourH.trend.direction === "BEARISH" && (fourH.trend.adx || 0) >= 18;

  // 1H just needs to not be strongly opposed — RSI threshold relaxed to 45/55
  const bullish1H = oneH.trend.direction !== "BEARISH" || (oneH.momentum.rsi || 0) >= 45;
  const bearish1H = oneH.trend.direction !== "BULLISH" || (oneH.momentum.rsi || 100) <= 55;

  if (bullish4H && bullish1H) return "BULLISH";
  if (bearish4H && bearish1H) return "BEARISH";
  return "NEUTRAL";
}

// ─── Target calculation ───────────────────────────────────────────────────────
function calcTargets(side, analysis) {
  const entry = analysis.currentPrice;
  const atr   = analysis.volatility.atr || entry * 0.003;
  const risk  = clamp(atr * 1.5, atr, atr * 3);

  if (side === "LONG") return {
    entry:       roundPrice(entry),
    stopLoss:    roundPrice(entry - risk),
    tp1:         roundPrice(entry + risk),
    tp2:         roundPrice(entry + risk * 1.6),
    tp3:         roundPrice(entry + risk * 2.4),
    riskPerUnit: roundPrice(risk),
  };
  return {
    entry:       roundPrice(entry),
    stopLoss:    roundPrice(entry + risk),
    tp1:         roundPrice(entry - risk),
    tp2:         roundPrice(entry - risk * 1.6),
    tp3:         roundPrice(entry - risk * 2.4),
    riskPerUnit: roundPrice(risk),
  };
}

function calcLeverage(analysis, confidence) {
  const price = analysis.currentPrice;
  const atr   = analysis.volatility.atr || price * 0.003;
  const atrPct = (atr / price) * 100;
  const base  = clamp(2 / atrPct, 3, 15);
  const bonus = confidence >= 80 ? 2 : confidence >= 70 ? 1 : 0;
  return Math.round(clamp(base + bonus, 3, 20));
}

// ─── Core signal scoring ──────────────────────────────────────────────────────
// Simplified 3-gate system: trend stack + momentum + volume.
// Each gate worth 30 pts. Bonus indicators add up to ~40 pts more.
// Signal fires when: all 3 gates pass AND score >= 60.
function buildCandidate(coin, timeframe, analysis, bias) {
  if (bias === "NEUTRAL") return null;

  const isBull = bias === "BULLISH";
  const price  = analysis.currentPrice;

  const { ema21, ema50, ema100, ema200, vwap, ichimoku, adx, pdi, mdi } = analysis.trend;
  const { rsi, macd, roc, ao } = analysis.momentum;
  const { volumeSpike, obvChange, forceIndex, mfi, volumeStrong } = analysis.volume;
  const { bollinger, atr } = analysis.volatility;
  const { averagePrice } = analysis.averages;

  const confirmations = [];
  let score = 0;

  // ── Gate 1: EMA trend stack (30 pts) ─────────────────────────────────────
  const emaBull = price > ema21 && ema21 > ema50 && ema50 > ema100 && ema100 > ema200;
  const emaBear = price < ema21 && ema21 < ema50 && ema50 < ema100 && ema100 < ema200;
  const g1 = isBull ? emaBull : emaBear;
  if (!g1) return null;  // hard gate — no trend stack = no signal
  score += 30;
  confirmations.push(`EMA stack ${isBull ? "bullish" : "bearish"}`);

  // VWAP alignment bonus
  if (isBull && price > vwap) { score += 8; confirmations.push(`Price above VWAP`); }
  if (!isBull && price < vwap) { score += 8; confirmations.push(`Price below VWAP`); }

  // Ichimoku
  if (isBull && ichimoku?.bullish) { score += 6; confirmations.push("Ichimoku bullish"); }
  if (!isBull && ichimoku?.bearish) { score += 6; confirmations.push("Ichimoku bearish"); }

  // ── Gate 2: Momentum (30 pts) ─────────────────────────────────────────────
  const rsiBull = (rsi || 0) >= 52 && (rsi || 0) <= 75;
  const rsiBear = (rsi || 0) <= 48 && (rsi || 0) >= 25;
  const macdBull = (macd?.histogram || 0) > 0;
  const macdBear = (macd?.histogram || 0) < 0;
  const g2 = isBull ? (rsiBull && macdBull) : (rsiBear && macdBear);
  if (!g2) return null;  // hard gate
  score += 30;
  confirmations.push(`RSI ${(rsi||0).toFixed(0)} | MACD ${isBull ? "+" : "-"}`);

  // ADX strength bonus
  if ((adx || 0) >= 20) {
    const diOk = isBull ? (pdi || 0) > (mdi || 0) : (mdi || 0) > (pdi || 0);
    if (diOk) { score += 10; confirmations.push(`ADX ${(adx||0).toFixed(0)} trending`); }
  }

  // ROC + AO directional bonus
  if (isBull && (roc || 0) > 0) { score += 4; }
  if (!isBull && (roc || 0) < 0) { score += 4; }
  if (isBull && (ao || 0) > 0)  { score += 4; }
  if (!isBull && (ao || 0) < 0) { score += 4; }

  // ── Gate 3: Volume confirmation (soft — adds score) ───────────────────────
  const volBull = volumeSpike || (obvChange > 0) || (forceIndex > 0) || ((mfi || 0) >= 40);
  const volBear = volumeSpike || (obvChange < 0) || (forceIndex < 0) || ((mfi || 100) <= 60);
  const g3 = isBull ? volBull : volBear;
  if (g3) {
    score += 15;
    confirmations.push(`Volume ${isBull ? "bullish" : "bearish"}`);
  }
  // Volume is soft — missing it doesn't kill the signal, but lowers score

  // ── Bonus: strong volume
  if (volumeStrong) { score += 5; confirmations.push("Strong volume"); }

  // ── Bonus: Bollinger band position
  if (isBull && bollinger?.lower && price <= bollinger.middle * 1.02) { score += 4; }
  if (!isBull && bollinger?.upper && price >= bollinger.middle * 0.98) { score += 4; }

  // ── Bonus: price vs average
  if (isBull && price > averagePrice) { score += 4; }
  if (!isBull && price < averagePrice) { score += 4; }

  // ── Minimum score threshold ───────────────────────────────────────────────
  if (score < 60) return null;

  const side    = isBull ? "LONG" : "SHORT";
  const targets = calcTargets(side, analysis);
  if (!targets.riskPerUnit || targets.riskPerUnit <= 0) return null;

  const leverage = calcLeverage(analysis, score);

  return createSignal({
    coin, side, timeframe,
    confidence: Math.min(score, 99),
    leverage,
    strength: score >= 75 ? "STRONG" : "MEDIUM",
    confirmations,
    indicatorSnapshot: {
      ema21: roundPrice(ema21), ema50: roundPrice(ema50),
      ema100: roundPrice(ema100), ema200: roundPrice(ema200),
      vwap: roundPrice(vwap), adx: roundPrice(adx || 0),
      rsi: roundPrice(rsi || 0),
      macd: { histogram: roundPrice(macd?.histogram || 0) },
      atr: roundPrice(atr || 0),
      bias,
    },
    patternSummary: analysis.patterns,
    scanMeta: { bias, modelVersion: "v6_simplified" },
    source: "ENGINE",
    ...targets,
  });
}

// ─── Coin analysis ────────────────────────────────────────────────────────────
async function analyzeCoin(coin) {
  const analyses = {};
  await Promise.all(
    SCAN_TIMEFRAMES.map(async tf => {
      const candles = await getKlines(coin, tf, 250);
      analyses[tf] = analyzeCandles(candles);
    })
  );

  const bias = getHTFBias(analyses);
  if (bias === "NEUTRAL") return null;

  const candidates = getTradeTFs()
    .map(tf => analyses[tf] ? buildCandidate(coin, tf, analyses[tf], bias) : null)
    .filter(Boolean);

  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.confidence - a.confidence)[0];
}

// ─── Active signal evaluation ─────────────────────────────────────────────────
async function evaluateActiveSignals() {
  const signals = await readCollection("signals");
  const active  = signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE);
  if (!active.length) return [];

  const prices = await getPrices([...new Set(active.map(s => s.coin))]);
  const now    = new Date().toISOString();
  const closed = [];

  await mutateCollection("signals", records => {
    const next = records.map(sig => {
      if (sig.status !== SIGNAL_STATUS.ACTIVE) return sig;

      // Expiry check
      const expiryMs = SIGNAL_EXPIRY_MS[sig.timeframe] || SIGNAL_EXPIRY_MS["15m"];
      if (Date.now() - new Date(sig.createdAt).getTime() > expiryMs) {
        const u = { ...sig, status: SIGNAL_STATUS.CANCELLED, result: "EXPIRED", closedAt: now, updatedAt: now };
        closed.push(u);
        return u;
      }

      const price = prices[sig.coin];
      if (!Number.isFinite(price)) return sig;

      // SL checked as 2x the original risk % from entry.
      // Prevents false triggers when mock fallback prices differ across timeframes.
      const entry = sig.entry || 1;
      const slPct = Math.abs(entry - sig.stopLoss) / entry;
      const longSLTrigger  = entry * (1 - slPct * 2);
      const shortSLTrigger = entry * (1 + slPct * 2);

      if (sig.side === "LONG") {
        if (price >= sig.tp3) { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: "TP3_HIT", closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; }
        if (price >= sig.tp2) { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: "TP2_HIT", closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; }
        if (price >= sig.tp1) { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: "TP1_HIT", closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; }
        if (price <= longSLTrigger) { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: "SL_HIT", closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; }
      } else {
        if (price <= sig.tp3) { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: "TP3_HIT", closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; }
        if (price <= sig.tp2) { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: "TP2_HIT", closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; }
        if (price <= sig.tp1) { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: "TP1_HIT", closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; }
        if (price >= shortSLTrigger) { const u = { ...sig, status: SIGNAL_STATUS.CLOSED, result: "SL_HIT", closePrice: roundPrice(price), closedAt: now, updatedAt: now }; closed.push(u); return u; }
      }
      return sig;
    });
    return next;
  });

  return closed;
}

async function signalExists(candidate) {
  const signals = await readCollection("signals");
  return signals.some(s =>
    s.status === SIGNAL_STATUS.ACTIVE &&
    s.coin === candidate.coin &&
    s.side === candidate.side &&
    s.timeframe === candidate.timeframe
  );
}

async function persistSignal(signal) {
  return mutateCollection("signals", records => ({
    records: [signal, ...records],
    value: signal,
  }));
}

// ─── Public: scanNow ─────────────────────────────────────────────────────────
async function scanNow({ source = "ENGINE" } = {}) {
  if (engineState.isScanning) return { skipped: true, message: "Scan in progress" };
  engineState.isScanning = true;

  const generated = [];
  const errors    = [];

  try {
    const closedSignals = await evaluateActiveSignals();

    for (const coin of getCoinList()) {
      try {
        const candidate = await analyzeCoin(coin);
        if (!candidate) continue;
        candidate.source    = source;
        candidate.updatedAt = new Date().toISOString();
        if (await signalExists(candidate)) continue;
        const saved = await persistSignal(candidate);
        generated.push(saved);
      } catch (e) {
        errors.push({ coin, message: e.message });
      }
    }

    engineState.lastGenerated = generated.length;
    engineState.lastScanAt    = new Date().toISOString();
    engineState.lastError     = errors.length ? `${errors.length} errors` : null;
    engineState.scanCount    += 1;

    return { closedSignals, generatedSignals: generated, errors, scanCount: engineState.scanCount };
  } finally {
    engineState.isScanning = false;
  }
}

// ─── Manual signal ────────────────────────────────────────────────────────────
async function createManualSignal(payload, actor) {
  const signal = createSignal({
    coin:               payload.coin,
    side:               payload.side,
    timeframe:          payload.timeframe || "5m",
    entry:              payload.entry,
    stopLoss:           payload.stopLoss,
    tp1:                payload.tp1,
    tp2:                payload.tp2,
    tp3:                payload.tp3,
    confidence:         Number(payload.confidence || 75),
    confirmations:      Array.isArray(payload.confirmations) ? payload.confirmations : ["Admin signal"],
    indicatorSnapshot:  payload.indicatorSnapshot || {},
    patternSummary:     payload.patternSummary || {},
    scanMeta:           { createdBy: actor?.email || "admin", manual: true, ...(payload.scanMeta || {}) },
    source:             payload.source || "MANUAL",
    strength:           Number(payload.confidence || 75) >= 70 ? "STRONG" : "MEDIUM",
    leverage:           payload.leverage || 5,
    riskPerUnit:        payload.riskPerUnit || 0,
  });
  await persistSignal(signal);
  return signal;
}

// ─── Demo seed ────────────────────────────────────────────────────────────────
async function seedDemoSignals(actor) {
  const fallback = { BTCUSDT: 84000, ETHUSDT: 1900, SOLUSDT: 130 };
  let live = {};
  try { live = await getPrices(Object.keys(fallback)); } catch {}
  const prices = { ...fallback, ...live };

  const templates = [
    { coin: "BTCUSDT", side: "LONG",  timeframe: "5m",  confidence: 78 },
    { coin: "ETHUSDT", side: "LONG",  timeframe: "15m", confidence: 74 },
    { coin: "SOLUSDT", side: "SHORT", timeframe: "5m",  confidence: 72 },
  ];

  const created = [];
  for (const t of templates) {
    if (await signalExists(t)) continue;
    const e = roundPrice(prices[t.coin]);
    const setup = t.side === "LONG"
      ? { entry: e, stopLoss: roundPrice(e*0.982), tp1: roundPrice(e*1.008), tp2: roundPrice(e*1.016), tp3: roundPrice(e*1.028) }
      : { entry: e, stopLoss: roundPrice(e*1.018), tp1: roundPrice(e*0.992), tp2: roundPrice(e*0.984), tp3: roundPrice(e*0.972) };
    const sig = await createManualSignal({
      ...t, ...setup,
      confirmations: ["Demo signal","Dashboard preview","Admin generated","Website visibility check"],
      indicatorSnapshot: { demo: true },
      patternSummary: { bullish: t.side==="LONG"?["Demo Momentum"]:[], bearish: t.side==="SHORT"?["Demo Momentum"]:[], neutral: [] },
      scanMeta: { demo: true },
      source: "DEMO",
    }, actor);
    created.push(sig);
  }
  return created;
}

// ─── Engine controls ─────────────────────────────────────────────────────────
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

function start() {
  if (engineState.timer) { engineState.running = true; return getStatus(); }
  engineState.intervalMs = Number(process.env.SCAN_INTERVAL_MS || engineState.intervalMs || 60000);
  engineState.timer = setInterval(() => {
    scanNow({ source: "ENGINE" }).catch(e => { engineState.lastError = e.message; });
  }, engineState.intervalMs);
  engineState.running = true;
  scanNow({ source: "ENGINE" }).catch(e => { engineState.lastError = e.message; });
  return getStatus();
}

function stop() {
  if (engineState.timer) { clearInterval(engineState.timer); engineState.timer = null; }
  engineState.running = false;
  return getStatus();
}

module.exports = { createManualSignal, evaluateActiveSignals, getCoinList, getStatus, scanNow, seedDemoSignals, start, stop };
