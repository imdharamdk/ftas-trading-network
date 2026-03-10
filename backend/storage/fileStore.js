const fs   = require("fs/promises");
const path = require("path");

const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME     = process.env.MONGODB_DB  || "ftas";

const COLLECTION_FILES = {
  payments:        "payments.json",
  paymentSettings: "payment-settings.json",
  signals:         "signals.json",
  signalsArchive:  "signals-archive.json",
  stockSignals:    "stock-signals.json",
  users:           "users.json",
};
const LEGACY_COLLECTION_FILES = {
  users: ["user.json"],
};

const DATA_DIR = path.join(__dirname, "..", "data");

function createId(prefix = "ftas") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

let _mongoClient = null;
let _db          = null;
let _mongoFailed = false;

async function getDb() {
  if (_mongoFailed) return null;
  if (_db) return _db;
  if (!MONGODB_URI) {
    console.warn("[fileStore] MONGODB_URI not set — using local JSON files");
    _mongoFailed = true;
    return null;
  }
  try {
    const { MongoClient } = require("mongodb");
    _mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });
    await _mongoClient.connect();
    _db = _mongoClient.db(DB_NAME);
    console.log("[fileStore] Connected to MongoDB Atlas ✅");
    return _db;
  } catch (err) {
    console.error("[fileStore] MongoDB connection failed:", err.message);
    _mongoFailed = true;
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

async function mongoWrite(name, records) {
  const db = await getDb();
  if (!db) return false;
  try {
    const col = db.collection(name);
    const ids = records.map(r => r.id).filter(Boolean);
    // Delete records that are no longer in the list
    if (ids.length > 0) {
      await col.deleteMany({ _id: { $nin: ids } });
    } else {
      await col.deleteMany({});
    }
    if (records.length > 0) {
      const ops = records.map(r => ({
        replaceOne: {
          filter:      { _id: r.id },
          replacement: { _id: r.id, data: r },
          upsert:      true,
        },
      }));
      await col.bulkWrite(ops, { ordered: false });
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
  const db = await getDb();
  if (db) {
    const result = await mongoRead(name);
    if (result !== null) return result;
  }
  return localRead(name);
}

async function writeCollection(name, records) {
  const safe = Array.isArray(records) ? records : [];
  const db   = await getDb();
  if (db) {
    const ok = await mongoWrite(name, safe);
    if (ok) return safe;
  }
  return localWrite(name, safe);
}

const queues = new Map();

function queueWork(name, task) {
  const current = queues.get(name) || Promise.resolve();
  const next    = current.then(task, task);
  queues.set(name, next.catch(() => undefined));
  return next;
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
  mutateCollection,
  readCollection,
  writeCollection,
};
