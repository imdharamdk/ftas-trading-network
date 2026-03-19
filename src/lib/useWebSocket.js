/**
 * useWebSocket — FTAS realtime WebSocket hook
 *
 * Auto-connects, auto-authenticates, auto-reconnects with exponential backoff.
 * Returns { connected, lastMessage, send }
 *
 * Usage:
 *   const { connected } = useWebSocket({
 *     onSignalNew:    (signal) => ...,
 *     onSignalClosed: (signal) => ...,
 *     onPriceUpdate:  (prices) => ...,  // { BTCUSDT: 60000, ... }
 *     onStatsUpdate:  (data)   => ...,  // { crypto: {...}, stocks: {...} }
 *     onChatMessage:  (msg)    => ...,
 *     onEngineStatus: (engine) => ...,
 *   });
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredToken } from "./api";

// Derive WebSocket URL from current page URL
function getWsUrl() {
  const base = import.meta.env.VITE_API_BASE_URL;
  if (base && base.startsWith("http")) {
    return base.replace(/^http/, "ws").replace(/\/api\/?$/, "") + "/ws";
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

const RECONNECT_BASE_MS  = 2_000;   // first retry after 2s
const RECONNECT_MAX_MS   = 30_000;  // max 30s between retries
const RECONNECT_FACTOR   = 1.8;     // exponential backoff multiplier

export function useWebSocket({
  onSignalNew,
  onSignalClosed,
  onStockNew,
  onStockClosed,
  onPriceUpdate,
  onStatsUpdate,
  onChatMessage,
  onEngineStatus,
} = {}) {
  const [connected, setConnected] = useState(false);
  const wsRef       = useRef(null);
  const retryDelay  = useRef(RECONNECT_BASE_MS);
  const retryTimer  = useRef(null);
  const unmounted   = useRef(false);

  const handleMessage = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.type) {
      case "auth:ok":
        setConnected(true);
        retryDelay.current = RECONNECT_BASE_MS; // reset backoff on success
        break;
      case "auth:fail":
        console.warn("[ws] Auth failed");
        break;
      case "ping":
        // Respond with pong
        wsRef.current?.send(JSON.stringify({ type: "pong" }));
        break;
      case "signal:new":
        onSignalNew?.(msg.signal);
        break;
      case "signal:closed":
        onSignalClosed?.(msg.signal);
        break;
      case "stock:new":
        onStockNew?.(msg.signal);
        break;
      case "stock:closed":
        onStockClosed?.(msg.signal);
        break;
      case "price:update":
        onPriceUpdate?.(msg.prices);
        break;
      case "stats:update":
        onStatsUpdate?.({ crypto: msg.crypto, stocks: msg.stocks });
        break;
      case "chat:message":
        onChatMessage?.(msg.message);
        break;
      case "engine:status":
        onEngineStatus?.(msg.engine);
        break;
      default:
        break;
    }
  }, [onSignalNew, onSignalClosed, onStockNew, onStockClosed, onPriceUpdate, onStatsUpdate, onChatMessage, onEngineStatus]);

  const connect = useCallback(() => {
    if (unmounted.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const token = getStoredToken();
    if (!token) return; // not logged in

    const url = getWsUrl();
    console.log("[ws] Connecting to", url);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[ws] Connected — authenticating");
      ws.send(JSON.stringify({ type: "auth", token }));
    };

    ws.onmessage = handleMessage;

    ws.onclose = (event) => {
      setConnected(false);
      wsRef.current = null;
      if (unmounted.current) return;
      // Don't reconnect on auth failure
      if (event.code === 4001) {
        console.warn("[ws] Auth failed — not reconnecting");
        return;
      }
      // Exponential backoff reconnect
      const delay = retryDelay.current;
      retryDelay.current = Math.min(delay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
      console.log(`[ws] Disconnected — retrying in ${Math.round(delay / 1000)}s`);
      retryTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror, handles reconnect
    };
  }, [handleMessage]);

  useEffect(() => {
    unmounted.current = false;
    connect();

    // Also reconnect when tab becomes visible again
    function onVisible() {
      if (document.visibilityState === "visible") {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          clearTimeout(retryTimer.current);
          retryDelay.current = RECONNECT_BASE_MS;
          connect();
        }
      }
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      unmounted.current = true;
      clearTimeout(retryTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
      wsRef.current?.close(1000, "Component unmounted");
      wsRef.current = null;
    };
  }, [connect]);

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { connected, send };
}
