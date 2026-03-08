const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const COLLECTION_FILES = {
  payments: "payments.json",
  paymentSettings: "payment-settings.json",
  signals: "signals.json",
  users: "users.json",
};

const queues = new Map();

async function ensureCollection(name) {
  const file = COLLECTION_FILES[name];

  if (!file) {
    throw new Error(`Unknown collection: ${name}`);
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  const filePath = path.join(DATA_DIR, file);

  try {
    await fs.access(filePath);
  } catch (error) {
    await fs.writeFile(filePath, "[]\n", "utf8");
  }

  return filePath;
}

function queueWork(name, task) {
  const current = queues.get(name) || Promise.resolve();
  const next = current.then(task, task);

  queues.set(
    name,
    next.catch(() => {
      return undefined;
    }),
  );

  return next;
}

async function readCollection(name) {
  const filePath = await ensureCollection(name);
  const raw = await fs.readFile(filePath, "utf8");

  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

async function writeCollection(name, records) {
  const filePath = await ensureCollection(name);
  const safeRecords = Array.isArray(records) ? records : [];
  await fs.writeFile(filePath, `${JSON.stringify(safeRecords, null, 2)}\n`, "utf8");
  return safeRecords;
}

async function mutateCollection(name, updater) {
  return queueWork(name, async () => {
    const current = await readCollection(name);
    const result = await updater([...current]);
    const nextRecords = Array.isArray(result) ? result : result?.records;

    if (!Array.isArray(nextRecords)) {
      throw new Error(`Mutation for ${name} must return an array or { records }`);
    }

    await writeCollection(name, nextRecords);
    return Array.isArray(result) ? nextRecords : result?.value;
  });
}

function createId(prefix = "ftas") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  COLLECTION_FILES,
  createId,
  ensureCollection,
  mutateCollection,
  readCollection,
  writeCollection,
};
