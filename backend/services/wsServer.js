/**
 * FTAS WebSocket Server
 * Channels: crypto_signals | stock_signals | prices
 * Auth: ?token=JWT on ws upgrade
 * Messages: JSON { type, channel, data, ts }
 */
const WebSocket = require("ws");
const jwt       = require("jsonwebtoken");
const { readCollection } = require("../storage/fileStore");
const { getPrices }      = require("./binanceService");
const { SIGNAL_STATUS }  = require("../models/Signal");

const JWT_SECRET = process.env.JWT_SECRET || "ftas_super_secret";

let wss = null;
const clientMeta = new WeakMap(); // ws → { user, channels: Set }

// ─── Auth ──────────────────────────────────────────────────────────────────────
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

function hasSignalAccess(user) {
  if (!user) return false;
  if (user.role === "ADMIN") return true;
  if (user.subscriptionStatus !== "ACTIVE") return false;
  if (user.subscriptionEndsAt && new Date(user.subscriptionEndsAt) < new Date()) return false;
  return ["PRO","PREMIUM","FREE_TRIAL"].includes(user.plan);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

function broadcast(channel, type, data) {
  if (!wss) return;
  const msg = JSON.stringify({ type, channel, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const meta = clientMeta.get(client);
    if (meta?.channels?.has(channel)) {
      try { client.send(msg); } catch { /* ignore */ }
    }
  }
}

// ─── Price ticker ──────────────────────────────────────────────────────────────
let priceTick = null;

function startPriceTicker() {
  if (priceTick) return;
  priceTick = setInterval(async () => {
    if (!wss) return;
    let hasSubs = false;
    for (const c of wss.clients) {
      if (clientMeta.get(c)?.channels?.has("prices")) { hasSubs = true; break; }
    }
    if (!hasSubs) return;
    try {
      const signals = await readCollection("signals");
      const coins   = [...new Set(signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE).map(s => s.coin).filter(Boolean))];
      if (!coins.length) return;
      const prices  = await getPrices(coins);
      if (Object.keys(prices).length) broadcast("prices", "PRICE_UPDATE", { prices, ts: Date.now() });
    } catch { /* ignore */ }
  }, 5000); // every 5s
}

function stopPriceTicker() {
  if (priceTick) { clearInterval(priceTick); priceTick = null; }
}

function checkPriceSubscribers() {
  if (!wss) return;
  for (const c of wss.clients) {
    if (clientMeta.get(c)?.channels?.has("prices")) return; // still has subscribers
  }
  stopPriceTicker();
}

// ─── Snapshots ─────────────────────────────────────────────────────────────────
async function sendSnapshot(ws, channel) {
  try {
    const col     = channel === "stock_signals" ? "stockSignals" : "signals";
    const signals = await readCollection(col);
    const active  = signals.filter(s => s.status === SIGNAL_STATUS.ACTIVE);
    send(ws, { type: "SNAPSHOT", channel, data: { signals: active }, ts: Date.now() });
  } catch { /* ignore */ }
}

// ─── Create WS server ──────────────────────────────────────────────────────────
function createWsServer(httpServer) {
  wss = new WebSocket.Server({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws, req) => {
    const url   = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const user  = await authenticateToken(token);

    if (!user) {
      send(ws, { type: "ERROR", message: "Authentication failed" });
      ws.close(4001, "Unauthorized");
      return;
    }

    const canAccess = hasSignalAccess(user);
    clientMeta.set(ws, { user, channels: new Set() });
    console.log(`[WS] +${user.email} (${user.role}) — ${getConnectedCount()} online`);

    send(ws, {
      type: "CONNECTED",
      data: { userId: user.id, role: user.role, canAccessSignals: canAccess,
        availableChannels: canAccess ? ["crypto_signals","stock_signals","prices"] : [] },
    });

    // Keep-alive ping every 30s
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) send(ws, { type: "PING", ts: Date.now() });
    }, 30000);

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const { type, channel } = msg;
      const meta = clientMeta.get(ws);
      if (!meta) return;

      if (type === "SUBSCRIBE" && channel) {
        if (!canAccess) { send(ws, { type: "ERROR", message: "Signal access required" }); return; }
        meta.channels.add(channel);
        send(ws, { type: "SUBSCRIBED", channel });
        if (channel === "crypto_signals" || channel === "stock_signals") sendSnapshot(ws, channel);
        if (channel === "prices") startPriceTicker();
      }

      if (type === "UNSUBSCRIBE" && channel) {
        meta.channels.delete(channel);
        send(ws, { type: "UNSUBSCRIBED", channel });
        if (channel === "prices") checkPriceSubscribers();
      }

      if (type === "PONG") { /* heartbeat received */ }
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      clientMeta.delete(ws);
      checkPriceSubscribers();
      console.log(`[WS] -${user.email} — ${getConnectedCount()} online`);
    });

    ws.on("error", () => { /* ignore */ });
  });

  console.log("[WS] WebSocket server ready at /ws");
  return wss;
}

function getConnectedCount() {
  if (!wss) return 0;
  return [...wss.clients].filter(c => c.readyState === WebSocket.OPEN).length;
}

// ─── Public broadcast API ──────────────────────────────────────────────────────
function broadcastNewSignal(signal, isStock = false) {
  broadcast(isStock ? "stock_signals" : "crypto_signals", "NEW_SIGNAL", { signal });
}

function broadcastClosedSignal(signal, isStock = false) {
  broadcast(isStock ? "stock_signals" : "crypto_signals", "SIGNAL_CLOSED", { signal });
}

module.exports = {
  createWsServer,
  // Crypto engine calls these:
  broadcastNewSignal,
  broadcastClosedSignal,
  broadcastSignalClosed: (signal) => broadcastClosedSignal(signal, false),
  // Stock engine calls these:
  broadcastNewStockSignal:    (signal) => broadcastNewSignal(signal, true),
  broadcastClosedStockSignal: (signal) => broadcastClosedSignal(signal, true),
  getConnectedCount,
};
