const { mutateCollection, readCollection, writeCollection } = require("../storage/fileStore");
const { SIGNAL_STATUS } = require("../models/Signal");
const cache = require("./apiCache");

const IST_TZ = "Asia/Kolkata";
const TARGET_HOUR = 5;
const TARGET_MINUTE = 30;

function ws() {
  try { return require("./wsServer"); } catch { return null; }
}

function sse() {
  try { return require("./sseManager"); } catch { return null; }
}

function getIstParts(date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: IST_TZ,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = formatter.formatToParts(date);
    const out = {};
    for (const part of parts) {
      if (part.type !== "literal") out[part.type] = part.value;
    }
    return {
      year: out.year,
      month: out.month,
      day: out.day,
      hour: Number(out.hour),
      minute: Number(out.minute),
    };
  } catch {
    const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
    const ist = new Date(utcMs + 330 * 60000);
    return {
      year: String(ist.getUTCFullYear()),
      month: String(ist.getUTCMonth() + 1).padStart(2, "0"),
      day: String(ist.getUTCDate()).padStart(2, "0"),
      hour: ist.getUTCHours(),
      minute: ist.getUTCMinutes(),
    };
  }
}

function getIstDateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function closeActiveInCollection(name, isStock, reason) {
  const now = new Date().toISOString();
  const closed = [];
  await mutateCollection(name, (records) => {
    return records.map((signal) => {
      if (signal.status !== SIGNAL_STATUS.ACTIVE) return signal;
      const updated = {
        ...signal,
        status: SIGNAL_STATUS.CLOSED,
        result: "EXPIRED",
        closeReason: reason,
        closedAt: now,
        updatedAt: now,
      };
      closed.push(updated);
      return updated;
    });
  });

  if (closed.length) {
    cache.invalidatePrefix(isStock ? "stocks:" : "signals:");
    const wsApi = ws();
    const sseApi = sse();
    for (const signal of closed) {
      try { wsApi?.broadcastClosedSignal?.(signal, isStock); } catch {}
      try { sseApi?.broadcastSignalClosed?.(signal, isStock); } catch {}
    }
  }

  return closed.length;
}

async function clearHistoryInCollection(name, isStock) {
  let removed = 0;
  await mutateCollection(name, (records) => {
    const next = records.filter((signal) => signal.status === SIGNAL_STATUS.ACTIVE);
    removed = records.length - next.length;
    return next;
  });

  if (removed) {
    cache.invalidatePrefix(isStock ? "stocks:" : "signals:");
    try { sse()?.broadcastStatsUpdate?.(); } catch {}
  }

  return removed;
}

let timer = null;
let running = false;

async function runMaintenance({ autoClose, autoClear, reason }) {
  if (running) return { skipped: true };
  running = true;
  try {
    let cryptoClosed = 0;
    let stockClosed = 0;
    let cryptoCleared = 0;
    let stockCleared = 0;

    if (autoClose) {
      [cryptoClosed, stockClosed] = await Promise.all([
        closeActiveInCollection("signals", false, reason),
        closeActiveInCollection("stockSignals", true, reason),
      ]);
    }

    if (autoClear) {
      [cryptoCleared, stockCleared] = await Promise.all([
        clearHistoryInCollection("signals", false),
        clearHistoryInCollection("stockSignals", true),
      ]);
    }

    return { cryptoClosed, stockClosed, cryptoCleared, stockCleared };
  } finally {
    running = false;
  }
}

async function runAutoCloseIfDue() {
  const parts = getIstParts();
  if (parts.hour !== TARGET_HOUR || parts.minute !== TARGET_MINUTE) return;

  const settings = await readCollection("appSettings");
  const record = settings.find((s) => s?.id === "maintenance") || {};

  const dateKey = getIstDateKey(parts);
  const autoCloseDue = Boolean(record.autoCloseSignals) && record.lastAutoCloseDate !== dateKey;
  const autoClearDue = Boolean(record.autoClearHistory) && record.lastAutoClearDate !== dateKey;

  if (!autoCloseDue && !autoClearDue) return;

  const nowIso = new Date().toISOString();
  const result = await runMaintenance({
    autoClose: autoCloseDue,
    autoClear: autoClearDue,
    reason: "AUTO_CLOSE_0530_IST",
  });

  if (result?.skipped) return;

  const next = [
    ...settings.filter((s) => s?.id !== "maintenance"),
    {
      id: "maintenance",
      autoCloseSignals: Boolean(record.autoCloseSignals),
      autoClearHistory: Boolean(record.autoClearHistory),
      lastAutoCloseDate: autoCloseDue ? dateKey : (record.lastAutoCloseDate || null),
      lastAutoCloseAt: autoCloseDue ? nowIso : (record.lastAutoCloseAt || null),
      lastAutoClearDate: autoClearDue ? dateKey : (record.lastAutoClearDate || null),
      lastAutoClearAt: autoClearDue ? nowIso : (record.lastAutoClearAt || null),
      updatedAt: nowIso,
    },
  ];
  await writeCollection("appSettings", next);

  console.log(`[maintenance] 05:30 IST auto-close=${autoCloseDue} clear-history=${autoClearDue} | closed ${result.cryptoClosed + result.stockClosed}, cleared ${result.cryptoCleared + result.stockCleared}`);
}

async function runMaintenanceNow(action = "AUTO_CLOSE") {
  const parts = getIstParts();
  const dateKey = getIstDateKey(parts);
  const nowIso = new Date().toISOString();

  const settings = await readCollection("appSettings");
  const record = settings.find((s) => s?.id === "maintenance") || {};

  const autoClose = action === "AUTO_CLOSE" || action === "AUTO_CLOSE_AND_CLEAR";
  const autoClear = action === "CLEAR_HISTORY" || action === "AUTO_CLOSE_AND_CLEAR";

  const result = await runMaintenance({
    autoClose,
    autoClear,
    reason: "MANUAL",
  });

  if (result?.skipped) return result;

  const next = [
    ...settings.filter((s) => s?.id !== "maintenance"),
    {
      id: "maintenance",
      autoCloseSignals: Boolean(record.autoCloseSignals),
      autoClearHistory: Boolean(record.autoClearHistory),
      lastAutoCloseDate: autoClose ? dateKey : (record.lastAutoCloseDate || null),
      lastAutoCloseAt: autoClose ? nowIso : (record.lastAutoCloseAt || null),
      lastAutoClearDate: autoClear ? dateKey : (record.lastAutoClearDate || null),
      lastAutoClearAt: autoClear ? nowIso : (record.lastAutoClearAt || null),
      updatedAt: nowIso,
    },
  ];
  await writeCollection("appSettings", next);

  return result;
}

function startMaintenanceScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    runAutoCloseIfDue().catch(() => {});
  }, 30 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  console.log("[maintenance] Scheduler active for 05:30 IST auto-close/clear");
}

module.exports = { startMaintenanceScheduler, runAutoCloseIfDue, runMaintenanceNow };
