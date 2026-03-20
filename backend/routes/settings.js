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

module.exports = router;
