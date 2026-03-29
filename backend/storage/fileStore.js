const fs   = require("fs/promises");
const path = require("path");

const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME     = String(process.env.MONGODB_DB || "").trim();

const COLLECTION_FILES = {
  payments:           "payments.json",
  paymentSettings:    "payment-settings.json",
  signals:            "signals.json",
  signalsArchive:     "signals-archive.json",
  stockSignals:       "stock-signals.json",
  stockSignalsArchive: "stock-signals-archive.json",
  users:              "users.json",
  pushSubscriptions:  "push-subscriptions.json",
  priceAlerts:        "price-alerts.json",
  telegramSubs:       "telegram-subs.json",
  chat_messages:      "chat-messages.json",
  communityPosts:     "community-posts.json",
  communityComments:  "community-comments.json",
  appSettings:        "app-settings.json",
  authSecurityEvents: "auth-security-events.json",
};
const LEGACY_COLLECTION_FILES = {
  users: ["user.json"],
};

const DATA_DIR = path.join(__dirname, "..", "data");

function createId(prefix = "ftas") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Read cache (hot reads) ───────────────────────────────────────────────────
// Avoid repeated disk/DB reads when multiple endpoints hit the same collection
// within a short window (e.g., dashboard loads 4-6 endpoints at once).
const READ_CACHE_TTL_MS = 5000;
const readCache = new Map();    // name -> { value, expiresAt }
const readInflight = new Map(); // name -> Promise

function getReadCache(name) {
  const entry = readCache.get(name);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    readCache.delete(name);
    return null;
  }
  return entry.value;
}

function setReadCache(name, value) {
  readCache.set(name, { value, expiresAt: Date.now() + READ_CACHE_TTL_MS });
}

function invalidateReadCache(name) {
  if (name) readCache.delete(name);
}

// ─── MongoDB connection state ──────────────────────────────────────────────────
// FIX: Previously _mongoFailed was permanent (never retried after first failure).
// Now: retry every MONGO_RETRY_INTERVAL_MS so a temporary outage heals itself.
let _mongoClient = null;
let _db          = null;
let _mongoFailed = false;
let _lastFailedAt = 0;
let _storageModeLogged = false;
const MONGO_RETRY_INTERVAL_MS = 5 * 60 * 1000; // retry every 5 min after failure

function logStorageMode(level, message, extra = "") {
  const line = extra ? `${message} ${extra}` : message;
  if (_storageModeLogged && !line.includes("Retrying MongoDB connection")) return;
  _storageModeLogged = true;
  console[level](line);
}

async function getDb() {
  // If failed recently, check if retry window has passed
  if (_mongoFailed) {
    if (Date.now() - _lastFailedAt < MONGO_RETRY_INTERVAL_MS) return null;
    // Retry window passed — reset and try again
    console.log("[fileStore] Retrying MongoDB connection...");
    _mongoFailed = false;
    _mongoClient = null;
    _db = null;
  }
  if (_db) return _db;
  if (!MONGODB_URI) {
    logStorageMode("warn", "[fileStore] Storage mode: LOCAL_JSON_FALLBACK", "(reason: MONGODB_URI not set)");
    _mongoFailed = true;
    _lastFailedAt = Date.now();
    return null;
  }
  try {
    const { MongoClient } = require("mongodb");
    _mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });
    await _mongoClient.connect();
    _db = DB_NAME ? _mongoClient.db(DB_NAME) : _mongoClient.db();
    logStorageMode("log", `[fileStore] Storage mode: MONGODB_ATLAS (db: ${_db.databaseName || "default"})`);
    return _db;
  } catch (err) {
    logStorageMode("error", "[fileStore] Storage mode: LOCAL_JSON_FALLBACK", `(reason: MongoDB connection failed: ${err.message})`);
    _mongoFailed = true;
    _lastFailedAt = Date.now();
    return null;
  }
}

async function mongoRead(name) {
  const db = await getDb();
  if (!db) return null;
  try {
    const docs = await db.collection(name).find({}).toArray();
    return docs.map(d => d.data ?? d);
  } catch (err) {
    console.error(`[fileStore] MongoDB read(${name}) failed:`, err.message);
    return null;
  }
}

// FIX: Previous strategy was deleteMany → bulkWrite (data loss risk on crash).
// New strategy: upsert all records first, then delete orphans.
// This means data is never fully absent even if the process crashes mid-write.
async function mongoWrite(name, records) {
  const db = await getDb();
  if (!db) return false;
  try {
    const col = db.collection(name);

    if (records.length === 0) {
      await col.deleteMany({});
      return true;
    }

    // Step 1: Upsert all current records (safe — data always present)
    const ops = records.map(r => ({
      replaceOne: {
        filter:      { _id: r.id },
        replacement: { _id: r.id, data: r },
        upsert:      true,
      },
    }));
    await col.bulkWrite(ops, { ordered: false });

    // Step 2: Remove stale records not in current set (safe — data already written)
    const ids = records.map(r => r.id).filter(Boolean);
    if (ids.length > 0) {
      await col.deleteMany({ _id: { $nin: ids } });
    }

    return true;
  } catch (err) {
    console.error(`[fileStore] MongoDB write(${name}) failed:`, err.message);
    return false;
  }
}

async function localEnsure(name) {
  const file = COLLECTION_FILES[name];
  if (!file) throw new Error(`Unknown collection: ${name}`);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, file);
  try { await fs.access(filePath); }
  catch {
    const legacyFiles = LEGACY_COLLECTION_FILES[name] || [];

    for (const legacyFile of legacyFiles) {
      const legacyPath = path.join(DATA_DIR, legacyFile);
      try {
        await fs.access(legacyPath);
        return legacyPath;
      } catch {
        // Keep checking for the next known legacy filename.
      }
    }

    await fs.writeFile(filePath, "[]\n", "utf8");
  }
  return filePath;
}

async function localRead(name) {
  const filePath = await localEnsure(name);
  const raw = await fs.readFile(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function localWrite(name, records) {
  const filePath = await localEnsure(name);
  const safe = Array.isArray(records) ? records : [];
  await fs.writeFile(filePath, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return safe;
}

async function ensureCollection(name) {
  if (!COLLECTION_FILES[name]) throw new Error(`Unknown collection: ${name}`);
  const db = await getDb();
  if (!db) return localEnsure(name);
  return name;
}

async function readCollection(name) {
  const cached = getReadCache(name);
  if (cached) return cached;

  const inflight = readInflight.get(name);
  if (inflight) return inflight;

  const task = (async () => {
    const db = await getDb();
    let result = null;
    if (db) {
      result = await mongoRead(name);
    }
    if (result === null) {
      result = await localRead(name);
    }
    const safe = Array.isArray(result) ? result : [];
    setReadCache(name, safe);
    return safe;
  })();

  readInflight.set(name, task);
  try {
    return await task;
  } finally {
    readInflight.delete(name);
  }
}

async function writeCollection(name, records) {
  const safe = Array.isArray(records) ? records : [];
  const db   = await getDb();
  if (db) {
    const ok = await mongoWrite(name, safe);
    if (ok) {
      setReadCache(name, safe);
      return safe;
    }
  }
  const written = await localWrite(name, safe);
  setReadCache(name, written);
  return written;
}

const queues = new Map();

function queueWork(name, task) {
  const current = queues.get(name) || Promise.resolve();
  const next    = current.then(task, task);
  queues.set(name, next.catch(() => undefined));
  return next;
}

function getStorageDebugInfo() {
  return {
    dbName: _db?.databaseName || DB_NAME || null,
    mongoConfigured: Boolean(MONGODB_URI),
    mongoConnected: Boolean(_db),
    mongoFailed: _mongoFailed,
    retryIntervalMs: MONGO_RETRY_INTERVAL_MS,
    fallbackDataDir: DATA_DIR,
  };
}

async function mutateCollection(name, updater) {
  return queueWork(name, async () => {
    const current     = await readCollection(name);
    const result      = await updater([...current]);
    const nextRecords = Array.isArray(result) ? result : result?.records;
    if (!Array.isArray(nextRecords)) {
      throw new Error(`Mutation for ${name} must return an array or { records }`);
    }
    await writeCollection(name, nextRecords);
    return Array.isArray(result) ? nextRecords : result?.value;
  });
}

module.exports = {
  COLLECTION_FILES,
  createId,
  ensureCollection,
  getStorageDebugInfo,
  invalidateReadCache,
  mutateCollection,
  readCollection,
  writeCollection,
};
