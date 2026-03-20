/**
 * FTAS Shared Constants
 *
 * Single source of truth for values used across backend routes AND
 * exposed to the frontend via the /api/config endpoint.
 *
 * PREVIOUSLY: SIGNAL_EXPIRY_MS was copy-pasted in:
 *   backend/routes/signals.js
 *   backend/services/signalEngine.js
 *   src/pages/Crypto.jsx  (frontend duplicate)
 *
 * NOW: import from here. Frontend reads from /api/config at startup.
 */

// ─── Signal Expiry ─────────────────────────────────────────────────────────────
const SIGNAL_EXPIRY_MS = {
  "1m":    8  * 60 * 1000,   //  8 minutes
  "5m":   25  * 60 * 1000,   // 25 minutes
  "15m":  90  * 60 * 1000,   // 90 minutes
  "30m":   3  * 60 * 60 * 1000,  //  3 hours
  "1h":    6  * 60 * 60 * 1000,  //  6 hours
  "4h":   24  * 60 * 60 * 1000,  // 24 hours
  default: 6  * 60 * 60 * 1000,  //  6 hours fallback
};

function getExpiryMs(timeframe) {
  return SIGNAL_EXPIRY_MS[timeframe] || SIGNAL_EXPIRY_MS.default;
}

// ─── Signal Results ────────────────────────────────────────────────────────────
const WIN_RESULTS  = new Set(["TP1_HIT", "TP2_HIT", "TP3_HIT"]);
const LOSS_RESULTS = new Set(["SL_HIT"]);

function isWinResult(result)  { return WIN_RESULTS.has(result); }
function isLossResult(result) { return LOSS_RESULTS.has(result); }

// ─── Strength thresholds ───────────────────────────────────────────────────────
const STRENGTH_THRESHOLDS = { STRONG: 88, MEDIUM: 80 };

module.exports = {
  SIGNAL_EXPIRY_MS,
  STRENGTH_THRESHOLDS,
  WIN_RESULTS,
  LOSS_RESULTS,
  getExpiryMs,
  isWinResult,
  isLossResult,
};
