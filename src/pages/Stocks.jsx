import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";

export default function Stocks() {
  const { user } = useSession();
  const isAdmin = user?.role === "ADMIN";
  const [overview, setOverview] = useState(null);
  const [activeSignals, setActiveSignals] = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [engine, setEngine] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionBusy, setActionBusy] = useState("");

  const overviewCards = useMemo(() => ([
    { label: "Active", value: overview?.activeSignals ?? 0 },
    { label: "Closed", value: overview?.closedSignals ?? 0 },
    { label: "Win rate", value: `${overview?.winRate ?? 0}%` },
    { label: "Avg confidence", value: `${overview?.averageConfidence ?? 0}%` },
  ]), [overview]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    const responses = await Promise.allSettled([
      apiFetch("/stocks/stats/overview"),
      apiFetch("/stocks/active?limit=40"),
      apiFetch("/stocks/history?limit=40"),
      apiFetch("/stocks/engine/status"),
    ]);

    const [overviewRes, activeRes, historyRes, engineRes] = responses;
    setOverview(overviewRes.status === "fulfilled" ? overviewRes.value.stats : null);
    setActiveSignals(activeRes.status === "fulfilled" ? activeRes.value.signals || [] : []);
    setHistorySignals(historyRes.status === "fulfilled" ? historyRes.value.signals || [] : []);
    setEngine(engineRes.status === "fulfilled" ? engineRes.value.engine : null);
    if (responses.some((res) => res.status === "rejected")) {
      setError(responses.find((res) => res.status === "rejected")?.reason?.message || "Failed to load SmartAPI signals");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleEngineAction(action) {
    setActionBusy(action);
    setError("");
    try {
      if (action === "start") {
        const response = await apiFetch("/stocks/engine/start", { method: "POST" });
        setEngine(response.engine);
      } else if (action === "stop") {
        const response = await apiFetch("/stocks/engine/stop", { method: "POST" });
        setEngine(response.engine);
      } else if (action === "scan") {
        await apiFetch("/stocks/scan", { method: "POST" });
      }
      await loadData();
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  return (
    <AppShell
      subtitle="Angel One SmartAPI powered F&O, equities, and commodities signals."
      title="Indian Market Signals"
    >
      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="stats-grid">
        {overviewCards.map((card) => (
          <article className="metric-card" key={card.label}>
            <span className="metric-label">{card.label}</span>
            <strong>{card.value}</strong>
            <span className="metric-meta">{card.label === "Active" ? "Smart engine" : "24h window"}</span>
          </article>
        ))}
      </section>

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
            <div>
              <span className="detail-label">Interval</span>
              <strong>{Math.round((engine?.intervalMs || 120000) / 1000)} sec</strong>
            </div>
            <div>
              <span className="detail-label">Scans</span>
              <strong>{engine?.scanCount || 0}</strong>
            </div>
            <div>
              <span className="detail-label">Last output</span>
              <strong>{engine?.lastGenerated || 0} signals</strong>
            </div>
            <div>
              <span className="detail-label">Last scan</span>
              <strong>{engine?.lastScanAt ? new Date(engine.lastScanAt).toLocaleTimeString("en-IN") : "Never"}</strong>
            </div>
          </div>
          {isAdmin ? (
            <div className="button-row">
              <button className="button button-primary" disabled={actionBusy === "start"} onClick={() => handleEngineAction("start")} type="button">
                Start engine
              </button>
              <button className="button button-ghost" disabled={actionBusy === "stop"} onClick={() => handleEngineAction("stop")} type="button">
                Stop engine
              </button>
              <button className="button button-secondary" disabled={actionBusy === "scan"} onClick={() => handleEngineAction("scan")} type="button">
                Run scan now
              </button>
            </div>
          ) : (
            <p className="panel-note">Engine controls are restricted to admins.</p>
          )}
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Universe</span>
              <h2>Segments covered</h2>
            </div>
          </div>
          <div className="list-stack">
            <div className="list-card">
              <strong>Equity cash</strong>
              <span>NSE/BSE large caps from SmartAPI instruments list.</span>
            </div>
            <div className="list-card">
              <strong>F&amp;O</strong>
              <span>NIFTY, BANKNIFTY, and major stock futures/options tokens.</span>
            </div>
            <div className="list-card">
              <strong>Commodities</strong>
              <span>MCX contracts such as crude oil and bullion.</span>
            </div>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Live board</span>
            <h2>Active FO / stock signals</h2>
          </div>
          <span className="pill pill-success">{activeSignals.length} active</span>
        </div>
        <SignalTable
          emptyLabel={loading ? "Loading SmartAPI signals..." : "No active contracts yet."}
          signals={activeSignals}
        />
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">History</span>
            <h2>Recent closures</h2>
          </div>
          <span className="pill pill-neutral">{historySignals.length} closes</span>
        </div>
        <SignalTable
          emptyLabel={loading ? "Loading SmartAPI history..." : "No closed trades yet."}
          signals={historySignals}
        />
      </section>
    </AppShell>
  );
}
