/**
 * FTAS SSE Manager — Server-Sent Events
 *
 * Render backend pe SSE endpoint provide karta hai.
 * Vercel serverless pe NEVER use karo — yeh Render-only feature hai.
 *
 * Endpoint: GET /api/signals/stream
 * Auth:     ?token=JWT query param (EventSource header support limited)
 *
 * Events pushed:
 *   signal:new     — naya crypto/stock signal
 *   signal:closed  — signal closed (TP/SL/expired)
 *   price:update   — live price batch
 *   stats:update   — overview stats
 *   connected      — initial handshake with client ID
 *   heartbeat      — every 20s to keep connection alive
 */

const jwt = require("jsonwebtoken");
const { readCollection } = require("../storage/fileStore");
const { hasSignalAccess } = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET || "ftas_super_secret";

// Active SSE clients: Map<clientId, { res, userId, hasAccess, role, connectedAt }>
const clients = new Map();
let nextId = 1;

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function authenticateToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const users   = await readCollection("users");
    const user    = users.find(u => u.id === payload.sub);
    if (!user || !user.isActive) return null;
    return user;
  } catch { return null; }
}

// ─── SSE Connection Handler ───────────────────────────────────────────────────
async function handleConnection(req, res) {
  // Auth via query param (EventSource doesn't support custom headers)
  const token = req.query.token || req.headers.authorization?.split(" ")[1];
  const user  = await authenticateToken(token);

  if (!user) {
    return res.status(401).json({ message: "Authentication required" });
  }

  const clientId = `sse_${nextId++}`;
  const hasAccess = hasSignalAccess(user);

  // Set SSE headers
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no",    // disable Nginx buffering on Render
    "Access-Control-Allow-Origin": req.headers.origin || "*",
  });
  res.flushHeaders();

  // Register client
  clients.set(clientId, {
    res,
    userId:      user.id,
    role:        user.role,
    hasAccess,
    connectedAt: Date.now(),
  });

  console.log(`[sse] Client connected: ${user.email} (${clientId}) — total: ${clients.size}`);

  // Send initial handshake
  sendToClient(clientId, "connected", {
    clientId,
    message: "SSE stream active",
    hasAccess,
  });

  // Heartbeat every 20s — prevents Render from closing idle connections
  const heartbeat = setInterval(() => {
    if (!clients.has(clientId)) { clearInterval(heartbeat); return; }
    sendToClient(clientId, "heartbeat", { ts: Date.now() });
  }, 20_000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    console.log(`[sse] Client disconnected: ${clientId} — remaining: ${clients.size}`);
  });

  req.on("error", () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
  });
}

// ─── Send to single client ────────────────────────────────────────────────────
function sendToClient(clientId, event, data) {
  const client = clients.get(clientId);
  if (!client) return;
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, _ts: Date.now() })}\n\n`);
  } catch {
    clients.delete(clientId);
  }
}

// ─── Broadcast to matching clients ───────────────────────────────────────────
function broadcast(event, data, { requireAccess = false, adminOnly = false } = {}) {
  if (clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify({ ...data, _ts: Date.now() })}\n\n`;

  for (const [id, client] of clients) {
    if (adminOnly  && client.role !== "ADMIN") continue;
    if (requireAccess && !client.hasAccess)    continue;
    try {
      client.res.write(payload);
    } catch {
      clients.delete(id);
    }
  }
}

// ─── Public broadcast API ─────────────────────────────────────────────────────
function broadcastNewSignal(signal, isStock = false) {
  broadcast(isStock ? "stock:new" : "signal:new", { signal }, { requireAccess: true });
  broadcastStatsUpdate();
}

function broadcastSignalClosed(signal, isStock = false) {
  broadcast(isStock ? "stock:closed" : "signal:closed", { signal }, { requireAccess: true });
  broadcastStatsUpdate();
}

function broadcastPrices(prices) {
  broadcast("price:update", { prices }, { requireAccess: true });
}

async function broadcastStatsUpdate() {
  try {
    const [cryptoSignals, stockSignals] = await Promise.all([
      readCollection("signals"),
      readCollection("stockSignals"),
    ]);

    const buildStats = (signals, filterFn = () => true) => {
      const filtered = signals.filter(filterFn);
      const active   = filtered.filter(s => s.status === "ACTIVE");
      const closed   = filtered.filter(s => s.status === "CLOSED" && s.result !== "EXPIRED");
      const expired  = filtered.filter(s => s.result === "EXPIRED");
      const wins     = closed.filter(s => ["TP1_HIT","TP2_HIT","TP3_HIT"].includes(s.result));
      return {
        activeSignals:  active.length,
        closedSignals:  closed.length,
        expiredSignals: expired.length,
        totalWins:      wins.length,
        totalLosses:    closed.length - wins.length,
        winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(1)) : 0,
      };
    };

    broadcast("stats:update", {
      crypto: buildStats(cryptoSignals),
      stocks: buildStats(stockSignals, s => !String(s.coin || "").toUpperCase().endsWith("USDT")),
    });
  } catch {}
}

function broadcastEngineStatus(engine) {
  broadcast("engine:status", { engine }, { adminOnly: true });
}

function getClientCount() { return clients.size; }

module.exports = {
  handleConnection,
  broadcast,
  broadcastNewSignal,
  broadcastSignalClosed,
  broadcastPrices,
  broadcastStatsUpdate,
  broadcastEngineStatus,
  getClientCount,
};
