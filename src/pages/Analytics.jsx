import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import { apiFetch } from "../lib/api";
import { useSession } from "../context/useSession";

// ─── Mini bar chart component ─────────────────────────────────────────────────
function BarChart({ data, colorFn, maxVal }) {
  const max = maxVal || Math.max(...data.map(d => d.value), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 80 }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <span style={{ fontSize: 9, color: "#64748b" }}>{d.value}</span>
          <div style={{
            width: "100%", borderRadius: "3px 3px 0 0",
            height: `${Math.max((d.value / max) * 70, 2)}px`,
            background: colorFn ? colorFn(d) : "rgba(99,102,241,0.6)",
            transition: "height 0.4s ease",
          }} />
          <span style={{ fontSize: 9, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", maxWidth: "100%", textAlign: "center" }}>
            {d.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Win rate ring ────────────────────────────────────────────────────────────
function WinRateRing({ rate, size = 100, strokeWidth = 10 }) {
  const r      = (size - strokeWidth) / 2;
  const circ   = 2 * Math.PI * r;
  const offset = circ - (rate / 100) * circ;
  const color  = rate >= 60 ? "#2bd48f" : rate >= 45 ? "#fbbf24" : "#f87171";
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeWidth} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color}
          strokeWidth={strokeWidth} strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" style={{ transition: "stroke-dashoffset 0.8s ease" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <strong style={{ fontSize: size * 0.22, color, letterSpacing: "-0.04em" }}>{rate}%</strong>
        <span style={{ fontSize: size * 0.1, color: "#64748b" }}>win rate</span>
      </div>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4,
    }}>
      <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      <strong style={{ fontSize: "1.6rem", letterSpacing: "-0.04em", color: color || "#e2e8f0" }}>{value}</strong>
      {sub && <span style={{ fontSize: 11, color: "#64748b" }}>{sub}</span>}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Analytics() {
  const { user } = useSession();
  if (user && user.role !== "ADMIN") return <Navigate replace to="/dashboard" />;

  const [cryptoPerf,  setCryptoPerf]  = useState(null);
  const [stockPerf,   setStockPerf]   = useState(null);
  const [cryptoStats, setCryptoStats] = useState(null);
  const [stockStats,  setStockStats]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("crypto");

  const load = useCallback(async () => {
    setLoading(true);
    const [cp, sp, co, so] = await Promise.allSettled([
      apiFetch("/signals/stats/performance"),
      apiFetch("/stocks/stats/performance"),
      apiFetch("/signals/stats/overview"),
      apiFetch("/stocks/stats/overview"),
    ]);
    if (cp.status === "fulfilled") setCryptoPerf(cp.value.performance);
    if (sp.status === "fulfilled") setStockPerf(sp.value.performance);
    if (co.status === "fulfilled") setCryptoStats(co.value.stats);
    if (so.status === "fulfilled") setStockStats(so.value.stats);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const perf  = tab === "crypto" ? cryptoPerf  : stockPerf;
  const stats = tab === "crypto" ? cryptoStats : stockStats;

  const tabBtn = (key, label, emoji) => (
    <button onClick={() => setTab(key)} type="button" style={{
      background: tab === key ? "rgba(99,102,241,0.25)" : "rgba(255,255,255,0.05)",
      border: `1px solid ${tab === key ? "rgba(99,102,241,0.4)" : "rgba(255,255,255,0.08)"}`,
      borderRadius: 8, color: tab === key ? "#818cf8" : "#94a3b8",
      cursor: "pointer", fontSize: 13, fontWeight: 700, padding: "8px 18px",
    }}>
      {emoji} {label}
    </button>
  );

  return (
    <AppShell title="Analytics" subtitle="Signal performance — Win/Loss tracker, timeframe breakdown, confidence analysis">
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        {tabBtn("crypto", "Crypto", "💹")}
        {tabBtn("stocks", "Stocks", "🇮🇳")}
        <button onClick={load} type="button" style={{
          marginLeft: "auto", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.09)",
          borderRadius: 8, color: "#94a3b8", cursor: "pointer", fontSize: 12, padding: "8px 14px",
        }}>🔄 Refresh</button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#64748b" }}>⏳ Loading analytics...</div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>

          {/* ── Overview stats ── */}
          <section className="panel">
            <div className="panel-header">
              <div><span className="eyebrow">Overview</span><h2>Performance Summary</h2></div>
              <span className="pill pill-neutral">{stats?.totalSignals ?? 0} total signals</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
              <WinRateRing rate={stats?.winRate ?? 0} size={110} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
                <StatCard label="Active"   value={stats?.activeSignals  ?? 0} color="#fbbf24" />
                <StatCard label="Wins ✅"  value={stats?.totalWins      ?? 0} color="#2bd48f" />
                <StatCard label="Losses ❌" value={stats?.totalLosses   ?? 0} color="#f87171" />
                <StatCard label="Expired"  value={stats?.expiredSignals ?? 0} color="#64748b" />
                <StatCard label="Resolved" value={stats?.closedSignals  ?? 0} />
                <StatCard label="Win Rate" value={`${stats?.winRate ?? 0}%`} color={stats?.winRate >= 60 ? "#2bd48f" : "#fbbf24"} />
              </div>
            </div>
          </section>

          {/* ── Timeframe breakdown ── */}
          {perf?.timeframeBreakdown?.length > 0 && (
            <section className="panel">
              <div className="panel-header"><div><span className="eyebrow">Breakdown</span><h2>By Timeframe</h2></div></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                {perf.timeframeBreakdown.map(tf => (
                  <div key={tf.label} style={{
                    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 10, padding: "12px 14px",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                      <strong style={{ fontSize: 15 }}>{tf.label}</strong>
                      <span style={{ fontSize: 12, color: tf.winRate >= 60 ? "#2bd48f" : tf.winRate >= 45 ? "#fbbf24" : "#f87171", fontWeight: 700 }}>
                        {tf.winRate}% win
                      </span>
                    </div>
                    {/* Win/Loss bar */}
                    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 4, height: 8, overflow: "hidden", marginBottom: 8 }}>
                      <div style={{
                        height: "100%", borderRadius: 4,
                        width: tf.total ? `${(tf.wins / tf.total) * 100}%` : "0%",
                        background: "linear-gradient(90deg, #2bd48f, #00e5a0)",
                        transition: "width 0.6s ease",
                      }} />
                    </div>
                    <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#64748b" }}>
                      <span style={{ color: "#2bd48f" }}>✅ {tf.wins}W</span>
                      <span style={{ color: "#f87171" }}>❌ {tf.losses}L</span>
                      <span>📊 {tf.total} total</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Confidence breakdown ── */}
          {perf?.confidenceBreakdown?.length > 0 && (
            <section className="panel">
              <div className="panel-header"><div><span className="eyebrow">Quality</span><h2>By Confidence Band</h2></div></div>
              <BarChart
                data={perf.confidenceBreakdown.map(c => ({ label: `${c.label}%`, value: c.total }))}
                colorFn={(d) => {
                  const item = perf.confidenceBreakdown.find(c => `${c.label}%` === d.label);
                  const wr = item?.winRate ?? 0;
                  return wr >= 60 ? "rgba(43,212,143,0.7)" : wr >= 45 ? "rgba(251,191,36,0.7)" : "rgba(248,113,113,0.7)";
                }}
              />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10, marginTop: 14 }}>
                {perf.confidenceBreakdown.map(c => (
                  <div key={c.label} style={{
                    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 8, padding: "10px 12px", fontSize: 13,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <strong>{c.label}% band</strong>
                      <span style={{ color: c.winRate >= 60 ? "#2bd48f" : "#fbbf24" }}>{c.winRate}%</span>
                    </div>
                    <span style={{ color: "#64748b", fontSize: 12 }}>{c.wins}W / {c.losses}L / {c.total} total</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Side breakdown ── */}
          {perf?.sideBreakdown?.length > 0 && (
            <section className="panel">
              <div className="panel-header"><div><span className="eyebrow">Direction</span><h2>LONG vs SHORT</h2></div></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {perf.sideBreakdown.map(s => (
                  <div key={s.label} style={{
                    background: s.label === "LONG" ? "rgba(43,212,143,0.07)" : "rgba(248,113,113,0.07)",
                    border: `1px solid ${s.label === "LONG" ? "rgba(43,212,143,0.2)" : "rgba(248,113,113,0.2)"}`,
                    borderRadius: 12, padding: "16px",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <strong style={{ fontSize: 16 }}>{s.label === "LONG" ? "🟢 LONG" : "🔴 SHORT"}</strong>
                      <span style={{ fontSize: 18, fontWeight: 800, color: s.label === "LONG" ? "#2bd48f" : "#f87171" }}>
                        {s.winRate}%
                      </span>
                    </div>
                    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 4, height: 6, overflow: "hidden", marginBottom: 8 }}>
                      <div style={{
                        height: "100%", borderRadius: 4,
                        width: s.total ? `${(s.wins / s.total) * 100}%` : "0%",
                        background: s.label === "LONG" ? "#2bd48f" : "#f87171",
                      }} />
                    </div>
                    <div style={{ display: "flex", gap: 10, fontSize: 12, color: "#64748b" }}>
                      <span>{s.wins}W</span><span>{s.losses}L</span><span>{s.total} total</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Recommendations ── */}
          {perf?.recommendations?.length > 0 && (
            <section className="panel" style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.2)" }}>
              <div className="panel-header"><div><span className="eyebrow">AI Insights</span><h2>Recommendations</h2></div></div>
              <div style={{ display: "grid", gap: 10 }}>
                {perf.recommendations.map((r, i) => (
                  <div key={i} style={{
                    background: "rgba(255,255,255,0.04)", borderRadius: 8,
                    padding: "10px 14px", fontSize: 13, color: "#c4b5fd",
                    borderLeft: "3px solid rgba(99,102,241,0.5)",
                  }}>
                    💡 {r}
                  </div>
                ))}
              </div>
            </section>
          )}

          {!perf && !loading && (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#64748b" }}>
              No performance data yet — signals need to close (TP/SL) before analytics appear.
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
