require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const authRoutes = require("./routes/auth");
const marketRoutes = require("./routes/market");
const newsRoutes = require("./routes/news");
const paymentRoutes = require("./routes/payments");
const signalRoutes = require("./routes/signals");
const { getStatus, start } = require("./services/signalEngine");

const PORT = Number(process.env.PORT || 5000);
const distPath = path.join(__dirname, "..", "dist");

function createApp() {
  const app = express();

  app.use(
    cors({
      origin: true,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (req, res) => {
    return res.json({
      name: "FTAS Signal Engine",
      ok: true,
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/news", newsRoutes);
  app.use("/api/market", marketRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/signals", signalRoutes);

  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));

    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) {
        return next();
      }

      return res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app;
}

function startServer(port = PORT) {
  const app = createApp();

  return app.listen(port, () => {
    console.log(`FTAS backend running on http://localhost:${port}`);
    console.log("Engine status:", getStatus());

    if (String(process.env.AUTO_START_ENGINE || "").toLowerCase() === "true") {
      start();
      console.log("Auto scanner started");
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
};
