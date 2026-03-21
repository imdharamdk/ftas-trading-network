const express = require("express");
const { requireAdmin, requireAuth } = require("../middleware/auth");
const { readCollection, writeCollection } = require("../storage/fileStore");
const { envToBool, resolveAutoStart } = require("../services/engineAutostart");

const router = express.Router();

router.get("/engines", requireAuth, requireAdmin, async (_req, res) => {
  const settings = await readCollection("appSettings");
  const record = settings.find((s) => s?.id === "engines") || {};
  const storedCrypto = typeof record.autoStartCrypto === "boolean" ? record.autoStartCrypto : null;
  const storedStock = typeof record.autoStartStock === "boolean" ? record.autoStartStock : null;
  const defaultAutoStart = process.env.NODE_ENV === "production";
  const envCrypto = envToBool(process.env.AUTO_START_ENGINE);
  const envStock = envToBool(process.env.AUTO_START_STOCK_ENGINE);

  const resolved = resolveAutoStart({
    envCrypto,
    envStock,
    storedCrypto,
    storedStock,
    defaultAutoStart,
  });

  return res.json({
    settings: {
      autoStartCrypto: storedCrypto,
      autoStartStock: storedStock,
    },
    effective: {
      autoStartCrypto: resolved.autoStartCrypto,
      autoStartStock: resolved.autoStartStock,
    },
    defaultAutoStart: resolved.defaultAutoStart,
    sources: resolved.sources,
  });
});

router.post("/engines", requireAuth, requireAdmin, async (req, res) => {
  const { autoStartCrypto, autoStartStock } = req.body || {};
  if (typeof autoStartCrypto !== "boolean" || typeof autoStartStock !== "boolean") {
    return res.status(400).json({ message: "autoStartCrypto and autoStartStock must be boolean" });
  }

  const settings = await readCollection("appSettings");
  const next = [
    ...settings.filter((s) => s?.id !== "engines"),
    { id: "engines", autoStartCrypto, autoStartStock, updatedAt: new Date().toISOString() },
  ];
  await writeCollection("appSettings", next);

  return res.json({ settings: { autoStartCrypto, autoStartStock } });
});

router.get("/maintenance", requireAuth, requireAdmin, async (_req, res) => {
  const settings = await readCollection("appSettings");
  const record = settings.find((s) => s?.id === "maintenance") || {};
  return res.json({
    settings: {
      autoCloseSignals: Boolean(record.autoCloseSignals),
      autoClearHistory: Boolean(record.autoClearHistory),
      lastAutoCloseAt: record.lastAutoCloseAt || null,
      lastAutoClearAt: record.lastAutoClearAt || null,
    },
  });
});

router.post("/maintenance", requireAuth, requireAdmin, async (req, res) => {
  const { autoCloseSignals, autoClearHistory } = req.body || {};
  if (typeof autoCloseSignals !== "boolean" || typeof autoClearHistory !== "boolean") {
    return res.status(400).json({ message: "autoCloseSignals and autoClearHistory must be boolean" });
  }

  const settings = await readCollection("appSettings");
  const record = settings.find((s) => s?.id === "maintenance") || {};
  const next = [
    ...settings.filter((s) => s?.id !== "maintenance"),
    {
      id: "maintenance",
      autoCloseSignals,
      autoClearHistory,
      lastAutoCloseAt: record.lastAutoCloseAt || null,
      lastAutoCloseDate: record.lastAutoCloseDate || null,
      lastAutoClearAt: record.lastAutoClearAt || null,
      lastAutoClearDate: record.lastAutoClearDate || null,
      updatedAt: new Date().toISOString(),
    },
  ];
  await writeCollection("appSettings", next);

  return res.json({
    settings: {
      autoCloseSignals,
      autoClearHistory,
      lastAutoCloseAt: record.lastAutoCloseAt || null,
      lastAutoClearAt: record.lastAutoClearAt || null,
    },
  });
});

router.post("/maintenance/run", requireAuth, requireAdmin, async (req, res) => {
  try {
    const action = String(req.body?.action || "AUTO_CLOSE").toUpperCase();
    const allowed = new Set(["AUTO_CLOSE", "CLEAR_HISTORY", "AUTO_CLOSE_AND_CLEAR"]);
    if (!allowed.has(action)) {
      return res.status(400).json({ message: "Invalid maintenance action" });
    }
    const { runMaintenanceNow } = require("../services/maintenanceScheduler");
    const result = await runMaintenanceNow(action);
    if (result?.skipped) {
      return res.status(409).json({ message: "Maintenance already running" });
    }
    return res.json({ result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
