/**
 * useSSE — FTAS Server-Sent Events hook (Vercel frontend compatible)
 *
 * Connects to Render backend SSE endpoint via EventSource.
 * Auto-reconnects with backoff. Complements useWebSocket as fallback.
 *
 * Usage:
 *   const { connected } = useSSE({
 *     onSignalNew:    (signal) => ...,
 *     onSignalClosed: (signal) => ...,
 *     onPriceUpdate:  (prices) => ...,
 *     onStatsUpdate:  ({ crypto, stocks }) => ...,
 *     onChatMessage:  (msg) => ...,
 *   });
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredToken } from "./api";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const SSE_URL  = `${API_BASE}/signals/stream`;

const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS  = 30_000;
const RECONNECT_FACTOR  = 1.8;

export function useSSE({
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
  const esRef      = useRef(null);
  const retryDelay = useRef(RECONNECT_BASE_MS);
  const retryTimer = useRef(null);
  const unmounted  = useRef(false);

  const connect = useCallback(() => {
    if (unmounted.current) return;
    const token = getStoredToken();
    if (!token) return;

    // Close existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const url = `${SSE_URL}?token=${encodeURIComponent(token)}`;
    const es  = new EventSource(url);
    esRef.current = es;

    es.addEventListener("connected", () => {
      setConnected(true);
      retryDelay.current = RECONNECT_BASE_MS; // reset backoff
      console.log("[sse] Connected");
    });

    es.addEventListener("heartbeat", () => {
      // Server keepalive — no action needed
    });

    es.addEventListener("signal:new", (e) => {
      try { onSignalNew?.(JSON.parse(e.data).signal); } catch {}
    });

    es.addEventListener("signal:closed", (e) => {
      try { onSignalClosed?.(JSON.parse(e.data).signal); } catch {}
    });

    es.addEventListener("stock:new", (e) => {
      try { onStockNew?.(JSON.parse(e.data).signal); } catch {}
    });

    es.addEventListener("stock:closed", (e) => {
      try { onStockClosed?.(JSON.parse(e.data).signal); } catch {}
    });

    es.addEventListener("price:update", (e) => {
      try { onPriceUpdate?.(JSON.parse(e.data).prices); } catch {}
    });

    es.addEventListener("stats:update", (e) => {
      try {
        const d = JSON.parse(e.data);
        onStatsUpdate?.({ crypto: d.crypto, stocks: d.stocks });
      } catch {}
    });

    es.addEventListener("chat:message", (e) => {
      try { onChatMessage?.(JSON.parse(e.data).message); } catch {}
    });

    es.addEventListener("engine:status", (e) => {
      try { onEngineStatus?.(JSON.parse(e.data).engine); } catch {}
    });

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      if (unmounted.current) return;
      const delay = retryDelay.current;
      retryDelay.current = Math.min(delay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
      console.log(`[sse] Reconnecting in ${Math.round(delay / 1000)}s`);
      retryTimer.current = setTimeout(connect, delay);
    };
  }, [onSignalNew, onSignalClosed, onStockNew, onStockClosed, onPriceUpdate, onStatsUpdate, onChatMessage, onEngineStatus]);

  useEffect(() => {
    unmounted.current = false;
    connect();

    // Reconnect on tab visibility
    function onVisible() {
      if (document.visibilityState === "visible" && !esRef.current) {
        clearTimeout(retryTimer.current);
        retryDelay.current = RECONNECT_BASE_MS;
        connect();
      }
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      unmounted.current = true;
      clearTimeout(retryTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [connect]);

  return { connected };
}
