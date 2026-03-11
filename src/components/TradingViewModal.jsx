import { useEffect, useRef } from "react";

// Map internal timeframes → TradingView interval codes
const TF_MAP = {
  "1m":  "1",
  "5m":  "5",
  "15m": "15",
  "1h":  "60",
  "4h":  "240",
  "12h": "720",
  "1d":  "D",
};

/**
 * Build the correct TradingView symbol string.
 *
 * Indian stocks/F&O (SMART_ENGINE):
 *   NSE equity  → "NSE:RELIANCE"
 *   NFO futures → "NSE:NIFTY25JUNFUT"
 *   MCX         → "MCX:CRUDEOIL25JUNFUT"
 *   BSE equity  → "BSE:RELIANCE"
 *
 * Crypto (Binance):
 *   "BTCUSDT" → "BINANCE:BTCUSDT.P"
 */
function buildTVSymbol(coin, tradingSymbol, exchange) {
  if (tradingSymbol) {
    const sym  = tradingSymbol.toUpperCase();
    const exch = (exchange || "NSE").toUpperCase();

    if (exch === "MCX")              return `MCX:${sym}`;
    if (exch === "NFO" || exch === "BFO") return `NSE:${sym}`;
    if (exch === "BSE")              return `BSE:${sym}`;
    return `NSE:${sym}`;
  }

  const symbol = coin.endsWith("USDT") ? coin : `${coin}USDT`;
  return `BINANCE:${symbol}.P`;
}

export default function TradingViewModal({ coin, timeframe, tradingSymbol, exchange, onClose }) {
  const containerRef = useRef(null);

  const tvSymbol    = buildTVSymbol(coin, tradingSymbol, exchange);
  const displayName = tradingSymbol || coin;
  const interval    = TF_MAP[timeframe] ?? "15";

  useEffect(() => {
    if (!containerRef.current) return;

    containerRef.current.innerHTML = "";

    const script = document.createElement("script");
    script.src   = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type  = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize:            true,
      symbol:              tvSymbol,
      interval:            interval,
      timezone:            "Asia/Kolkata",
      theme:               "dark",
      style:               "1",
      locale:              "en",
      allow_symbol_change: true,
      calendar:            false,
      support_host:        "https://www.tradingview.com",
    });

    containerRef.current.appendChild(script);
  }, [tvSymbol, interval]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="tv-modal-backdrop" onClick={onClose}>
      <div className="tv-modal-box" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="tv-modal-header">
          <span className="tv-modal-title">
            📈 {displayName}
            {tradingSymbol && exchange ? (
              <span style={{ opacity: 0.6, fontSize: "0.78em", marginLeft: "6px" }}>{exchange}</span>
            ) : null}
            &nbsp;
            <span className="tv-modal-tf">{timeframe}</span>
          </span>
          <button className="tv-modal-close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* TradingView widget */}
        <div className="tradingview-widget-container" ref={containerRef} style={{ height: "100%", width: "100%" }}>
          <div className="tradingview-widget-container__widget" style={{ height: "calc(100% - 32px)", width: "100%" }} />
        </div>

      </div>
    </div>
  );
}
