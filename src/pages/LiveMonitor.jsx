import { useEffect, useRef, useState } from "react";
import AppShell from "../components/AppShell";
import TradingViewModal from "../components/TradingViewModal";
import { apiFetch } from "../lib/api";

function formatPrice(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "n/a";
  if (Math.abs(amount) >= 1000) {
    return amount.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }
  if (Math.abs(amount) >= 1) return amount.toFixed(4);
  if (Math.abs(amount) >= 0.0001) return amount.toFixed(6);
  return amount.toFixed(8);
}

function formatSignedPercent(value, digits = 2) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "n/a";
  const prefix = amount > 0 ? "+" : "";
  return `${prefix}${amount.toFixed(digits)}%`;
}

function signalTone(signal) {
  const text = String(signal || "").toUpperCase();
  if (text.includes("LONG") || text === "BULLISH") return "pill-success";
  if (text.includes("SHORT") || text === "BEARISH") return "pill-danger";
  if (text.startsWith("WATCH")) return "pill-neutral";
  return "pill-warning";
}

function metricTone(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return amount >= 0 ? "trend-up" : "trend-down";
}

function shouldAlert(item) {
  return Boolean(item?.guidance?.shouldTrade) && String(item?.strength || "").toUpperCase() === "STRONG";
}

function playAlertTone() {
  if (typeof window === "undefined") return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;

  try {
    const audio = new AudioCtx();
    const now = audio.currentTime;
    const notes = [740, 880, 1046];

    notes.forEach((frequency, index) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.06, now + index * 0.08 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.08 + 0.16);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(now + index * 0.08);
      osc.stop(now + index * 0.08 + 0.18);
    });

    window.setTimeout(() => {
      audio.close().catch(() => {});
    }, 600);
  } catch {}
}

export default function LiveMonitor() {
  const [data, setData] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chartCoin, setChartCoin] = useState(null);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [permission, setPermission] = useState(() => {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  });
  const [lastAlertText, setLastAlertText] = useState("");
  const [viewMode, setViewMode] = useState("all");
  const activeAlertKeysRef = useRef(new Set());

  useEffect(() => {
    let active = true;

    async function loadLiveTrend() {
      try {
        const res = await apiFetch("/signals/live-trend-scanner?limit=24");
        if (!active) return;
        const nextData = res?.trends || [];
        setData(nextData);
        setMeta({ summary: res?.summary || null, recorder: res?.recorder || null, performance: res?.performance || null });
        setError("");

        const nextKeys = new Set();
        for (const item of nextData.filter(shouldAlert)) {
          const key = `${item.symbol}|${item.signal}`;
          nextKeys.add(key);
          if (!activeAlertKeysRef.current.has(key) && alertsEnabled) {
            const text = `${item.symbol} ${item.signal.replaceAll("_", " ")} | ${item.guidance?.action || "Review trade"} | 2m ${formatSignedPercent(item.change2m, 3)}`;
            setLastAlertText(text);
            if (soundEnabled) playAlertTone();
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              try {
                new Notification(`FTAS Live Monitor: ${item.signal.replaceAll("_", " ")}`, {
                  body: text,
                  icon: "/vite.svg",
                  tag: `live-monitor-${item.symbol}`,
                });
              } catch {}
            }
          }
        }
        activeAlertKeysRef.current = nextKeys;
      } catch (e) {
        if (!active) return;
        setError(e.message || "Failed to load live monitor");
        setData([]);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadLiveTrend();
    const id = window.setInterval(loadLiveTrend, 15_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [alertsEnabled, soundEnabled]);

  const visibleData = data.filter((item) => {
    if (viewMode === "watch") return String(item.signal || "").toUpperCase() === "WATCH";
    if (viewMode === "action") return Boolean(item.guidance?.shouldTrade);
    return true;
  });

  async function enableDesktopAlerts() {
    if (typeof Notification === "undefined") {
      setPermission("unsupported");
      return;
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
    } catch {
      setPermission("denied");
    }
  }

  return (
    <AppShell
      title="Live Monitor"
      subtitle="Live Binance futures recorder with short-term trend signals"
    >
      {error ? <div className="banner banner-error">{error}</div> : null}

      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Recorder state</span>
          <strong>{meta?.recorder?.running ? "Running" : loading ? "Loading" : "Idle"}</strong>
          <span className="metric-meta">Refresh every 15 seconds</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Tracked pairs</span>
          <strong>{meta?.recorder?.universeSize ?? 0}</strong>
          <span className="metric-meta">Spread-aware Binance perpetual activity</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Actionable setups</span>
          <strong>{meta?.summary?.actionable ?? 0}</strong>
          <span className="metric-meta">Server-side guidance {meta?.recorder?.guidanceVersion || "v2"}</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Live win rate</span>
          <strong>{meta?.performance?.overall?.winRate ?? 0}%</strong>
          <span className="metric-meta">{meta?.performance?.overall?.total ?? 0} evaluated live recommendations</span>
        </article>
      </section>

      <section className="panel live-trend-panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Live recorder</span>
            <h2>Binance trend scanner</h2>
          </div>
          <span className="pill pill-neutral">
            {loading ? "Recording..." : `${meta?.recorder?.historyWindowMinutes || 0}m memory`}
          </span>
        </div>

        <div className="live-monitor-controls">
          <button className={`button ${viewMode === "all" ? "button-primary" : "button-ghost"}`} onClick={() => setViewMode("all")} type="button">All Signals</button>
          <button className={`button ${viewMode === "watch" ? "button-secondary" : "button-ghost"}`} onClick={() => setViewMode("watch")} type="button">Watch</button>
          <button className={`button ${viewMode === "action" ? "button-secondary" : "button-ghost"}`} onClick={() => setViewMode("action")} type="button">Actionable</button>
          <button className={`button ${alertsEnabled ? "button-primary" : "button-ghost"}`} onClick={() => setAlertsEnabled((value) => !value)} type="button">{alertsEnabled ? "Alerts On" : "Alerts Off"}</button>
          <button className={`button ${soundEnabled ? "button-secondary" : "button-ghost"}`} onClick={() => setSoundEnabled((value) => !value)} type="button">{soundEnabled ? "Sound On" : "Sound Off"}</button>
          <button className="button button-ghost" onClick={enableDesktopAlerts} type="button">{permission === "granted" ? "Desktop Allowed" : permission === "denied" ? "Desktop Blocked" : permission === "unsupported" ? "Desktop Unsupported" : "Enable Desktop Alerts"}</button>
        </div>

        {lastAlertText ? <div className="banner banner-success">Latest alert: {lastAlertText}</div> : null}

        <div className="live-trend-summary">
          <article className="live-trend-stat">
            <span>Recorder pace</span>
            <strong>{Math.round((meta?.recorder?.sampleIntervalMs || 0) / 1000)}s</strong>
            <small>{meta?.recorder?.lastSampleAt ? `Updated ${new Date(meta.recorder.lastSampleAt).toLocaleTimeString("en-IN")}` : "Waiting for first sample"}</small>
          </article>
          <article className="live-trend-stat">
            <span>Watchlist count</span>
            <strong>{meta?.summary?.watch ?? 0}</strong>
            <small>Mixed pairs or incomplete history. No trade until structure clears.</small>
          </article>
          <article className="live-trend-stat">
            <span>Recorder status</span>
            <strong>{meta?.recorder?.lastError ? "Attention" : "Healthy"}</strong>
            <small>{meta?.recorder?.lastError || "Sampling Binance market data continuously"}</small>
          </article>
        </div>

        <div className="table-wrap">
          <table className="signal-table signal-table-compact live-trend-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Signal</th>
                <th>Kya Karein</th>
                <th>Score</th>
                <th>30s</th>
                <th>2m</th>
                <th>5m</th>
                <th>24h</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {visibleData.length ? visibleData.map((item) => (
                <tr key={item.symbol}>
                  <td>
                    <div className="live-trend-symbol-cell">
                      <button className="coin-chart-btn" onClick={() => setChartCoin(item.symbol)} type="button">
                        <strong>{item.symbol}</strong>
                      </button>
                      <span>{formatPrice(item.price)}</span>
                      <small>{item.spreadBps !== null ? `Spread ${item.spreadBps} bps` : "Spread n/a"}</small>
                    </div>
                  </td>
                  <td>
                    <div className="live-trend-signal-stack">
                      <span className={`pill ${signalTone(item.signal)}`}>{item.signal.replaceAll("_", " ")}</span>
                      <small>{item.strength}</small>
                    </div>
                  </td>
                  <td>
                    <div className="live-trend-score-stack">
                      <strong>{item.guidance?.action || "Wait"}</strong>
                      <small>{item.guidance?.plan || item.note}</small>
                    </div>
                  </td>
                  <td>
                    <div className="live-trend-score-stack">
                      <strong className={metricTone(item.momentumScore)}>{formatSignedPercent(item.momentumScore)}</strong>
                      <small>{item.note}</small>
                    </div>
                  </td>
                  <td className={metricTone(item.change30s)}>{formatSignedPercent(item.change30s, 3)}</td>
                  <td className={metricTone(item.change2m)}>{formatSignedPercent(item.change2m, 3)}</td>
                  <td className={metricTone(item.change5m)}>{formatSignedPercent(item.change5m, 3)}</td>
                  <td>
                    <span className={`pill ${Number(item.priceChangePercent24h) >= 0 ? "pill-success" : "pill-danger"}`}>{formatSignedPercent(item.priceChangePercent24h)}</span>
                  </td>
                  <td>{`${Math.max(1, Math.round(item.recordedSeconds / 60))}m / ${item.recordedPoints} pts`}</td>
                </tr>
              )) : (
                <tr>
                  <td className="empty-row" colSpan="9">{loading ? "Recording live Binance data..." : viewMode === "watch" ? "No watch signals right now." : viewMode === "action" ? "No actionable signals right now." : "No recorder data yet."}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {chartCoin ? <TradingViewModal coin={chartCoin} timeframe="15m" onClose={() => setChartCoin(null)} /> : null}
    </AppShell>
  );
}
