import { useCallback, useEffect, useState } from "react";
import AppShell from "../components/AppShell";
import { apiFetch } from "../lib/api";
import { useSession } from "../context/useSession";
import { usePushNotifications } from "../lib/usePushNotifications";

// ─── Section wrapper ──────────────────────────────────────────────────────────
function Section({ title, eyebrow, children, accent }) {
  return (
    <section className="panel" style={accent ? {
      background: `linear-gradient(135deg, ${accent}15 0%, transparent 60%)`,
      border: `1px solid ${accent}30`,
    } : {}}>
      <div className="panel-header">
        <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
      </div>
      {children}
    </section>
  );
}

// ─── Toggle switch ────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        width: 44, height: 24, borderRadius: 12, border: "none", cursor: disabled ? "not-allowed" : "pointer",
        background: checked ? "#2bd48f" : "rgba(255,255,255,0.12)",
        position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}
    >
      <span style={{
        position: "absolute", top: 3, left: checked ? 23 : 3,
        width: 18, height: 18, borderRadius: "50%", background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
      }} />
    </button>
  );
}

// ─── Price Alert form ─────────────────────────────────────────────────────────
function PriceAlertForm({ onAdded }) {
  const [coin, setCoin]         = useState("BTCUSDT");
  const [condition, setCondition] = useState("above");
  const [price, setPrice]       = useState("");
  const [note, setNote]         = useState("");
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const res = await apiFetch("/price-alerts", { method: "POST", body: { coin, condition, price: Number(price), note } });
      onAdded(res.alert);
      setPrice(""); setNote("");
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
          Coin
          <input value={coin} onChange={e => setCoin(e.target.value.toUpperCase())}
            placeholder="BTCUSDT" style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
          Condition
          <select value={condition} onChange={e => setCondition(e.target.value)} style={inputStyle}>
            <option value="above">📈 Price goes above</option>
            <option value="below">📉 Price drops below</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
          Price
          <input type="number" value={price} onChange={e => setPrice(e.target.value)}
            placeholder="e.g. 95000" style={inputStyle} required />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
        <input value={note} onChange={e => setNote(e.target.value)}
          placeholder="Optional note (e.g. resistance level)" style={inputStyle} />
        <button type="submit" disabled={busy || !price} className="button button-primary" style={{ fontSize: 13, minHeight: 40 }}>
          {busy ? "Adding..." : "+ Add Alert"}
        </button>
      </div>
      {err && <p style={{ color: "#f87171", fontSize: 12 }}>{err}</p>}
    </form>
  );
}

const inputStyle = {
  background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8, color: "#e2e8f0", fontSize: 13, outline: "none", padding: "8px 12px",
};

// ─── Main Settings Page ───────────────────────────────────────────────────────
export default function Settings() {
  const { user, logout, refreshUser } = useSession();
  const isAdmin  = user?.role === "ADMIN";

  const { permission, subscribed, supported, loading: pushLoading, error: pushError, subscribe, unsubscribe } = usePushNotifications();
  const [pushConfig, setPushConfig] = useState({ loading: true, configured: true, message: "" });
  const [pushTestBusy, setPushTestBusy] = useState(false);
  const [pushTestMsg, setPushTestMsg] = useState("");

  // Price alerts
  const [alerts, setAlerts]       = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(true);

  // Telegram (admin)
  const [tgStatus, setTgStatus]   = useState(null);
  const [tgSettings, setTgSettings] = useState({ autoSend: false, minConfidence: 82 });
  const [tgBusy, setTgBusy]       = useState(false);
  const [tgMsg, setTgMsg]         = useState("");

  // Facebook (admin)
  const [fbStatus, setFbStatus]   = useState(null);
  const [fbBusy, setFbBusy]       = useState(false);
  const [fbMsg, setFbMsg]         = useState("");
  const [fbTokenForm, setFbTokenForm] = useState({ appId: "", appSecret: "", shortToken: "" });
  const [fbTokenResult, setFbTokenResult] = useState(null);

  // Engines (admin)
  const [cryptoEngine, setCryptoEngine] = useState(null);
  const [stockEngine, setStockEngine] = useState(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineMsg, setEngineMsg] = useState("");
  const [engineSettings, setEngineSettings] = useState(null);
  const [engineSettingsBusy, setEngineSettingsBusy] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState("");
  const [maintenanceMsg, setMaintenanceMsg] = useState("");

  // Risk preference (all users)
  const [riskDraft, setRiskDraft] = useState(user?.riskPreference || "BALANCED");
  const [riskBusy, setRiskBusy] = useState(false);
  const [riskMsg, setRiskMsg] = useState("");

  const checkPushConfig = useCallback(async () => {
    setPushConfig((prev) => ({ ...prev, loading: true }));
    try {
      await apiFetch("/notifications/vapid-public-key", { skipAuth: true });
      setPushConfig({ loading: false, configured: true, message: "" });
    } catch (e) {
      setPushConfig({ loading: false, configured: false, message: e.message || "Push notifications not configured" });
    }
  }, []);

  const sendTestPush = useCallback(async () => {
    setPushTestBusy(true);
    setPushTestMsg("");
    try {
      await apiFetch("/notifications/test", {
        method: "POST",
        body: { title: "FTAS Test", body: "Push notifications are working!" },
      });
      setPushTestMsg("✅ Test push sent. Check your notification tray.");
    } catch (e) {
      setPushTestMsg(`❌ ${e.message}`);
    } finally {
      setPushTestBusy(false);
      setTimeout(() => setPushTestMsg(""), 5000);
    }
  }, []);

  useEffect(() => {
    checkPushConfig();
  }, [checkPushConfig]);

  const loadAlerts = useCallback(async () => {
    setAlertsLoading(true);
    try {
      const res = await apiFetch("/price-alerts");
      setAlerts(res.alerts || []);
    } catch {} finally { setAlertsLoading(false); }
  }, []);

  const loadTelegram = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await apiFetch("/telegram/status");
      setTgStatus(res);
      if (res.settings) setTgSettings(res.settings);
    } catch {}
  }, [isAdmin]);

  const loadFacebook = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await apiFetch("/facebook/status");
      setFbStatus(res);
    } catch {}
  }, [isAdmin]);

  const loadEngines = useCallback(async () => {
    if (!isAdmin) return;
    const [cryptoRes, stockRes] = await Promise.allSettled([
      apiFetch("/signals/engine/status"),
      apiFetch("/stocks/engine/status"),
    ]);
    setCryptoEngine(cryptoRes.status === "fulfilled" ? cryptoRes.value.engine : null);
    setStockEngine(stockRes.status === "fulfilled" ? stockRes.value.engine : null);
  }, [isAdmin]);

  const loadEngineSettings = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await apiFetch("/settings/engines");
      setEngineSettings(res);
    } catch {}
  }, [isAdmin]);

  useEffect(() => {
    loadAlerts();
    loadTelegram();
    loadFacebook();
    loadEngines();
    loadEngineSettings();
  }, [loadAlerts, loadTelegram, loadFacebook, loadEngines, loadEngineSettings]);

  useEffect(() => {
    setRiskDraft(user?.riskPreference || "BALANCED");
  }, [user?.riskPreference]);

  const bothEnginesRunning = Boolean(cryptoEngine?.running) && Boolean(stockEngine?.running);

  const toggleEngines = async () => {
    if (!isAdmin) return;
    setEngineBusy(true);
    setEngineMsg("");
    try {
      if (bothEnginesRunning) {
        await Promise.all([
          apiFetch("/signals/engine/stop", { method: "POST" }),
          apiFetch("/stocks/engine/stop", { method: "POST" }),
        ]);
        setEngineMsg("✅ Both engines stopped");
      } else {
        await Promise.all([
          apiFetch("/signals/engine/start", { method: "POST" }),
          apiFetch("/stocks/engine/start", { method: "POST" }),
        ]);
        setEngineMsg("✅ Both engines started");
      }
      await loadEngines();
    } catch (e) {
      setEngineMsg(`❌ ${e.message}`);
    } finally {
      setEngineBusy(false);
      setTimeout(() => setEngineMsg(""), 4000);
    }
  };

  const autoStartEnabled = Boolean(engineSettings?.effective?.autoStartCrypto) && Boolean(engineSettings?.effective?.autoStartStock);
  const envOverrideActive = engineSettings?.sources && (engineSettings.sources.envCrypto !== null || engineSettings.sources.envStock !== null);

  const saveEngineAutoStart = async (enabled) => {
    if (!isAdmin) return;
    setEngineSettingsBusy(true);
    try {
      await apiFetch("/settings/engines", {
        method: "POST",
        body: { autoStartCrypto: enabled, autoStartStock: enabled },
      });
      await loadEngineSettings();
    } catch (e) {
      setEngineMsg(`❌ ${e.message}`);
      setTimeout(() => setEngineMsg(""), 4000);
    } finally {
      setEngineSettingsBusy(false);
    }
  };

  const saveRiskPreference = async () => {
    setRiskBusy(true);
    setRiskMsg("");
    try {
      await apiFetch("/auth/me", { method: "PATCH", body: { riskPreference: riskDraft } });
      await refreshUser();
      setRiskMsg("✅ Risk preference updated");
    } catch (e) {
      setRiskMsg(`❌ ${e.message}`);
    } finally {
      setRiskBusy(false);
      setTimeout(() => setRiskMsg(""), 4000);
    }
  };

  const runArchiveAction = async (key, url, action) => {
    setMaintenanceBusy(key);
    setMaintenanceMsg("");
    try {
      const res = await apiFetch(url, { method: "POST", body: { action } });
      if (action === "ARCHIVE_CLOSED") {
        setMaintenanceMsg(`✅ Archived ${res.archived || 0} signals. Archive size: ${res.archiveSize || 0}`);
      } else if (action === "CLEAR_ARCHIVE") {
        setMaintenanceMsg("✅ Archive cleared");
      } else if (action === "CLEAR_HISTORY") {
        setMaintenanceMsg(`✅ History cleared. Remaining: ${res.remaining ?? 0}`);
      } else {
        setMaintenanceMsg("✅ Done");
      }
    } catch (e) {
      setMaintenanceMsg(`❌ ${e.message}`);
    } finally {
      setMaintenanceBusy("");
      setTimeout(() => setMaintenanceMsg(""), 5000);
    }
  };

  const deleteAlert = async (id) => {
    await apiFetch(`/price-alerts/${id}`, { method: "DELETE" });
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  const saveTgSettings = async () => {
    setTgBusy(true);
    try {
      await apiFetch("/telegram/settings", { method: "POST", body: tgSettings });
      setTgMsg("✅ Settings saved");
    } catch (e) { setTgMsg(`❌ ${e.message}`); }
    finally { setTgBusy(false); setTimeout(() => setTgMsg(""), 3000); }
  };

  const testTelegram = async () => {
    setTgBusy(true);
    try {
      await apiFetch("/telegram/test", { method: "POST" });
      setTgMsg("✅ Test message sent to Telegram!");
    } catch (e) { setTgMsg(`❌ ${e.message}`); }
    finally { setTgBusy(false); setTimeout(() => setTgMsg(""), 4000); }
  };

  return (
    <AppShell title="Settings" subtitle="Notifications, alerts, and integrations">
      <div style={{ display: "grid", gap: 16 }}>

        {/* ── Push Notifications ── */}
        <Section eyebrow="Browser" title="Push Notifications" accent="#2bd48f">
          {!supported ? (
            <div className="banner banner-warning">⚠️ {pushError || "Your browser doesn't support push notifications. Try Chrome or Firefox."}</div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <p style={{ fontWeight: 600, marginBottom: 4 }}>Signal Alerts</p>
                  <p style={{ fontSize: 13, color: "#64748b" }}>
                    Get notified instantly when a new trading signal is generated — even when the app is closed.
                  </p>
                </div>
                {permission !== "denied" && (
                  <Toggle
                    checked={subscribed}
                    onChange={subscribed ? unsubscribe : subscribe}
                    disabled={pushLoading || !pushConfig.configured}
                  />
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: pushConfig.configured ? "#22c55e" : "#f87171" }}>
                  {pushConfig.loading
                    ? "Checking push configuration..."
                    : pushConfig.configured
                      ? "✅ Push configured"
                      : `❌ ${pushConfig.message || "Push notifications not configured"}`}
                </span>
                {isAdmin && (
                  <>
                    <button
                      type="button"
                      onClick={checkPushConfig}
                      disabled={pushConfig.loading}
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.15)",
                        borderRadius: 8, padding: "6px 12px",
                        color: "#e2e8f0", fontSize: 12, cursor: pushConfig.loading ? "not-allowed" : "pointer",
                      }}
                    >
                      {pushConfig.loading ? "Checking..." : "Check Status"}
                    </button>
                    <button
                      type="button"
                      onClick={sendTestPush}
                      disabled={!pushConfig.configured || pushTestBusy}
                      style={{
                        background: "linear-gradient(135deg,#22c55e,#16a34a)",
                        border: "none", borderRadius: 8, padding: "6px 12px",
                        color: "#fff", fontSize: 12, fontWeight: 700,
                        cursor: (!pushConfig.configured || pushTestBusy) ? "not-allowed" : "pointer",
                        opacity: (!pushConfig.configured || pushTestBusy) ? 0.6 : 1,
                      }}
                    >
                      {pushTestBusy ? "Sending..." : "Send Test Push"}
                    </button>
                  </>
                )}
              </div>

              {pushTestMsg && <p style={{ fontSize: 12, color: pushTestMsg.startsWith("✅") ? "#22c55e" : "#f87171" }}>{pushTestMsg}</p>}

              {/* Blocked — show step by step fix */}
              {permission === "denied" && (
                <div style={{
                  background: "rgba(255,85,119,0.08)",
                  border: "1px solid rgba(255,85,119,0.25)",
                  borderRadius: 12, padding: 16,
                }}>
                  <p style={{ color: "#ff5577", fontWeight: 700, marginBottom: 10, fontSize: 14 }}>
                    🚫 Notifications Blocked
                  </p>
                  <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
                    You need to allow notifications in your browser settings. Follow these steps:
                  </p>

                  {/* Android Chrome steps */}
                  <div style={{ display: "grid", gap: 8 }}>
                    {[
                      { step: "1", text: "Tap the 🔒 lock icon in the address bar (top of Chrome)" },
                      { step: "2", text: "Tap \"Permissions\" or \"Site settings\"" },
                      { step: "3", text: "Tap \"Notifications\"" },
                      { step: "4", text: "Select \"Allow\"" },
                      { step: "5", text: "Come back here and toggle ON" },
                    ].map(({ step, text }) => (
                      <div key={step} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <span style={{
                          background: "rgba(255,85,119,0.2)", borderRadius: "50%",
                          color: "#ff5577", fontSize: 11, fontWeight: 800,
                          flexShrink: 0, height: 22, width: 22,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>{step}</span>
                        <span style={{ fontSize: 13, color: "#cbd5e1", paddingTop: 2 }}>{text}</span>
                      </div>
                    ))}
                  </div>

                  {/* Direct settings link for Chrome Android */}
                  <a
                    href="chrome://settings/content/notifications"
                    style={{
                      display: "block", marginTop: 14, textAlign: "center",
                      background: "rgba(255,85,119,0.15)",
                      border: "1px solid rgba(255,85,119,0.3)",
                      borderRadius: 8, color: "#ff5577",
                      fontSize: 13, fontWeight: 700, padding: "8px 14px",
                      textDecoration: "none",
                    }}
                  >
                    Open Chrome Notification Settings ↗
                  </a>
                </div>
              )}

              {permission === "default" && !subscribed && (
                <div className="banner banner-warning" style={{ fontSize: 13 }}>
                  👆 Tap the toggle above to enable notifications. Your browser will ask for permission.
                </div>
              )}
              {subscribed && (
                <div className="banner banner-success">✅ Push notifications active — you'll receive signal alerts instantly!</div>
              )}
              {pushLoading && (
                <p style={{ color: "#64748b", fontSize: 13 }}>⏳ Processing...</p>
              )}
              {pushError && <p style={{ color: "#f87171", fontSize: 13 }}>{pushError}</p>}
            </div>
          )}
        </Section>

        {/* ── Price Alerts ── */}
        <Section eyebrow="Alerts" title="Price Alerts" accent="#fbbf24">
          <p style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
            Set price thresholds — get a push notification when a coin crosses your target price.
          </p>

          <PriceAlertForm onAdded={(alert) => setAlerts(prev => [alert, ...prev])} />

          <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
            {alertsLoading ? (
              <p style={{ color: "#64748b", fontSize: 13 }}>Loading alerts...</p>
            ) : alerts.length === 0 ? (
              <p style={{ color: "#64748b", fontSize: 13 }}>No alerts set yet. Add one above.</p>
            ) : (
              alerts.map(a => (
                <div key={a.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                  background: a.triggered ? "rgba(43,212,143,0.06)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${a.triggered ? "rgba(43,212,143,0.2)" : "rgba(255,255,255,0.07)"}`,
                  borderRadius: 10, padding: "10px 14px",
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13 }}>{a.coin}</strong>
                      <span style={{ fontSize: 12, color: a.condition === "above" ? "#2bd48f" : "#f87171" }}>
                        {a.condition === "above" ? "📈 above" : "📉 below"} {a.price.toLocaleString()}
                      </span>
                      {a.triggered && <span className="pill pill-success" style={{ fontSize: 10 }}>✅ Triggered</span>}
                    </div>
                    {a.note && <p style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>{a.note}</p>}
                  </div>
                  {!a.triggered && (
                    <button onClick={() => deleteAlert(a.id)} type="button" style={{
                      background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.2)",
                      borderRadius: 6, color: "#f87171", cursor: "pointer", fontSize: 11, padding: "4px 10px",
                    }}>Remove</button>
                  )}
                </div>
              ))
            )}
          </div>
        </Section>

        {/* ── Risk Preference ── */}
        <Section eyebrow="Signals" title="Risk Profile" accent="#8b5cf6">
          <div style={{ display: "grid", gap: 12 }}>
            <p style={{ fontSize: 13, color: "#64748b" }}>
              Choose how strict signal filtering should be. Higher risk = more signals, lower win-rate. Conservative = fewer, higher quality.
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              <label style={{ fontSize: 12, color: "#64748b", display: "block" }}>
                Risk profile
              </label>
              <select value={riskDraft} onChange={(e) => setRiskDraft(e.target.value)} style={inputStyle}>
                <option value="AGGRESSIVE">Aggressive (more signals)</option>
                <option value="BALANCED">Balanced (default)</option>
                <option value="CONSERVATIVE">Conservative (higher win-rate)</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" className="button button-primary" onClick={saveRiskPreference} disabled={riskBusy}>
                {riskBusy ? "Saving..." : "Save Preference"}
              </button>
              <span style={{ fontSize: 12, color: "#64748b" }}>
                Current: <strong style={{ color: "#e2e8f0" }}>{user?.riskPreference || "BALANCED"}</strong>
              </span>
            </div>
            {riskMsg && <p style={{ fontSize: 13, color: riskMsg.startsWith("✅") ? "#2bd48f" : "#f87171" }}>{riskMsg}</p>}
          </div>
        </Section>

        {/* ── Engines (Admin only) ── */}
        {isAdmin && (
          <Section eyebrow="Admin" title="Engines" accent="#f59e0b">
            <div className="detail-grid">
              <div><span className="detail-label">Crypto engine</span><strong>{cryptoEngine?.running ? "LIVE" : "OFF"}</strong></div>
              <div><span className="detail-label">Crypto scans</span><strong>{cryptoEngine?.scanCount || 0}</strong></div>
              <div><span className="detail-label">Crypto last scan</span><strong>{cryptoEngine?.lastScanAt ? new Date(cryptoEngine.lastScanAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</strong></div>
              <div><span className="detail-label">Stock engine</span><strong>{stockEngine?.running ? "LIVE" : "OFF"}</strong></div>
              <div><span className="detail-label">Stock scans</span><strong>{stockEngine?.scanCount || 0}</strong></div>
              <div><span className="detail-label">Stock last scan</span><strong>{stockEngine?.lastScanAt ? new Date(stockEngine.lastScanAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</strong></div>
            </div>
            <div className="button-row" style={{ flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="button button-primary"
                disabled={engineBusy}
                onClick={toggleEngines}
              >
                {engineBusy ? "Working..." : bothEnginesRunning ? "Stop Both Engines" : "Start Both Engines"}
              </button>
              <button type="button" className="button button-ghost" onClick={loadEngines} disabled={engineBusy}>
                Refresh Status
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
              <div>
                <p style={{ fontWeight: 600, marginBottom: 4 }}>Auto-start on server boot</p>
                <p style={{ fontSize: 13, color: "#64748b" }}>
                  Server restart ke baad dono engines automatic start honge.
                </p>
              </div>
              <Toggle
                checked={autoStartEnabled}
                onChange={(v) => saveEngineAutoStart(v)}
                disabled={engineSettingsBusy}
              />
            </div>
            <p className="panel-note" style={{ marginTop: 10 }}>
              Engines run automatically on interval after start. Auto-start on server boot can be enabled with{" "}
              <code>AUTO_START_ENGINE=true</code> and <code>AUTO_START_STOCK_ENGINE=true</code>.
            </p>
            {envOverrideActive && (
              <p className="panel-note" style={{ marginTop: 6, color: "#fbbf24" }}>
                Env override active — Auto-start toggle may not take effect until env vars are cleared.
              </p>
            )}
            {engineMsg && <p style={{ fontSize: 13, color: engineMsg.startsWith("✅") ? "#2bd48f" : "#f87171" }}>{engineMsg}</p>}
          </Section>
        )}

        {/* ── Data Maintenance (Admin only) ── */}
        {isAdmin && (
          <Section eyebrow="Admin" title="Data Maintenance" accent="#ef4444">
            <p className="panel-note">
              Archive moves closed signals to a separate file so pages load faster. Active signals remain untouched.
            </p>
            <div className="section-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
              <div className="panel" style={{ margin: 0 }}>
                <div className="panel-header">
                  <div><span className="eyebrow">Crypto</span><h2>Signal Archive</h2></div>
                </div>
                <div className="button-row" style={{ flexWrap: "wrap", gap: 8 }}>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={maintenanceBusy === "crypto-archive"}
                    onClick={() => runArchiveAction("crypto-archive", "/signals/archive", "ARCHIVE_CLOSED")}
                  >
                    {maintenanceBusy === "crypto-archive" ? "Working..." : "Archive Closed Signals"}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={maintenanceBusy === "crypto-expired-archive"}
                    onClick={() => runArchiveAction("crypto-expired-archive", "/signals/archive", "ARCHIVE_EXPIRED")}
                  >
                    {maintenanceBusy === "crypto-expired-archive" ? "Working..." : "Archive Expired Signals"}
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={maintenanceBusy === "crypto-clear"}
                    onClick={() => runArchiveAction("crypto-clear", "/signals/archive", "CLEAR_ARCHIVE")}
                  >
                    Clear Archive
                  </button>
                </div>
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <div className="panel-header">
                  <div><span className="eyebrow">Stocks</span><h2>Signal Archive</h2></div>
                </div>
                <div className="button-row" style={{ flexWrap: "wrap", gap: 8 }}>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={maintenanceBusy === "stock-archive"}
                    onClick={() => runArchiveAction("stock-archive", "/stocks/archive", "ARCHIVE_CLOSED")}
                  >
                    {maintenanceBusy === "stock-archive" ? "Working..." : "Archive Closed Signals"}
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={maintenanceBusy === "stock-clear"}
                    onClick={() => runArchiveAction("stock-clear", "/stocks/archive", "CLEAR_ARCHIVE")}
                  >
                    Clear Archive
                  </button>
                </div>
              </div>
            </div>
            {maintenanceMsg && <p style={{ fontSize: 13, color: maintenanceMsg.startsWith("✅") ? "#2bd48f" : "#f87171" }}>{maintenanceMsg}</p>}
          </Section>
        )}

        {/* ── Telegram (Admin only) ── */}
        {isAdmin && (
          <Section eyebrow="Integration" title="Telegram Bot" accent="#229ED9">
            {!tgStatus?.configured ? (
              <div>
                <div className="banner banner-warning" style={{ marginBottom: 14 }}>
                  ⚠️ Telegram bot not configured. Set these in Render environment variables:
                </div>
                <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: 14, fontFamily: "monospace", fontSize: 12, color: "#93c5fd" }}>
                  <div>TELEGRAM_BOT_TOKEN=<span style={{ color: "#fbbf24" }}>your-bot-token-from-@BotFather</span></div>
                  <div style={{ marginTop: 6 }}>TELEGRAM_CHANNEL_ID=<span style={{ color: "#fbbf24" }}>@your_channel or -100xxxxxxx</span></div>
                </div>
                <p style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
                  1. Message @BotFather on Telegram → /newbot → copy token<br/>
                  2. Add bot as admin to your channel<br/>
                  3. Set env vars above → redeploy Render
                </p>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                <div className="banner banner-success">
                  ✅ Bot connected: @{tgStatus.bot?.username}
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                  <div>
                    <p style={{ fontWeight: 600, marginBottom: 4 }}>Auto-send new signals</p>
                    <p style={{ fontSize: 13, color: "#64748b" }}>Automatically post signals to Telegram channel when generated</p>
                  </div>
                  <Toggle
                    checked={tgSettings.autoSend}
                    onChange={(v) => setTgSettings(s => ({ ...s, autoSend: v }))}
                  />
                </div>

                <div>
                  <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 6 }}>
                    Minimum confidence to auto-send: <strong style={{ color: "#e2e8f0" }}>{tgSettings.minConfidence}%</strong>
                  </label>
                  <input
                    type="range" min={70} max={95} step={1}
                    value={tgSettings.minConfidence}
                    onChange={e => setTgSettings(s => ({ ...s, minConfidence: Number(e.target.value) }))}
                    style={{ width: "100%", accentColor: "#229ED9" }}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b" }}>
                    <span>70% (more signals)</span><span>95% (fewer, higher quality)</span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={saveTgSettings} disabled={tgBusy} type="button" className="button button-primary" style={{ fontSize: 13 }}>
                    {tgBusy ? "Saving..." : "💾 Save Settings"}
                  </button>
                  <button onClick={testTelegram} disabled={tgBusy} type="button" className="button button-ghost" style={{ fontSize: 13 }}>
                    📤 Send Test Message
                  </button>
                </div>
                {tgMsg && <p style={{ fontSize: 13, color: tgMsg.startsWith("✅") ? "#2bd48f" : "#f87171" }}>{tgMsg}</p>}
              </div>
            )}
          </Section>
        )}

        {/* ── Facebook (Admin only) ── */}
        {isAdmin && (
          <Section eyebrow="Integration" title="Facebook Auto-Post" accent="#1877f2">
            {!fbStatus?.configured ? (
              <div style={{ display: "grid", gap: 14 }}>
                <div className="banner banner-warning">
                  ⚠️ Facebook not configured. Set these in Render environment variables:
                </div>
                <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: 14, fontFamily: "monospace", fontSize: 12, color: "#93c5fd" }}>
                  <div>FB_PAGE_ID=<span style={{ color: "#fbbf24" }}>your_numeric_page_id</span></div>
                  <div style={{ marginTop: 6 }}>FB_PAGE_ACCESS_TOKEN=<span style={{ color: "#fbbf24" }}>your_long_lived_page_token</span></div>
                  <div style={{ marginTop: 6 }}>FB_MIN_CONFIDENCE=<span style={{ color: "#fbbf24" }}>85</span></div>
                  <div style={{ marginTop: 6 }}>FB_AUTO_POST=<span style={{ color: "#fbbf24" }}>true</span></div>
                </div>

                {/* Token exchange helper */}
                <div style={{ borderTop: "1px solid rgba(255,255,255,0.07)", paddingTop: 14 }}>
                  <p style={{ fontWeight: 600, marginBottom: 8 }}>🔑 Get Long-Lived Page Token</p>
                  <p style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
                    Enter your App credentials and a short-lived user token — we'll exchange it for a long-lived page token automatically.
                  </p>
                  <div style={{ display: "grid", gap: 8 }}>
                    {[
                      ["App ID", "appId", "From developers.facebook.com → Your App"],
                      ["App Secret", "appSecret", "From App Dashboard → Settings → Basic"],
                      ["Short-lived User Token", "shortToken", "From Graph API Explorer → Generate Token"],
                    ].map(([label, key, placeholder]) => (
                      <label key={key} style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
                        {label}
                        <input
                          type={key === "appSecret" ? "password" : "text"}
                          value={fbTokenForm[key]}
                          onChange={e => setFbTokenForm(f => ({ ...f, [key]: e.target.value }))}
                          placeholder={placeholder}
                          style={inputStyle}
                        />
                      </label>
                    ))}
                    <button
                      type="button"
                      disabled={fbBusy || !fbTokenForm.appId || !fbTokenForm.appSecret || !fbTokenForm.shortToken}
                      onClick={async () => {
                        setFbBusy(true); setFbTokenResult(null);
                        try {
                          const res = await apiFetch("/facebook/exchange-token", { method: "POST", body: fbTokenForm });
                          setFbTokenResult(res);
                        } catch (e) { setFbMsg(`❌ ${e.message}`); }
                        finally { setFbBusy(false); }
                      }}
                      className="button button-primary"
                      style={{ fontSize: 13, justifySelf: "start" }}
                    >
                      {fbBusy ? "Exchanging..." : "🔄 Get Long-Lived Token"}
                    </button>
                  </div>

                  {fbTokenResult && (
                    <div style={{ marginTop: 14, background: "rgba(43,212,143,0.08)", border: "1px solid rgba(43,212,143,0.2)", borderRadius: 8, padding: 14 }}>
                      <p style={{ fontWeight: 700, color: "#2bd48f", marginBottom: 8 }}>✅ Token exchanged! Copy these to Render env vars:</p>
                      {fbTokenResult.pages?.map(p => (
                        <div key={p.id} style={{ marginBottom: 10 }}>
                          <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>📄 {p.name} (ID: {p.id})</p>
                          <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 6, padding: "8px 10px", fontFamily: "monospace", fontSize: 11, color: "#fbbf24", wordBreak: "break-all" }}>
                            FB_PAGE_ID={p.id}<br/>
                            FB_PAGE_ACCESS_TOKEN={p.accessToken}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {fbMsg && <p style={{ fontSize: 13, color: "#f87171", marginTop: 8 }}>{fbMsg}</p>}
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                <div className="banner banner-success">
                  ✅ Connected to: <strong>{fbStatus.page?.name}</strong>
                  {fbStatus.page?.fan_count ? ` · ${fbStatus.page.fan_count.toLocaleString()} followers` : ""}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
                    <span style={{ color: "#64748b", display: "block", marginBottom: 4, fontSize: 11 }}>AUTO-POST</span>
                    <strong style={{ color: fbStatus.autoPost ? "#2bd48f" : "#f87171" }}>
                      {fbStatus.autoPost ? "✅ Enabled" : "❌ Disabled"}
                    </strong>
                    <p style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Set FB_AUTO_POST=true in Render to enable</p>
                  </div>
                  <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
                    <span style={{ color: "#64748b", display: "block", marginBottom: 4, fontSize: 11 }}>MIN CONFIDENCE</span>
                    <strong>{fbStatus.minConf}%+</strong>
                    <p style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Set FB_MIN_CONFIDENCE=85 in Render</p>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button" disabled={fbBusy}
                    onClick={async () => {
                      setFbBusy(true); setFbMsg("");
                      try {
                        await apiFetch("/facebook/test", { method: "POST" });
                        setFbMsg("✅ Test post sent to Facebook page!");
                      } catch (e) { setFbMsg(`❌ ${e.message}`); }
                      finally { setFbBusy(false); setTimeout(() => setFbMsg(""), 5000); }
                    }}
                    className="button button-ghost" style={{ fontSize: 13 }}
                  >
                    📤 Send Test Post
                  </button>
                  <button
                    type="button" onClick={loadFacebook}
                    className="button button-ghost" style={{ fontSize: 13 }}
                  >
                    🔄 Refresh Status
                  </button>
                  <a
                    href="https://www.facebook.com/Ftas.trading.network"
                    target="_blank" rel="noopener noreferrer"
                    className="button button-ghost" style={{ fontSize: 13 }}
                  >
                    📘 Open Facebook Page ↗
                  </a>
                </div>
                {fbMsg && <p style={{ fontSize: 13, color: fbMsg.startsWith("✅") ? "#2bd48f" : "#f87171" }}>{fbMsg}</p>}
              </div>
            )}
          </Section>
        )}

        {/* ── Community links ── */}
        <Section eyebrow="Community" title="Follow FTAS">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <a href="https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c" target="_blank" rel="noopener noreferrer"
              style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(37,211,102,0.1)", border: "1px solid rgba(37,211,102,0.2)", borderRadius: 10, padding: "12px 14px", textDecoration: "none" }}>
              <span style={{ fontSize: 24 }}>💬</span>
              <div>
                <p style={{ fontWeight: 700, color: "#25d366", fontSize: 13 }}>WhatsApp Channel</p>
                <p style={{ fontSize: 12, color: "#64748b" }}>Signal alerts & updates</p>
              </div>
            </a>
            <a href="https://facebook.com/Ftas.trading.network" target="_blank" rel="noopener noreferrer"
              style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(24,119,242,0.1)", border: "1px solid rgba(24,119,242,0.2)", borderRadius: 10, padding: "12px 14px", textDecoration: "none" }}>
              <span style={{ fontSize: 24 }}>📘</span>
              <div>
                <p style={{ fontWeight: 700, color: "#1877f2", fontSize: 13 }}>Facebook Page</p>
                <p style={{ fontSize: 12, color: "#64748b" }}>Analysis & education</p>
              </div>
            </a>
          </div>
        </Section>

        {/* ── Account / Logout ── */}
        <section className="panel" style={{ border: "1px solid rgba(255,85,119,0.15)", background: "rgba(255,85,119,0.04)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <p style={{ fontWeight: 700, marginBottom: 3 }}>
                {user?.name || "FTAS Member"}
              </p>
              <p style={{ fontSize: 13, color: "#64748b" }}>{user?.email}</p>
              <p style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
                Plan: <strong style={{ color: "#e2e8f0" }}>{user?.plan || "FREE"}</strong>
                {" · "}
                Role: <strong style={{ color: user?.role === "ADMIN" ? "var(--c-accent)" : "#e2e8f0" }}>{user?.role || "USER"}</strong>
              </p>
            </div>
            <button
              onClick={logout}
              type="button"
              style={{
                alignItems: "center",
                background: "rgba(255,85,119,0.12)",
                border: "1px solid rgba(255,85,119,0.3)",
                borderRadius: 10,
                color: "#ff5577",
                cursor: "pointer",
                display: "flex",
                fontSize: 14,
                fontWeight: 700,
                gap: 8,
                padding: "10px 20px",
              }}
            >
              ⏻ Logout
            </button>
          </div>
        </section>

      </div>
    </AppShell>
  );
}
