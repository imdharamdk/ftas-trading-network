// src/components/TickerMarquee.jsx
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

const REFRESH_INTERVAL_MS = 60_000;

function formatPrice(price) {
  const n = parseFloat(price);
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function formatChange(change) {
  const n = parseFloat(change);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export default function TickerMarquee() {
  const [tickers, setTickers] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchTickers = async () => {
    try {
      const res = await apiFetch("/market/tickers?limit=250&sort=changePercent&fields=lite", {
        skipAuth: true,
      });
      const tickersList = Array.isArray(res?.tickers) ? res.tickers : [];

      const usdt = tickersList.filter((ticker) => (
        String(ticker.symbol || "").endsWith("USDT")
        && Number(ticker.quoteVolume) > 0
        && ticker.changePercent != null
      ));

      const sorted = [...usdt].sort((a, b) => Number(b.changePercent) - Number(a.changePercent));
      const topGainers = sorted.slice(0, 10);
      const topLosers = sorted.slice(-10).reverse();

      setTickers([...topGainers, ...topLosers]);
    } catch (err) {
      console.error("TickerMarquee:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTickers();
    const id = setInterval(fetchTickers, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (loading || tickers.length === 0) {
    return (
      <div style={s.wrapper}>
        <span style={s.loadingText}>Loading market data…</span>
      </div>
    );
  }

  const items = [...tickers, ...tickers];

  return (
    <div style={s.wrapper} aria-label="Live market ticker">
      <div style={s.fadeLeft} aria-hidden="true" />
      <div style={s.fadeRight} aria-hidden="true" />

      <div style={s.trackOuter}>
        <div style={{ ...s.track, animationDuration: `${items.length * 2.6}s` }}>
          {items.map((ticker, i) => {
            const change = Number(ticker.changePercent);
            const isUp = change >= 0;
            const color = isUp ? "#22c55e" : "#ef4444";
            return (
              <span key={`${ticker.symbol}-${i}`} style={s.item}>
                <span style={s.symbol}>
                  {ticker.symbol.replace("USDT", "")}
                  <span style={s.quote}>/USDT</span>
                </span>
                <span style={{ ...s.price, color }}>${formatPrice(ticker.price)}</span>
                <span style={{ ...s.badge, background: isUp ? "rgba(34,197,94,0.13)" : "rgba(239,68,68,0.13)", color }}>
                  {isUp ? "▲" : "▼"} {formatChange(change)}
                </span>
                <span style={s.dot} aria-hidden="true">•</span>
              </span>
            );
          })}
        </div>
      </div>

      <div style={s.livePill} aria-label="Live data">
        <span style={s.liveDot} />
        LIVE
      </div>

      <style>{`
        @keyframes ftas-ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @keyframes ftas-pulse  { 0%,100% { opacity:1; } 50% { opacity:0.25; } }
      `}</style>
    </div>
  );
}

const s = {
  wrapper: {
    position: "relative",
    width: "100%",
    height: "34px",
    background: "linear-gradient(90deg,#0c1220 0%,#111827 50%,#0c1220 100%)",
    borderBottom: "1px solid rgba(255,255,255,0.055)",
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
    flexShrink: 0,
    zIndex: 40,
  },
  trackOuter: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    height: "100%",
  },
  track: {
    display: "inline-flex",
    alignItems: "center",
    whiteSpace: "nowrap",
    animation: "ftas-ticker linear infinite",
    willChange: "transform",
  },
  item: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    marginRight: "20px",
    userSelect: "none",
  },
  symbol: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#e2e8f0",
    letterSpacing: "0.03em",
    fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace",
  },
  quote: {
    color: "#475569",
    fontWeight: 400,
  },
  price: {
    fontSize: "11px",
    fontWeight: 500,
    fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace",
  },
  badge: {
    fontSize: "10px",
    fontWeight: 700,
    padding: "1px 4px",
    borderRadius: "3px",
    fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace",
  },
  dot: {
    color: "#1e293b",
    fontSize: "10px",
    marginLeft: "6px",
  },
  fadeLeft: {
    position: "absolute",
    left: 0, top: 0, bottom: 0,
    width: "60px",
    background: "linear-gradient(to right,#0c1220,transparent)",
    zIndex: 10,
    pointerEvents: "none",
  },
  fadeRight: {
    position: "absolute",
    right: "56px", top: 0, bottom: 0,
    width: "60px",
    background: "linear-gradient(to left,#0c1220,transparent)",
    zIndex: 10,
    pointerEvents: "none",
  },
  livePill: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "0 10px",
    fontSize: "9px",
    fontWeight: 700,
    letterSpacing: "0.1em",
    color: "#22c55e",
    borderLeft: "1px solid rgba(255,255,255,0.055)",
    height: "100%",
    background: "#0c1220",
    flexShrink: 0,
    fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace",
    zIndex: 20,
  },
  liveDot: {
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    background: "#22c55e",
    display: "inline-block",
    animation: "ftas-pulse 1.4s ease-in-out infinite",
  },
  loadingText: {
    flex: 1,
    textAlign: "center",
    fontSize: "10px",
    color: "#334155",
    letterSpacing: "0.05em",
  },
};
