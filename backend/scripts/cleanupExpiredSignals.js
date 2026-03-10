#!/usr/bin/env node

/**
 * Removes or reclassifies legacy signals that were closed automatically with result === "EXPIRED".
 *
 * Usage examples:
 *   node backend/scripts/cleanupExpiredSignals.js
 *   node backend/scripts/cleanupExpiredSignals.js --dry-run
 *   node backend/scripts/cleanupExpiredSignals.js --mode=cancelled
 *   node backend/scripts/cleanupExpiredSignals.js --backup=/tmp/expired-backup.json
 */

const fs = require("fs/promises");
const path = require("path");
const { SIGNAL_STATUS } = require("../models/Signal");
const { readCollection, writeCollection } = require("../storage/fileStore");

function parseArgs(argv) {
  const args = {
    dryRun: argv.includes("--dry-run"),
    mode: "delete",
    backup: null,
    noBackup: argv.includes("--no-backup"),
  };

  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      const [, value] = arg.split("=");
      if (value === "delete" || value === "cancelled") {
        args.mode = value;
      } else {
        console.warn(`[cleanup-expired] Unknown mode "${value}", falling back to "delete".`);
      }
    }
    if (arg.startsWith("--backup=")) {
      const [, value] = arg.split("=");
      if (value) {
        args.backup = path.resolve(process.cwd(), value);
      }
    }
  }

  return args;
}

async function ensureBackupPath(customPath) {
  if (customPath) return customPath;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(__dirname, "..", "data", `signals-expired-backup-${timestamp}.json`);
}

async function backupRecords(records, backupPath) {
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return backupPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const signals = await readCollection("signals");
  const expired = signals.filter((signal) => signal?.result === "EXPIRED");

  if (!expired.length) {
    console.log("[cleanup-expired] No EXPIRED signals found. Nothing to do.");
    return;
  }

  console.log(`[cleanup-expired] Found ${expired.length} EXPIRED signals out of ${signals.length} total records.`);

  if (!args.noBackup) {
    const backupPath = await ensureBackupPath(args.backup);
    await backupRecords(expired, backupPath);
    console.log(`[cleanup-expired] Backup written to ${backupPath}`);
  } else {
    console.warn("[cleanup-expired] Skipping backup per --no-backup flag.");
  }

  if (args.dryRun) {
    console.log("[cleanup-expired] Dry run enabled — no records were modified.");
    return;
  }

  const nowIso = new Date().toISOString();
  const updated = [];

  for (const signal of signals) {
    if (signal?.result !== "EXPIRED") {
      updated.push(signal);
      continue;
    }

    if (args.mode === "cancelled") {
      updated.push({
        ...signal,
        status: SIGNAL_STATUS.CANCELLED,
        result: null,
        closedAt: null,
        updatedAt: nowIso,
      });
    }
    // In "delete" mode we simply drop the expired record.
  }

  await writeCollection("signals", updated);
  console.log(`[cleanup-expired] ${signals.length - updated.length} records processed as "${args.mode}".`);
}

main().catch((err) => {
  console.error("[cleanup-expired] Failed:", err);
  process.exitCode = 1;
});
