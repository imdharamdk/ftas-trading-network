require("dotenv").config();

const { scanNow } = require("../services/signalEngine");

async function main() {
  const result = await scanNow({ source: "CLI" });
  console.log(
    JSON.stringify(
      {
        generated: result.generatedSignals?.length || 0,
        closed: result.closedSignals?.length || 0,
        errors: result.errors || [],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
