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

export default function TradingViewModal({ coin, timeframe, onClose }) {
  const containerRef = useRef(null);

  // Build TradingView symbol  e.g. BTCUSDT → BINANCE:BTCUSDT.P  (perp futures)
  const symbol   = coin.endsWith("USDT") ? coin : `${coin}USDT`;
  const tvSymbol = `BINANCE:${symbol}.P`;
  const interval = TF_MAP[timeframe] ?? "15";

  useEffect(() => {
    if (!containerRef.current) return;

    // Remove any previous widget
    containerRef.current.innerHTML = "";

    const script = document.createElement("script");
    script.src   = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type  = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize:          true,
      symbol:            tvSymbol,
      interval:          interval,
      timezone:          "Etc/UTC",
      theme:             "dark",
      style:             "1",
      locale:            "en",
      allow_symbol_change: false,
      calendar:          false,
      support_host:      "https://www.tradingview.com",
    });

    containerRef.current.appendChild(script);
  }, [tvSymbol, interval]);

  // Close on backdrop click or Escape key
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="tv-modal-backdrop" onClick={onClose}>
      <div
        className="tv-modal-box"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="tv-modal-header">
          <span className="tv-modal-title">
            📈 {symbol} &nbsp;
            <span className="tv-modal-tf">{timeframe}</span>
          </span>
          <button className="tv-modal-close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* TradingView widget container */}
        <div className="tradingview-widget-container" ref={containerRef} style={{ height: "100%", width: "100%" }}>
          <div className="tradingview-widget-container__widget" style={{ height: "calc(100% - 32px)", width: "100%" }} />
        </div>
      </div>
    </div>
  );
}
