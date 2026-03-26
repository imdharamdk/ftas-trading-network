import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";
import { useWebSocket } from "../lib/useWebSocket";

function isCryptoCoin(coin) {
  return String(coin || "").toUpperCase().endsWith("USDT");
}

function isWinningResult(result) {
  return ["TP1_HIT", "TP2_HIT", "TP3_HIT"].includes(String(result || "").toUpperCase());
}

function isCommoditySignal(signal) {
  const instrument = signal?.scanMeta?.instrument || {};
  const exchange = String(instrument.exchange || signal?.exchange || "").toUpperCase();
  const segment = String(instrument.segment || signal?.segment || "").toUpperCase();
  const instrumentType = String(instrument.instrumentType || signal?.instrumentType || "").toUpperCase();

  if (isCryptoCoin(signal?.coin)) return false;
  return exchange === "MCX"
    || exchange === "NCDEX"
    || segment === "COMMODITY"
    || instrumentType.includes("COM");
}

function buildOverview(activeSignals, closedSignals) {
  const wins = closedSignals.filter((signal) => isWinningResult(signal.result)).length;
  const avgConfidence = activeSignals.length
    ? activeSignals.reduce((sum, signal) => sum + Number(signal.confidence || 0), 0) / activeSignals.length
    : 0;

  return {
    activeSignals: activeSignals.length,
    closedSignals: closedSignals.length,
    totalWins: wins,
    totalLosses: Math.max(0, closedSignals.length - wins),
    averageConfidence: Number(avgConfidence.toFixed(1)),
    winRate: closedSignals.length ? Number(((wins / closedSignals.length) * 100).toFixed(1)) : 0,
  };
}

export default function Commodities() {
  const { user } = useSession();
  const isAdmin = user?.role === "ADMIN";
  const passesRisk = useCallback(() => true, []);

  const [activeSignals, setActiveSignals] = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("active");
  const [historyLimit, setHistoryLimit] = useState(50);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [closedFilter, setClosedFilter] = useState("all");

  const dashboardFocus = (() => {
    if (typeof window === "undefined") return "";
    const params = new URLSearchParams(window.location.search || "");
    return String(params.get("focus") || "").toLowerCase();
  })();

  const loadData = useCallback(async () => {
    setError("");
    const [, activeRes] = await Promise.allSettled([
      apiFetch("/stocks/stats/overview"),
      apiFetch(`/stocks/active?limit=${isAdmin ? 1000 : 40}`),
    ]);

    const rawActive = activeRes.status === "fulfilled" ? activeRes.value.signals || [] : [];
    setActiveSignals(rawActive.filter((signal) => isCommoditySignal(signal) && passesRisk(signal)));
    setLoading(false);
  }, [isAdmin, passesRisk]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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

  const onStockNew = useCallback((signal) => {
    if (!isCommoditySignal(signal) || !passesRisk(signal)) return;
    setActiveSignals((current) => {
      if (current.some((item) => item.id === signal.id)) return current;
      return [signal, ...current];
    });
  }, [passesRisk]);

  const onStockClosed = useCallback((signal) => {
    if (!isCommoditySignal(signal)) return;
    setActiveSignals((current) => current.filter((item) => item.id !== signal.id));
    if (!passesRisk(signal)) return;
    setHistorySignals((current) => [signal, ...current.filter((item) => item.id !== signal.id)]);
  }, [passesRisk]);

  useWebSocket({
    onStockNew,
    onStockClosed,
  });

  const loadHistory = useCallback(async () => {
    if (historyLoaded || historyLoading) return;
    setHistoryLoading(true);
    try {
      const res = await apiFetch(isAdmin ? "/stocks/history?limit=5000&includeArchive=1" : "/stocks/history?limit=200");
      const rawHistory = res.signals || [];
      setHistorySignals(rawHistory.filter((signal) => isCommoditySignal(signal) && passesRisk(signal)));
      setHistoryLoaded(true);
    } catch {}
    finally {
      setHistoryLoading(false);
    }
  }, [historyLoaded, historyLoading, isAdmin, passesRisk]);

  useEffect(() => {
    if (tab === "closed") loadHistory();
  }, [tab, loadHistory]);

  const activeCoinsKey = getSignalCoins(activeSignals).join(",");
  useEffect(() => {
    let mounted = true;
    async function refreshPrices() {
      if (!activeCoinsKey) return;
      try {
        const res = await apiFetch(`/stocks/live-prices?coins=${activeCoinsKey}`);
        if (!mounted) return;
        setActiveSignals((current) => mergeSignalLivePrices(current, res.prices || []));
      } catch {}
    }
    refreshPrices();
    const id = window.setInterval(refreshPrices, 25_000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, [activeCoinsKey]);

  const closedSignals = historySignals;
  const closedCount = closedSignals.length;
  const winCount = closedSignals.filter((signal) => isWinningResult(signal.result)).length;
  const resolvedCount = closedCount;
  const winRate = resolvedCount > 0 ? ((winCount / resolvedCount) * 100).toFixed(1) : "—";
  const outcomeFilteredClosed = closedSignals.filter((signal) => {
    if (closedFilter === "wins") return isWinningResult(signal.result);
    if (closedFilter === "losses") return String(signal?.result || "").toUpperCase() === "SL_HIT";
    return true;
  });
  const visibleClosed = outcomeFilteredClosed.slice(0, historyLimit);
  const overview = useMemo(() => buildOverview(activeSignals, closedSignals), [activeSignals, closedSignals]);

  return (
    <AppShell
      subtitle="MCX commodity signals powered by SmartAPI, with live entries, exits, and closed trade history."
      title="Commodity Signals"
    >
      <style>{`
        .tab-bar { display:flex;gap:8px;margin-bottom:16px; }
        .tab-btn { padding:7px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.15s;background:rgba(255,255,255,0.06);color:#94a3b8; }
        .tab-btn.active { background:rgba(245,158,11,0.2);color:#f59e0b; }
        .tab-btn:hover:not(.active) { background:rgba(255,255,255,0.1);color:#e2e8f0; }
      `}</style>

      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Active Trades</span>
          <strong>{activeSignals.length}</strong>
          <span className="metric-meta">MCX engine live</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Closed</span>
          <strong>{resolvedCount}</strong>
          <span className="metric-meta">TP / SL hit</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Win Rate</span>
          <strong>{winRate}{winRate !== "—" ? "%" : ""}</strong>
          <span className="metric-meta">TP / SL only</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Avg Confidence</span>
          <strong>{overview.averageConfidence ?? 0}%</strong>
          <span className="metric-meta">Active commodity signals</span>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Universe</span><h2>Contracts covered</h2></div>
        </div>
        <div className="list-stack">
          <div className="list-card"><strong>Energy</strong><span>Crude oil and other MCX energy contracts when enabled in SmartAPI.</span></div>
          <div className="list-card"><strong>Metals</strong><span>Gold, silver, bullion, and related commodity futures.</span></div>
          <div className="list-card"><strong>Commodity stream</strong><span>This page only shows signals identified as MCX or COMMODITY instruments.</span></div>
        </div>
      </section>

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
      </div>

      {tab === "active" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Live Board</span>
              <h2>Active Commodity Signals</h2>
            </div>
            <span className="pill pill-warning">{activeSignals.length} active</span>
          </div>
          {activeSignals.length > 0 ? (
            <SignalTable
              signals={activeSignals}
              emptyLabel={loading ? "Loading commodity signals..." : "No active commodity contracts right now."}
            />
          ) : (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#64748b" }}>
              {loading ? "⏳ Loading signals..." : "🔍 No active commodity signals right now. Engine is scanning..."}
            </div>
          )}
        </section>
      )}

      {tab === "closed" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">History</span>
              <h2>Closed Commodity Signals</h2>
              <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
                TP1 / TP2 / TP3 hits &amp; Stop Loss hits only
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button type="button" className={`tab-btn${closedFilter === "all" ? " active" : ""}`} onClick={() => { setClosedFilter("all"); setHistoryLimit(50); }}>
                  All {closedSignals.length}
                </button>
                <button type="button" className={`tab-btn${closedFilter === "wins" ? " active" : ""}`} onClick={() => { setClosedFilter("wins"); setHistoryLimit(50); }}>
                  Wins {closedSignals.filter((signal) => isWinningResult(signal.result)).length}
                </button>
                <button type="button" className={`tab-btn${closedFilter === "losses" ? " active" : ""}`} onClick={() => { setClosedFilter("losses"); setHistoryLimit(50); }}>
                  Losses {closedSignals.filter((signal) => String(signal?.result || "").toUpperCase() === "SL_HIT").length}
                </button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span className="pill pill-success">{winCount} wins</span>
              <span className="pill pill-danger">{resolvedCount - winCount} SL</span>
            </div>
          </div>
          <SignalTable
            compact
            signals={visibleClosed}
            emptyLabel={historyLoading || !historyLoaded ? "Loading commodity history..." : "No closed commodity trades yet."}
          />
          {outcomeFilteredClosed.length > historyLimit && (
            <div style={{ textAlign: "center", padding: "16px 0 4px" }}>
              <button
                onClick={() => setHistoryLimit((limit) => limit + 50)}
                style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "8px 24px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                Load More ({historyLimit}/{outcomeFilteredClosed.length} showing)
              </button>
            </div>
          )}
        </section>
      )}
    </AppShell>
  );
}
