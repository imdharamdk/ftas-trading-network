import { useEffect, useState } from "react";
import CandlestickChart from "./CandlestickChart";

// ─── Expiry map (must match signalEngine.js SIGNAL_EXPIRY_MS) ─────────────────
const EXPIRY_MS = {
  "1m":  30  * 60 * 1000,
  "5m":  60  * 60 * 1000,
  "15m": 4   * 60 * 60 * 1000,
  "1h":  16  * 60 * 60 * 1000,
  "4h":  72  * 60 * 60 * 1000,
  "12h": 7   * 24 * 60 * 60 * 1000,
  "1d":  21  * 24 * 60 * 60 * 1000,
};

function getExpiryMs(timeframe) {
  return EXPIRY_MS[timeframe] || EXPIRY_MS["15m"];
}

function formatCountdown(createdAt, timeframe) {
  if (!createdAt) return null;
  const expiryMs   = getExpiryMs(timeframe);
  const created    = new Date(createdAt).getTime();
  const expiresAt  = created + expiryMs;
  const remaining  = expiresAt - Date.now();

  if (remaining <= 0) return { label: "Expired", urgent: true, expiresAt };

  const totalSec = Math.floor(remaining / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  let label;
  if (d > 0)      label = `${d}d ${h}h`;
  else if (h > 0) label = `${h}h ${m}m`;
  else if (m > 0) label = `${m}m ${s}s`;
  else            label = `${s}s`;

  const urgent = remaining < 30 * 60 * 1000; // red if <30 min left
  return { label, urgent, expiresAt };
}

function formatPrice(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  if (Math.abs(amount) >= 10000)  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Math.abs(amount) >= 1000)   return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (Math.abs(amount) >= 1)      return amount.toFixed(4);
  if (Math.abs(amount) >= 0.0001) return amount.toFixed(6);
  return amount.toFixed(8);
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", hour: "2-digit", minute: "2-digit", month: "short",
  }).format(new Date(value));
}

function formatSignedPercent(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return `${amount > 0 ? "+" : ""}${amount.toFixed(2)}%`;
}

function sideClass(side) {
  return side === "LONG" ? "pill-success" : "pill-danger";
}

function statusClass(status, result) {
  if (status === "ACTIVE") return "pill-warning";
  if (result === "SL_HIT") return "pill-danger";
  return "pill-success";
}

// ─── Live countdown — ticks every second while signal is ACTIVE ───────────────
function ExpiryCell({ createdAt, status, timeframe }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (status !== "ACTIVE") return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  if (status !== "ACTIVE") return <span style={{ opacity: 0.4 }}>—</span>;

  const info = formatCountdown(createdAt, timeframe);
  if (!info) return <span style={{ opacity: 0.4 }}>—</span>;

  return (
    <span
      className={`pill ${info.urgent ? "pill-danger" : "pill-neutral"}`}
      title={`Expires at ${new Date(info.expiresAt).toLocaleString("en-IN")}`}
      style={{ fontVariantNumeric: "tabular-nums", minWidth: "60px", display: "inline-block", textAlign: "center" }}
    >
      ⏱ {info.label}
    </span>
  );
}

// ─── Leverage badge — colour coded by risk ───────────────────────────────────
function LeverageBadge({ leverage }) {
  const lev = Number(leverage);
  if (!Number.isFinite(lev) || lev <= 0) return <span style={{ opacity: 0.4 }}>—</span>;
  const cls = lev >= 15 ? "pill-danger" : lev >= 10 ? "pill-warning" : "pill-success";
  return (
    <span className={`pill ${cls}`} title={`Suggested leverage: ${lev}×`}>
      {lev}×
    </span>
  );
}

export default function SignalTable({ compact = false, emptyLabel, signals }) {
  const [chartCoin, setChartCoin] = useState(null);
  const [chartTf, setChartTf]     = useState("15m");

  function openChart(coin, timeframe) {
    setChartCoin(coin);
    setChartTf(timeframe || "15m");
  }

  const colCount = compact ? 13 : 14;

  return (
    <>
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
                {!compact && <th>Expires In</th>}
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {signals.length ? (
                signals.map((signal) => (
                  <tr key={signal.id}>
                    {/* Coin — click to open TradingView chart */}
                    <td>
                      <button
                        className="coin-chart-btn"
                        onClick={() => openChart(signal.coin, signal.timeframe)}
                        title={`View ${signal.coin} chart`}
                        type="button"
                      >
                        <strong>{signal.coin}</strong>
                        <span className="coin-chart-icon">📈</span>
                      </button>
                    </td>

                    {/* Side */}
                    <td>
                      <span className={`pill ${sideClass(signal.side)}`}>{signal.side}</span>
                    </td>

                    {/* Timeframe */}
                    <td>{signal.timeframe}</td>

                    {/* Entry price */}
                    <td>{formatPrice(signal.entry)}</td>

                    {/* Live price with move % */}
                    <td>
                      <strong>{formatPrice(signal.livePrice ?? signal.closePrice)}</strong>
                      {Number.isFinite(Number(signal.signalMovePercent)) && (
                        <div>
                          <span className={`pill ${Number(signal.signalMovePercent) >= 0 ? "pill-success" : "pill-danger"}`}>
                            {formatSignedPercent(signal.signalMovePercent)}
                          </span>
                        </div>
                      )}
                    </td>

                    {/* SL / TPs */}
                    <td>{formatPrice(signal.stopLoss)}</td>
                    <td>{formatPrice(signal.tp1)}</td>
                    <td>{formatPrice(signal.tp2)}</td>
                    <td>{formatPrice(signal.tp3)}</td>

                    {/* Confidence — colour coded */}
                    <td>
                      <span className={`pill ${
                        signal.confidence >= 85 ? "pill-success"
                        : signal.confidence >= 70 ? "pill-warning"
                        : "pill-neutral"
                      }`}>
                        {signal.confidence}%
                      </span>
                    </td>

                    {/* Suggested leverage */}
                    <td>
                      <LeverageBadge leverage={signal.leverage ?? signal.indicatorSnapshot?.leverage} />
                    </td>

                    {/* Expiry countdown — full mode only */}
                    {!compact && (
                      <td>
                        <ExpiryCell
                          createdAt={signal.createdAt}
                          status={signal.status}
                          timeframe={signal.timeframe}
                        />
                      </td>
                    )}

                    {/* Status / result */}
                    <td>
                      <span className={`pill ${statusClass(signal.status, signal.result)}`}>
                        {signal.result || signal.status}
                      </span>
                    </td>

                    {/* Created at */}
                    <td>{formatDate(signal.createdAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty-row" colSpan={colCount}>
                    {emptyLabel}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Chart modal — opens on coin click */}
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
