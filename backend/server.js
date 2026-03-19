require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const fs         = require("fs");
const http       = require("http");
const path       = require("path");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const morgan     = require("morgan");

const chatRoutes        = require("./routes/chat");
const authRoutes        = require("./routes/auth");
const marketRoutes      = require("./routes/market");
const newsRoutes        = require("./routes/news");
const paymentRoutes     = require("./routes/payments");
const signalRoutes      = require("./routes/signals");
const stockSignalRoutes = require("./routes/stockSignals");
const { router: notificationRoutes } = require("./routes/notifications");
const { router: telegramRoutes }     = require("./routes/telegram");
const { router: priceAlertRoutes }   = require("./routes/priceAlerts");
const { getStatus, start } = require("./services/signalEngine");
const stockSignalEngine    = require("./services/stockSignalEngine");
const { createWsServer, getConnectedCount } = require("./services/wsServer");
const sseManager           = require("./services/sseManager");

const PORT     = Number(process.env.PORT || 5000);
const distPath = path.join(__dirname, "..", "dist");

function getAllowedOrigins() {
  const configuredOrigins = String(process.env.FRONTEND_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV === "production") {
    return [...new Set(configuredOrigins)];
  }

  return [...new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...configuredOrigins,
  ])];
}

function createCorsOptions() {
  const allowedOrigins = getAllowedOrigins();

  if (!allowedOrigins.length) {
    return {
      credentials: true,
      origin: true,
    };
  }

  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },
  };
}

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

  // ── Security ────────────────────────────────────────────────────────────────
  app.disable("x-powered-by");
  app.use(helmet({
    crossOriginEmbedderPolicy: false, // allow charts/widgets to load
    contentSecurityPolicy: false,     // managed by Vercel frontend
  }));
  app.use(cors(createCorsOptions()));
  app.use(express.json({ limit: "1mb" }));

  // ── Logging ─────────────────────────────────────────────────────────────────
  // Compact format: METHOD /path STATUS ms
  app.use(morgan(":method :url :status :res[content-length] - :response-time ms", {
    skip: (req) => req.path === "/api/health", // don't spam logs with health checks
  }));

  // ── Rate limiting ───────────────────────────────────────────────────────────
  // Global: 200 req / 1 min per IP
  const globalLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             200,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { message: "Too many requests, please slow down." },
    skip: (req) => req.path === "/api/health",
  });

  // Auth endpoints: tighter — 20 req / 15 min (brute-force protection)
  const authLimiter = rateLimit({
    windowMs:        15 * 60 * 1000,
    max:             20,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { message: "Too many auth attempts, try again later." },
  });

  // Signal scan endpoint (admin only but still limit)
  const scanLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      5,
    message:  { message: "Scan rate limit exceeded." },
  });

  app.use(globalLimiter);

  // ── Cache-control for API routes ────────────────────────────────────────────
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    next();
  });

  // ── Health ──────────────────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => res.json({
    name:       "FTAS Signal Engine",
    ok:         true,
    timestamp:  new Date().toISOString(),
    engine:     getStatus(),
    wsClients:  getConnectedCount(),
    sseClients: sseManager.getClientCount(),
  }));

  // ── SSE stream (Render-only real-time for clients that can't use WS) ────────
  app.get("/api/signals/stream", sseManager.handleConnection);

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use("/api/auth",          authLimiter, authRoutes);
  app.use("/api/chat",          chatRoutes);
  app.use("/api/news",          newsRoutes);
  app.use("/api/market",        marketRoutes);
  app.use("/api/payments",      paymentRoutes);
  app.use("/api/signals",       scanLimiter, signalRoutes);
  app.use("/api/stocks",        stockSignalRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/telegram",      telegramRoutes);
  app.use("/api/price-alerts",  priceAlertRoutes);

  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      return res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // ── Global error handler ────────────────────────────────────────────────────
  // Must be last — catches any unhandled errors from routes/middleware
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const isProd = process.env.NODE_ENV === "production";

    console.error(`[error] ${req.method} ${req.path} →`, err.message);
    if (!isProd) console.error(err.stack);

    return res.status(status).json({
      message: isProd && status === 500 ? "Internal server error" : (err.message || "Internal server error"),
      ...(isProd ? {} : { stack: err.stack }),
    });
  });

  return app;
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function startServer(port = PORT) {
  await maybeBootstrapAdmin();

  const app    = createApp();
  const server = http.createServer(app);

  // Attach WebSocket server to same HTTP server
  createWsServer(server);

  server.listen(port, () => {
    console.log(`FTAS backend running on port ${port}`);
    console.log(`WS ready at ws://localhost:${port}/ws`);
    console.log("Engine:", JSON.stringify(getStatus()));

    if (String(process.env.AUTO_START_ENGINE || "").toLowerCase() === "true") {
      start();
      console.log("Signal scanner started");
    }
    if (String(process.env.AUTO_START_STOCK_ENGINE || "").toLowerCase() === "true") {
      stockSignalEngine.start();
      console.log("Stock/FO scanner started");
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
