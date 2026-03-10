const fs = require("fs");
const path = require("path");

const MASTER_PATH = path.join(__dirname, "..", "config", "OpenAPIScripMaster.json");
const FALLBACK_PATH = path.join(__dirname, "..", "config", "smart-instruments.json");

const SEGMENT_MAP = {
  NSE: "EQUITY",
  BSE: "EQUITY",
  NFO: "FNO",
  MCX: "COMMODITY",
  CDS: "CURRENCY",
};

const cache = {
  [MASTER_PATH]: { mtime: 0, data: [] },
  [FALLBACK_PATH]: { mtime: 0, data: [] },
};

function readJson(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (cache[filePath] && stats.mtimeMs === cache[filePath].mtime) {
      return cache[filePath].data;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw || "[]");
    cache[filePath] = { mtime: stats.mtimeMs, data: Array.isArray(data) ? data : [] };
    return cache[filePath].data;
  } catch {
    return [];
  }
}

function normalizeMasterInstrument(entry = {}) {
  const exchange = String(entry.exch_seg || entry.exchange || "").trim().toUpperCase();
  if (!exchange) return null;
  const symbol = String(entry.symbol || entry.name || "").trim();
  if (!symbol) return null;
  const token = String(entry.token || "").trim();
  if (!token) return null;

  const segment = SEGMENT_MAP[exchange] || String(entry.segment || "EQUITY").trim().toUpperCase();
  return {
    symbol: `${exchange}:${symbol}`,
    tradingSymbol: symbol,
    exchange,
    segment,
    token,
    lotSize: Number(entry.lotsize || entry.lot_size || 1),
    expiry: entry.expiry || null,
    strike: entry.strike || null,
    instrumentType: entry.instrumenttype || entry.instrument_type || "",
  };
}

function normalizeFallbackInstrument(entry = {}) {
  return {
    symbol: String(entry.symbol || entry.tradingSymbol || "").trim(),
    tradingSymbol: String(entry.tradingSymbol || entry.symbol || "").trim(),
    exchange: String(entry.exchange || "NSE").trim().toUpperCase(),
    segment: String(entry.segment || "EQUITY").trim().toUpperCase(),
    token: String(entry.token || "").trim(),
    lotSize: Number(entry.lotSize || entry.lotsize || 1),
    expiry: entry.expiry || null,
    strike: entry.strike || null,
    instrumentType: entry.instrumentType || entry.instrumenttype || "",
  };
}

function loadUniverse() {
  const master = readJson(MASTER_PATH)
    .map(normalizeMasterInstrument)
    .filter(Boolean);
  if (master.length) return master;
  return readJson(FALLBACK_PATH)
    .map(normalizeFallbackInstrument)
    .filter((instrument) => instrument.symbol && instrument.token);
}

function getInstrumentUniverse(options = {}) {
  const segments = String(options.segments || process.env.SMART_ALLOWED_SEGMENTS || "EQUITY,FNO,COMMODITY")
    .split(",")
    .map((segment) => segment.trim().toUpperCase())
    .filter(Boolean);
  const exchanges = String(options.exchanges || process.env.SMART_ALLOWED_EXCHANGES || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const instrumentTypes = String(options.instrumentTypes || process.env.SMART_ALLOWED_INSTRUMENT_TYPES || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const limit = Number(options.limit || process.env.SMART_MAX_INSTRUMENTS || 80);

  const segmentSet = new Set(segments);
  const exchangeSet = new Set(exchanges);
  const typeSet = new Set(instrumentTypes);

  const universe = loadUniverse().filter((instrument) => {
    if (!instrument.symbol || !instrument.token) return false;
    if (segmentSet.size && !segmentSet.has(instrument.segment)) return false;
    if (exchangeSet.size && !exchangeSet.has(instrument.exchange)) return false;
    if (typeSet.size && instrument.instrumentType && !typeSet.has(instrument.instrumentType.toUpperCase())) return false;
    return true;
  });

  return universe.slice(0, Math.max(1, limit));
}

module.exports = {
  getInstrumentUniverse,
};
