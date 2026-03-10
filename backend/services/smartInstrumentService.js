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

// Ye instrument types Angel One ke getCandleData API se candle data NAHI dete.
// Indexes, Options, aur synthetic instruments ko filter karna zaroori hai —
// warna engine har scan mein silently null return karta hai aur koi signal nahi banta.
const NON_TRADEABLE_TYPES = new Set([
  "AMXIDX",  // NSE/BSE Index level (Nifty 50, BankNifty index — not tradeable contracts)
  "INDEX",   // BSE Index
  "OPTSTK",  // Stock Options
  "OPTFUT",  // Future Options
  "OPTIDX",  // Index Options
  "OPTCUR",  // Currency Options
  "OPTBLN",  // Bond Options
  "OPTIRC",  // Interest Rate Options
  "UNDIRC",  // Underlying Interest Rate
  "UNDCUR",  // Underlying Currency
]);

// Preferred scan order — quality signals inhi se milte hain
const TYPE_PRIORITY = {
  "":       0,  // NSE/BSE EQ stocks (highest priority)
  "FUTSTK": 1,  // Stock Futures
  "FUTIDX": 2,  // Index Futures (NIFTY FUT, BANKNIFTY FUT)
  "FUTCOM": 3,  // Commodity Futures
  "COMDTY": 4,  // MCX Commodity spot
  "FUTENR": 5,  // Energy Futures
  "FUTBAS": 6,  // Base Metal Futures
  "FUTBLN": 7,  // Bond Futures
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

function resolveSegment(exchange) {
  if (SEGMENT_MAP[exchange]) return SEGMENT_MAP[exchange];
  if (exchange === "BFO")   return "FNO";        // BSE Futures & Options
  if (exchange === "NCO")   return "CURRENCY";   // NSE Currency Options
  if (exchange === "NCDEX") return "COMMODITY";  // Commodity derivatives
  return "EQUITY";
}

function normalizeMasterInstrument(entry = {}) {
  const exchange = String(entry.exch_seg || entry.exchange || "").trim().toUpperCase();
  if (!exchange) return null;

  const symbol = String(entry.symbol || entry.name || "").trim();
  if (!symbol) return null;

  const token = String(entry.token || "").trim();
  if (!token) return null;

  const instrumentType = String(entry.instrumenttype || entry.instrument_type || "").trim();

  // Non-tradeable instruments ko yahan hi filter karo — API call waste nahi hogi
  if (NON_TRADEABLE_TYPES.has(instrumentType)) return null;

  const segment = resolveSegment(exchange);

  return {
    symbol: `${exchange}:${symbol}`,
    tradingSymbol: symbol,
    exchange,
    segment,
    token,
    lotSize: Number(entry.lotsize || entry.lot_size || 1),
    expiry: entry.expiry || null,
    strike: entry.strike || null,
    instrumentType,
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
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const exchanges = String(options.exchanges || process.env.SMART_ALLOWED_EXCHANGES || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const instrumentTypes = String(options.instrumentTypes || process.env.SMART_ALLOWED_INSTRUMENT_TYPES || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const limit = Number(options.limit || process.env.SMART_MAX_INSTRUMENTS || 80);

  const segmentSet  = new Set(segments);
  const exchangeSet = new Set(exchanges);
  const typeSet     = new Set(instrumentTypes);

  const universe = loadUniverse().filter((instrument) => {
    if (!instrument.symbol || !instrument.token) return false;
    if (segmentSet.size  && !segmentSet.has(instrument.segment))   return false;
    if (exchangeSet.size && !exchangeSet.has(instrument.exchange)) return false;
    if (typeSet.size && instrument.instrumentType && !typeSet.has(instrument.instrumentType.toUpperCase())) return false;
    return true;
  });

  // Priority sort: EQ stocks pehle, phir Futures, phir baaki
  // Isse ensure hoga ki first MAX_INSTRUMENTS mein best tradeable instruments aayenge
  universe.sort((a, b) => {
    const pa = TYPE_PRIORITY[a.instrumentType] ?? 99;
    const pb = TYPE_PRIORITY[b.instrumentType] ?? 99;
    if (pa !== pb) return pa - pb;
    // Same type ke andar NSE ko BSE se pehle rakhte hain
    if (a.exchange !== b.exchange) {
      if (a.exchange === "NSE") return -1;
      if (b.exchange === "NSE") return 1;
    }
    return 0;
  });

  return universe.slice(0, Math.max(1, limit));
}

module.exports = {
  getInstrumentUniverse,
};
