import { useEffect, useRef, useState } from "react";
import AppShell from "../components/AppShell";
import TradingViewModal from "../components/TradingViewModal";
import { apiFetch } from "../lib/api";

function formatPrice(value) {
  const amount = Number(value || 0);
  if (Math.abs(amount) >= 1000) {
    return amount.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }
  if (Math.abs(amount) >= 1) return amount.toFixed(4);
  if (Math.abs(amount) >= 0.0001) return amount.toFixed(6);
  return amount.toFixed(8);
}

function formatSignedPercent(value, digits = 2) {
  const amount = Number(value || 0);
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

function shouldAlert(item) {
  const signal = String(item?.signal || "").toUpperCase();
  const strength = String(item?.strength || "").toUpperCase();
  return strength === "STRONG" && ["BREAKOUT_LONG", "BREAKOUT_SHORT", "REVERSAL_LONG", "REVERSAL_SHORT"].includes(signal);
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
  const seenAlertsRef = useRef(new Set());
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    let active = true;

    async function loadLiveTrend() {
      try {
        const res = await apiFetch("/signals/live-trend-scanner?limit=24");
        if (!active) return;
        const nextData = res?.trends || [];
        setData(nextData);
        setMeta({ summary: res?.summary || null, recorder: res?.recorder || null });
        setError("");

        const candidates = nextData.filter(shouldAlert);
        if (!bootstrappedRef.current) {
          candidates.forEach((item) => {
            seenAlertsRef.current.add(`${item.symbol}|${item.signal}|${item.updatedAt}`);
          });
          bootstrappedRef.current = true;
          return;
        }

        for (const item of candidates) {
          const key = `${item.symbol}|${item.signal}|${item.updatedAt}`;
          if (seenAlertsRef.current.has(key)) continue;
          seenAlertsRef.current.add(key);

          if (!alertsEnabled) continue;

          const text = `${item.symbol} ${item.signal.replaceAll("_", " ")} at ${formatPrice(item.price)} | 2m ${formatSignedPercent(item.change2m, 3)}`;
          setLastAlertText(text);

          if (soundEnabled) {
            playAlertTone();
          }

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
          <strong>{loading ? "Loading" : "Running"}</strong>
          <span className="metric-meta">Refresh every 15 seconds</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Tracked pairs</span>
          <strong>{meta?.recorder?.universeSize ?? 0}</strong>
          <span className="metric-meta">Top Binance perpetual activity</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Bullish / bearish</span>
          <strong>{`${meta?.summary?.bullish ?? 0} / ${meta?.summary?.bearish ?? 0}`}</strong>
          <span className="metric-meta">Direction from recorded snapshots</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Breakouts / reversals</span>
          <strong>{`${meta?.summary?.breakouts ?? 0} / ${meta?.summary?.reversals ?? 0}`}</strong>
          <span className="metric-meta">Fast trend triggers</span>
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
          <button className={`button ${alertsEnabled ? "button-primary" : "button-ghost"}`} onClick={() => setAlertsEnabled((value) => !value)} type="button">
            {alertsEnabled ? "Alerts On" : "Alerts Off"}
          </button>
          <button className={`button ${soundEnabled ? "button-secondary" : "button-ghost"}`} onClick={() => setSoundEnabled((value) => !value)} type="button">
            {soundEnabled ? "Sound On" : "Sound Off"}
          </button>
          <button className="button button-ghost" onClick={enableDesktopAlerts} type="button">
            {permission === "granted" ? "Desktop Allowed" : permission === "denied" ? "Desktop Blocked" : permission === "unsupported" ? "Desktop Unsupported" : "Enable Desktop Alerts"}
          </button>
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
            <small>Pairs that are still mixed and not directional yet</small>
          </article>
          <article className="live-trend-stat">
            <span>Recorder status</span>
            <strong>{meta?.recorder?.lastError ? "Attention" : "Healthy"}</strong>
            <small>{meta?.recorder?.lastError || "Sampling Binance market data normally"}</small>
          </article>
        </div>

        <div className="table-wrap">
          <table className="signal-table signal-table-compact live-trend-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Signal</th>
                <th>Score</th>
                <th>30s</th>
                <th>2m</th>
                <th>5m</th>
                <th>24h</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {data.length ? data.map((item) => (
                <tr key={item.symbol}>
                  <td>
                    <div className="live-trend-symbol-cell">
                      <button className="coin-chart-btn" onClick={() => setChartCoin(item.symbol)} type="button">
                        <strong>{item.symbol}</strong>
                      </button>
                      <span>{formatPrice(item.price)}</span>
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
                      <strong className={item.momentumScore >= 0 ? "trend-up" : "trend-down"}>{formatSignedPercent(item.momentumScore)}</strong>
                      <small>{item.note}</small>
                    </div>
                  </td>
                  <td className={item.change30s >= 0 ? "trend-up" : "trend-down"}>{formatSignedPercent(item.change30s, 3)}</td>
                  <td className={item.change2m >= 0 ? "trend-up" : "trend-down"}>{formatSignedPercent(item.change2m, 3)}</td>
                  <td className={item.change5m >= 0 ? "trend-up" : "trend-down"}>{formatSignedPercent(item.change5m, 3)}</td>
                  <td>
                    <span className={`pill ${item.priceChangePercent24h >= 0 ? "pill-success" : "pill-danger"}`}>{formatSignedPercent(item.priceChangePercent24h)}</span>
                  </td>
                  <td>{`${Math.max(1, Math.round(item.recordedSeconds / 60))}m / ${item.recordedPoints} pts`}</td>
                </tr>
              )) : (
                <tr>
                  <td className="empty-row" colSpan="8">{loading ? "Recording live Binance data..." : "No recorder data yet."}</td>
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
