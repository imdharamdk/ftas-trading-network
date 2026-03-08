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

// ─── Auto-bootstrap admin on startup (only if env vars set) ──────────────────
async function maybeBootstrapAdmin() {
  const email    = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (!email || !password) return;

  try {
    const bcrypt = require("bcryptjs");
    const { USER_ROLES, createUser, normalizeEmail } = require("./models/User");
    const { readCollection, mutateCollection } = require("./storage/fileStore");

    const users    = await readCollection("users");
    const existing = users.find(u => u.email === normalizeEmail(email));

    if (existing && existing.role === USER_ROLES.ADMIN) {
      console.log("[bootstrap] Admin already exists:", email);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await mutateCollection("users", (records) => {
      const idx = records.findIndex(u => u.email === normalizeEmail(email));

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
        return { records: next, value: updated };
      }

      const user = createUser({
        email,
        name: process.env.ADMIN_BOOTSTRAP_NAME || "FTAS Admin",
        passwordHash,
        role: USER_ROLES.ADMIN,
        plan: "PREMIUM",
        subscriptionStatus: "ACTIVE",
        subscriptionEndsAt: null,
        isActive: true,
      });
      return { records: [user, ...records], value: user };
    });

    console.log("[bootstrap] Admin account ready:", email);
  } catch (err) {
    console.error("[bootstrap] Failed:", err.message);
  }
}

// ─── App factory ──────────────────────────────────────────────────────────────
function createApp() {
  const app = express();

  // CORS — allow all origins in dev, restrict to env var in production
  const allowedOrigin = process.env.FRONTEND_URL || true;
  app.use(cors({ origin: allowedOrigin, credentials: true }));

  app.use(express.json({ limit: "1mb" }));

  // Health check — Render uses this to confirm service is up
  app.get("/api/health", (_req, res) => res.json({
    name: "FTAS Signal Engine",
    ok:   true,
    timestamp: new Date().toISOString(),
    engine: getStatus(),
  }));

  app.use("/api/auth",     authRoutes);
  app.use("/api/news",     newsRoutes);
  app.use("/api/market",   marketRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/signals",  signalRoutes);

  // Serve built frontend if dist/ exists (optional — not needed when using Vercel)
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      return res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app;
}

// ─── Start server ─────────────────────────────────────────────────────────────
async function startServer(port = PORT) {
  // Bootstrap admin before accepting requests
  await maybeBootstrapAdmin();

  const app = createApp();

  app.listen(port, () => {
    console.log(`FTAS backend running on port ${port}`);
    console.log("Engine status:", JSON.stringify(getStatus()));

    if (String(process.env.AUTO_START_ENGINE || "").toLowerCase() === "true") {
      start();
      console.log("Signal scanner auto-started");
    }
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error("Server failed to start:", err.message);
    process.exit(1);
  });
}

module.exports = { createApp, startServer };
