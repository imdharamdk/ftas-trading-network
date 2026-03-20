/**
 * FTAS API Response Cache
 *
 * Lightweight in-memory TTL cache for hot read endpoints.
 * Prevents DB hammering when multiple users hit the same endpoint.
 *
 * Usage:
 *   const cache = require("../services/apiCache");
 *
 *   // In a route handler:
 *   const cached = cache.get("signals:active");
 *   if (cached) return res.json(cached);
 *   // ... do expensive work ...
 *   cache.set("signals:active", result, 20); // 20 second TTL
 *   return res.json(result);
 *
 * Cache is invalidated automatically when signals are written
 * (new signal, signal closed) via cache.invalidate(key).
 */

const store = new Map(); // key → { value, expiresAt }

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlSeconds = 30) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function invalidate(key) {
  if (key) {
    store.delete(key);
  }
}

// Invalidate all keys matching a prefix
function invalidatePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

// Clear everything (e.g. after a scan run)
function flush() {
  store.clear();
}

function size() {
  return store.size;
}

module.exports = { get, set, invalidate, invalidatePrefix, flush, size };
