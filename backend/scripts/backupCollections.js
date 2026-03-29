require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { MongoClient } = require("mongodb");
const { COLLECTION_FILES } = require("../storage/fileStore");

const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = String(process.env.MONGODB_DB || "").trim();
const DEFAULT_OUTPUT_DIR = path.join(__dirname, "..", "backups");

function getArg(flag) {
  const prefix = `--${flag}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function resolveCollections() {
  const requested = getArg("collections")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return requested.length ? requested : Object.keys(COLLECTION_FILES);
}

async function main() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputRoot = getArg("outDir") || DEFAULT_OUTPUT_DIR;
  const backupDir = path.join(outputRoot, timestamp);
  const collections = resolveCollections();

  await fs.mkdir(backupDir, { recursive: true });

  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    const db = DB_NAME ? client.db(DB_NAME) : client.db();
    const manifest = {
      createdAt: new Date().toISOString(),
      dbName: db.databaseName,
      collections: [],
    };

    for (const name of collections) {
      if (!COLLECTION_FILES[name]) {
        throw new Error(`Unknown collection: ${name}`);
      }

      const docs = await db.collection(name).find({}).toArray();
      const records = docs.map((doc) => doc?.data ?? doc);
      const filename = COLLECTION_FILES[name];
      await fs.writeFile(
        path.join(backupDir, filename),
        `${JSON.stringify(records, null, 2)}\n`,
        "utf8",
      );
      manifest.collections.push({ name, filename, count: records.length });
    }

    await fs.writeFile(
      path.join(backupDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    console.log(JSON.stringify({ ok: true, backupDir, manifest }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
