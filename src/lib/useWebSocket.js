import { useEffect, useRef, useState } from "react";
import { getStoredToken } from "./api";

function getWsUrl(token) {
  const base = import.meta.env.VITE_API_BASE_URL;
  const query = token ? `?token=${encodeURIComponent(token)}` : "";

  if (base && base.startsWith("http")) {
    return `${base.replace(/^http/, "ws").replace(/\/api\/?$/, "")}/ws${query}`;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws${query}`;
}

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;

let sharedSocket = null;
let sharedConnected = false;
let sharedRetryDelay = RECONNECT_BASE_MS;
let sharedRetryTimer = null;
const listeners = new Set();

function emitConnected(next) {
  sharedConnected = next;
  for (const listener of listeners) {
    try {
      listener.onConnectedChange?.(next);
    } catch {}
  }
}

function notifyMessage(msg) {
  for (const listener of listeners) {
    try {
      listener.onMessage?.(msg);
    } catch {}
  }
}

function hasDemand() {
  for (const listener of listeners) {
    if (listener.wantsRealtime?.()) return true;
  }
  return false;
}

function subscribeChannels(socket, availableChannels) {
  const channelDemand = {
    crypto_signals: false,
    stock_signals: false,
    prices: false,
  };

  for (const listener of listeners) {
    const wants = listener.getDesiredChannels?.() || [];
    for (const channel of wants) {
      if (channel in channelDemand) channelDemand[channel] = true;
    }
  }

  for (const channel of availableChannels || []) {
    if (channelDemand[channel]) {
      socket.send(JSON.stringify({ type: "SUBSCRIBE", channel }));
    }
  }
}

function cleanupSocket() {
  if (sharedSocket) {
    try {
      sharedSocket.onopen = null;
      sharedSocket.onmessage = null;
      sharedSocket.onclose = null;
      sharedSocket.onerror = null;
      if (sharedSocket.readyState === WebSocket.OPEN || sharedSocket.readyState === WebSocket.CONNECTING) {
        sharedSocket.close(1000, "No listeners");
      }
    } catch {}
  }
  sharedSocket = null;
  emitConnected(false);
}

function scheduleReconnect() {
  if (sharedRetryTimer || !hasDemand()) return;
  const delay = sharedRetryDelay;
  sharedRetryDelay = Math.min(delay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
  sharedRetryTimer = window.setTimeout(() => {
    sharedRetryTimer = null;
    ensureSharedConnection();
  }, delay);
}

function ensureSharedConnection() {
  if (typeof window === "undefined") return;
  if (!hasDemand()) {
    cleanupSocket();
    return;
  }

  const token = getStoredToken();
  if (!token) {
    cleanupSocket();
    return;
  }

  if (sharedSocket?.readyState === WebSocket.OPEN || sharedSocket?.readyState === WebSocket.CONNECTING) {
    return;
  }

  const socket = new WebSocket(getWsUrl(token));
  sharedSocket = socket;

  socket.onopen = () => {
    sharedRetryDelay = RECONNECT_BASE_MS;
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "CONNECTED") {
      emitConnected(true);
      subscribeChannels(socket, msg?.data?.availableChannels || []);
      return;
    }

    if (msg.type === "PING") {
      socket.send(JSON.stringify({ type: "PONG" }));
      return;
    }

    if (msg.type === "ERROR") {
      console.warn("[ws]", msg.message || "WebSocket error");
    }

    notifyMessage(msg);
  };

  socket.onclose = (event) => {
    if (sharedSocket === socket) sharedSocket = null;
    emitConnected(false);

    if (!hasDemand()) return;
    if (event.code === 4001) {
      console.warn("[ws] Auth failed, not reconnecting");
      return;
    }

    scheduleReconnect();
  };

  socket.onerror = () => {};
}

function createListener(handlerRef, setConnected) {
  return {
    wantsRealtime() {
      const current = handlerRef.current;
      return Boolean(
        current.onSignalNew ||
        current.onSignalClosed ||
        current.onStockNew ||
        current.onStockClosed ||
        current.onPriceUpdate ||
        current.onStatsUpdate ||
        current.onChatMessage ||
        current.onEngineStatus
      );
    },
    getDesiredChannels() {
      const current = handlerRef.current;
      const desired = [];
      if (current.onSignalNew || current.onSignalClosed) desired.push("crypto_signals");
      if (current.onStockNew || current.onStockClosed) desired.push("stock_signals");
      if (current.onPriceUpdate) desired.push("prices");
      return desired;
    },
    onConnectedChange(next) {
      setConnected(next);
    },
    onMessage(msg) {
      const current = handlerRef.current;
      switch (msg.type) {
        case "NEW_SIGNAL":
          if (msg.channel === "crypto_signals") current.onSignalNew?.(msg.data?.signal);
          if (msg.channel === "stock_signals") current.onStockNew?.(msg.data?.signal);
          break;
        case "SIGNAL_CLOSED":
          if (msg.channel === "crypto_signals") current.onSignalClosed?.(msg.data?.signal);
          if (msg.channel === "stock_signals") current.onStockClosed?.(msg.data?.signal);
          break;
        case "PRICE_UPDATE":
          current.onPriceUpdate?.(msg.data?.prices);
          break;
        case "stats:update":
          current.onStatsUpdate?.({ crypto: msg.crypto, stocks: msg.stocks });
          break;
        case "chat:message":
          current.onChatMessage?.(msg.message);
          break;
        case "engine:status":
          current.onEngineStatus?.(msg.engine);
          break;
        default:
          break;
      }
    },
  };
}

export function useWebSocket(handlers = {}) {
  const [connected, setConnected] = useState(sharedConnected);
  const handlerRef = useRef(handlers);
  handlerRef.current = handlers;

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const listener = createListener(handlerRef, setConnected);
    listeners.add(listener);
    ensureSharedConnection();

    function onVisible() {
      if (document.visibilityState === "visible") {
        if (sharedRetryTimer) {
          window.clearTimeout(sharedRetryTimer);
          sharedRetryTimer = null;
        }
        sharedRetryDelay = RECONNECT_BASE_MS;
        ensureSharedConnection();
      }
    }

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      listeners.delete(listener);
      document.removeEventListener("visibilitychange", onVisible);
      if (!hasDemand()) {
        if (sharedRetryTimer) {
          window.clearTimeout(sharedRetryTimer);
          sharedRetryTimer = null;
        }
        cleanupSocket();
      }
    };
  }, []);

  const send = (data) => {
    if (sharedSocket?.readyState === WebSocket.OPEN) {
      sharedSocket.send(JSON.stringify(data));
    }
  };

  return { connected, send };
}
