const { createId } = require("../storage/fileStore");

const SIGNAL_STATUS = {
  ACTIVE: "ACTIVE",
  CANCELLED: "CANCELLED",
  CLOSED: "CLOSED",
};
const MIN_LEVERAGE = 10;
const MAX_LEVERAGE = 50;

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeLeverage(value) {
  const leverage = toNumber(value, MIN_LEVERAGE);
  return Math.min(Math.max(leverage, MIN_LEVERAGE), MAX_LEVERAGE);
}

function createSignal({
  coin,
  confidence = 0,
  confirmations = [],
  entry,
  indicatorSnapshot = {},
  leverage = 10,
  patternSummary = {},
  result = null,
  scanMeta = {},
  side,
  source = "ENGINE",
  status = SIGNAL_STATUS.ACTIVE,
  stopLoss,
  strength = "MEDIUM",
  timeframe = "5m",
  tp1,
  tp2,
  tp3,
}) {
  const now = new Date().toISOString();

  return {
    id: createId("sig"),
    coin: String(coin || "").trim().toUpperCase(),
    side: String(side || "").trim().toUpperCase(),
    entry: toNumber(entry, 0),
    stopLoss: toNumber(stopLoss, 0),
    tp1: toNumber(tp1, 0),
    tp2: toNumber(tp2, 0),
    tp3: toNumber(tp3, 0),
    confidence: toNumber(confidence, 0),
    leverage: normalizeLeverage(leverage),
    timeframe: String(timeframe || "5m").trim(),
    strength: String(strength || "MEDIUM").trim().toUpperCase(),
    source: String(source || "ENGINE").trim().toUpperCase(),
    status,
    result,
    confirmations: Array.isArray(confirmations) ? confirmations : [],
    indicatorSnapshot: indicatorSnapshot || {},
    patternSummary: patternSummary || {},
    scanMeta: scanMeta || {},
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}

module.exports = {
  MAX_LEVERAGE,
  MIN_LEVERAGE,
  SIGNAL_STATUS,
  createSignal,
};
