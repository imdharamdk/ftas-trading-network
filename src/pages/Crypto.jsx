import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";
import { useSession } from "../context/useSession";
import { useWebSocket } from "../lib/useWebSocket";

// ─── Expiry config — loaded from backend at startup via /api/signals/config ──
// FIX: Was hardcoded here. Now fetched from backend so both stay in sync.
// Falls back to defaults while loading (matches backend values).
let EXPIRY_MS = {
  "1m":  8  * 60 * 1000,
  "5m":  25 * 60 * 1000,
  "15m": 90 * 60 * 1000,
  "30m":  3  * 60 * 60 * 1000,
  "1h":   6  * 60 * 60 * 1000,
  "4h":  24  * 60 * 60 * 1000,
  default: 6 * 60 * 60 * 1000,
};

// Load from backend once at module init
apiFetch("/signals/config").then(cfg => {
  if (cfg?.signalExpiryMs) EXPIRY_MS = cfg.signalExpiryMs;
}).catch(() => { /* use defaults */ });

function getExpiryMs(signal) {
  return EXPIRY_MS[signal.timeframe] || EXPIRY_MS.default || 6 * 60 * 60 * 1000;
}

function getRemainingMs(signal) {
  if (!signal.createdAt) return 0;
  const elapsed = Date.now() - new Date(signal.createdAt).getTime();
  return Math.max(0, getExpiryMs(signal) - elapsed);
}

function formatCountdown(ms) {
  if (ms <= 0) return "EXPIRED";
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function isWinningResult(result) {
  return ["TP1_HIT", "TP2_HIT", "TP3_HIT"].includes(String(result || "").toUpperCase());
}

// ─── Single global tick — ONE timer for the whole page ───────────────────────
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ─── Countdown badge (receives now from parent — no own timer) ───────────────
function ExpiryCountdown({ signal, now }) {
  const remaining = Math.max(0, getExpiryMs(signal) - (now - new Date(signal.createdAt).getTime()));
  const pct = remaining / getExpiryMs(signal);
  const cls =
    remaining <= 0 ? "expiry-badge expiry-dead" :
    pct < 0.25     ? "expiry-badge expiry-urgent" :
    pct < 0.5      ? "expiry-badge expiry-warn" :
                     "expiry-badge expiry-ok";
  const label = remaining <= 0 ? "EXPIRED" : formatCountdown(remaining);
  return <span className={cls}>⏱ {label}</span>;
}

export default function Crypto() {
  const { user } = useSession();
  const isAdmin = user?.role === "ADMIN";
  const now = useNow(); // single 1s tick for all countdowns
  const riskPref = String(user?.riskPreference || "BALANCED").toUpperCase();
  const minConfidence = riskPref === "AGGRESSIVE" ? 70 : riskPref === "CONSERVATIVE" ? 90 : 80;
  const passesRisk = useCallback((signal) => Number(signal?.confidence || 0) >= minConfidence, [minConfidence]);

  const [activeSignals, setActiveSignals]   = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [expiredSignals, setExpiredSignals] = useState([]);
  const [overview, setOverview]             = useState(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState("");
  const [tab, setTab]                       = useState("active"); // "active" | "closed" | "expired"
  const [tfFilter, setTfFilter]             = useState("ALL"); // "ALL"|"1m"|"5m"|"15m"|"30m"|"1h"
  const [historyLimit, setHistoryLimit]     = useState(50);
  const [expiredLimit, setExpiredLimit]     = useState(50);
  const [historyLoaded, setHistoryLoaded]   = useState(false);
  const [expiredLoaded, setExpiredLoaded]   = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expiredLoading, setExpiredLoading] = useState(false);
  const [closedFilter, setClosedFilter] = useState("all");

  const ALL_TF = ["1m","5m","15m","30m","1h"];

  const dashboardFocus = useMemo(() => {
    if (typeof window === "undefined") return "";
    const params = new URLSearchParams(window.location.search || "");
    return String(params.get("focus") || "").toLowerCase();
  }, []);

  useEffect(() => {
    if (dashboardFocus === "active") {
      setTab("active");
      setClosedFilter("all");
      return;
    }
    if (dashboardFocus === "wins") {
      setTab("closed");
      setClosedFilter("wins");
      return;
    }
    if (dashboardFocus === "losses") {
      setTab("closed");
      setClosedFilter("losses");
    }
  }, [dashboardFocus]);

  // ── WebSocket handlers ─────────────────────────────────────────────────────
  const onSignalNew = useCallback((signal) => {
    if (signal.source === "SMART_ENGINE") return; // stock signal — ignore
    if (!ALL_TF.includes(signal.timeframe)) return;
    if (!passesRisk(signal)) return;
    setActiveSignals(prev => {
      // Avoid duplicate
      if (prev.some(s => s.id === signal.id)) return prev;
      return [signal, ...prev];
    });
  }, [passesRisk]);

  const onSignalClosed = useCallback((signal) => {
    if (signal.source === "SMART_ENGINE") return;
    // Remove from active
    setActiveSignals(prev => prev.filter(s => s.id !== signal.id));
    // Add to correct bucket
    if (!passesRisk(signal)) return;
    if (signal.result === "EXPIRED") {
      setExpiredSignals(prev => [signal, ...prev.filter(s => s.id !== signal.id)]);
    } else {
      setHistorySignals(prev => [signal, ...prev.filter(s => s.id !== signal.id)]);
    }
  }, [passesRisk]);

  const onPriceUpdate = useCallback((prices) => {
    setActiveSignals(prev => prev.map(s => {
      const livePrice = prices[s.coin];
      if (!livePrice) return s;
      const entry = Number(s.entry);
      const signalMovePercent = entry ? Number((((s.side === "LONG" ? livePrice - entry : entry - livePrice) / entry) * 100).toFixed(2)) : null;
      return { ...s, livePrice, liveUpdatedAt: new Date().toISOString(), signalMovePercent };
    }));
  }, []);

  const onStatsUpdate = useCallback(({ crypto }) => {
    if (crypto) setOverview(prev => ({ ...prev, ...crypto }));
  }, []);

  const { connected: wsConnected } = useWebSocket({
    onSignalNew,
    onSignalClosed,
    onPriceUpdate,
    onStatsUpdate,
  });

  // ── Admin: coin search + paused coins ──────────────────────────────────────
  const [searchCoin, setSearchCoin]         = useState("");
  const [searchLoading, setSearchLoading]   = useState(false);
  const [searchResult, setSearchResult]     = useState(null);
  const [pausedCoins, setPausedCoins]       = useState({});
  const [pauseReason, setPauseReason]       = useState("");

  // ── Admin: load paused coins ────────────────────────────────────────────────
  useEffect(() => {
    if (!isAdmin) return;
    apiFetch("/signals/admin/paused-coins")
      .then((res) => setPausedCoins(res.pausedCoins || {}))
      .catch(() => {});
  }, [isAdmin]);

  async function handleSearchGenerate() {
    const coin = searchCoin.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!coin) return;
    const symbol = coin.endsWith("USDT") ? coin : `${coin}USDT`;
    setSearchLoading(true);
    setSearchResult(null);
    try {
      const res = await apiFetch("/signals/admin/generate-for-coin", {
        method: "POST",
        body: { symbol },
      });
      setSearchResult(res);
      if (res.generated) {
        // Reload active signals after new signal generated
        const activeRes = await apiFetch("/signals/active?limit=100");
        const all = activeRes.signals || [];
        const ALL_TF = ["1m","5m","15m","30m","1h"];
        setActiveSignals(all.filter(s => s.source !== "SMART_ENGINE" && ALL_TF.includes(s.timeframe) && passesRisk(s)));
        setTab("active");
      }
    } catch (e) {
      setSearchResult({ generated: false, message: e.message });
    } finally {
      setSearchLoading(false);
    }
  }

  async function handlePauseCoin(symbol) {
    try {
      const res = await apiFetch("/signals/admin/pause-coin", {
        method: "POST",
        body: { symbol, reason: pauseReason || "Repeated stop losses" },
      });
      setPausedCoins(res.pausedCoins || {});
      setPauseReason("");
    } catch (e) { alert(e.message); }
  }

  async function handleResumeCoin(symbol) {
    try {
      const res = await apiFetch("/signals/admin/resume-coin", {
        method: "POST",
        body: { symbol },
      });
      setPausedCoins(res.pausedCoins || {});
    } catch (e) { alert(e.message); }
  }

  const signalCoinsKey = useMemo(() => getSignalCoins(activeSignals).join(","), [activeSignals]);

  // ── Data loader ────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        // Phase 1: active signals — backend expires stale ones first
        const [overviewRes, activeRes] = await Promise.allSettled([
          apiFetch("/signals/stats/overview"),
          apiFetch("/signals/active?limit=60"),
        ]);
        if (!mounted) return;

        setOverview(overviewRes.status === "fulfilled" ? overviewRes.value.stats : null);

        const ALL_TF = ["1m","5m","15m","30m","1h"];
        const allActive = activeRes.status === "fulfilled" ? (activeRes.value.signals || []) : [];
        setActiveSignals(allActive.filter(s => s.source !== "SMART_ENGINE" && ALL_TF.includes(s.timeframe) && passesRisk(s)));
        setLoading(false); // show page immediately
      } catch (e) {
        if (mounted) { setError(e.message); setLoading(false); }
      }
    }
    load();
    // WS handles realtime — polling is fallback only (every 2 min)
    const id = window.setInterval(load, 120_000);
    return () => { mounted = false; window.clearInterval(id); };
  }, []);

  const loadHistory = useCallback(async () => {
    if (historyLoaded || historyLoading) return;
    setHistoryLoading(true);
    try {
      const res = await apiFetch("/signals/history?limit=200");
      const allHistory = res.signals || [];
      const ALL_TF = ["1m","5m","15m","30m","1h"];
      setHistorySignals(allHistory.filter(s => s.source !== "SMART_ENGINE" && ALL_TF.includes(s.timeframe) && passesRisk(s)));
      setHistoryLoaded(true);
    } catch {}
    finally { setHistoryLoading(false); }
  }, [historyLoaded, historyLoading, passesRisk]);

  const loadExpired = useCallback(async () => {
    if (expiredLoaded || expiredLoading) return;
    setExpiredLoading(true);
    try {
      const res = await apiFetch("/signals/expired?limit=200");
      const allExpired = res.signals || [];
      const ALL_TF = ["1m","5m","15m","30m","1h"];
      setExpiredSignals(allExpired.filter(s => s.source !== "SMART_ENGINE" && ALL_TF.includes(s.timeframe) && passesRisk(s)));
      setExpiredLoaded(true);
    } catch {}
    finally { setExpiredLoading(false); }
  }, [expiredLoaded, expiredLoading, passesRisk]);

  useEffect(() => {
    if (tab === "closed") loadHistory();
    if (tab === "expired") loadExpired();
  }, [tab, loadHistory, loadExpired]);

  // ── Live price refresh (fallback when WS not connected) ───────────────────
  useEffect(() => {
    if (wsConnected) return; // WS handles prices — skip polling
    let mounted = true;
    async function refreshPrices() {
      if (!signalCoinsKey) return;
      try {
        const res = await apiFetch(`/signals/live-prices?coins=${signalCoinsKey}`);
        if (!mounted) return;
        setActiveSignals(cur => mergeSignalLivePrices(cur, res.prices || []));
      } catch { /* keep stale */ }
    }
    refreshPrices();
    const id = window.setInterval(refreshPrices, 20_000);
    return () => { mounted = false; window.clearInterval(id); };
  }, [signalCoinsKey, wsConnected]);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const closedSignals  = historySignals; // historySignals already = TP/SL only from backend
  const closedCount    = closedSignals.length;
  const expiredCount   = expiredSignals.length;
  const winCount       = closedSignals.filter(s => isWinningResult(s.result)).length;
  const resolvedCount  = closedCount;
  const winRate        = resolvedCount > 0 ? ((winCount / resolvedCount) * 100).toFixed(1) : "—";

  // TF-filtered views
  const filteredActive   = tfFilter === "ALL" ? activeSignals  : activeSignals.filter(s => s.timeframe === tfFilter);
  const filteredClosed   = tfFilter === "ALL" ? closedSignals  : closedSignals.filter(s => s.timeframe === tfFilter);
  const filteredExpired  = tfFilter === "ALL" ? expiredSignals : expiredSignals.filter(s => s.timeframe === tfFilter);
  const outcomeFilteredClosed = filteredClosed.filter((signal) => {
    if (closedFilter === "wins") return isWinningResult(signal.result);
    if (closedFilter === "losses") return String(signal?.result || "").toUpperCase() === "SL_HIT";
    return true;
  });
  const visibleHistory   = outcomeFilteredClosed.slice(0, historyLimit);
  const visibleExpired   = filteredExpired.slice(0, expiredLimit);

  return (
    <AppShell subtitle="Bybit Futures — Multi-timeframe signals (1m · 5m · 15m · 30m · 1h)" title="Crypto Signals">
      {/* Inline styles for expiry badges */}
      <style>{`
        .expiry-badge {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 2px 8px; border-radius: 999px;
          font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
          letter-spacing: 0.5px;
        }
        .expiry-ok     { background: rgba(34,197,94,0.15);  color: #22c55e; }
        .expiry-warn   { background: rgba(234,179,8,0.15);  color: #eab308; }
        .expiry-urgent { background: rgba(239,68,68,0.18);  color: #ef4444; animation: pulse-exp 0.8s infinite; }
        .expiry-dead   { background: rgba(107,114,128,0.15); color: #6b7280; }
        @keyframes pulse-exp { 0%,100% { opacity:1; } 50% { opacity:0.45; } }
        .tab-bar { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }
        .tab-btn {
          padding: 7px 20px; border-radius: 8px; border: none; cursor: pointer;
          font-size: 13px; font-weight: 600; transition: all 0.15s;
          background: rgba(255,255,255,0.06); color: #94a3b8;
        }
        .tab-btn.active { background: rgba(99,102,241,0.25); color: #818cf8; }
        .tab-btn:hover:not(.active) { background: rgba(255,255,255,0.1); color: #e2e8f0; }
        .signal-timeframe-badge {
          display:inline-block; padding:2px 7px; border-radius:6px;
          font-size:11px; font-weight:700;
          background: rgba(99,102,241,0.18); color: #818cf8;
        }
        .tf-badge-1m  { background:rgba(99,102,241,0.2);  color:#818cf8; }
        .tf-badge-5m  { background:rgba(6,182,212,0.2);   color:#22d3ee; }
        .tf-badge-15m { background:rgba(16,185,129,0.2);  color:#34d399; }
        .tf-badge-30m { background:rgba(245,158,11,0.2);  color:#fbbf24; }
        .tf-badge-1h  { background:rgba(239,68,68,0.2);   color:#f87171; }
        .tf-filter-bar { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; align-items:center; }
        .tf-btn {
          padding: 4px 12px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1);
          cursor: pointer; font-size: 11px; font-weight: 700; transition: all 0.15s;
          background: rgba(255,255,255,0.04); color: #64748b;
        }
        .tf-btn.active { border-color: rgba(99,102,241,0.5); background: rgba(99,102,241,0.15); color: #a5b4fc; }
        .tf-btn:hover:not(.active) { background: rgba(255,255,255,0.08); color: #94a3b8; }
      `}</style>

      {error ? <div className="banner banner-error">{error}</div> : null}

      {/* Stats */}
      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Active Trades</span>
          <strong>{activeSignals.length}</strong>
          <span className="metric-meta">1m · 5m · 15m · 30m · 1h</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Closed</span>
          <strong>{resolvedCount}</strong>
          <span className="metric-meta">TP / SL hit</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Win Rate</span>
          <strong>{winRate}{winRate !== "—" ? "%" : ""}</strong>
          <span className="metric-meta">Excluding expired</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Expired</span>
          <strong>{expiredCount}</strong>
          <span className="metric-meta">Auto-closed (no hit)</span>
        </article>
      </section>

      {/* ── ADMIN PANEL ─────────────────────────────────────────────────────── */}
      {isAdmin && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-header">
            <div>
              <span className="eyebrow">Admin Controls</span>
              <h2>🔧 Signal Management</h2>
            </div>
          </div>

          {/* ── Coin Search & Force Generate ──────────────────────────────── */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 8 }}>
              🔍 Search Coin &amp; Generate Signal
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="text"
                value={searchCoin}
                onChange={(e) => setSearchCoin(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && handleSearchGenerate()}
                placeholder="e.g. BTC or BTCUSDT"
                style={{
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(99,102,241,0.35)",
                  borderRadius: 8, padding: "8px 14px", color: "#e2e8f0",
                  fontSize: 13, outline: "none", width: 180,
                }}
              />
              <button
                onClick={handleSearchGenerate}
                disabled={searchLoading || !searchCoin.trim()}
                style={{
                  background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                  border: "none", borderRadius: 8, padding: "8px 18px",
                  color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
                  opacity: (searchLoading || !searchCoin.trim()) ? 0.5 : 1,
                }}
              >
                {searchLoading ? "⏳ Scanning…" : "⚡ Generate Signal"}
              </button>
            </div>

            {searchResult && (
              <div style={{
                marginTop: 10, padding: "12px 14px", borderRadius: 10,
                background: searchResult.generated
                  ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
                border: `1px solid ${searchResult.generated ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
                fontSize: 13,
              }}>
                {searchResult.generated ? (
                  <div style={{ color: "#22c55e" }}>
                    ✅ Signal generated! <strong>{searchResult.signal?.coin}</strong> — {searchResult.signal?.side} @ {searchResult.signal?.entry} | Confidence: {searchResult.signal?.confidence}%
                    {searchResult.diagnostics?.gateResults && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#86efac" }}>
                        Timeframe: {searchResult.diagnostics.winner?.toUpperCase()} | Fib: {Object.values(searchResult.diagnostics.gateResults).find(r => r?.gates?.fibonacci)?.gates?.fibonacci || "—"}
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div style={{ color: "#ef4444", marginBottom: 8 }}>
                      ⚠️ No signal generated for <strong>{searchCoin.trim().toUpperCase()}</strong>
                    </div>
                    {searchResult.diagnostics?.gateResults && (
                      <div style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 4 }}>
                        {Object.entries(searchResult.diagnostics.gateResults).map(([tf, r]) => {
                          const verdict = typeof r === "object" ? r.verdict : r;
                          const passed  = verdict?.includes("PASS");
                          return (
                            <div key={tf} style={{
                              padding: "4px 8px", borderRadius: 6,
                              background: passed ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                              color: passed ? "#86efac" : "#fca5a5",
                              display: "flex", gap: 8,
                            }}>
                              <span style={{ fontWeight: 700, minWidth: 28 }}>{tf.toUpperCase()}</span>
                              <span>{verdict}</span>
                              {typeof r === "object" && r.gates && (
                                <span style={{ color: "#64748b", marginLeft: "auto" }}>
                                  {Object.entries(r.gates).map(([g, v]) => `${g}:${v?.split(" ")[0]}`).join(" · ")}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Paused Coins Manager ──────────────────────────────────────── */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 10 }}>
              🚫 Paused Coins (Removed from Scanner)
            </div>

            {/* Pause a coin */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
              <input
                type="text"
                placeholder="Coin to pause, e.g. SOLUSDT"
                id="pauseCoinInput"
                style={{
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(239,68,68,0.35)",
                  borderRadius: 8, padding: "8px 14px", color: "#e2e8f0",
                  fontSize: 13, outline: "none", width: 180,
                }}
              />
              <input
                type="text"
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                placeholder="Reason (optional)"
                style={{
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8, padding: "8px 14px", color: "#e2e8f0",
                  fontSize: 13, outline: "none", width: 200,
                }}
              />
              <button
                onClick={() => {
                  const sym = document.getElementById("pauseCoinInput").value.trim().toUpperCase();
                  if (!sym) return;
                  const symbol = sym.endsWith("USDT") ? sym : `${sym}USDT`;
                  handlePauseCoin(symbol);
                  document.getElementById("pauseCoinInput").value = "";
                }}
                style={{
                  background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.4)",
                  borderRadius: 8, padding: "8px 16px",
                  color: "#ef4444", fontWeight: 700, fontSize: 13, cursor: "pointer",
                }}
              >
                🚫 Pause Coin
              </button>
            </div>

            {/* List of paused coins */}
            {Object.keys(pausedCoins).length === 0 ? (
              <div style={{ color: "#475569", fontSize: 13 }}>No coins are currently paused. ✅</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {Object.entries(pausedCoins).map(([symbol, info]) => (
                  <div key={symbol} style={{
                    background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
                    borderRadius: 10, padding: "8px 12px",
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    <div>
                      <div style={{ fontWeight: 700, color: "#ef4444", fontSize: 13 }}>{symbol}</div>
                      <div style={{ fontSize: 11, color: "#64748b" }}>{info.reason}</div>
                      <div style={{ fontSize: 10, color: "#475569" }}>
                        by {info.pausedBy} · {new Date(info.pausedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                      </div>
                    </div>
                    <button
                      onClick={() => handleResumeCoin(symbol)}
                      style={{
                        background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)",
                        borderRadius: 7, padding: "5px 12px",
                        color: "#22c55e", fontWeight: 700, fontSize: 12, cursor: "pointer",
                      }}
                    >
                      ▶ Resume
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* TF Filter Bar */}
      <div className="tf-filter-bar">
        <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>TIMEFRAME:</span>
        {["ALL","1m","5m","15m","30m","1h"].map(tf => (
          <button key={tf} className={`tf-btn${tfFilter === tf ? " active" : ""}`} onClick={() => { setTfFilter(tf); setHistoryLimit(50); setExpiredLimit(50); }}>
            {tf}
            {tf !== "ALL" && activeSignals.filter(s => s.timeframe === tf).length > 0 && (
              <span style={{ marginLeft: 4, background: "rgba(99,102,241,0.3)", borderRadius: 8, padding: "0 4px", fontSize: 10 }}>
                {activeSignals.filter(s => s.timeframe === tf).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab switcher */}
      <div className="tab-bar">
        <button className={`tab-btn${tab === "active" ? " active" : ""}`} onClick={() => setTab("active")}>
          🟢 Active Trades {filteredActive.length > 0 ? `(${filteredActive.length})` : ""}
        </button>
        <button className={`tab-btn${tab === "closed" ? " active" : ""}`} onClick={() => { setTab("closed"); setHistoryLimit(50); }}>
          ✅ Closed Signals {closedCount > 0 ? `(${closedCount})` : ""}
        </button>
        <button className={`tab-btn${tab === "expired" ? " active" : ""}`} onClick={() => { setTab("expired"); setExpiredLimit(50); }}>
          ⏰ Expired {expiredCount > 0 ? `(${expiredCount})` : ""}
        </button>
      </div>

      {/* ── ACTIVE TAB ── */}
      {tab === "active" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Live Board</span>
              <h2>Active Trades</h2>
              <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
                Auto-expire: <strong>1m→8m</strong> · <strong>5m→25m</strong> · <strong>15m→90m</strong> · <strong>30m→3h</strong> · <strong>1h→6h</strong>
              </p>
            </div>
            <span className="pill pill-success">{filteredActive.length} active</span>
          </div>

          {filteredActive.length > 0 ? (
            <div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:12 }}>
                {filteredActive.map(s => (
                  <div key={s.id} style={{ display:"flex", alignItems:"center", gap:6,
                    background:"rgba(255,255,255,0.04)", padding:"5px 10px", borderRadius:8, fontSize:12 }}>
                    <span className={`signal-timeframe-badge tf-badge-${s.timeframe}`}>{s.timeframe}</span>
                    <span style={{ fontWeight:600, color:"#e2e8f0" }}>{s.coin?.replace("USDT","")}</span>
                    <span className={`pill ${s.side === "LONG" ? "pill-success" : "pill-danger"}`} style={{fontSize:10}}>{s.side}</span>
                    <ExpiryCountdown signal={s} now={now} />
                  </div>
                ))}
              </div>
              <SignalTable
                emptyLabel={loading ? "Loading signals..." : "No active signals."}
                signals={filteredActive}
              />
            </div>
          ) : (
            <div style={{ textAlign:"center", padding:"40px 0", color:"#64748b" }}>
              {loading ? "⏳ Loading signals..." : tfFilter !== "ALL"
                ? `🔍 No active ${tfFilter} signals. Try a different timeframe or ALL.`
                : "🔍 No active signals right now. Engine is scanning..."}
            </div>
          )}
        </section>
      )}

      {/* ── CLOSED TAB ── */}
      {tab === "closed" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">History</span>
              <h2>Closed Signals</h2>
              <p style={{ fontSize:12, color:"#64748b", margin:"4px 0 0" }}>
                TP1 / TP2 / TP3 hits &amp; Stop Loss hits only
              </p>
              <div style={{ display:"flex", gap:8, marginTop:10, flexWrap:"wrap" }}>
                <button type="button" className={`tf-btn${closedFilter === "all" ? " active" : ""}`} onClick={() => { setClosedFilter("all"); setHistoryLimit(50); }}>
                  All {filteredClosed.length}
                </button>
                <button type="button" className={`tf-btn${closedFilter === "wins" ? " active" : ""}`} onClick={() => { setClosedFilter("wins"); setHistoryLimit(50); }}>
                  Wins {filteredClosed.filter((signal) => isWinningResult(signal.result)).length}
                </button>
                <button type="button" className={`tf-btn${closedFilter === "losses" ? " active" : ""}`} onClick={() => { setClosedFilter("losses"); setHistoryLimit(50); }}>
                  Losses {filteredClosed.filter((signal) => String(signal?.result || "").toUpperCase() === "SL_HIT").length}
                </button>
              </div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <span className="pill pill-success">{winCount} wins</span>
              <span className="pill pill-danger">{resolvedCount - winCount} SL</span>
            </div>
          </div>
          <SignalTable
            compact
            emptyLabel={historyLoading || !historyLoaded ? "Loading history..." : "No closed signals yet."}
            signals={visibleHistory}
          />
          {outcomeFilteredClosed.length > historyLimit && (
            <div style={{ textAlign:"center", padding:"16px 0 4px" }}>
              <button
                onClick={() => setHistoryLimit(l => l + 50)}
                style={{
                  background:"rgba(99,102,241,0.15)", color:"#818cf8",
                  border:"1px solid rgba(99,102,241,0.3)", borderRadius:8,
                  padding:"8px 24px", cursor:"pointer", fontSize:13, fontWeight:600,
                }}
              >
                Load More ({historyLimit}/{outcomeFilteredClosed.length} showing)
              </button>
            </div>
          )}
          {outcomeFilteredClosed.length > 0 && outcomeFilteredClosed.length <= historyLimit && (
            <p style={{ textAlign:"center", fontSize:12, color:"#475569", padding:"12px 0 0" }}>
              All {outcomeFilteredClosed.length} signals loaded
            </p>
          )}
        </section>
      )}

      {/* ── EXPIRED TAB ── */}
      {tab === "expired" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Expired</span>
              <h2>Expired Signals</h2>
              <p style={{ fontSize:12, color:"#64748b", margin:"4px 0 0" }}>
                Signals that timed out without hitting TP or SL
              </p>
            </div>
            <span className="pill pill-neutral">{expiredCount} expired</span>
          </div>
          <SignalTable
            compact
            emptyLabel={expiredLoading || !expiredLoaded ? "Loading expired signals..." : "No expired signals yet."}
            signals={visibleExpired}
          />
          {filteredExpired.length > expiredLimit && (
            <div style={{ textAlign:"center", padding:"16px 0 4px" }}>
              <button
                onClick={() => setExpiredLimit(l => l + 50)}
                style={{
                  background:"rgba(107,114,128,0.15)", color:"#9ca3af",
                  border:"1px solid rgba(107,114,128,0.3)", borderRadius:8,
                  padding:"8px 24px", cursor:"pointer", fontSize:13, fontWeight:600,
                }}
              >
                Load More ({expiredLimit}/{filteredExpired.length} showing)
              </button>
            </div>
          )}
          {filteredExpired.length > 0 && filteredExpired.length <= expiredLimit && (
            <p style={{ textAlign:"center", fontSize:12, color:"#475569", padding:"12px 0 0" }}>
              All {filteredExpired.length} expired signals loaded
            </p>
          )}
        </section>
      )}
    </AppShell>
  );
}
