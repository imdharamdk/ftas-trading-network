import { useEffect, useMemo, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";

function formatPrice(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (Math.abs(n) >= 1)    return n.toFixed(4);
  if (Math.abs(n) >= 0.0001) return n.toFixed(6);
  return n.toFixed(8);
}

export default function Crypto() {
  const [overview, setOverview]         = useState(null);
  const [activeSignals, setActiveSignals] = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [timeframeFilter, setTimeframeFilter] = useState("ALL");
  const [sideFilter, setSideFilter]     = useState("ALL");
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState("");

  const signalCoinsKey = getSignalCoins(activeSignals).join(",");

  // Load signals
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

        // Only crypto signals — filter out SMART_ENGINE (Indian stocks)
        const allActive  = activeRes.status  === "fulfilled" ? activeRes.value.signals  || [] : [];
        const allHistory = historyRes.status === "fulfilled" ? historyRes.value.signals || [] : [];
        setActiveSignals(allActive.filter(s  => s.source !== "SMART_ENGINE"));
        setHistorySignals(allHistory.filter(s => s.source !== "SMART_ENGINE"));
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

  // Live price refresh
  useEffect(() => {
    let active = true;
    async function refreshPrices() {
      if (!signalCoinsKey) return;
      try {
        const res = await apiFetch(`/signals/live-prices?coins=${signalCoinsKey}`);
        if (!active) return;
        setActiveSignals(cur => mergeSignalLivePrices(cur, res.prices || []));
      } catch { /* keep stale prices */ }
    }
    refreshPrices();
    const id = window.setInterval(refreshPrices, 5000);
    return () => { active = false; window.clearInterval(id); };
  }, [signalCoinsKey]);

  const filteredSignals = useMemo(() => activeSignals.filter(s => {
    const tfOk   = timeframeFilter === "ALL" || s.timeframe === timeframeFilter;
    const sideOk = sideFilter      === "ALL" || s.side      === sideFilter;
    return tfOk && sideOk;
  }), [activeSignals, timeframeFilter, sideFilter]);

  const topSignals = [...filteredSignals].sort((a, b) => b.confidence - a.confidence).slice(0, 3);

  return (
    <AppShell subtitle="Binance Futures crypto signals — BTC, ETH, altcoins and more." title="Crypto Signals">
      {error ? <div className="banner banner-error">{error}</div> : null}

      {/* ── STATS ── */}
      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Active Signals</span>
          <strong>{activeSignals.length}</strong>
          <span className="metric-meta">{filteredSignals.length} matching filter</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Win Rate</span>
          <strong>{overview?.winRate ?? 0}%</strong>
          <span className="metric-meta">{overview?.closedSignals ?? 0} closed</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Strong Setups</span>
          <strong>{overview?.strongSignals ?? 0}</strong>
          <span className="metric-meta">Confidence ≥ 85%</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Avg Confidence</span>
          <strong>{overview?.averageConfidence ?? 0}%</strong>
          <span className="metric-meta">Across active signals</span>
        </article>
      </section>

      {/* ── FILTERS ── */}
      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Filters</span><h2>Signal view</h2></div>
          <span className={`pill ${loading ? "pill-neutral" : "pill-success"}`}>{loading ? "Loading" : "Live"}</span>
        </div>
        <div className="filters-row">
          <label>
            <span>Timeframe</span>
            <select onChange={e => setTimeframeFilter(e.target.value)} value={timeframeFilter}>
              <option value="ALL">All timeframes</option>
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
              <option value="4h">4h</option>
            </select>
          </label>
          <label>
            <span>Side</span>
            <select onChange={e => setSideFilter(e.target.value)} value={sideFilter}>
              <option value="ALL">All sides</option>
              <option value="LONG">LONG only</option>
              <option value="SHORT">SHORT only</option>
            </select>
          </label>
          {(timeframeFilter !== "ALL" || sideFilter !== "ALL") && (
            <button
              className="button button-ghost"
              onClick={() => { setTimeframeFilter("ALL"); setSideFilter("ALL"); }}
              style={{ alignSelf: "flex-end" }}
              type="button"
            >
              Clear filters
            </button>
          )}
        </div>
      </section>

      {/* ── TOP SIGNALS SPOTLIGHT ── */}
      {topSignals.length > 0 && (
        <section className="spotlight-grid">
          {topSignals.map(signal => (
            <article className="spotlight-card" key={signal.id}>
              <span className={`pill ${signal.side === "LONG" ? "pill-success" : "pill-danger"}`}>{signal.side}</span>
              <h2>{signal.coin.replace("USDT", "")} <span style={{ fontSize: "0.7em", opacity: 0.5 }}>/USDT</span></h2>
              <p>{signal.timeframe} · Conf {signal.confidence}% · Entry {formatPrice(signal.entry)}</p>
              <div className="spotlight-meta">
                <span>SL {formatPrice(signal.stopLoss)}</span>
                <span>TP1 {formatPrice(signal.tp1)}</span>
                <span>TP3 {formatPrice(signal.tp3)}</span>
              </div>
            </article>
          ))}
        </section>
      )}

      {/* ── ACTIVE SIGNALS ── */}
      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Live board</span><h2>Active crypto signals</h2></div>
          <span className="pill pill-success">{filteredSignals.length} active</span>
        </div>
        <SignalTable
          emptyLabel={loading ? "Loading signals..." : "No crypto signals match the current filter."}
          signals={filteredSignals}
        />
      </section>

      {/* ── HISTORY ── */}
      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">History</span><h2>Recent closed signals</h2></div>
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
