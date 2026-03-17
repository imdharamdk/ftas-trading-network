import { useCallback, useEffect, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";

// Crypto coins USDT mein end hote hain — stock page pe kabhi nahi dikhne chahiye
function isCryptoCoin(coin) {
  return String(coin || "").toUpperCase().endsWith("USDT");
}

export default function Stocks() {
  const { user } = useSession();
  const isAdmin = user?.role === "ADMIN";

  const [overview, setOverview]             = useState(null);
  const [activeSignals, setActiveSignals]   = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [engine, setEngine]                 = useState(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState("");
  const [actionBusy, setActionBusy]         = useState("");
  const [tab, setTab]                       = useState("active"); // "active" | "closed" | "expired"
  const [historyLimit, setHistoryLimit]     = useState(50);
  const [expiredLimit, setExpiredLimit]     = useState(50);
  const [purgeMsg, setPurgeMsg]             = useState("");

  // ── Data loader ────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setError("");
    const responses = await Promise.allSettled([
      apiFetch("/stocks/stats/overview"),
      apiFetch("/stocks/active?limit=40"),
      apiFetch("/stocks/history?limit=5000"),
      apiFetch("/stocks/engine/status"),
    ]);
    const [overviewRes, activeRes, historyRes, engineRes] = responses;
    setOverview(overviewRes.status   === "fulfilled" ? overviewRes.value.stats        : null);
    // Frontend safety filter — strip any crypto signals that slipped through
    const rawActive  = activeRes.status  === "fulfilled" ? activeRes.value.signals  || [] : [];
    const rawHistory = historyRes.status === "fulfilled" ? historyRes.value.signals || [] : [];
    setActiveSignals(rawActive.filter(s  => !isCryptoCoin(s.coin)));
    setHistorySignals(rawHistory.filter(s => !isCryptoCoin(s.coin)));
    setEngine(engineRes.status          === "fulfilled" ? engineRes.value.engine        : null);
    const failed = responses.find(r => r.status === "rejected");
    if (failed) setError(failed.reason?.message || "Failed to load SmartAPI signals");
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const id = window.setInterval(loadData, 30000);
    return () => window.clearInterval(id);
  }, [loadData]);

  // ── Live price refresh ─────────────────────────────────────────────────────
  const activeCoinsKey = getSignalCoins(activeSignals).join(",");
  useEffect(() => {
    let mounted = true;
    async function refreshPrices() {
      if (!activeCoinsKey) return;
      try {
        const res = await apiFetch(`/stocks/live-prices?coins=${activeCoinsKey}`);
        if (!mounted) return;
        setActiveSignals(cur => mergeSignalLivePrices(cur, res.prices || []));
      } catch {}
    }
    refreshPrices();
    const id = window.setInterval(refreshPrices, 12000);
    return () => { mounted = false; window.clearInterval(id); };
  }, [activeCoinsKey]);

  // ── Engine controls ────────────────────────────────────────────────────────
  async function handleEngineAction(action) {
    setActionBusy(action);
    setError("");
    try {
      if (action === "start")     { const r = await apiFetch("/stocks/engine/start", { method: "POST" }); setEngine(r.engine); }
      else if (action === "stop") { const r = await apiFetch("/stocks/engine/stop",  { method: "POST" }); setEngine(r.engine); }
      else if (action === "scan") { await apiFetch("/stocks/scan", { method: "POST" }); }
      await loadData();
    } catch (e) {
      setError(e.message);
    } finally {
      setActionBusy("");
    }
  }

  // ── Purge crypto signals from stockSignals DB ──────────────────────────────
  async function handlePurgeCrypto() {
    if (!window.confirm("stockSignals collection se saare crypto (USDT) signals delete ho jaayenge. Continue?")) return;
    setActionBusy("purge");
    try {
      const res = await apiFetch("/stocks/admin/purge-crypto", { method: "POST" });
      setPurgeMsg(res.message || "Done");
      await loadData();
    } catch (e) {
      setError(e.message);
    } finally {
      setActionBusy("");
    }
  }

  // ── Derived stats ──────────────────────────────────────────────────────────
  const closedSignals  = historySignals.filter(s => s.result !== "EXPIRED");
  const expiredSignals = historySignals.filter(s => s.result === "EXPIRED");
  const closedCount    = closedSignals.length;
  const expiredCount   = expiredSignals.length;
  const winCount       = closedSignals.filter(s => ["TP1_HIT","TP2_HIT","TP3_HIT"].includes(s.result)).length;
  const resolvedCount  = closedCount;
  const winRate        = resolvedCount > 0 ? ((winCount / resolvedCount) * 100).toFixed(1) : "—";
  const visibleClosed  = closedSignals.slice(0, historyLimit);
  const visibleExpired = expiredSignals.slice(0, expiredLimit);

  return (
    <AppShell
      subtitle="Angel One SmartAPI powered F&O, equities, and commodities signals."
      title="Indian Market Signals"
    >
      <style>{`
        .tab-bar { display:flex;gap:8px;margin-bottom:16px; }
        .tab-btn { padding:7px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.15s;background:rgba(255,255,255,0.06);color:#94a3b8; }
        .tab-btn.active { background:rgba(99,102,241,0.25);color:#818cf8; }
        .tab-btn:hover:not(.active) { background:rgba(255,255,255,0.1);color:#e2e8f0; }
      `}</style>

      {error ? <div className="banner banner-error">{error}</div> : null}

      {/* Stats */}
      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Active Trades</span>
          <strong>{activeSignals.length}</strong>
          <span className="metric-meta">Smart engine live</span>
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
          <span className="metric-label">Avg Confidence</span>
          <strong>{overview?.averageConfidence ?? 0}%</strong>
          <span className="metric-meta">Active signals</span>
        </article>
      </section>

      {/* Engine + Universe */}
      <section className="section-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Stock engine</span>
              <h2>SmartAPI scanner</h2>
            </div>
            <span className={`pill ${engine?.running ? "pill-success" : "pill-danger"}`}>
              {engine?.running ? "LIVE" : "OFF"}
            </span>
          </div>
          <div className="detail-grid">
            <div><span className="detail-label">Interval</span><strong>{Math.round((engine?.intervalMs || 120000) / 1000)} sec</strong></div>
            <div><span className="detail-label">Scans</span><strong>{engine?.scanCount || 0}</strong></div>
            <div><span className="detail-label">Last output</span><strong>{engine?.lastGenerated || 0} signals</strong></div>
            <div><span className="detail-label">Last scan</span><strong>{engine?.lastScanAt ? new Date(engine.lastScanAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "Never"}</strong></div>
          </div>
          {isAdmin ? (
            <div className="button-row" style={{ flexWrap: "wrap", gap: 8 }}>
              <button className="button button-primary"   disabled={actionBusy === "start"} onClick={() => handleEngineAction("start")} type="button">Start engine</button>
              <button className="button button-ghost"     disabled={actionBusy === "stop"}  onClick={() => handleEngineAction("stop")}  type="button">Stop engine</button>
              <button className="button button-secondary" disabled={actionBusy === "scan"}  onClick={() => handleEngineAction("scan")}  type="button">Run scan now</button>
              <button
                disabled={actionBusy === "purge"}
                onClick={handlePurgeCrypto}
                type="button"
                style={{ background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >{actionBusy === "purge" ? "Purging..." : "🧹 Purge crypto signals"}</button>
              {purgeMsg && <span style={{ fontSize: 12, color: "#4ade80" }}>✅ {purgeMsg}</span>}
            </div>
          ) : (
            <p className="panel-note">Engine controls are restricted to admins.</p>
          )}
        </article>

        <article className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Universe</span><h2>Segments covered</h2></div>
          </div>
          <div className="list-stack">
            <div className="list-card"><strong>Equity cash</strong><span>NSE/BSE large caps from SmartAPI instruments list.</span></div>
            <div className="list-card"><strong>F&amp;O</strong><span>NIFTY, BANKNIFTY, and major stock futures/options tokens.</span></div>
            <div className="list-card"><strong>Commodities</strong><span>MCX contracts such as crude oil and bullion.</span></div>
          </div>
        </article>
      </section>

      {/* Tab switcher */}
      <div className="tab-bar">
        <button
          className={`tab-btn${tab === "active" ? " active" : ""}`}
          onClick={() => setTab("active")}
        >
          🟢 Active Trades {activeSignals.length > 0 ? `(${activeSignals.length})` : ""}
        </button>
        <button
          className={`tab-btn${tab === "closed" ? " active" : ""}`}
          onClick={() => { setTab("closed"); setHistoryLimit(50); }}
        >
          ✅ Closed Signals {closedCount > 0 ? `(${closedCount})` : ""}
        </button>
        <button
          className={`tab-btn${tab === "expired" ? " active" : ""}`}
          onClick={() => { setTab("expired"); setExpiredLimit(50); }}
        >
          ⏰ Expired {expiredCount > 0 ? `(${expiredCount})` : ""}
        </button>
      </div>

      {/* ── ACTIVE TAB ── */}
      {tab === "active" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Live Board</span>
              <h2>Active F&amp;O / Stock Signals</h2>
            </div>
            <span className="pill pill-success">{activeSignals.length} active</span>
          </div>
          {activeSignals.length > 0 ? (
            <SignalTable
              signals={activeSignals}
              emptyLabel={loading ? "Loading SmartAPI signals..." : "No active contracts yet."}
            />
          ) : (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#64748b" }}>
              {loading ? "⏳ Loading signals..." : "🔍 No active stock signals right now. Engine is scanning..."}
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
              <h2>Closed Stock Signals</h2>
              <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
                TP1 / TP2 / TP3 hits &amp; Stop Loss hits only
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span className="pill pill-success">{winCount} wins</span>
              <span className="pill pill-danger">{resolvedCount - winCount} SL</span>
            </div>
          </div>
          <SignalTable
            compact
            signals={visibleClosed}
            emptyLabel={loading ? "Loading SmartAPI history..." : "No closed trades yet."}
          />
          {closedSignals.length > historyLimit && (
            <div style={{ textAlign: "center", padding: "16px 0 4px" }}>
              <button
                onClick={() => setHistoryLimit(l => l + 50)}
                style={{ background: "rgba(99,102,241,0.15)", color: "#818cf8", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, padding: "8px 24px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                Load More ({historyLimit}/{closedSignals.length} showing)
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── EXPIRED TAB ── */}
      {tab === "expired" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Expired</span>
              <h2>Expired Stock Signals</h2>
              <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
                Signals that timed out without hitting TP or SL
              </p>
            </div>
            <span className="pill pill-neutral">{expiredCount} expired</span>
          </div>
          <SignalTable
            compact
            signals={visibleExpired}
            emptyLabel={loading ? "Loading..." : "No expired signals yet."}
          />
          {expiredSignals.length > expiredLimit && (
            <div style={{ textAlign: "center", padding: "16px 0 4px" }}>
              <button
                onClick={() => setExpiredLimit(l => l + 50)}
                style={{ background: "rgba(107,114,128,0.15)", color: "#9ca3af", border: "1px solid rgba(107,114,128,0.3)", borderRadius: 8, padding: "8px 24px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                Load More ({expiredLimit}/{expiredSignals.length} showing)
              </button>
            </div>
          )}
        </section>
      )}
    </AppShell>
  );
}
