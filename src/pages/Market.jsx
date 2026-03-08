import { useEffect, useMemo, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";

function formatPrice(value) {
  const amount = Number(value || 0);

  if (Math.abs(amount) >= 1000) {
    return amount.toLocaleString("en-IN", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    });
  }

  return amount.toFixed(4);
}

export default function Market() {
  const [engine, setEngine] = useState(null);
  const [overview, setOverview] = useState(null);
  const [activeSignals, setActiveSignals] = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [tickers, setTickers] = useState([]);
  const [coinFilter, setCoinFilter] = useState("");
  const [timeframeFilter, setTimeframeFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const signalCoinsKey = getSignalCoins(activeSignals).join(",");

  useEffect(() => {
    let active = true;

    async function loadScanner() {
      try {
        const signalResults = await Promise.allSettled([
          apiFetch("/signals/stats/overview"),
          apiFetch("/signals/active?limit=40"),
          apiFetch("/signals/history?limit=40"),
          apiFetch("/signals/engine/status"),
        ]);
        const tickerResult = await Promise.allSettled([
          apiFetch("/market/tickers?limit=18&sort=quoteVolume", { skipAuth: true }),
        ]);

        if (!active) {
          return;
        }

        const [overviewResponse, activeResponse, historyResponse, engineResponse] = signalResults;
        const [tickersResponse] = tickerResult;

        setOverview(overviewResponse.status === "fulfilled" ? overviewResponse.value.stats : null);
        setActiveSignals(activeResponse.status === "fulfilled" ? activeResponse.value.signals || [] : []);
        setHistorySignals(historyResponse.status === "fulfilled" ? historyResponse.value.signals || [] : []);
        setEngine(engineResponse.status === "fulfilled" ? engineResponse.value.engine : null);
        setTickers(tickersResponse.status === "fulfilled" ? tickersResponse.value.tickers || [] : []);

        const signalError = signalResults.find((result) => result.status === "rejected");
        const marketError = tickerResult.find((result) => result.status === "rejected");
        setError(signalError?.reason?.message || marketError?.reason?.message || "");
      } catch (loadError) {
        if (active) {
          setError(loadError.message);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadScanner();
    const intervalId = window.setInterval(loadScanner, 20000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function refreshLivePrices() {
      if (!signalCoinsKey) {
        return;
      }

      try {
        const response = await apiFetch(`/signals/live-prices?coins=${signalCoinsKey}`);

        if (!active) {
          return;
        }

        setActiveSignals((current) => mergeSignalLivePrices(current, response.prices || []));
      } catch (refreshError) {
        // Keep the scanner usable if a live price refresh fails.
      }
    }

    refreshLivePrices();
    const intervalId = window.setInterval(refreshLivePrices, 5000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [signalCoinsKey]);

  const filteredSignals = useMemo(() => {
    return activeSignals.filter((signal) => {
      const coinMatch = !coinFilter || signal.coin.toLowerCase().includes(coinFilter.toLowerCase());
      const timeframeMatch = timeframeFilter === "ALL" || signal.timeframe === timeframeFilter;
      return coinMatch && timeframeMatch;
    });
  }, [activeSignals, coinFilter, timeframeFilter]);

  const filteredTickers = useMemo(() => {
    return tickers.filter((ticker) => {
      return !coinFilter || ticker.symbol.toLowerCase().includes(coinFilter.toLowerCase());
    });
  }, [coinFilter, tickers]);

  const strongestSignals = [...filteredSignals]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 3);

  const topMovers = [...filteredTickers]
    .sort((left, right) => right.changePercent - left.changePercent)
    .slice(0, 3);

  const topLosers = [...filteredTickers]
    .sort((left, right) => left.changePercent - right.changePercent)
    .slice(0, 3);

  return (
    <AppShell subtitle="Website scanner view with live Binance Futures trading pairs and FTAS signals." title="Signal Scanner">
      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Scanner state</span>
          <strong>{engine?.running ? "Running" : "Stopped"}</strong>
          <span className="metric-meta">{engine?.isScanning ? "Scan in progress" : "Idle"}</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Live setups</span>
          <strong>{overview?.activeSignals ?? 0}</strong>
          <span className="metric-meta">Filtered {filteredSignals.length}</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Binance pairs</span>
          <strong>{filteredTickers.length}</strong>
          <span className="metric-meta">Top volume futures pairs</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Average confidence</span>
          <strong>{overview?.averageConfidence ?? 0}%</strong>
          <span className="metric-meta">Across all recent signals</span>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Filters</span>
            <h2>Market view</h2>
          </div>
          <span className="pill pill-neutral">{loading ? "Loading" : "Live"}</span>
        </div>

        <div className="filters-row">
          <label>
            <span>Coin</span>
            <input onChange={(event) => setCoinFilter(event.target.value)} placeholder="BTC, ETH..." value={coinFilter} />
          </label>
          <label>
            <span>Timeframe</span>
            <select onChange={(event) => setTimeframeFilter(event.target.value)} value={timeframeFilter}>
              <option value="ALL">All</option>
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
            </select>
          </label>
        </div>
      </section>

      <section className="spotlight-grid">
        {strongestSignals.map((signal) => (
          <article className="spotlight-card" key={signal.id}>
            <span className={`pill ${signal.side === "LONG" ? "pill-success" : "pill-danger"}`}>{signal.side}</span>
            <h2>{signal.coin}</h2>
            <p>
              {signal.timeframe} • Confidence {signal.confidence}% • Entry {signal.entry} • Live {formatPrice(signal.livePrice ?? signal.closePrice)}
            </p>
            <div className="spotlight-meta">
              <span>SL {signal.stopLoss}</span>
              <span>TP3 {signal.tp3}</span>
            </div>
          </article>
        ))}
        {!strongestSignals.length ? <div className="empty-state">No live setups match the current filter.</div> : null}
      </section>

      <section className="section-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Binance Futures</span>
              <h2>Top gainers</h2>
            </div>
          </div>
          <div className="list-stack">
            {topMovers.map((ticker) => (
              <div className="list-card" key={ticker.symbol}>
                <div>
                  <strong>{ticker.symbol}</strong>
                  <span>Price {formatPrice(ticker.price)}</span>
                </div>
                <span className="pill pill-success">{Number(ticker.changePercent || 0).toFixed(2)}%</span>
              </div>
            ))}
            {!topMovers.length ? <div className="empty-state">No Binance ticker data yet.</div> : null}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Binance Futures</span>
              <h2>Top losers</h2>
            </div>
          </div>
          <div className="list-stack">
            {topLosers.map((ticker) => (
              <div className="list-card" key={ticker.symbol}>
                <div>
                  <strong>{ticker.symbol}</strong>
                  <span>Price {formatPrice(ticker.price)}</span>
                </div>
                <span className="pill pill-danger">{Number(ticker.changePercent || 0).toFixed(2)}%</span>
              </div>
            ))}
            {!topLosers.length ? <div className="empty-state">No Binance ticker data yet.</div> : null}
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Binance Futures</span>
            <h2>Top trading coins</h2>
          </div>
          <span className="pill pill-neutral">{filteredTickers.length} pairs</span>
        </div>
        <div className="table-wrap">
          <table className="signal-table signal-table-compact">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Price</th>
                <th>24h %</th>
                <th>High</th>
                <th>Low</th>
                <th>Quote Volume</th>
              </tr>
            </thead>
            <tbody>
              {filteredTickers.length ? (
                filteredTickers.map((ticker) => (
                  <tr key={ticker.symbol}>
                    <td>
                      <strong>{ticker.symbol}</strong>
                    </td>
                    <td>{formatPrice(ticker.price)}</td>
                    <td>
                      <span className={`pill ${ticker.changePercent >= 0 ? "pill-success" : "pill-danger"}`}>
                        {Number(ticker.changePercent || 0).toFixed(2)}%
                      </span>
                    </td>
                    <td>{formatPrice(ticker.highPrice)}</td>
                    <td>{formatPrice(ticker.lowPrice)}</td>
                    <td>{Number(ticker.quoteVolume || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty-row" colSpan="6">
                    Binance ticker data unavailable.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Scanner feed</span>
            <h2>Active signal book</h2>
          </div>
        </div>
        <SignalTable emptyLabel={loading ? "Loading scanner..." : "No signals found for this filter."} signals={filteredSignals} />
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Recent closes</span>
            <h2>Closed signals</h2>
          </div>
        </div>
        <SignalTable compact emptyLabel="No closed signals available yet." signals={historySignals} />
      </section>
    </AppShell>
  );
}
