require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const authRoutes    = require("./routes/auth");
const marketRoutes  = require("./routes/market");
const newsRoutes    = require("./routes/news");
const paymentRoutes = require("./routes/payments");
const signalRoutes  = require("./routes/signals");
const { getStatus, start } = require("./services/signalEngine");

const PORT     = Number(process.env.PORT || 5000);
const distPath = path.join(__dirname, "..", "dist");

// ─── Auto-bootstrap admin on every startup ────────────────────────────────────
// Render free tier mein file system reset hota hai har redeploy pe.
// Isliye har startup pe admin check aur recreate karte hain env vars se.
async function maybeBootstrapAdmin() {
  const email    = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const name     = process.env.ADMIN_BOOTSTRAP_NAME || "FTAS Admin";

  if (!email || !password) {
    console.warn("[bootstrap] ADMIN_BOOTSTRAP_EMAIL or ADMIN_BOOTSTRAP_PASSWORD not set — skipping");
    return;
  }

  try {
    const bcrypt        = require("bcryptjs");
    const { USER_ROLES, createUser, normalizeEmail } = require("./models/User");
    const { mutateCollection } = require("./storage/fileStore");

    const normalEmail  = normalizeEmail(email);
    const passwordHash = await bcrypt.hash(password, 10);

    await mutateCollection("users", (records) => {
      const idx = records.findIndex(u => u.email === normalEmail);

      // Already admin — just sync password in case it changed
      if (idx !== -1 && records[idx].role === USER_ROLES.ADMIN) {
        const updated = { ...records[idx], passwordHash, isActive: true, updatedAt: new Date().toISOString() };
        const next = [...records];
        next[idx] = updated;
        console.log("[bootstrap] Admin password synced:", normalEmail);
        return { records: next, value: updated };
      }

      // Exists but not admin — upgrade
      if (idx !== -1) {
        const updated = {
          ...records[idx],
          passwordHash,
          role: USER_ROLES.ADMIN,
          plan: "PREMIUM",
          subscriptionStatus: "ACTIVE",
          subscriptionEndsAt: null,
          isActive: true,
          updatedAt: new Date().toISOString(),
        };
        const next = [...records];
        next[idx] = updated;
        console.log("[bootstrap] User upgraded to admin:", normalEmail);
        return { records: next, value: updated };
      }

      // Fresh create
      const user = createUser({
        email: normalEmail,
        name,
        passwordHash,
        role: USER_ROLES.ADMIN,
        plan: "PREMIUM",
        subscriptionStatus: "ACTIVE",
        subscriptionEndsAt: null,
        isActive: true,
      });
      console.log("[bootstrap] Admin created:", normalEmail);
      return { records: [user, ...records], value: user };
    });

  } catch (err) {
    console.error("[bootstrap] Failed:", err.message);
  }
}

// ─── App factory ──────────────────────────────────────────────────────────────
function createApp() {
  const app = express();

  const allowedOrigin = process.env.FRONTEND_URL || true;
  app.use(cors({ origin: allowedOrigin, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // Health — Render uses this to confirm service is alive
  app.get("/api/health", (_req, res) => res.json({
    name:      "FTAS Signal Engine",
    ok:        true,
    timestamp: new Date().toISOString(),
    engine:    getStatus(),
  }));

  app.use("/api/auth",     authRoutes);
  app.use("/api/news",     newsRoutes);
  app.use("/api/market",   marketRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/signals",  signalRoutes);

  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      return res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app;
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function startServer(port = PORT) {
  await maybeBootstrapAdmin();

  const app = createApp();

  app.listen(port, () => {
    console.log(`FTAS backend running on port ${port}`);
    console.log("Engine:", JSON.stringify(getStatus()));

    if (String(process.env.AUTO_START_ENGINE || "").toLowerCase() === "true") {
      start();
      console.log("Signal scanner started");
    }
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error("Startup failed:", err.message);
    process.exit(1);
  });
}

module.exports = { createApp, startServer };