import { useCallback, useEffect, useState } from "react";
import AppShell from "../components/AppShell";
import { apiFetch } from "../lib/api";
import { useSession } from "../context/useSession";
import { Navigate } from "react-router-dom";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10000) return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1)     return n.toFixed(4);
  if (Math.abs(n) >= 0.001) return n.toFixed(6);
  return n.toFixed(8);
}

function formatSymbol(signal) {
  const coin = String(signal.coin || "").toUpperCase();
  if (coin.endsWith("USDT")) return coin.replace("USDT", "/USDT");
  const tradingSymbol = signal.scanMeta?.instrument?.tradingSymbol;
  return tradingSymbol || coin;
}

function isStock(signal) {
  // Stock signals either have source=SMART_ENGINE OR coin doesn't end with USDT
  if (signal.source === "SMART_ENGINE") return true;
  const coin = String(signal.coin || "").toUpperCase();
  if (coin.endsWith("USDT")) return false;
  // Has exchange info = stock
  if (signal.scanMeta?.instrument?.exchange) return true;
  // No USDT suffix and not a known crypto pattern = treat as stock
  return !coin.match(/^[A-Z]{2,10}USDT$/);
}

function getMarketEmoji(signal) {
  if (isStock(signal)) return "🇮🇳";
  return "💹";
}

function getMarketLabel(signal) {
  if (!isStock(signal)) return "Binance Futures";
  const exchange = signal.scanMeta?.instrument?.exchange
    || signal.indicatorSnapshot?.exchange;
  if (exchange) return exchange;
  return "NSE/BSE";
}

function getSideEmoji(side) {
  return side === "LONG" ? "🟢" : "🔴";
}

function getConfidenceBar(conf) {
  const n = Number(conf);
  if (n >= 90) return "🔥🔥🔥";
  if (n >= 80) return "🔥🔥";
  if (n >= 70) return "🔥";
  return "⚡";
}

function nowIST() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── Post Templates ───────────────────────────────────────────────────────────
function generateWhatsAppPost(signals, includeFooter) {
  if (!signals.length) return "No active signals right now.";

  const header = [
    "━━━━━━━━━━━━━━━━━━━━━━",
    "📡 *FTAS TRADING SIGNALS*",
    `🕐 ${nowIST()} IST`,
    "━━━━━━━━━━━━━━━━━━━━━━",
    "",
  ].join("\n");

  const body = signals.map((s, i) => {
    const sym    = formatSymbol(s);
    const market = getMarketLabel(s);
    const lines  = [
      `${getSideEmoji(s.side)} *Signal ${i + 1} — ${sym}*`,
      ``,
      `📌 *Type:* ${s.side} ${s.timeframe.toUpperCase()}`,
      `🏛️ *Market:* ${getMarketEmoji(s)} ${market}`,
      ``,
      `💰 *Entry:* ${formatPrice(s.entry)}`,
      `🛡️ *Stop Loss:* ${formatPrice(s.stopLoss)}`,
      ``,
      `🎯 *Targets:*`,
      `  TP1 → ${formatPrice(s.tp1)}`,
      `  TP2 → ${formatPrice(s.tp2)}`,
      `  TP3 → ${formatPrice(s.tp3)}`,
      ``,
      `📊 *Confidence:* ${s.confidence}% ${getConfidenceBar(s.confidence)}`,
      s.leverage ? `⚡ *Leverage:* ${s.leverage}x` : "",
      s.confirmations?.length
        ? `\n✅ *Reasons:*\n${s.confirmations.slice(0, 3).map(c => `  • ${c}`).join("\n")}`
        : "",
    ].filter(Boolean).join("\n");
    return lines;
  }).join("\n\n" + "─".repeat(22) + "\n\n");

  const footer = includeFooter ? [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "⚠️ *Disclaimer:* These are algorithmic signals. Always manage risk. DYOR.",
    "",
    "📲 Join our channel:",
    "https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c",
    "",
    "📘 Follow us:",
    "https://facebook.com/Ftas.trading.network",
    "━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n") : "";

  return header + body + footer;
}

function generateFacebookPost(signals, includeFooter) {
  if (!signals.length) return "No active signals right now.";

  const header = [
    "📡 FTAS TRADING SIGNALS",
    `🕐 ${nowIST()} IST`,
    "─────────────────────────",
    "",
  ].join("\n");

  const body = signals.map((s, i) => {
    const sym    = formatSymbol(s);
    const market = `${getMarketEmoji(s)} ${getMarketLabel(s)}`;
    return [
      `${getSideEmoji(s.side)} Signal ${i + 1} | ${sym} | ${s.side} ${s.timeframe.toUpperCase()}`,
      `Market: ${market}`,
      `Entry: ${formatPrice(s.entry)} | SL: ${formatPrice(s.stopLoss)}`,
      `TP1: ${formatPrice(s.tp1)} | TP2: ${formatPrice(s.tp2)} | TP3: ${formatPrice(s.tp3)}`,
      `Confidence: ${s.confidence}% ${getConfidenceBar(s.confidence)}${s.leverage ? ` | Leverage: ${s.leverage}x` : ""}`,
      s.confirmations?.length
        ? `Signals: ${s.confirmations.slice(0, 2).join(" • ")}`
        : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n─────────────────────────\n\n");

  const footer = includeFooter ? [
    "",
    "─────────────────────────",
    "⚠️ Disclaimer: Algorithmic signals only. Always manage your risk. DYOR.",
    "",
    "📲 WhatsApp Channel: https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c",
    "📘 Facebook: https://facebook.com/Ftas.trading.network",
    "",
    "#Trading #Signals #FTAS #Crypto #StockMarket #NSE #Forex",
  ].join("\n") : "";

  return header + body + footer;
}

// ─── Copy button ──────────────────────────────────────────────────────────────
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };
  return (
    <button
      onClick={copy}
      type="button"
      style={{
        background: copied ? "rgba(43,212,143,0.2)" : "rgba(255,255,255,0.08)",
        border: `1px solid ${copied ? "rgba(43,212,143,0.4)" : "rgba(255,255,255,0.12)"}`,
        borderRadius: 8, color: copied ? "#2bd48f" : "#e2e8f0",
        cursor: "pointer", fontSize: 13, fontWeight: 700,
        padding: "8px 18px", transition: "all 0.2s",
      }}
    >
      {copied ? "✅ Copied!" : "📋 Copy"}
    </button>
  );
}

// ─── Signal selector checkbox ─────────────────────────────────────────────────
function SignalCheckbox({ signal, checked, onChange }) {
  const sym = formatSymbol(signal);
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 10, cursor: "pointer",
      background: checked ? "rgba(99,102,241,0.12)" : "rgba(255,255,255,0.03)",
      border: `1px solid ${checked ? "rgba(99,102,241,0.35)" : "rgba(255,255,255,0.07)"}`,
      transition: "all 0.15s",
    }}>
      <input
        type="checkbox" checked={checked} onChange={onChange}
        style={{ width: 16, height: 16, cursor: "pointer", accentColor: "#818cf8" }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{sym}</span>
          <span className={`pill ${signal.side === "LONG" ? "pill-success" : "pill-danger"}`} style={{ fontSize: 10 }}>
            {signal.side}
          </span>
          <span style={{ background: "rgba(124,106,255,0.2)", color: "#c4b5fd", borderRadius: 4, fontSize: 10, fontWeight: 700, padding: "2px 6px" }}>
            {signal.timeframe}
          </span>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>{signal.confidence}% conf</span>
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
          Entry {formatPrice(signal.entry)} · SL {formatPrice(signal.stopLoss)} · TP1 {formatPrice(signal.tp1)}
        </div>
      </div>
      <span style={{ fontSize: 18 }}>{getMarketEmoji(signal)}</span>
    </label>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function PostGenerator() {
  const { user } = useSession();

  // Redirect non-admins
  if (user && user.role !== "ADMIN") return <Navigate replace to="/dashboard" />;

  const [cryptoSignals, setCryptoSignals] = useState([]);
  const [stockSignals, setStockSignals]   = useState([]);
  const [loading, setLoading]             = useState(true);
  const [selected, setSelected]           = useState(new Set());
  const [platform, setPlatform]           = useState("whatsapp"); // "whatsapp" | "facebook"
  const [includeFooter, setIncludeFooter] = useState(true);
  const [customNote, setCustomNote]       = useState("");
  const [lastRefresh, setLastRefresh]     = useState(null);

  const loadSignals = useCallback(async () => {
    setLoading(true);
    try {
      const [cryptoRes, stockRes] = await Promise.allSettled([
        apiFetch("/signals/active?limit=50"),
        apiFetch("/stocks/active?limit=50"),
      ]);
      const crypto = cryptoRes.status === "fulfilled" ? (cryptoRes.value.signals || []) : [];
      const stocks = stockRes.status  === "fulfilled" ? (stockRes.value.signals  || []) : [];
      setCryptoSignals(crypto);
      setStockSignals(stocks);
      setLastRefresh(new Date());
      // Auto-select all on first load
      setSelected(prev => {
        if (prev.size === 0) {
          const allIds = new Set([...crypto, ...stocks].map(s => s.id));
          return allIds;
        }
        return prev;
      });
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadSignals(); }, [loadSignals]);

  const allSignals    = [...cryptoSignals, ...stockSignals];
  const selectedSigs  = allSignals.filter(s => selected.has(s.id))
    .sort((a, b) => Number(b.confidence) - Number(a.confidence));

  const toggleSignal = (id) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectAll   = () => setSelected(new Set(allSignals.map(s => s.id)));
  const selectNone  = () => setSelected(new Set());
  const selectTop   = (n) => setSelected(new Set(
    [...allSignals].sort((a, b) => Number(b.confidence) - Number(a.confidence)).slice(0, n).map(s => s.id)
  ));

  const rawPost = platform === "whatsapp"
    ? generateWhatsAppPost(selectedSigs, includeFooter)
    : generateFacebookPost(selectedSigs, includeFooter);

  const finalPost = customNote.trim()
    ? rawPost + "\n\n" + customNote.trim()
    : rawPost;

  return (
    <AppShell title="Post Generator" subtitle="Generate ready-to-paste trading signal posts for WhatsApp & Facebook">
      <style>{`
        .post-textarea {
          background: rgba(5,10,20,0.9);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          color: #e2e8f0;
          font-family: "SF Mono", "Fira Code", monospace;
          font-size: 13px;
          line-height: 1.7;
          min-height: 320px;
          padding: 16px;
          resize: vertical;
          width: 100%;
          outline: none;
        }
        .post-textarea:focus { border-color: rgba(99,102,241,0.5); box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }
        .platform-tab { padding: 9px 20px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 700; transition: all 0.15s; }
        .platform-tab.active { transform: none; }
      `}</style>

      <div style={{ display: "grid", gap: 20 }}>

        {/* ── Top controls ── */}
        <section className="panel" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {/* Platform tabs */}
            <button
              className={`platform-tab${platform === "whatsapp" ? " active" : ""}`}
              onClick={() => setPlatform("whatsapp")}
              type="button"
              style={{
                background: platform === "whatsapp" ? "linear-gradient(135deg,#25d366,#128c7e)" : "rgba(255,255,255,0.06)",
                color: platform === "whatsapp" ? "#fff" : "#94a3b8",
                boxShadow: platform === "whatsapp" ? "0 4px 14px rgba(37,211,102,0.3)" : "none",
              }}
            >
              💬 WhatsApp
            </button>
            <button
              className={`platform-tab${platform === "facebook" ? " active" : ""}`}
              onClick={() => setPlatform("facebook")}
              type="button"
              style={{
                background: platform === "facebook" ? "linear-gradient(135deg,#1877f2,#0d65d9)" : "rgba(255,255,255,0.06)",
                color: platform === "facebook" ? "#fff" : "#94a3b8",
                boxShadow: platform === "facebook" ? "0 4px 14px rgba(24,119,242,0.3)" : "none",
              }}
            >
              📘 Facebook
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#94a3b8", cursor: "pointer" }}>
              <input type="checkbox" checked={includeFooter} onChange={e => setIncludeFooter(e.target.checked)} style={{ accentColor: "#818cf8" }} />
              Include footer & links
            </label>
            <button onClick={loadSignals} disabled={loading} type="button" className="button button-ghost" style={{ fontSize: 12, minHeight: 36 }}>
              {loading ? "⏳" : "🔄"} Refresh
            </button>
          </div>
        </section>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 20 }}>

          {/* ── LEFT: Signal Picker ── */}
          <section className="panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="panel-header">
              <div>
                <span className="eyebrow">Step 1</span>
                <h2>Pick Signals</h2>
                <p style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
                  {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}` : "Loading..."}
                </p>
              </div>
              <span className="pill pill-accent">{selectedSigs.length} selected</span>
            </div>

            {/* Quick select buttons */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[
                { label: "All",    action: selectAll },
                { label: "None",   action: selectNone },
                { label: "Top 3",  action: () => selectTop(3) },
                { label: "Top 5",  action: () => selectTop(5) },
              ].map(({ label, action }) => (
                <button key={label} onClick={action} type="button" style={{
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.09)",
                  borderRadius: 6, color: "#e2e8f0", cursor: "pointer", fontSize: 12,
                  fontWeight: 600, padding: "4px 12px",
                }}>{label}</button>
              ))}
            </div>

            {/* Signal list */}
            {loading ? (
              <div style={{ textAlign: "center", padding: "30px 0", color: "#64748b" }}>⏳ Loading signals...</div>
            ) : allSignals.length === 0 ? (
              <div style={{ textAlign: "center", padding: "30px 0", color: "#64748b" }}>
                No active signals right now. Engine is scanning...
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 480, overflowY: "auto" }}>
                {cryptoSignals.length > 0 && (
                  <p style={{ fontSize: 11, fontWeight: 700, color: "#64748b", letterSpacing: "0.1em", textTransform: "uppercase", margin: "4px 0 2px" }}>
                    💹 Crypto ({cryptoSignals.length})
                  </p>
                )}
                {cryptoSignals.map(s => (
                  <SignalCheckbox key={s.id} signal={s} checked={selected.has(s.id)} onChange={() => toggleSignal(s.id)} />
                ))}
                {stockSignals.length > 0 && (
                  <p style={{ fontSize: 11, fontWeight: 700, color: "#64748b", letterSpacing: "0.1em", textTransform: "uppercase", margin: "8px 0 2px" }}>
                    🇮🇳 Stocks ({stockSignals.length})
                  </p>
                )}
                {stockSignals.map(s => (
                  <SignalCheckbox key={s.id} signal={s} checked={selected.has(s.id)} onChange={() => toggleSignal(s.id)} />
                ))}
              </div>
            )}
          </section>

          {/* ── RIGHT: Generated Post ── */}
          <section className="panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="panel-header">
              <div>
                <span className="eyebrow">Step 2</span>
                <h2>Generated Post</h2>
                <p style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
                  {platform === "whatsapp" ? "Ready for WhatsApp — bold text supported" : "Ready for Facebook — hashtags included"}
                </p>
              </div>
              <CopyButton text={finalPost} />
            </div>

            {/* Custom note */}
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 6 }}>
                Add custom note (optional — appended at bottom)
              </label>
              <input
                type="text"
                value={customNote}
                onChange={e => setCustomNote(e.target.value)}
                placeholder="e.g. Market looks bullish today, trade safe 🎯"
                style={{
                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)",
                  borderRadius: 8, color: "#e2e8f0", fontSize: 13, outline: "none",
                  padding: "8px 12px", width: "100%",
                }}
              />
            </div>

            {/* Post preview */}
            <textarea
              className="post-textarea"
              value={selectedSigs.length === 0 ? "← Select at least one signal from the left panel." : finalPost}
              readOnly
            />

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <CopyButton text={finalPost} />
              {platform === "whatsapp" ? (
                <a
                  href={`https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c`}
                  target="_blank" rel="noopener noreferrer"
                  className="button"
                  style={{ background: "linear-gradient(135deg,#25d366,#128c7e)", color: "#fff", minHeight: 36, fontSize: 13 }}
                >
                  Open WhatsApp Channel ↗
                </a>
              ) : (
                <a
                  href="https://www.facebook.com/Ftas.trading.network"
                  target="_blank" rel="noopener noreferrer"
                  className="button"
                  style={{ background: "linear-gradient(135deg,#1877f2,#0d65d9)", color: "#fff", minHeight: 36, fontSize: 13 }}
                >
                  Open Facebook Page ↗
                </a>
              )}
            </div>

            {/* Character count */}
            <p style={{ fontSize: 11, color: "#475569", textAlign: "right" }}>
              {finalPost.length.toLocaleString()} characters
              {platform === "whatsapp" && finalPost.length > 4096 && (
                <span style={{ color: "#f87171", marginLeft: 8 }}>⚠️ WhatsApp limit is 4096 chars — trim signals</span>
              )}
            </p>
          </section>
        </div>

        {/* ── Preview card ── */}
        {selectedSigs.length > 0 && (
          <section className="panel" style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="panel-header">
              <div><span className="eyebrow">Preview</span><h2>Signal Summary</h2></div>
              <span className="pill pill-neutral">{selectedSigs.length} signals</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
              {selectedSigs.map(s => (
                <div key={s.id} style={{
                  background: s.side === "LONG" ? "rgba(43,212,143,0.07)" : "rgba(255,85,119,0.07)",
                  border: `1px solid ${s.side === "LONG" ? "rgba(43,212,143,0.2)" : "rgba(255,85,119,0.2)"}`,
                  borderRadius: 10, padding: "10px 14px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <strong style={{ fontSize: 14 }}>{formatSymbol(s)}</strong>
                    <span className={`pill ${s.side === "LONG" ? "pill-success" : "pill-danger"}`} style={{ fontSize: 10 }}>{s.side}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#94a3b8", display: "grid", gap: 2 }}>
                    <span>Entry: {formatPrice(s.entry)}</span>
                    <span>SL: {formatPrice(s.stopLoss)}</span>
                    <span>TP1: {formatPrice(s.tp1)}</span>
                    <span style={{ color: s.confidence >= 85 ? "#2bd48f" : "#fbbf24", fontWeight: 700 }}>
                      {getConfidenceBar(s.confidence)} {s.confidence}% confidence
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
