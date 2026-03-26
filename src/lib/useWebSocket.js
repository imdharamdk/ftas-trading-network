/**
 * useWebSocket — FTAS realtime WebSocket hook
 *
 * Auto-connects, auto-subscribes, auto-reconnects with exponential backoff.
 * Returns { connected, lastMessage, send }
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
  const wsRef = useRef(null);
  const retryDelay = useRef(RECONNECT_BASE_MS);
  const retryTimer = useRef(null);
  const unmounted = useRef(false);

  const subscribeToAvailableChannels = useCallback((availableChannels = []) => {
    const channelSet = new Set(Array.isArray(availableChannels) ? availableChannels : []);

    if (channelSet.has("crypto_signals") && (onSignalNew || onSignalClosed)) {
      wsRef.current?.send(JSON.stringify({ type: "SUBSCRIBE", channel: "crypto_signals" }));
    }
    if (channelSet.has("stock_signals") && (onStockNew || onStockClosed)) {
      wsRef.current?.send(JSON.stringify({ type: "SUBSCRIBE", channel: "stock_signals" }));
    }
    if (channelSet.has("prices") && onPriceUpdate) {
      wsRef.current?.send(JSON.stringify({ type: "SUBSCRIBE", channel: "prices" }));
    }
  }, [onPriceUpdate, onSignalClosed, onSignalNew, onStockClosed, onStockNew]);

  const handleMessage = useCallback((event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "CONNECTED":
        setConnected(true);
        retryDelay.current = RECONNECT_BASE_MS;
        subscribeToAvailableChannels(msg?.data?.availableChannels);
        break;
      case "PING":
        wsRef.current?.send(JSON.stringify({ type: "PONG" }));
        break;
      case "NEW_SIGNAL":
        if (msg.channel === "crypto_signals") onSignalNew?.(msg.data?.signal);
        if (msg.channel === "stock_signals") onStockNew?.(msg.data?.signal);
        break;
      case "SIGNAL_CLOSED":
        if (msg.channel === "crypto_signals") onSignalClosed?.(msg.data?.signal);
        if (msg.channel === "stock_signals") onStockClosed?.(msg.data?.signal);
        break;
      case "PRICE_UPDATE":
        onPriceUpdate?.(msg.data?.prices);
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
      case "ERROR":
        console.warn("[ws]", msg.message || "WebSocket error");
        break;
      default:
        break;
    }
  }, [onChatMessage, onEngineStatus, onPriceUpdate, onSignalClosed, onSignalNew, onStatsUpdate, onStockClosed, onStockNew, subscribeToAvailableChannels]);

  const connect = useCallback(() => {
    if (unmounted.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

    const token = getStoredToken();
    if (!token) return;

    const url = getWsUrl(token);
    console.log("[ws] Connecting to", url);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[ws] Connected");
    };

    ws.onmessage = handleMessage;

    ws.onclose = (event) => {
      setConnected(false);
      wsRef.current = null;
      if (unmounted.current) return;
      if (event.code === 4001) {
        console.warn("[ws] Auth failed, not reconnecting");
        return;
      }
      const delay = retryDelay.current;
      retryDelay.current = Math.min(delay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
      console.log(`[ws] Disconnected, retrying in ${Math.round(delay / 1000)}s`);
      retryTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {};
  }, [handleMessage]);

  useEffect(() => {
    unmounted.current = false;
    connect();

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
