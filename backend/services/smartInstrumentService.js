const fs = require("fs");
const path = require("path");

const MASTER_PATH   = path.join(__dirname, "..", "config", "OpenAPIScripMaster.json");
const CURATED_PATH  = path.join(__dirname, "..", "config", "smart-instruments.json");

const SEGMENT_MAP = {
  NSE: "EQUITY", BSE: "EQUITY",
  NFO: "FNO",    MCX: "COMMODITY",
  CDS: "CURRENCY",
};

// Ye types Angel One ke getCandleData se data NAHI dete
const NON_TRADEABLE_TYPES = new Set([
  "AMXIDX", "INDEX",
  "OPTSTK", "OPTFUT", "OPTIDX", "OPTCUR", "OPTBLN", "OPTIRC",
  "UNDIRC", "UNDCUR",
]);

// Scan priority — EQ stocks pehle, phir Futures
const TYPE_PRIORITY = {
  "": 0, "FUTSTK": 1, "FUTIDX": 2,
  "FUTCOM": 3, "COMDTY": 4, "FUTENR": 5, "FUTBAS": 6, "FUTBLN": 7,
};

const cache = {};

function readJson(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (cache[filePath] && stats.mtimeMs === cache[filePath].mtime) {
      return cache[filePath].data;
    }
    const raw  = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw || "[]");
    cache[filePath] = { mtime: stats.mtimeMs, data: Array.isArray(data) ? data : [] };
    return cache[filePath].data;
  } catch {
    return [];
  }
}

function resolveSegment(exchange) {
  if (SEGMENT_MAP[exchange]) return SEGMENT_MAP[exchange];
  if (exchange === "BFO")   return "FNO";
  if (exchange === "NCO")   return "CURRENCY";
  if (exchange === "NCDEX") return "COMMODITY";
  if (exchange === "MCX")   return "COMMODITY";
  if (exchange === "BSE")   return "EQUITY";
  return "EQUITY";
}

function normalizeMaster(entry = {}) {
  const exchange = String(entry.exch_seg || entry.exchange || "").trim().toUpperCase();
  if (!exchange) return null;
  const symbol = String(entry.symbol || entry.name || "").trim();
  if (!symbol) return null;
  const token = String(entry.token || "").trim();
  if (!token) return null;
  const instrumentType = String(entry.instrumenttype || entry.instrument_type || "").trim();
  if (NON_TRADEABLE_TYPES.has(instrumentType)) return null;

  // Bonds, SGBs, ETF NAV instruments filter karo — inke candles nahi milte
  // Pattern: naam mein digits + letters mix (782HP32, SGBJUN27 etc.)
  // EXCEPTION: Commodity futures (FUTCOM, COMDTY) legitimately have digits in their names
  //            e.g. GOLD05JUN26FUT, SILVER05MAY26FUT, CRUDEOIL19MAR26FUT
  const isCommodityFuture = instrumentType === "FUTCOM" || instrumentType === "COMDTY" || exchange === "MCX" || exchange === "NCDEX";
  if (!isCommodityFuture && /\d/.test(symbol.replace(/-EQ$|-BE$|-SM$|-GB$|-SG$/, ""))) return null;

  const segment = resolveSegment(exchange);
  return {
    symbol: `${exchange}:${symbol}`,
    tradingSymbol: symbol,
    exchange,
    segment,
    token,
    lotSize: Number(entry.lotsize || entry.lot_size || 1),
    expiry: entry.expiry || null,
    instrumentType,
  };
}

function normalizeCurated(entry = {}) {
  const symbol = String(entry.symbol || entry.tradingSymbol || "").trim();
  const token  = String(entry.token  || "").trim();
  if (!symbol || !token) return null;
  return {
    symbol,
    tradingSymbol: String(entry.tradingSymbol || entry.symbol || "").trim(),
    exchange:      String(entry.exchange || "NSE").trim().toUpperCase(),
    segment:       String(entry.segment  || "EQUITY").trim().toUpperCase(),
    token,
    lotSize:       Number(entry.lotSize || entry.lotsize || 1),
    expiry:        entry.expiry || null,
    instrumentType: entry.instrumentType || "",
  };
}

function loadUniverse() {
  // Step 1: Curated list HAMESHA pehle load karo — ye top liquid stocks hain
  const curated = readJson(CURATED_PATH)
    .map(normalizeCurated)
    .filter(Boolean);

  // Step 2: Master file se remaining instruments add karo (curated wale skip)
  const curatedTokens = new Set(curated.map(i => i.token));

  const fromMaster = readJson(MASTER_PATH)
    .map(normalizeMaster)
    .filter(Boolean)
    .filter(i => !curatedTokens.has(i.token)); // duplicates avoid karo

  // Curated pehle, phir master se extra
  return [...curated, ...fromMaster];
}

function getInstrumentUniverse(options = {}) {
  const segments = String(options.segments || process.env.SMART_ALLOWED_SEGMENTS || "EQUITY,FNO,COMMODITY")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

  const exchanges = String(options.exchanges || process.env.SMART_ALLOWED_EXCHANGES || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

  const instrumentTypes = String(options.instrumentTypes || process.env.SMART_ALLOWED_INSTRUMENT_TYPES || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

  const limit = Number(options.limit || process.env.SMART_MAX_INSTRUMENTS || 80);
  const query = String(options.query || options.q || "").trim().toUpperCase();

  const segmentSet  = new Set(segments);
  const exchangeSet = new Set(exchanges);
  const typeSet     = new Set(instrumentTypes);

  const universe = loadUniverse().filter(instrument => {
    if (!instrument.symbol || !instrument.token) return false;
    if (segmentSet.size  && !segmentSet.has(instrument.segment))   return false;
    if (exchangeSet.size && !exchangeSet.has(instrument.exchange)) return false;
    if (typeSet.size && instrument.instrumentType && !typeSet.has(instrument.instrumentType.toUpperCase())) return false;

    if (query) {
      const sym = String(instrument.tradingSymbol || instrument.symbol || "").toUpperCase();
      const ex  = String(instrument.exchange || "").toUpperCase();
      if (!sym.includes(query) && !ex.includes(query)) return false;
    }

    return true;
  });

  // Curated list already sorted by priority, master se aaye extra ko type se sort karo
  const curated  = universe.slice(0, readJson(CURATED_PATH).filter(Boolean).length);
  const rest     = universe.slice(curated.length).sort((a, b) => {
    const pa = TYPE_PRIORITY[a.instrumentType] ?? 99;
    const pb = TYPE_PRIORITY[b.instrumentType] ?? 99;
    return pa - pb;
  });

  return [...curated, ...rest].slice(0, Math.max(1, limit));
}

module.exports = { getInstrumentUniverse };
