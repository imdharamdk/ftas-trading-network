import { useEffect, useRef, useState } from "react";

function formatPrice(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  if (Math.abs(amount) >= 1000) return amount.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (Math.abs(amount) >= 1) return amount.toFixed(4);
  return amount.toFixed(6);
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", hour: "2-digit", minute: "2-digit", month: "short",
    timeZone: "Asia/Kolkata", hour12: false,
  }).format(new Date(value));
}

function formatSignedPercent(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return `${amount > 0 ? "+" : ""}${amount.toFixed(2)}%`;
}

function sideClass(side) { return side === "LONG" ? "pill-success" : "pill-danger"; }

function statusClass(status, result) {
  if (status === "ACTIVE") return "pill-warning";
  if (result === "SL_HIT") return "pill-danger";
  return "pill-success";
}

function toTvInterval(timeframe) {
  return { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240" }[timeframe] || "5";
}

function ChartModal({ signal, onClose }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = "";

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.onload = () => {
      if (!containerRef.current || !window.TradingView) return;
      new window.TradingView.widget({
        autosize: true,
        symbol: `BINANCE:${signal.coin}.P`,
        interval: toTvInterval(signal.timeframe),
        timezone: "Asia/Kolkata",
        theme: "dark",
        style: "1",
        locale: "en",
        toolbar_bg: "#0f172a",
        enable_publishing: false,
        hide_top_toolbar: false,
        save_image: false,
        container_id: "tv_chart_container",
        studies: ["MAExp@tv-basicstudies", "RSI@tv-basicstudies", "MACD@tv-basicstudies", "BB@tv-basicstudies", "Volume@tv-basicstudies"],
        overrides: {
          "mainSeriesProperties.candleStyle.upColor": "#22c55e",
          "mainSeriesProperties.candleStyle.downColor": "#ef4444",
          "mainSeriesProperties.candleStyle.borderUpColor": "#22c55e",
          "mainSeriesProperties.candleStyle.borderDownColor": "#ef4444",
          "mainSeriesProperties.candleStyle.wickUpColor": "#22c55e",
          "mainSeriesProperties.candleStyle.wickDownColor": "#ef4444",
        },
      });
    };
    containerRef.current.appendChild(script);
    return () => { if (containerRef.current) containerRef.current.innerHTML = ""; };
  }, [signal.coin, signal.timeframe]);

  useEffect(() => {
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "16px" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: "1100px", background: "#0f172a", borderRadius: "12px", overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,0.7)", border: "1px solid #1e293b" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #1e293b" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <strong style={{ color: "#f1f5f9", fontSize: "1.1rem" }}>{signal.coin}</strong>
            <span className={`pill ${sideClass(signal.side)}`}>{signal.side}</span>
            <span className="pill pill-neutral">{signal.timeframe}</span>
            {signal.leverage ? <span className="pill pill-accent">{signal.leverage}x</span> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
            <div style={{ display: "flex", gap: "20px", fontSize: "0.8rem", color: "#94a3b8" }}>
              <span>Entry <strong style={{ color: "#f1f5f9" }}>{formatPrice(signal.entry)}</strong></span>
              <span>SL <strong style={{ color: "#ef4444" }}>{formatPrice(signal.stopLoss)}</strong></span>
              <span>TP1 <strong style={{ color: "#22c55e" }}>{formatPrice(signal.tp1)}</strong></span>
              <span>TP2 <strong style={{ color: "#22c55e" }}>{formatPrice(signal.tp2)}</strong></span>
              <span>TP3 <strong style={{ color: "#22c55e" }}>{formatPrice(signal.tp3)}</strong></span>
            </div>
            <button
              onClick={onClose}
              style={{ background: "none", border: "1px solid #334155", borderRadius: "6px", color: "#94a3b8", cursor: "pointer", padding: "4px 12px", fontSize: "0.85rem" }}
            >
              ✕ Close
            </button>
          </div>
        </div>
        <div ref={containerRef} id="tv_chart_container" style={{ width: "100%", height: "560px" }} />
      </div>
    </div>
  );
}

export default function SignalTable({ compact = false, emptyLabel, signals }) {
  const [chartSignal, setChartSignal] = useState(null);

  return (
    <>
      {chartSignal ? <ChartModal signal={chartSignal} onClose={() => setChartSignal(null)} /> : null}
      <div className="table-card">
        <div className="table-wrap">
          <table className={`signal-table${compact ? " signal-table-compact" : ""}`}>
            <thead>
              <tr>
                <th>Coin</th>
                <th>Side</th>
                <th>TF</th>
                <th>Leverage</th>
                <th>Entry</th>
                <th>Live</th>
                <th>SL</th>
                <th>TP1</th>
                <th>TP2</th>
                <th>TP3</th>
                <th>Confidence</th>
                <th>Status</th>
                <th>Created (IST)</th>
              </tr>
            </thead>
            <tbody>
              {signals.length ? (
                signals.map((signal) => (
                  <tr key={signal.id}>
                    <td>
                      <button
                        onClick={() => setChartSignal(signal)}
                        title={`Live chart — ${signal.coin}`}
                        type="button"
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline", textDecorationStyle: "dotted", color: "inherit", fontWeight: "bold", fontSize: "inherit" }}
                      >
                        {signal.coin}
                      </button>
                    </td>
                    <td><span className={`pill ${sideClass(signal.side)}`}>{signal.side}</span></td>
                    <td>{signal.timeframe}</td>
                    <td><span className="pill pill-accent">{signal.leverage ? `${signal.leverage}x` : "-"}</span></td>
                    <td>{formatPrice(signal.entry)}</td>
                    <td>
                      <strong>{formatPrice(signal.livePrice ?? signal.closePrice)}</strong>
                      {Number.isFinite(Number(signal.signalMovePercent)) ? (
                        <div>
                          <span className={`pill ${Number(signal.signalMovePercent) >= 0 ? "pill-success" : "pill-danger"}`}>
                            {formatSignedPercent(signal.signalMovePercent)}
                          </span>
                        </div>
                      ) : null}
                    </td>
                    <td>{formatPrice(signal.stopLoss)}</td>
                    <td>{formatPrice(signal.tp1)}</td>
                    <td>{formatPrice(signal.tp2)}</td>
                    <td>{formatPrice(signal.tp3)}</td>
                    <td>{signal.confidence}%</td>
                    <td>
                      <span className={`pill ${statusClass(signal.status, signal.result)}`}>
                        {signal.result || signal.status}
                      </span>
                    </td>
                    <td>{formatDate(signal.createdAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty-row" colSpan="13">{emptyLabel}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
