require("dotenv").config();

const { runMaintenanceNow } = require("../services/maintenanceScheduler");

function getArg(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

async function main() {
  const action = (getArg("action") || process.env.MAINTENANCE_ACTION || "AUTO_CLOSE").toUpperCase();
  const allowed = new Set(["AUTO_CLOSE", "CLEAR_HISTORY", "AUTO_CLOSE_AND_CLEAR"]);
  if (!allowed.has(action)) {
    console.error("Invalid action. Use AUTO_CLOSE, CLEAR_HISTORY, or AUTO_CLOSE_AND_CLEAR");
    process.exit(1);
  }

  const result = await runMaintenanceNow(action);
  if (result?.skipped) {
    console.log("Maintenance already running. Try again later.");
    return;
  }

  const closedTotal = (result.cryptoClosed || 0) + (result.stockClosed || 0);
  const clearedTotal = (result.cryptoCleared || 0) + (result.stockCleared || 0);

  console.log(`Done. Closed ${closedTotal} signal(s). Cleared ${clearedTotal} signal(s).`);
}

main().catch((err) => {
  console.error("Maintenance run failed:", err.message);
  process.exit(1);
});
