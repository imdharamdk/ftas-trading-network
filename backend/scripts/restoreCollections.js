require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { MongoClient } = require("mongodb");
const { COLLECTION_FILES } = require("../storage/fileStore");

const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = String(process.env.MONGODB_DB || "").trim();
const DEFAULT_BACKUP_ROOT = path.join(__dirname, "..", "backups");

function getArg(flag) {
  const prefix = `--${flag}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function hasFlag(flag) {
  return process.argv.includes(`--${flag}`);
}

async function resolveBackupDir() {
  const explicit = getArg("dir");
  if (explicit) return path.resolve(explicit);

  const entries = await fs.readdir(DEFAULT_BACKUP_ROOT, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  if (!dirs.length) {
    throw new Error("No backup directories found. Pass --dir=/path/to/backup");
  }

  return path.join(DEFAULT_BACKUP_ROOT, dirs[0]);
}

async function readManifest(backupDir) {
  const manifestPath = path.join(backupDir, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  if (!hasFlag("force")) {
    throw new Error("Refusing restore without --force");
  }
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }

  const backupDir = await resolveBackupDir();
  const manifest = await readManifest(backupDir);
  const requestedCollections = getArg("collections")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const collections = requestedCollections.length
    ? manifest.collections.filter((item) => requestedCollections.includes(item.name))
    : manifest.collections;

  if (!collections.length) {
    throw new Error("No matching collections found in backup manifest");
  }

  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    const db = DB_NAME ? client.db(DB_NAME) : client.db();
    const summary = [];

    for (const item of collections) {
      if (!COLLECTION_FILES[item.name]) {
        throw new Error(`Unknown collection in manifest: ${item.name}`);
      }

      const filePath = path.join(backupDir, item.filename);
      const raw = await fs.readFile(filePath, "utf8");
      const records = JSON.parse(raw);
      const docs = records.map((record) => ({
        _id: record.id,
        data: record,
      }));

      const collection = db.collection(item.name);
      await collection.deleteMany({});
      if (docs.length) {
        await collection.insertMany(docs, { ordered: false });
      }
      summary.push({ name: item.name, restored: records.length });
    }

    console.log(JSON.stringify({ ok: true, backupDir, dbName: db.databaseName, summary }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
