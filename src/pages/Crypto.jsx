import { useEffect, useMemo, useRef, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import TradingViewModal from "../components/TradingViewModal";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";

function formatPrice(value) {
  const amount = Number(value || 0);
  if (Math.abs(amount) >= 1000) {
    return amount.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }
  if (Math.abs(amount) >= 1) return amount.toFixed(4);
  if (Math.abs(amount) >= 0.0001) return amount.toFixed(6);
  return amount.toFixed(8);
}

export default function Market() {
  const [engine, setEngine] = useState(null);
  const [overview, setOverview] = useState(null);
  const [activeSignals, setActiveSignals] = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [tickers, setTickers] = useState([]);
  const [allCoins, setAllCoins] = useState([]);
  const [coinSearch, setCoinSearch] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [timeframeFilter, setTimeframeFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chartCoin, setChartCoin] = useState(null);
  const [sortBy, setSortBy] = useState("quoteVolume");
  const [tickerPrices, setTickerPrices] = useState({}); // live price overlay for ticker table
  const searchRef = useRef(null);
  const signalCoinsKey = getSignalCoins(activeSignals).join(",");
  const tickerCoinsKey = useMemo(
    () => tickers.slice(0, 200).map((ticker) => ticker.symbol).join(","),
    [tickers]
  );

  // Load all data
  useEffect(() => {
    let active = true;

    async function loadScanner() {
      try {
        const [signalResults, tickerResult, coinsResult] = await Promise.all([
          Promise.allSettled([
            apiFetch("/signals/stats/overview"),
            apiFetch("/signals/active?limit=100"),
            apiFetch("/signals/history?limit=50"),
            apiFetch("/signals/engine/status"),
          ]),
          Promise.allSettled([apiFetch(`/market/tickers?limit=500&sort=${sortBy}`, { skipAuth: true })]),
          Promise.allSettled([apiFetch("/market/coins", { skipAuth: true })]),
        ]);

        if (!active) return;

        const [overviewRes, activeRes, historyRes, engineRes] = signalResults;
        const [tickersRes] = tickerResult;
        const [coinsRes] = coinsResult;

        setOverview(overviewRes.status === "fulfilled" ? overviewRes.value.stats : null);
        setActiveSignals(activeRes.status === "fulfilled" ? activeRes.value.signals || [] : []);
        setHistorySignals(historyRes.status === "fulfilled" ? historyRes.value.signals || [] : []);
        setEngine(engineRes.status === "fulfilled" ? engineRes.value.engine : null);
        setTickers(tickersRes.status === "fulfilled" ? tickersRes.value.tickers || [] : []);
        setAllCoins(coinsRes.status === "fulfilled" ? coinsRes.value.coins || [] : []);

        const signalError = signalResults.find((r) => r.status === "rejected");
        setError(signalError?.reason?.message || "");
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadScanner();
    const intervalId = window.setInterval(loadScanner, 20000);
    return () => { active = false; window.clearInterval(intervalId); };
  }, [sortBy]);

  // Live price refresh for active signals
  useEffect(() => {
    let active = true;
    async function refreshLivePrices() {
      if (!signalCoinsKey) return;
      try {
        const response = await apiFetch(`/signals/live-prices?coins=${signalCoinsKey}`);
        if (!active) return;
        setActiveSignals((current) => mergeSignalLivePrices(current, response.prices || []));
      } catch {
        // Keep stale live prices visible if this lightweight refresh fails.
      }
    }
    refreshLivePrices();
    const intervalId = window.setInterval(refreshLivePrices, 5000);
    return () => { active = false; window.clearInterval(intervalId); };
  }, [signalCoinsKey]);

  // Live price refresh for the full ticker table — refreshes every 5 seconds
  useEffect(() => {
    let active = true;
    async function refreshTickerPrices() {
      if (!tickerCoinsKey) return;
      try {
        const response = await apiFetch(`/signals/live-prices?coins=${tickerCoinsKey}`);
        if (!active) return;
        const priceMap = {};
        for (const item of response.prices || []) {
          if (item.livePrice) priceMap[item.coin] = item.livePrice;
        }
        setTickerPrices(priceMap);
      } catch {
        // Preserve the last successful price snapshot when polling fails.
      }
    }
    refreshTickerPrices();
    const intervalId = window.setInterval(refreshTickerPrices, 5000);
    return () => { active = false; window.clearInterval(intervalId); };
  }, [tickerCoinsKey]);

  // Close suggestions on outside click
  useEffect(() => {
    function handleClick(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Filtered coins for autocomplete suggestions
  const suggestions = useMemo(() => {
    if (!coinSearch.trim() || coinSearch.length < 1) return [];
    const q = coinSearch.toUpperCase();
    return allCoins.filter((c) => c.includes(q)).slice(0, 10);
  }, [coinSearch, allCoins]);

  // Tickers filtered by search
  const filteredTickers = useMemo(() => {
    if (!coinSearch.trim()) return tickers;
    const q = coinSearch.toUpperCase();
    return tickers.filter((t) => t.symbol.includes(q));
  }, [tickers, coinSearch]);

  // Signals filtered
  const filteredSignals = useMemo(() => {
    return activeSignals.filter((signal) => {
      const coinMatch = !coinSearch || signal.coin.toLowerCase().includes(coinSearch.toLowerCase());
      const tfMatch = timeframeFilter === "ALL" || signal.timeframe === timeframeFilter;
      return coinMatch && tfMatch;
    });
  }, [activeSignals, coinSearch, timeframeFilter]);

  const strongestSignals = [...filteredSignals].sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  const topMovers = [...filteredTickers].sort((a, b) => b.changePercent - a.changePercent).slice(0, 5);
  const topLosers = [...filteredTickers].sort((a, b) => a.changePercent - b.changePercent).slice(0, 5);

  function selectCoin(coin) {
    setCoinSearch(coin);
    setShowSuggestions(false);
  }

  return (
    <AppShell subtitle="All Binance Futures pairs — search any coin, click to view chart." title="Signal Scanner">
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
          <span className="metric-label">Binance pairs loaded</span>
          <strong>{allCoins.length}</strong>
          <span className="metric-meta">USDT perpetual futures</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Average confidence</span>
          <strong>{overview?.averageConfidence ?? 0}%</strong>
          <span className="metric-meta">Across all recent signals</span>
        </article>
      </section>

      {/* Search + Filter bar */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Filters</span>
            <h2>Market view</h2>
          </div>
          <span className="pill pill-neutral">{loading ? "Loading" : "Live"}</span>
        </div>

        <div className="filters-row">
          {/* Searchable coin input with autocomplete */}
          <label style={{ position: "relative" }} ref={searchRef}>
            <span>Search coin</span>
            <input
              autoComplete="off"
              onChange={(e) => { setCoinSearch(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              placeholder="BTC, ETH, SOL..."
              value={coinSearch}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="coin-suggestions">
                {suggestions.map((coin) => (
                  <button
                    className="coin-suggestion-item"
                    key={coin}
                    onClick={() => selectCoin(coin)}
                    type="button"
                  >
                    {coin.replace("USDT", "")}
                    <span className="coin-suggestion-usdt">USDT</span>
                    <span className="coin-suggestion-chart">📈 Chart</span>
                  </button>
                ))}
              </div>
            )}
          </label>

          <label>
            <span>Timeframe</span>
            <select onChange={(e) => setTimeframeFilter(e.target.value)} value={timeframeFilter}>
              <option value="ALL">All</option>
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
            </select>
          </label>

          <label>
            <span>Sort by</span>
            <select onChange={(e) => setSortBy(e.target.value)} value={sortBy}>
              <option value="quoteVolume">Quote Volume</option>
              <option value="changePercent">Change %</option>
              <option value="price">Price</option>
            </select>
          </label>

          {coinSearch && (
            <button
              className="button button-ghost"
              onClick={() => { setCoinSearch(""); setShowSuggestions(false); }}
              style={{ alignSelf: "flex-end" }}
              type="button"
            >
              Clear
            </button>
          )}
        </div>

        {/* Quick chart button when coin is selected */}
        {coinSearch && (
          <div style={{ marginTop: "12px" }}>
            <button
              className="button button-secondary"
              onClick={() => setChartCoin(coinSearch.toUpperCase().endsWith("USDT") ? coinSearch.toUpperCase() : coinSearch.toUpperCase() + "USDT")}
              type="button"
            >
              📈 Open {coinSearch.toUpperCase().replace("USDT", "")}/USDT Chart
            </button>
          </div>
        )}
      </section>

      {/* Spotlight signals */}
      <section className="spotlight-grid">
        {strongestSignals.map((signal) => (
          <article className="spotlight-card spotlight-card-clickable" key={signal.id} onClick={() => setChartCoin(signal.coin)}>
            <span className={`pill ${signal.side === "LONG" ? "pill-success" : "pill-danger"}`}>{signal.side}</span>
            <h2>{signal.coin} <span style={{ fontSize: "0.7em", opacity: 0.6 }}>📈</span></h2>
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

      {/* Gainers / Losers */}
      <section className="section-grid">
        <article className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Binance Futures</span><h2>Top gainers</h2></div>
          </div>
          <div className="list-stack">
            {topMovers.map((ticker) => (
              <div
                className="list-card list-card-clickable"
                key={ticker.symbol}
                onClick={() => setChartCoin(ticker.symbol)}
                title="Click to view chart"
              >
                <div>
                  <strong>{ticker.symbol}</strong>
                  <span>Price {formatPrice(ticker.price)}</span>
                </div>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <span className="pill pill-success">{Number(ticker.changePercent || 0).toFixed(2)}%</span>
                  <span style={{ fontSize: "0.8em", opacity: 0.5 }}>📈</span>
                </div>
              </div>
            ))}
            {!topMovers.length ? <div className="empty-state">No ticker data yet.</div> : null}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Binance Futures</span><h2>Top losers</h2></div>
          </div>
          <div className="list-stack">
            {topLosers.map((ticker) => (
              <div
                className="list-card list-card-clickable"
                key={ticker.symbol}
                onClick={() => setChartCoin(ticker.symbol)}
                title="Click to view chart"
              >
                <div>
                  <strong>{ticker.symbol}</strong>
                  <span>Price {formatPrice(ticker.price)}</span>
                </div>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <span className="pill pill-danger">{Number(ticker.changePercent || 0).toFixed(2)}%</span>
                  <span style={{ fontSize: "0.8em", opacity: 0.5 }}>📈</span>
                </div>
              </div>
            ))}
            {!topLosers.length ? <div className="empty-state">No ticker data yet.</div> : null}
          </div>
        </article>
      </section>

      {/* Full market table — all Binance Futures USDT coins */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Binance Futures</span>
            <h2>All trading pairs</h2>
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
                <th>Chart</th>
              </tr>
            </thead>
            <tbody>
              {filteredTickers.length ? (
                filteredTickers.map((ticker) => {
                  const livePrice = tickerPrices[ticker.symbol];
                  const displayPrice = livePrice ?? ticker.price;
                  const isLive = Boolean(livePrice);
                  return (
                    <tr key={ticker.symbol} className="ticker-row">
                      <td>
                        <button
                          className="coin-chart-btn"
                          onClick={() => setChartCoin(ticker.symbol)}
                          title={`View ${ticker.symbol} chart`}
                          type="button"
                        >
                          <strong>{ticker.symbol}</strong>
                        </button>
                      </td>
                      <td>
                        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                          {isLive && (
                            <span
                              style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block", flexShrink: 0 }}
                              title="Live price"
                            />
                          )}
                          <strong>{formatPrice(displayPrice)}</strong>
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${ticker.changePercent >= 0 ? "pill-success" : "pill-danger"}`}>
                          {Number(ticker.changePercent || 0).toFixed(2)}%
                        </span>
                      </td>
                      <td>{formatPrice(ticker.highPrice)}</td>
                      <td>{formatPrice(ticker.lowPrice)}</td>
                      <td>{Number(ticker.quoteVolume || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                      <td>
                        <button
                          className="button button-ghost"
                          onClick={() => setChartCoin(ticker.symbol)}
                          style={{ padding: "2px 8px", fontSize: "0.75em" }}
                          type="button"
                        >
                          📈
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="empty-row" colSpan="7">
                    {loading ? "Loading Binance data..." : coinSearch ? `No coins found matching "${coinSearch}"` : "Binance data unavailable."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Active signals */}
      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Scanner feed</span><h2>Active signal book</h2></div>
          <span className="pill pill-warning">{filteredSignals.length} active</span>
        </div>
        <SignalTable emptyLabel={loading ? "Loading scanner..." : "No signals found for this filter."} signals={filteredSignals} />
      </section>

      {/* Closed signals */}
      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Recent closes</span><h2>Closed signals</h2></div>
        </div>
        <SignalTable compact emptyLabel="No closed signals available yet." signals={historySignals} />
      </section>

      {/* Chart modal */}
      {chartCoin && (
        <TradingViewModal
          coin={chartCoin}
          timeframe="15m"
          onClose={() => setChartCoin(null)}
        />
      )}
    </AppShell>
  );
}
