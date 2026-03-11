import { useEffect, useMemo, useRef, useState } from "react";
import AppShell from "../components/AppShell";
import SignalTable from "../components/SignalTable";
import TradingViewModal from "../components/TradingViewModal";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";

function formatPrice(value) {
  const amount = Number(value || 0);
  if (Math.abs(amount) >= 1000)
    return amount.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (Math.abs(amount) >= 1) return amount.toFixed(4);
  if (Math.abs(amount) >= 0.0001) return amount.toFixed(6);
  return amount.toFixed(8);
}

function segmentColor(segment) {
  if (segment === "FNO")       return "#818cf8";
  if (segment === "COMMODITY") return "#f59e0b";
  if (segment === "CURRENCY")  return "#38bdf8";
  return "#34d399";
}

function TabBtn({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      type="button"
      style={{
        background: active ? "rgba(255,138,61,0.15)" : "rgba(255,255,255,0.04)",
        border: active ? "1px solid rgba(255,138,61,0.5)" : "1px solid rgba(255,255,255,0.08)",
        borderRadius: "8px",
        color: active ? "#ff8a3d" : "rgba(255,255,255,0.65)",
        cursor: "pointer",
        fontSize: "0.85rem",
        fontWeight: active ? 700 : 500,
        padding: "8px 18px",
        transition: "all 0.18s",
      }}
    >
      {children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   CRYPTO TAB
══════════════════════════════════════════════════════════════════════════════ */
function CryptoTab() {
  const [tickers, setTickers]               = useState([]);
  const [allCoins, setAllCoins]             = useState([]);
  const [activeSignals, setActiveSignals]   = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [overview, setOverview]             = useState(null);
  const [engine, setEngine]                 = useState(null);
  const [coinSearch, setCoinSearch]         = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [timeframeFilter, setTimeframeFilter] = useState("ALL");
  const [sortBy, setSortBy]                 = useState("quoteVolume");
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState("");
  const [chartCoin, setChartCoin]           = useState(null);
  const [tickerPrices, setTickerPrices]     = useState({});
  const searchRef = useRef(null);

  const signalCoinsKey = getSignalCoins(activeSignals).join(",");
  const tickerCoinsKey = useMemo(() => tickers.slice(0, 200).map(t => t.symbol).join(","), [tickers]);

  useEffect(() => {
    let active = true;
    async function load() {
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
        const [coinsRes]   = coinsResult;
        setOverview(overviewRes.status === "fulfilled" ? overviewRes.value.stats : null);
        setActiveSignals(activeRes.status === "fulfilled" ? activeRes.value.signals || [] : []);
        setHistorySignals(historyRes.status === "fulfilled" ? historyRes.value.signals || [] : []);
        setEngine(engineRes.status === "fulfilled" ? engineRes.value.engine : null);
        setTickers(tickersRes.status === "fulfilled" ? tickersRes.value.tickers || [] : []);
        setAllCoins(coinsRes.status === "fulfilled" ? coinsRes.value.coins || [] : []);
        setError(signalResults.find(r => r.status === "rejected")?.reason?.message || "");
      } catch (e) { if (active) setError(e.message); }
      finally     { if (active) setLoading(false); }
    }
    load();
    const id = window.setInterval(load, 20000);
    return () => { active = false; window.clearInterval(id); };
  }, [sortBy]);

  useEffect(() => {
    let active = true;
    async function refresh() {
      if (!signalCoinsKey) return;
      try {
        const res = await apiFetch(`/signals/live-prices?coins=${signalCoinsKey}`);
        if (!active) return;
        setActiveSignals(cur => mergeSignalLivePrices(cur, res.prices || []));
      } catch { /* stale */ }
    }
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(id); };
  }, [signalCoinsKey]);

  useEffect(() => {
    let active = true;
    async function refreshTicker() {
      if (!tickerCoinsKey) return;
      try {
        const res = await apiFetch(`/signals/live-prices?coins=${tickerCoinsKey}`);
        if (!active) return;
        const map = {};
        for (const item of res.prices || []) {
          if (item.livePrice) map[item.coin] = item.livePrice;
        }
        setTickerPrices(map);
      } catch { /* stale */ }
    }
    refreshTicker();
    const id = window.setInterval(refreshTicker, 5000);
    return () => { active = false; window.clearInterval(id); };
  }, [tickerCoinsKey]);

  useEffect(() => {
    function handle(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) setShowSuggestions(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const suggestions = useMemo(() => {
    if (!coinSearch.trim()) return [];
    const q = coinSearch.toUpperCase();
    return allCoins.filter(c => c.includes(q)).slice(0, 10);
  }, [coinSearch, allCoins]);

  const filteredTickers = useMemo(() => {
    if (!coinSearch.trim()) return tickers;
    const q = coinSearch.toUpperCase();
    return tickers.filter(t => t.symbol.includes(q));
  }, [tickers, coinSearch]);

  const filteredSignals = useMemo(() =>
    activeSignals.filter(s => {
      const coinMatch = !coinSearch || s.coin.toLowerCase().includes(coinSearch.toLowerCase());
      const tfMatch   = timeframeFilter === "ALL" || s.timeframe === timeframeFilter;
      return coinMatch && tfMatch;
    }), [activeSignals, coinSearch, timeframeFilter]);

  const topMovers = [...filteredTickers].sort((a, b) => b.changePercent - a.changePercent).slice(0, 5);
  const topLosers = [...filteredTickers].sort((a, b) => a.changePercent - b.changePercent).slice(0, 5);

  return (
    <>
      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Scanner state</span>
          <strong>{engine?.running ? "Running" : "Stopped"}</strong>
          <span className="metric-meta">{engine?.isScanning ? "Scanning..." : "Idle"}</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Live setups</span>
          <strong>{overview?.activeSignals ?? 0}</strong>
          <span className="metric-meta">Filtered {filteredSignals.length}</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Binance pairs</span>
          <strong>{allCoins.length}</strong>
          <span className="metric-meta">USDT perpetual futures</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Avg confidence</span>
          <strong>{overview?.averageConfidence ?? 0}%</strong>
          <span className="metric-meta">All recent signals</span>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Filters</span><h2>Crypto market view</h2></div>
          <span className="pill pill-neutral">{loading ? "Loading" : "Live"}</span>
        </div>
        <div className="filters-row">
          <label style={{ position: "relative" }} ref={searchRef}>
            <span>Search coin</span>
            <input
              autoComplete="off"
              onChange={e => { setCoinSearch(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              placeholder="BTC, ETH, SOL..."
              value={coinSearch}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="coin-suggestions">
                {suggestions.map(coin => (
                  <button
                    className="coin-suggestion-item"
                    key={coin}
                    onClick={() => { setCoinSearch(coin); setShowSuggestions(false); }}
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
            <select onChange={e => setTimeframeFilter(e.target.value)} value={timeframeFilter}>
              <option value="ALL">All</option>
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
            </select>
          </label>
          <label>
            <span>Sort by</span>
            <select onChange={e => setSortBy(e.target.value)} value={sortBy}>
              <option value="quoteVolume">Volume</option>
              <option value="changePercent">Change %</option>
              <option value="price">Price</option>
            </select>
          </label>
          {coinSearch && (
            <button className="button button-ghost" onClick={() => { setCoinSearch(""); setShowSuggestions(false); }} style={{ alignSelf: "flex-end" }} type="button">Clear</button>
          )}
        </div>
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

      <section className="section-grid">
        <article className="panel">
          <div className="panel-header"><div><span className="eyebrow">Binance Futures</span><h2>Top gainers</h2></div></div>
          <div className="list-stack">
            {topMovers.map(ticker => (
              <div className="list-card list-card-clickable" key={ticker.symbol} onClick={() => setChartCoin(ticker.symbol)}>
                <div><strong>{ticker.symbol}</strong><span>Price {formatPrice(ticker.price)}</span></div>
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
          <div className="panel-header"><div><span className="eyebrow">Binance Futures</span><h2>Top losers</h2></div></div>
          <div className="list-stack">
            {topLosers.map(ticker => (
              <div className="list-card list-card-clickable" key={ticker.symbol} onClick={() => setChartCoin(ticker.symbol)}>
                <div><strong>{ticker.symbol}</strong><span>Price {formatPrice(ticker.price)}</span></div>
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

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Binance Futures</span><h2>All crypto pairs</h2></div>
          <span className="pill pill-neutral">{filteredTickers.length} pairs</span>
        </div>
        <div className="signal-view-mobile">
          {filteredTickers.length ? (
            <div className="ticker-cards">
              {filteredTickers.map(ticker => {
                const lp = tickerPrices[ticker.symbol];
                const dp = lp ?? ticker.price;
                const isUp = Number(ticker.changePercent || 0) >= 0;
                return (
                  <div className="ticker-card" key={ticker.symbol} onClick={() => setChartCoin(ticker.symbol)}>
                    <div className="ticker-card-top">
                      <strong className="ticker-card-symbol">{ticker.symbol.replace("USDT", "")}<span style={{ opacity: 0.4, fontSize: "0.7em" }}>/USDT</span></strong>
                      <span className={`pill ${isUp ? "pill-success" : "pill-danger"}`}>{Number(ticker.changePercent || 0).toFixed(2)}%</span>
                    </div>
                    <div className="ticker-card-price">
                      {lp && <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block", marginRight: "5px" }} />}
                      <strong>{formatPrice(dp)}</strong>
                    </div>
                    <div className="ticker-card-meta">
                      <span>H {formatPrice(ticker.highPrice)}</span>
                      <span>L {formatPrice(ticker.lowPrice)}</span>
                      <span>Vol {Number(ticker.quoteVolume || 0).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">{loading ? "Loading..." : `No coins found${coinSearch ? ` for "${coinSearch}"` : ""}.`}</div>
          )}
        </div>
        <div className="signal-view-desktop">
          <div className="table-wrap">
            <table className="signal-table signal-table-compact">
              <thead>
                <tr><th>Symbol</th><th>Price</th><th>24h %</th><th>High</th><th>Low</th><th>Volume</th><th>Chart</th></tr>
              </thead>
              <tbody>
                {filteredTickers.length ? filteredTickers.map(ticker => {
                  const lp = tickerPrices[ticker.symbol];
                  const dp = lp ?? ticker.price;
                  return (
                    <tr key={ticker.symbol} className="ticker-row">
                      <td><button className="coin-chart-btn" onClick={() => setChartCoin(ticker.symbol)} type="button"><strong>{ticker.symbol}</strong></button></td>
                      <td>
                        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                          {lp && <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />}
                          <strong>{formatPrice(dp)}</strong>
                        </span>
                      </td>
                      <td><span className={`pill ${ticker.changePercent >= 0 ? "pill-success" : "pill-danger"}`}>{Number(ticker.changePercent || 0).toFixed(2)}%</span></td>
                      <td>{formatPrice(ticker.highPrice)}</td>
                      <td>{formatPrice(ticker.lowPrice)}</td>
                      <td>{Number(ticker.quoteVolume || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                      <td><button className="button button-ghost" onClick={() => setChartCoin(ticker.symbol)} style={{ padding: "2px 8px", fontSize: "0.75em" }} type="button">📈</button></td>
                    </tr>
                  );
                }) : (
                  <tr><td className="empty-row" colSpan="7">{loading ? "Loading..." : "No data."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Scanner feed</span><h2>Active signal book</h2></div>
          <span className="pill pill-warning">{filteredSignals.length} active</span>
        </div>
        <SignalTable emptyLabel={loading ? "Loading scanner..." : "No signals found."} signals={filteredSignals} />
      </section>
      <section className="panel">
        <div className="panel-header"><div><span className="eyebrow">Recent closes</span><h2>Closed signals</h2></div></div>
        <SignalTable compact emptyLabel="No closed signals yet." signals={historySignals} />
      </section>

      {chartCoin && <TradingViewModal coin={chartCoin} timeframe="15m" onClose={() => setChartCoin(null)} />}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   STOCKS TAB
══════════════════════════════════════════════════════════════════════════════ */
function StocksTab() {
  const [instruments, setInstruments]       = useState([]);
  const [activeSignals, setActiveSignals]   = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [search, setSearch]                 = useState("");
  const [segmentFilter, setSegmentFilter]   = useState("ALL");
  const [exchangeFilter, setExchangeFilter] = useState("ALL");
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState("");
  const [tvSignal, setTvSignal]             = useState(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [instrRes, activeRes, historyRes] = await Promise.allSettled([
          apiFetch("/stocks/instruments"),
          apiFetch("/stocks/active?limit=100"),
          apiFetch("/stocks/history?limit=50"),
        ]);
        if (!active) return;
        setInstruments(instrRes.status === "fulfilled" ? instrRes.value.instruments || [] : []);
        setActiveSignals(activeRes.status === "fulfilled" ? activeRes.value.signals || [] : []);
        setHistorySignals(historyRes.status === "fulfilled" ? historyRes.value.signals || [] : []);
        if (instrRes.status === "rejected") setError(instrRes.reason?.message || "Failed to load instruments");
      } catch (e) { if (active) setError(e.message); }
      finally     { if (active) setLoading(false); }
    }
    load();
    const id = window.setInterval(load, 30000);
    return () => { active = false; window.clearInterval(id); };
  }, []);

  const segments  = useMemo(() => ["ALL", ...new Set(instruments.map(i => i.segment).filter(Boolean))], [instruments]);
  const exchanges = useMemo(() => ["ALL", ...new Set(instruments.map(i => i.exchange).filter(Boolean))], [instruments]);

  const filteredInstruments = useMemo(() => {
    let list = instruments;
    if (segmentFilter !== "ALL")  list = list.filter(i => i.segment === segmentFilter);
    if (exchangeFilter !== "ALL") list = list.filter(i => i.exchange === exchangeFilter);
    if (search.trim()) {
      const q = search.toUpperCase();
      list = list.filter(i => i.tradingSymbol?.toUpperCase().includes(q) || i.exchange?.includes(q));
    }
    return list;
  }, [instruments, segmentFilter, exchangeFilter, search]);

  const filteredSignals = useMemo(() => {
    if (!search.trim()) return activeSignals;
    const q = search.toUpperCase();
    return activeSignals.filter(s => (s.scanMeta?.instrument?.tradingSymbol || s.coin || "").toUpperCase().includes(q));
  }, [activeSignals, search]);

  function openChart(instrument) {
    setTvSignal({ source: "SMART_ENGINE", timeframe: "15m", scanMeta: { instrument } });
  }

  return (
    <>
      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Total instruments</span>
          <strong>{instruments.length}</strong>
          <span className="metric-meta">NSE / BSE / NFO / MCX</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Filtered</span>
          <strong>{filteredInstruments.length}</strong>
          <span className="metric-meta">Showing now</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Active signals</span>
          <strong>{activeSignals.length}</strong>
          <span className="metric-meta">SmartAPI engine</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Segments</span>
          <strong>{segments.length - 1}</strong>
          <span className="metric-meta">Equity · F&O · Commodity</span>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Filters</span><h2>Indian market view</h2></div>
          <span className="pill pill-neutral">{loading ? "Loading" : `${filteredInstruments.length} instruments`}</span>
        </div>
        <div className="filters-row">
          <label>
            <span>Search stock</span>
            <input onChange={e => setSearch(e.target.value)} placeholder="RELIANCE, NIFTY, GOLD..." value={search} />
          </label>
          <label>
            <span>Segment</span>
            <select onChange={e => setSegmentFilter(e.target.value)} value={segmentFilter}>
              {segments.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>
            <span>Exchange</span>
            <select onChange={e => setExchangeFilter(e.target.value)} value={exchangeFilter}>
              {exchanges.map(ex => <option key={ex} value={ex}>{ex}</option>)}
            </select>
          </label>
          {(search || segmentFilter !== "ALL" || exchangeFilter !== "ALL") && (
            <button className="button button-ghost" onClick={() => { setSearch(""); setSegmentFilter("ALL"); setExchangeFilter("ALL"); }} style={{ alignSelf: "flex-end" }} type="button">Clear</button>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Angel One SmartAPI</span><h2>All stock instruments</h2></div>
          <span className="pill pill-neutral">{filteredInstruments.length} instruments</span>
        </div>

        {/* Mobile cards */}
        <div className="signal-view-mobile">
          {filteredInstruments.length ? (
            <div className="ticker-cards">
              {filteredInstruments.map((inst, idx) => (
                <div className="ticker-card" key={inst.token || idx} onClick={() => openChart(inst)} style={{ cursor: "pointer" }}>
                  <div className="ticker-card-top">
                    <strong className="ticker-card-symbol" style={{ fontSize: "0.88rem" }}>{inst.tradingSymbol}</strong>
                    <span style={{ background: "rgba(255,255,255,0.07)", borderRadius: "5px", color: segmentColor(inst.segment), fontSize: "0.68rem", fontWeight: 700, padding: "2px 7px" }}>
                      {inst.segment}
                    </span>
                  </div>
                  <div className="ticker-card-meta">
                    <span>{inst.exchange}</span>
                    {inst.expiry ? <span>Exp: {inst.expiry}</span> : null}
                    {inst.lotSize > 1 ? <span>Lot: {inst.lotSize}</span> : null}
                    <span style={{ opacity: 0.5 }}>📊 Chart</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">{loading ? "Loading instruments..." : "No instruments found."}</div>
          )}
        </div>

        {/* Desktop table */}
        <div className="signal-view-desktop">
          <div className="table-wrap">
            <table className="signal-table signal-table-compact">
              <thead>
                <tr><th>Symbol</th><th>Exchange</th><th>Segment</th><th>Type</th><th>Lot Size</th><th>Expiry</th><th>Chart</th></tr>
              </thead>
              <tbody>
                {filteredInstruments.length ? filteredInstruments.map((inst, idx) => (
                  <tr key={inst.token || idx} className="ticker-row">
                    <td>
                      <button className="coin-chart-btn" onClick={() => openChart(inst)} type="button">
                        <strong>{inst.tradingSymbol}</strong>
                      </button>
                    </td>
                    <td><span className="pill pill-neutral" style={{ fontSize: "0.72rem" }}>{inst.exchange}</span></td>
                    <td>
                      <span style={{ background: "rgba(255,255,255,0.06)", borderRadius: "5px", color: segmentColor(inst.segment), fontSize: "0.72rem", fontWeight: 700, padding: "2px 8px" }}>
                        {inst.segment}
                      </span>
                    </td>
                    <td style={{ opacity: 0.65, fontSize: "0.78rem" }}>{inst.instrumentType || "EQ"}</td>
                    <td style={{ opacity: 0.75 }}>{inst.lotSize > 1 ? inst.lotSize : "—"}</td>
                    <td style={{ opacity: 0.65, fontSize: "0.78rem" }}>{inst.expiry || "—"}</td>
                    <td>
                      <button className="button button-ghost" onClick={() => openChart(inst)} style={{ padding: "2px 8px", fontSize: "0.75em" }} type="button">📊</button>
                    </td>
                  </tr>
                )) : (
                  <tr><td className="empty-row" colSpan="7">{loading ? "Loading..." : "No instruments found."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">SmartAPI signals</span><h2>Active stock signals</h2></div>
          <span className="pill pill-warning">{filteredSignals.length} active</span>
        </div>
        <SignalTable emptyLabel={loading ? "Loading stock signals..." : "No active stock signals."} signals={filteredSignals} />
      </section>
      <section className="panel">
        <div className="panel-header"><div><span className="eyebrow">Recent closes</span><h2>Closed stock signals</h2></div></div>
        <SignalTable compact emptyLabel="No closed stock signals yet." signals={historySignals} />
      </section>

      {tvSignal && (
        <TradingViewModal
          coin={tvSignal.scanMeta?.instrument?.tradingSymbol || ""}
          timeframe="15m"
          tradingSymbol={tvSignal.scanMeta?.instrument?.tradingSymbol}
          exchange={tvSignal.scanMeta?.instrument?.exchange}
          onClose={() => setTvSignal(null)}
        />
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN EXPORT
══════════════════════════════════════════════════════════════════════════════ */
export default function Market() {
  const [tab, setTab] = useState("crypto");

  return (
    <AppShell
      subtitle="Crypto (Binance Futures) aur Indian stocks (NSE / BSE / NFO / MCX) — dono ek jagah."
      title="Signal Scanner"
    >
      <div style={{ display: "flex", gap: "10px", marginBottom: "24px", flexWrap: "wrap" }}>
        <TabBtn active={tab === "crypto"} onClick={() => setTab("crypto")}>💹 Crypto Pairs</TabBtn>
        <TabBtn active={tab === "stocks"} onClick={() => setTab("stocks")}>🇮🇳 Indian Stocks</TabBtn>
      </div>

      {tab === "crypto" ? <CryptoTab /> : <StocksTab />}
    </AppShell>
  );
}
