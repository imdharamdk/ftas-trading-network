/**
 * useSSE — FTAS Server-Sent Events hook (Vercel frontend compatible)
 *
 * Connects to Render backend SSE endpoint via EventSource.
 * Never use on Vercel server-side — client-only.
 *
 * Improvements over naive implementations:
 *  - unmounted guard prevents setState after component destroy
 *  - duplicate connection guard (esRef check before new EventSource)
 *  - exponential backoff capped at 30s
 *  - visibility reconnect resets backoff counter
 *  - all 8 FTAS event types handled
 *  - getStoredToken() uses app's actual token key (not hardcoded localStorage)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredToken } from "./api";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const SSE_URL  = `${API_BASE}/signals/stream`;

const BACKOFF_BASE_MS = 2_000;   // 2s first retry
const BACKOFF_MAX_MS  = 30_000;  // 30s max
const BACKOFF_FACTOR  = 2;       // doubles each retry: 2s, 4s, 8s, 16s, 30s

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
  const esRef       = useRef(null);
  const retryCount  = useRef(0);
  const retryTimer  = useRef(null);
  const unmounted   = useRef(false);

  const connect = useCallback(() => {
    if (unmounted.current) return;
    if (esRef.current) return;           // ← prevent double connection

    const token = getStoredToken();
    if (!token) return;                  // not logged in — skip

    const url = `${SSE_URL}?token=${encodeURIComponent(token)}`;
    const es  = new EventSource(url);
    esRef.current = es;

    // ── Server confirmed connection ──────────────────────────────────────────
    es.addEventListener("connected", () => {
      if (unmounted.current) return;
      setConnected(true);
      retryCount.current = 0; // reset backoff on successful connect
      console.log("[sse] ✅ Connected");
    });

    es.addEventListener("heartbeat", () => { /* keepalive — no action */ });

    // ── Signal events ────────────────────────────────────────────────────────
    es.addEventListener("signal:new",    (e) => { try { onSignalNew?.(JSON.parse(e.data).signal);   } catch {} });
    es.addEventListener("signal:closed", (e) => { try { onSignalClosed?.(JSON.parse(e.data).signal); } catch {} });
    es.addEventListener("stock:new",     (e) => { try { onStockNew?.(JSON.parse(e.data).signal);    } catch {} });
    es.addEventListener("stock:closed",  (e) => { try { onStockClosed?.(JSON.parse(e.data).signal); } catch {} });

    // ── Price + stats ────────────────────────────────────────────────────────
    es.addEventListener("price:update",  (e) => { try { onPriceUpdate?.(JSON.parse(e.data).prices); } catch {} });
    es.addEventListener("stats:update",  (e) => {
      try {
        const d = JSON.parse(e.data);
        onStatsUpdate?.({ crypto: d.crypto, stocks: d.stocks });
      } catch {}
    });

    // ── Chat + Engine ────────────────────────────────────────────────────────
    es.addEventListener("chat:message",  (e) => { try { onChatMessage?.(JSON.parse(e.data).message); } catch {} });
    es.addEventListener("engine:status", (e) => { try { onEngineStatus?.(JSON.parse(e.data).engine); } catch {} });

    // ── Error → reconnect with exponential backoff ───────────────────────────
    es.onerror = () => {
      if (unmounted.current) return;
      setConnected(false);
      es.close();
      esRef.current = null;

      const delay = Math.min(BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, retryCount.current), BACKOFF_MAX_MS);
      retryCount.current++;
      console.log(`[sse] ❌ Error — retry #${retryCount.current} in ${Math.round(delay / 1000)}s`);
      retryTimer.current = setTimeout(connect, delay);
    };
  }, [onSignalNew, onSignalClosed, onStockNew, onStockClosed, onPriceUpdate, onStatsUpdate, onChatMessage, onEngineStatus]);

  useEffect(() => {
    unmounted.current = false;
    connect();

    // Reconnect when user switches back to the tab
    function onVisible() {
      if (document.visibilityState === "visible" && !esRef.current) {
        clearTimeout(retryTimer.current);
        retryCount.current = 0; // reset backoff for manual reconnect
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
    };
  }, [connect]);

  return { connected };
}
