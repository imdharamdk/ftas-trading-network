import { useEffect, useMemo, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";

export default function Crypto() {
  const [activeSignals, setActiveSignals]   = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [overview, setOverview]             = useState(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState("");

  const signalCoinsKey = getSignalCoins(activeSignals).join(",");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [overviewRes, activeRes, historyRes] = await Promise.allSettled([
          apiFetch("/signals/stats/overview"),
          apiFetch("/signals/active?limit=100"),
          apiFetch("/signals/history?limit=50"),
        ]);
        if (!active) return;
        setOverview(overviewRes.status === "fulfilled" ? overviewRes.value.stats : null);
        const allActive  = activeRes.status  === "fulfilled" ? activeRes.value.signals  || [] : [];
        const allHistory = historyRes.status === "fulfilled" ? historyRes.value.signals || [] : [];
        setActiveSignals(allActive.filter(s  => s.source !== "SMART_ENGINE"));
        setHistorySignals(allHistory.filter(s => s.source !== "SMART_ENGINE" && s.result !== "EXPIRED"));
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    const id = window.setInterval(load, 20000);
    return () => { active = false; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    let active = true;
    async function refreshPrices() {
      if (!signalCoinsKey) return;
      try {
        const res = await apiFetch(`/signals/live-prices?coins=${signalCoinsKey}`);
        if (!active) return;
        setActiveSignals(cur => mergeSignalLivePrices(cur, res.prices || []));
      } catch { /* keep stale */ }
    }
    refreshPrices();
    const id = window.setInterval(refreshPrices, 5000);
    return () => { active = false; window.clearInterval(id); };
  }, [signalCoinsKey]);

  return (
    <AppShell subtitle="Binance Futures crypto signals — live trades and closed history." title="Crypto Signals">
      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Active</span>
          <strong>{activeSignals.length}</strong>
          <span className="metric-meta">Live crypto trades</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Closed</span>
          <strong>{overview?.closedSignals ?? 0}</strong>
          <span className="metric-meta">24h window</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Win Rate</span>
          <strong>{overview?.winRate ?? 0}%</strong>
          <span className="metric-meta">24h window</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Avg Confidence</span>
          <strong>{overview?.averageConfidence ?? 0}%</strong>
          <span className="metric-meta">Active signals</span>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Live board</span><h2>Active FO / crypto signals</h2></div>
          <span className="pill pill-success">{activeSignals.length} active</span>
        </div>
        <SignalTable
          emptyLabel={loading ? "Loading signals..." : "No active crypto signals yet."}
          signals={activeSignals}
        />
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">History</span><h2>Recent closures</h2></div>
          <span className="pill pill-neutral">{historySignals.length} closes</span>
        </div>
        <SignalTable
          compact
          emptyLabel="No closed crypto signals yet."
          signals={historySignals}
        />
      </section>
    </AppShell>
  );
}
