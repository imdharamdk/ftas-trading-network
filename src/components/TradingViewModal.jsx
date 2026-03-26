import { useEffect, useMemo, useRef } from "react";

const TF_MAP = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
  "12h": "720",
  "1d": "D",
};

const DEFAULT_STUDIES = [
  "Volume@tv-basicstudies",
  "MAExp@tv-basicstudies",
  "BB@tv-basicstudies",
  "VWAP@tv-basicstudies",
  "RSI@tv-basicstudies",
  "MACD@tv-basicstudies",
  "ADX@tv-basicstudies",
];

function buildTVSymbol(coin, tradingSymbol, exchange) {
  if (tradingSymbol) {
    const sym = tradingSymbol.toUpperCase();
    const exch = (exchange || "NSE").toUpperCase();

    if (exch === "MCX") return `MCX:${sym}`;
    if (exch === "NFO" || exch === "BFO") return `NSE:${sym}`;
    if (exch === "BSE") return `BSE:${sym}`;
    return `NSE:${sym}`;
  }

  const symbol = coin.endsWith("USDT") ? coin : `${coin}USDT`;
  return `BINANCE:${symbol}.P`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "-";
    if (Math.abs(value) >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (Math.abs(value) >= 1) return value.toFixed(2);
    return value.toFixed(4);
  }
  return String(value);
}

function prettify(label) {
  return String(label || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildIndicatorItems(signal) {
  const snapshot = signal?.indicatorSnapshot || {};
  const items = [];
  const primaryKeys = [
    "ema9", "ema21", "ema50", "ema100", "ema200", "vwap",
    "adx", "pdi", "mdi", "psar", "rsi", "rsi9", "cci", "mfi",
    "ao", "williamsR", "trix", "atr", "bbPctB", "regime",
    "volumeSpike", "volumeStrong", "higherBias", "effectiveBias", "riskPerUnit", "leverage",
  ];

  primaryKeys.forEach((key) => {
    if (snapshot[key] === undefined) return;
    items.push({ label: prettify(key), value: formatValue(snapshot[key]) });
  });

  if (snapshot.macd) {
    items.push({ label: "MACD", value: formatValue(snapshot.macd.macd) });
    items.push({ label: "MACD Signal", value: formatValue(snapshot.macd.signal) });
    items.push({ label: "MACD Histogram", value: formatValue(snapshot.macd.histogram) });
  }

  if (snapshot.bollinger) {
    items.push({ label: "BB Upper", value: formatValue(snapshot.bollinger.upper) });
    items.push({ label: "BB Middle", value: formatValue(snapshot.bollinger.middle) });
    items.push({ label: "BB Lower", value: formatValue(snapshot.bollinger.lower) });
  }

  if (snapshot.marketActivity) {
    items.push({ label: "Quote Volume", value: formatValue(snapshot.marketActivity.quoteVolume) });
    items.push({ label: "Trade Count", value: formatValue(snapshot.marketActivity.tradeCount) });
    items.push({ label: "Open Interest", value: formatValue(snapshot.marketActivity.openInterestValue) });
    items.push({ label: "Activity Score", value: formatValue(snapshot.marketActivity.activityScore) });
  }

  return items;
}

function buildFilterItems(signal) {
  const meta = signal?.scanMeta || {};
  const base = [
    ["Rule Version", meta.ruleVersion],
    ["Model Version", meta.modelVersion],
    ["Higher Bias", meta.higherBias],
    ["Effective Bias", meta.effectiveBias],
    ["Publish Floor", meta.publishFloor],
    ["ATR %", meta.atrPercent],
    ["SR Room R", meta.srRoomR],
    ["Market Activity Score", meta.marketActivityScore],
    ["Market Quote Volume", meta.marketQuoteVolume],
    ["Market Trade Count", meta.marketTradeCount],
    ["Market Open Interest", meta.marketOpenInterestValue],
  ];

  return base
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => ({ label, value: formatValue(value) }));
}

function buildReasonItems(signal) {
  const meta = signal?.scanMeta || {};
  const items = [];

  if (Array.isArray(signal?.confirmations)) {
    signal.confirmations.forEach((text) => items.push({ tone: "accent", text }));
  }

  if (Array.isArray(meta?.qualityGuard?.reasons)) {
    meta.qualityGuard.reasons.forEach((text) => items.push({ tone: "warning", text: `Guard: ${text}` }));
  }

  if (Array.isArray(meta?.selfLearning?.reasons)) {
    meta.selfLearning.reasons.forEach((text) => items.push({ tone: "sky", text: `Self-learning: ${text}` }));
  }

  if (meta?.localAI?.predictedWinProbability !== undefined && meta?.localAI?.predictedWinProbability !== null) {
    items.push({ tone: "neutral", text: `Local AI win probability: ${formatValue(meta.localAI.predictedWinProbability)}` });
  }

  return items;
}

export default function TradingViewModal({ coin, timeframe, tradingSymbol, exchange, signal = null, onClose }) {
  const containerRef = useRef(null);

  const tvSymbol = buildTVSymbol(coin, tradingSymbol, exchange);
  const displayName = tradingSymbol || coin;
  const interval = TF_MAP[timeframe] ?? "15";

  const indicatorItems = useMemo(() => buildIndicatorItems(signal), [signal]);
  const filterItems = useMemo(() => buildFilterItems(signal), [signal]);
  const reasonItems = useMemo(() => buildReasonItems(signal), [signal]);

  useEffect(() => {
    if (!containerRef.current) return;

    containerRef.current.innerHTML = "";

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval,
      timezone: "Asia/Kolkata",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: true,
      calendar: false,
      details: true,
      studies: DEFAULT_STUDIES,
      support_host: "https://www.tradingview.com",
    });

    containerRef.current.appendChild(script);
  }, [tvSymbol, interval]);

  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="tv-modal-backdrop" onClick={onClose}>
      <div className="tv-modal-box" onClick={(event) => event.stopPropagation()}>
        <div className="tv-modal-header">
          <span className="tv-modal-title">
            📈 {displayName}
            {tradingSymbol && exchange ? (
              <span style={{ opacity: 0.6, fontSize: "0.78em", marginLeft: "6px" }}>{exchange}</span>
            ) : null}
            <span className="tv-modal-tf">{timeframe}</span>
          </span>
          <button className="tv-modal-close" onClick={onClose} title="Close" type="button">✕</button>
        </div>

        {signal ? (
          <div className="tv-signal-strip">
            <span className="tv-chip tv-chip-side">{signal.side}</span>
            <span className="tv-chip">Confidence {formatValue(signal.confidence)}%</span>
            <span className="tv-chip">Strength {formatValue(signal.strength)}</span>
            <span className="tv-chip">Leverage {formatValue(signal.leverage)}x</span>
            <span className="tv-chip">Entry {formatValue(signal.entry)}</span>
            <span className="tv-chip">SL {formatValue(signal.stopLoss)}</span>
            <span className="tv-chip">TP1 {formatValue(signal.tp1)}</span>
            <span className="tv-chip">TP2 {formatValue(signal.tp2)}</span>
            <span className="tv-chip">TP3 {formatValue(signal.tp3)}</span>
          </div>
        ) : (
          <div className="tv-signal-strip">
            <span className="tv-chip">Indicators loaded: EMA, BB, VWAP, RSI, MACD, ADX, Volume</span>
          </div>
        )}

        <div className="tv-modal-content">
          <div className="tradingview-widget-container" ref={containerRef}>
            <div className="tradingview-widget-container__widget" style={{ height: "100%", width: "100%" }} />
          </div>

          {signal ? (
            <aside className="tv-sidepanel">
              <section className="tv-section">
                <div className="tv-section-title">Confirmations And Guards</div>
                <div className="tv-chip-list">
                  {reasonItems.length ? reasonItems.map((item, index) => (
                    <span className={`tv-chip tv-chip-${item.tone}`} key={`${item.text}_${index}`}>{item.text}</span>
                  )) : <span className="tv-empty-note">No extra confirmations attached.</span>}
                </div>
              </section>

              <section className="tv-section">
                <div className="tv-section-title">Applied Filters</div>
                <div className="tv-detail-grid">
                  {filterItems.length ? filterItems.map((item) => (
                    <div className="tv-detail-card" key={item.label}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  )) : <span className="tv-empty-note">No filter metadata attached.</span>}
                </div>
              </section>

              <section className="tv-section">
                <div className="tv-section-title">Indicator Snapshot</div>
                <div className="tv-detail-grid">
                  {indicatorItems.length ? indicatorItems.map((item) => (
                    <div className="tv-detail-card" key={item.label}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  )) : <span className="tv-empty-note">No indicator snapshot attached.</span>}
                </div>
              </section>
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
