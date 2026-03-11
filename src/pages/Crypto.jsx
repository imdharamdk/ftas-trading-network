import { useEffect, useRef, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";

// Expiry config — must match backend SIGNAL_EXPIRY_MS
const EXPIRY_MS = { "1m": 5 * 60 * 1000, "5m": 15 * 60 * 1000 };

function getExpiryMs(signal) {
  return EXPIRY_MS[signal.timeframe] || 15 * 60 * 1000;
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

function ExpiryCountdown({ signal }) {
  const [remaining, setRemaining] = useState(() => getRemainingMs(signal));
  useEffect(() => {
    const id = setInterval(() => setRemaining(getRemainingMs(signal)), 1000);
    return () => clearInterval(id);
  }, [signal.createdAt, signal.timeframe]);
  const pct = remaining / getExpiryMs(signal);
  const cls =
    remaining <= 0 ? "expiry-badge expiry-dead"   :
    pct < 0.25     ? "expiry-badge expiry-urgent" :
    pct < 0.5      ? "expiry-badge expiry-warn"   :
                     "expiry-badge expiry-ok";
  return <span className={cls}>⏱ {formatCountdown(remaining)}</span>;
}

export default function Crypto() {
  const [activeSignals, setActiveSignals]   = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState("");
  const [tab, setTab]                       = useState("active");

  const signalCoinsKey = getSignalCoins(activeSignals).join(",");

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [activeRes, historyRes] = await Promise.allSettled([
          apiFetch("/signals/active?limit=100"),
          apiFetch("/signals/history?limit=100"),
        ]);
        if (!mounted) return;
        const allActive  = activeRes.status  === "fulfilled" ? (activeRes.value.signals  || []) : [];
        const allHistory = historyRes.status === "fulfilled" ? (historyRes.value.signals || []) : [];
        // Only 1m and 5m scalping signals
        setActiveSignals(allActive.filter(s  => s.source !== "SMART_ENGINE" && ["1m","5m"].includes(s.timeframe)));
        setHistorySignals(allHistory.filter(s => s.source !== "SMART_ENGINE" && ["1m","5m"].includes(s.timeframe)));
      } catch (e) {
        if (mounted) setError(e.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    const id = window.setInterval(load, 15000);
    return () => { mounted = false; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    let mounted = true;
    async function refreshPrices() {
      if (!signalCoinsKey) return;
      try {
        const res = await apiFetch(`/signals/live-prices?coins=${signalCoinsKey}`);
        if (!mounted) return;
        setActiveSignals(cur => mergeSignalLivePrices(cur, res.prices || []));
      } catch {}
    }
    refreshPrices();
    const id = window.setInterval(refreshPrices, 5000);
    return () => { mounted = false; window.clearInterval(id); };
  }, [signalCoinsKey]);

  const closedCount   = historySignals.length;
  const expiredCount  = historySignals.filter(s => s.result === "EXPIRED").length;
  const winCount      = historySignals.filter(s => ["TP1_HIT","TP2_HIT","TP3_HIT"].includes(s.result)).length;
  const resolvedCount = closedCount - expiredCount;
  const winRate       = resolvedCount > 0 ? ((winCount / resolvedCount) * 100).toFixed(1) : "—";

  return (
    <AppShell subtitle="Binance Futures — Scalping signals (1m & 5m only)" title="Crypto Scalping">
      <style>{`
        .expiry-badge { display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:0.5px; }
        .expiry-ok     { background:rgba(34,197,94,0.15);  color:#22c55e; }
        .expiry-warn   { background:rgba(234,179,8,0.15);  color:#eab308; }
        .expiry-urgent { background:rgba(239,68,68,0.18);  color:#ef4444; animation:pulse-exp 0.8s infinite; }
        .expiry-dead   { background:rgba(107,114,128,0.15);color:#6b7280; }
        @keyframes pulse-exp { 0%,100%{opacity:1}50%{opacity:0.45} }
        .tab-bar { display:flex;gap:8px;margin-bottom:16px; }
        .tab-btn { padding:7px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.15s;background:rgba(255,255,255,0.06);color:#94a3b8; }
        .tab-btn.active { background:rgba(99,102,241,0.25);color:#818cf8; }
        .tab-btn:hover:not(.active) { background:rgba(255,255,255,0.1);color:#e2e8f0; }
        .tf-badge { display:inline-block;padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700;background:rgba(99,102,241,0.18);color:#818cf8; }
      `}</style>

      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Active Trades</span>
          <strong>{activeSignals.length}</strong>
          <span className="metric-meta">1m &amp; 5m live</span>
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
          <span className="metric-meta">Auto-closed</span>
        </article>
      </section>

      <div className="tab-bar">
        <button className={`tab-btn${tab === "active" ? " active" : ""}`} onClick={() => setTab("active")}>
          🟢 Active Trades {activeSignals.length > 0 ? `(${activeSignals.length})` : ""}
        </button>
        <button className={`tab-btn${tab === "closed" ? " active" : ""}`} onClick={() => setTab("closed")}>
          📋 Closed Signals {closedCount > 0 ? `(${closedCount})` : ""}
        </button>
      </div>

      {tab === "active" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Live Board</span>
              <h2>Active Scalp Trades</h2>
              <p style={{fontSize:12,color:"#64748b",margin:"4px 0 0"}}>
                Auto-expire: <strong>1m → 5 min</strong> &nbsp;|&nbsp; <strong>5m → 15 min</strong>
              </p>
            </div>
            <span className="pill pill-success">{activeSignals.length} active</span>
          </div>
          {activeSignals.length > 0 ? (
            <>
              <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:12}}>
                {activeSignals.map(s => (
                  <div key={s.id} style={{display:"flex",alignItems:"center",gap:6,background:"rgba(255,255,255,0.04)",padding:"5px 10px",borderRadius:8,fontSize:12}}>
                    <span className="tf-badge">{s.timeframe}</span>
                    <span style={{fontWeight:600,color:"#e2e8f0"}}>{s.coin?.replace("USDT","")}</span>
                    <span className={`pill ${s.side === "LONG" ? "pill-success" : "pill-danger"}`} style={{fontSize:10}}>{s.side}</span>
                    <ExpiryCountdown signal={s} />
                  </div>
                ))}
              </div>
              <SignalTable signals={activeSignals} emptyLabel="No active scalp signals." />
            </>
          ) : (
            <div style={{textAlign:"center",padding:"40px 0",color:"#64748b"}}>
              {loading ? "⏳ Loading..." : "🔍 No active scalp signals right now. Engine is scanning..."}
            </div>
          )}
        </section>
      )}

      {tab === "closed" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">History</span>
              <h2>Closed Scalp Signals</h2>
            </div>
            <div style={{display:"flex",gap:8}}>
              <span className="pill pill-success">{winCount} wins</span>
              <span className="pill pill-danger">{resolvedCount - winCount} SL</span>
              <span className="pill pill-neutral">{expiredCount} expired</span>
            </div>
          </div>
          <SignalTable compact signals={historySignals} emptyLabel="No closed scalp signals yet." />
        </section>
      )}
    </AppShell>
  );
}
