const fs = require("fs");
const path = require("path");

const INSTRUMENTS_PATH = path.join(__dirname, "..", "config", "smart-instruments.json");

let cachedUniverse = [];
let cachedMtime = 0;

function readInstrumentFile() {
  try {
    const stats = fs.statSync(INSTRUMENTS_PATH);
    if (stats.mtimeMs === cachedMtime && cachedUniverse.length) {
      return cachedUniverse;
    }
    const raw = fs.readFileSync(INSTRUMENTS_PATH, "utf8");
    const data = JSON.parse(raw || "[]");
    cachedUniverse = Array.isArray(data) ? data : [];
    cachedMtime = stats.mtimeMs;
    return cachedUniverse;
  } catch (error) {
    console.warn("[smartInstrument] Failed to read instruments:", error.message);
    cachedUniverse = [];
    cachedMtime = 0;
    return [];
  }
}

function normalizeInstrument(input = {}) {
  return {
    symbol: String(input.symbol || input.tradingSymbol || "").trim(),
    tradingSymbol: String(input.tradingSymbol || input.symbol || "").trim(),
    exchange: String(input.exchange || "NSE").trim().toUpperCase(),
    segment: String(input.segment || "EQUITY").trim().toUpperCase(),
    token: String(input.token || "").trim(),
    lotSize: Number(input.lotSize || 1),
    expiry: input.expiry || null,
  };
}

function getInstrumentUniverse(options = {}) {
  const segments = String(options.segments || process.env.SMART_ALLOWED_SEGMENTS || "EQUITY,FNO,COMMODITY")
    .split(",")
    .map((segment) => segment.trim().toUpperCase())
    .filter(Boolean);
  const whitelist = new Set(segments);
  return readInstrumentFile()
    .map(normalizeInstrument)
    .filter((instrument) => instrument.symbol && instrument.token)
    .filter((instrument) => !whitelist.size || whitelist.has(instrument.segment));
}

module.exports = {
  getInstrumentUniverse,
};
