import { useState } from "react";
import CandlestickChart from "./CandlestickChart";

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 10000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1000)  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (Math.abs(n) >= 1)     return n.toFixed(4);
  if (Math.abs(n) >= 0.0001) return n.toFixed(6);
  return n.toFixed(8);
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function formatSignedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function sideClass(side) {
  return side === "LONG" ? "pill-success" : "pill-danger";
}

function statusClass(status, result) {
  if (status === "ACTIVE")   return "pill-warning";
  if (result === "SL_HIT")   return "pill-danger";
  return "pill-success";
}

/* ─── Leverage badge ───────────────────────────────────────────────────────── */
function LeverageBadge({ leverage }) {
  const lev = Number(leverage);
  if (!Number.isFinite(lev) || lev <= 0) return <span style={{ opacity: 0.4 }}>—</span>;
  const cls = lev >= 40 ? "pill-danger" : lev >= 25 ? "pill-warning" : "pill-success";
  return <span className={`pill ${cls}`}>{lev}×</span>;
}

/* ─── Confidence badge ─────────────────────────────────────────────────────── */
function ConfBadge({ confidence }) {
  const cls = confidence >= 85 ? "pill-success" : confidence >= 70 ? "pill-warning" : "pill-neutral";
  return <span className={`pill ${cls}`}>{confidence}%</span>;
}

/* ══════════════════════════════════════════════════════════════════════════════
   MOBILE SIGNAL CARD — shown when screen width < 640px
   Uses CSS class .signal-card defined in index.css
══════════════════════════════════════════════════════════════════════════════ */
function SignalCard({ signal, onChartOpen }) {
  const move = Number(signal.signalMovePercent);
  const hasMove = Number.isFinite(move);
  const livePrice = formatPrice(signal.livePrice ?? signal.closePrice);
  const confirmations = Array.isArray(signal.confirmations)
    ? signal.confirmations.slice(0, 4).join(" · ")
    : "";

  return (
    <article className="signal-card">
      {/* Top row: coin + side + status */}
      <div className="signal-card-header">
        <button
          className="signal-card-coin"
          onClick={() => onChartOpen(signal.coin, signal.timeframe)}
          type="button"
        >
          {signal.coin.replace("USDT", "")}
          <span style={{ opacity: 0.5, fontSize: "0.8em" }}>/USDT</span>
          <span style={{ fontSize: "0.75em", opacity: 0.55 }}>📈</span>
        </button>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          <span className={`pill ${sideClass(signal.side)}`}>{signal.side}</span>
          <span className={`pill ${statusClass(signal.status, signal.result)}`}>
            {signal.result || signal.status}
          </span>
        </div>
      </div>

      {/* Price grid */}
      <div className="signal-card-grid">
        <div className="signal-card-row">
          <span className="signal-card-label">Entry</span>
          <span className="signal-card-value">{formatPrice(signal.entry)}</span>
        </div>

        <div className="signal-card-row">
          <span className="signal-card-label">Live Price</span>
          <span className="signal-card-value">
            {livePrice}
            {hasMove && (
              <span
                className={`pill ${move >= 0 ? "pill-success" : "pill-danger"}`}
                style={{ marginLeft: "5px", fontSize: "0.65rem" }}
              >
                {formatSignedPct(move)}
              </span>
            )}
          </span>
        </div>

        <div className="signal-card-row">
          <span className="signal-card-label">Stop Loss</span>
          <span className="signal-card-value" style={{ color: "#ffd2d8" }}>{formatPrice(signal.stopLoss)}</span>
        </div>

        <div className="signal-card-row">
          <span className="signal-card-label">TP1</span>
          <span className="signal-card-value" style={{ color: "#c9ffe5" }}>{formatPrice(signal.tp1)}</span>
        </div>

        <div className="signal-card-row">
          <span className="signal-card-label">TP2</span>
          <span className="signal-card-value" style={{ color: "#c9ffe5" }}>{formatPrice(signal.tp2)}</span>
        </div>

        <div className="signal-card-row">
          <span className="signal-card-label">TP3</span>
          <span className="signal-card-value" style={{ color: "#c9ffe5" }}>{formatPrice(signal.tp3)}</span>
        </div>

        <div className="signal-card-row">
          <span className="signal-card-label">Confidence</span>
          <span className="signal-card-value"><ConfBadge confidence={signal.confidence} /></span>
        </div>

        <div className="signal-card-row">
          <span className="signal-card-label">Leverage</span>
          <span className="signal-card-value">
            <LeverageBadge leverage={signal.leverage ?? signal.indicatorSnapshot?.leverage} />
          </span>
        </div>

        <div className="signal-card-row">
          <span className="signal-card-label">Timeframe</span>
          <span className="signal-card-value">{signal.timeframe}</span>
        </div>

      </div>

      {/* Confirmations */}
      {confirmations ? (
        <p className="signal-card-confirmations">{confirmations}</p>
      ) : null}

      {/* Created */}
      <div style={{ color: "var(--c-muted)", fontSize: "0.72rem", marginTop: "2px" }}>
        Created {formatDate(signal.createdAt)}
      </div>
    </article>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   DESKTOP TABLE ROW
══════════════════════════════════════════════════════════════════════════════ */
function TableRow({ signal, onChartOpen }) {
  return (
    <tr>
      <td>
        <button
          className="coin-chart-btn"
          onClick={() => onChartOpen(signal.coin, signal.timeframe)}
          title={`View ${signal.coin} chart`}
          type="button"
        >
          <strong>{signal.coin}</strong>
          <span className="coin-chart-icon">📈</span>
        </button>
      </td>

      <td><span className={`pill ${sideClass(signal.side)}`}>{signal.side}</span></td>

      <td>{signal.timeframe}</td>

      <td>{formatPrice(signal.entry)}</td>

      <td>
        <strong>{formatPrice(signal.livePrice ?? signal.closePrice)}</strong>
        {Number.isFinite(Number(signal.signalMovePercent)) && (
          <div>
            <span className={`pill ${Number(signal.signalMovePercent) >= 0 ? "pill-success" : "pill-danger"}`}>
              {formatSignedPct(signal.signalMovePercent)}
            </span>
          </div>
        )}
      </td>

      <td>{formatPrice(signal.stopLoss)}</td>
      <td>{formatPrice(signal.tp1)}</td>
      <td>{formatPrice(signal.tp2)}</td>
      <td>{formatPrice(signal.tp3)}</td>

      <td><ConfBadge confidence={signal.confidence} /></td>

      <td><LeverageBadge leverage={signal.leverage ?? signal.indicatorSnapshot?.leverage} /></td>

      <td>
        <span className={`pill ${statusClass(signal.status, signal.result)}`}>
          {signal.result || signal.status}
        </span>
      </td>

      <td>{formatDate(signal.createdAt)}</td>
    </tr>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN EXPORT
   - Mobile (< 640px): renders SignalCard components
   - Desktop (≥ 640px): renders scrollable table
   Switching is done via CSS — both are rendered, one is hidden via CSS
   This avoids any JS screen-size detection which can cause flickers.
══════════════════════════════════════════════════════════════════════════════ */
export default function SignalTable({ compact = false, emptyLabel, signals }) {
  const [chartCoin, setChartCoin] = useState(null);
  const [chartTf, setChartTf]     = useState("15m");

  function openChart(coin, timeframe) {
    setChartCoin(coin);
    setChartTf(timeframe || "15m");
  }

  const colCount = 13;

  return (
    <>
      {/* ── MOBILE CARD VIEW (hidden at 640px+ via CSS) ── */}
      <div className="signal-view-mobile">
        {signals.length ? (
          <div className="signal-cards">
            {signals.map(signal => (
              <SignalCard key={signal.id} signal={signal} onChartOpen={openChart} />
            ))}
          </div>
        ) : (
          <div className="empty-state" style={{ padding: "16px 0" }}>{emptyLabel}</div>
        )}
      </div>

      {/* ── DESKTOP TABLE VIEW (hidden below 640px via CSS) ── */}
      <div className="signal-view-desktop">
        <div className="table-card">
          <div className="table-wrap">
            <table className={`signal-table${compact ? " signal-table-compact" : ""}`}>
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Side</th>
                  <th>TF</th>
                  <th>Entry</th>
                  <th>Live Price</th>
                  <th>SL</th>
                  <th>TP1</th>
                  <th>TP2</th>
                  <th>TP3</th>
                  <th>Confidence</th>
                  <th>Leverage</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {signals.length ? (
                  signals.map(signal => (
                    <TableRow
                      key={signal.id}
                      signal={signal}
                      onChartOpen={openChart}
                    />
                  ))
                ) : (
                  <tr>
                    <td className="empty-row" colSpan={colCount}>{emptyLabel}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Chart modal */}
      {chartCoin && (
        <CandlestickChart
          coin={chartCoin}
          timeframe={chartTf}
          signal={signals.find(s => s.coin === chartCoin && s.timeframe === chartTf) || null}
          onClose={() => setChartCoin(null)}
        />
      )}
    </>
  );
}
