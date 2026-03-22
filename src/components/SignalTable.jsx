import { useMemo, useState } from "react";
import CandlestickChart from "./CandlestickChart";
import TradingViewModal from "./TradingViewModal";

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (Math.abs(n) >= 1) return n.toFixed(4);
  if (Math.abs(n) >= 0.0001) return n.toFixed(6);
  return n.toFixed(8);
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date(value));
}

function formatSignedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function buildExplainability(signal = {}) {
  const confirmations = Array.isArray(signal.confirmations) ? signal.confirmations : [];
  const scanMeta = signal.scanMeta || {};
  const indicator = signal.indicatorSnapshot || {};

  const qualityReasons = Array.isArray(scanMeta?.qualityGuard?.reasons) ? scanMeta.qualityGuard.reasons : [];
  const selfLearningReasons = Array.isArray(scanMeta?.selfLearning?.reasons) ? scanMeta.selfLearning.reasons : [];
  const localAiReasons = Array.isArray(scanMeta?.localAI?.reasons) ? scanMeta.localAI.reasons : [];

  const context = [
    { label: "ADX", value: indicator.adx },
    { label: "RSI", value: indicator.rsi },
    { label: "ATR", value: indicator.atr },
    { label: "Risk/Unit", value: indicator.riskPerUnit },
    { label: "Publish Floor", value: scanMeta.publishFloor },
    { label: "Model", value: scanMeta.modelVersion },
  ].filter((item) => item.value !== undefined && item.value !== null && item.value !== "");

  return {
    confirmations,
    qualityReasons,
    selfLearningReasons,
    localAiReasons,
    context,
  };
}

function sideClass(side) { return side === "LONG" ? "pill-success" : "pill-danger"; }
function statusClass(status, result) {
  if (status === "ACTIVE") return "pill-warning";
  if (result === "SL_HIT") return "pill-danger";
  if (result === "EXPIRED") return "pill-neutral";
  return "pill-success";
}

function formatDisplaySymbol(signal) {
  const instrument = signal.scanMeta?.instrument;
  if (instrument?.tradingSymbol) {
    const detailParts = [];
    if (instrument.exchange) detailParts.push(instrument.exchange);
    if (instrument.segment && instrument.segment !== instrument.exchange) detailParts.push(instrument.segment);
    return { label: instrument.tradingSymbol, detail: detailParts.join(" · ") };
  }
  const coin = String(signal.coin || "").toUpperCase();
  if (!coin) return { label: "—", detail: "" };
  if (coin.endsWith("USDT")) return { label: coin.replace("USDT", ""), detail: "/USDT" };
  return { label: coin, detail: "" };
}

function LeverageBadge({ leverage }) {
  const lev = Number(leverage);
  if (!Number.isFinite(lev) || lev <= 0) return <span style={{ opacity: 0.35 }}>—</span>;
  const cls = lev >= 40 ? "pill-danger" : lev >= 25 ? "pill-warning" : "pill-success";
  return <span className={`pill ${cls}`}>{lev}×</span>;
}

function ConfBadge({ confidence }) {
  const cls = confidence >= 85 ? "pill-success" : confidence >= 70 ? "pill-warning" : "pill-neutral";
  return <span className={`pill ${cls}`}>{confidence}%</span>;
}

function SignalCard({ signal, onChartOpen, onExplain }) {
  const move = Number(signal.signalMovePercent);
  const hasMove = Number.isFinite(move);
  const livePrice = signal.livePrice ?? signal.closePrice;
  const sym = formatDisplaySymbol(signal);
  const isStock = signal.source === "SMART_ENGINE";
  const isClosed = signal.status !== "ACTIVE";
  const result = signal.result || signal.status;

  return (
    <article className="signal-card" data-side={signal.side}>
      <div className="signal-card-header">
        <button
          className="signal-card-coin"
          onClick={() => onChartOpen(signal)}
          title={`View ${sym.label} chart`}
          type="button"
        >
          <span>{sym.label}</span>
          {sym.detail && <span style={{ opacity: 0.45, fontSize: "0.72em" }}>{sym.detail}</span>}
          <span style={{ fontSize: "0.75em", opacity: 0.5 }}>{isStock ? "📊" : "📈"}</span>
        </button>

        <div className="signal-card-tags">
          <span className={`pill ${sideClass(signal.side)}`}>{signal.side}</span>
          <span className="signal-timeframe-badge">{signal.timeframe}</span>
          <ConfBadge confidence={signal.confidence} />
        </div>
      </div>

      <div className="signal-card-prices">
        <div className="signal-price-cell">
          <span className="signal-price-label">Entry</span>
          <span className="signal-price-value">{formatPrice(signal.entry)}</span>
        </div>
        <div className="signal-price-divider" />
        <div className="signal-price-cell">
          <span className="signal-price-label">{isClosed ? "Close" : "Live"}</span>
          <span className="signal-price-value" style={{ color: hasMove ? (move >= 0 ? "var(--c-green)" : "var(--c-red)") : undefined }}>
            {formatPrice(livePrice)}
            {hasMove && <span style={{ fontSize: "0.70em", marginLeft: 4, opacity: 0.8 }}>({formatSignedPct(move)})</span>}
          </span>
        </div>
        <div className="signal-price-divider" />
        <div className="signal-price-cell">
          <span className="signal-price-label">Stop Loss</span>
          <span className="signal-price-value" style={{ color: "var(--c-red)" }}>{formatPrice(signal.stopLoss)}</span>
        </div>
      </div>

      <div className="signal-card-tp-row">
        {[["TP1", signal.tp1], ["TP2", signal.tp2], ["TP3", signal.tp3]].map(([label, val]) => (
          <div key={label} className="signal-tp-cell">
            <span className="signal-tp-label">{label}</span>
            <span className="signal-tp-value">{formatPrice(val)}</span>
          </div>
        ))}
      </div>

      <div className="signal-card-meta">
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <LeverageBadge leverage={signal.leverage ?? signal.indicatorSnapshot?.leverage} />
          <span className={`pill ${statusClass(signal.status, signal.result)}`}>{result}</span>
          <button className="button button-ghost" onClick={() => onExplain(signal)} style={{ minHeight: 24, padding: "2px 8px", fontSize: "0.72rem" }} type="button">
            Why?
          </button>
        </div>
        <span className="signal-card-time">{formatDate(signal.createdAt)}</span>
      </div>

      {Array.isArray(signal.confirmations) && signal.confirmations.length > 0 ? (
        <p className="signal-card-confirmations">
          {signal.confirmations.slice(0, 3).join(" · ")}
          {signal.confirmations.length > 3 && ` +${signal.confirmations.length - 3} more`}
        </p>
      ) : null}
    </article>
  );
}

function TableRow({ signal, onChartOpen, onExplain }) {
  const sym = formatDisplaySymbol(signal);
  const isStock = signal.source === "SMART_ENGINE";
  return (
    <tr>
      <td>
        <button className="coin-chart-btn" onClick={() => onChartOpen(signal)} title={`View ${sym.label} chart`} type="button">
          <strong>{sym.label}</strong>
          {sym.detail && <span style={{ opacity: 0.55, fontSize: "0.74em", marginLeft: 5 }}>{sym.detail}</span>}
          <span className="coin-chart-icon">{isStock ? "📊" : "📈"}</span>
        </button>
        <div style={{ marginTop: 6 }}>
          <button className="button button-ghost" onClick={() => onExplain(signal)} style={{ minHeight: 22, padding: "2px 8px", fontSize: "0.72rem" }} type="button">
            Why?
          </button>
        </div>
      </td>
      <td><span className={`pill ${sideClass(signal.side)}`}>{signal.side}</span></td>
      <td>{signal.timeframe}</td>
      <td>{formatPrice(signal.entry)}</td>
      <td>
        <strong>{formatPrice(signal.livePrice ?? signal.closePrice)}</strong>
        {Number.isFinite(Number(signal.signalMovePercent)) ? (
          <div>
            <span className={`pill ${Number(signal.signalMovePercent) >= 0 ? "pill-success" : "pill-danger"}`}>
              {formatSignedPct(signal.signalMovePercent)}
            </span>
          </div>
        ) : null}
      </td>
      <td>{formatPrice(signal.stopLoss)}</td>
      <td>{formatPrice(signal.tp1)}</td>
      <td>{formatPrice(signal.tp2)}</td>
      <td>{formatPrice(signal.tp3)}</td>
      <td><ConfBadge confidence={signal.confidence} /></td>
      <td><LeverageBadge leverage={signal.leverage ?? signal.indicatorSnapshot?.leverage} /></td>
      <td><span className={`pill ${statusClass(signal.status, signal.result)}`}>{signal.result || signal.status}</span></td>
      <td>{formatDate(signal.createdAt)}</td>
    </tr>
  );
}

export default function SignalTable({ compact = false, emptyLabel, signals }) {
  const [chartCoin, setChartCoin] = useState(null);
  const [chartTf, setChartTf] = useState("15m");
  const [chartSignal, setChartSignal] = useState(null);
  const [tvSignal, setTvSignal] = useState(null);
  const [visibleCount, setVisibleCount] = useState(compact ? 40 : 60);
  const [explainSignal, setExplainSignal] = useState(null);

  const visibleSignals = useMemo(() => signals.slice(0, visibleCount), [signals, visibleCount]);
  const hasMore = signals.length > visibleCount;

  function openChart(signal) {
    if (signal.source === "SMART_ENGINE" && !signal.scanMeta?.instrument?.token) {
      setTvSignal(signal);
    } else {
      setChartSignal(signal);
      setChartCoin(signal.coin);
      setChartTf(signal.timeframe || "15m");
    }
  }

  return (
    <>
      <div className="signal-view-mobile">
        {signals.length ? (
          <>
            <div className="signal-cards">
              {visibleSignals.map((s) => <SignalCard key={s.id} signal={s} onChartOpen={openChart} onExplain={setExplainSignal} />)}
            </div>
            {hasMore ? (
              <div style={{ textAlign: "center", marginTop: 12 }}>
                <button className="button button-ghost" onClick={() => setVisibleCount((c) => c + 40)} type="button">
                  Load More ({visibleCount}/{signals.length})
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state" style={{ padding: "20px 0", textAlign: "center" }}>{emptyLabel}</div>
        )}
      </div>

      <div className="signal-view-desktop">
        <div className="table-card">
          <div className="table-wrap">
            <table className={`signal-table${compact ? " signal-table-compact" : ""}`}>
              <thead>
                <tr>
                  <th>Coin</th><th>Side</th><th>TF</th><th>Entry</th>
                  <th>Live Price</th><th>SL</th><th>TP1</th><th>TP2</th><th>TP3</th>
                  <th>Confidence</th><th>Leverage</th><th>Status</th><th>Created</th>
                </tr>
              </thead>
              <tbody>
                {visibleSignals.length ? (
                  visibleSignals.map((s) => <TableRow key={s.id} signal={s} onChartOpen={openChart} onExplain={setExplainSignal} />)
                ) : (
                  <tr><td className="empty-row" colSpan={13}>{emptyLabel}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {hasMore ? (
            <div style={{ textAlign: "center", padding: "10px 0 2px" }}>
              <button className="button button-ghost" onClick={() => setVisibleCount((c) => c + 60)} type="button">
                Load More ({visibleCount}/{signals.length})
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {explainSignal ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,0.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="panel" style={{ width: "min(860px, 95vw)", maxHeight: "85vh", overflow: "auto" }}>
            <div className="panel-header">
              <div>
                <span className="eyebrow">Explainability</span>
                <h2>{explainSignal.coin} • {explainSignal.side} • {explainSignal.timeframe}</h2>
              </div>
              <button className="button button-ghost" onClick={() => setExplainSignal(null)} type="button">Close</button>
            </div>
            {(() => {
              const data = buildExplainability(explainSignal);
              return (
                <div className="section-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                  <article className="panel" style={{ margin: 0 }}>
                    <div className="panel-header"><div><span className="eyebrow">Signal</span><h2>Confirmations</h2></div></div>
                    <div className="list-stack">
                      {data.confirmations.length ? data.confirmations.map((c, idx) => <div className="list-card" key={idx}><strong>{c}</strong></div>) : <div className="empty-state">No confirmations captured.</div>}
                    </div>
                  </article>
                  <article className="panel" style={{ margin: 0 }}>
                    <div className="panel-header"><div><span className="eyebrow">Engine</span><h2>Quality Guards</h2></div></div>
                    <div className="list-stack">
                      {data.qualityReasons.map((r, idx) => <div className="list-card" key={`q_${idx}`}><strong>{r}</strong></div>)}
                      {data.selfLearningReasons.map((r, idx) => <div className="list-card" key={`s_${idx}`}><strong>self-learning: {r}</strong></div>)}
                      {data.localAiReasons.map((r, idx) => <div className="list-card" key={`l_${idx}`}><strong>local-ai: {r}</strong></div>)}
                      {!data.qualityReasons.length && !data.selfLearningReasons.length && !data.localAiReasons.length ? <div className="empty-state">No guard reasons attached.</div> : null}
                    </div>
                  </article>
                  <article className="panel" style={{ margin: 0, gridColumn: "1 / -1" }}>
                    <div className="panel-header"><div><span className="eyebrow">Context</span><h2>Indicator Snapshot</h2></div></div>
                    <div className="detail-grid">
                      {data.context.map((item) => (
                        <div key={item.label}>
                          <span className="detail-label">{item.label}</span>
                          <strong>{String(item.value)}</strong>
                        </div>
                      ))}
                    </div>
                  </article>
                </div>
              );
            })()}
          </div>
        </div>
      ) : null}

      {chartCoin ? (
        <CandlestickChart
          coin={chartCoin}
          timeframe={chartTf}
          signal={chartSignal || signals.find((s) => s.coin === chartCoin && s.timeframe === chartTf) || null}
          onClose={() => { setChartCoin(null); setChartSignal(null); }}
        />
      ) : null}

      {tvSignal ? (
        <TradingViewModal
          coin={tvSignal.coin || tvSignal.scanMeta?.instrument?.tradingSymbol || ""}
          timeframe={tvSignal.timeframe || "15m"}
          tradingSymbol={tvSignal.scanMeta?.instrument?.tradingSymbol}
          exchange={tvSignal.scanMeta?.instrument?.exchange}
          onClose={() => setTvSignal(null)}
        />
      ) : null}
    </>
  );
}
