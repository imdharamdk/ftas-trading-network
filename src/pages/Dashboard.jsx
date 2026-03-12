import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "../components/AppShell";
import DistributionList from "../components/DistributionList";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";

const defaultPaymentForm = {
  amount: "",
  method: "UPI",
  notes: "",
  plan: "PRO",
  reference: "",
  screenshotUrl: "",
};

const defaultManualForm = {
  coin: "BTCUSDT",
  confidence: 80,
  entry: "",
  leverage: 10,
  side: "LONG",
  stopLoss: "",
  timeframe: "5m",
  tp1: "",
  tp2: "",
  tp3: "",
};

const fallbackPaymentSettings = {
  contactPerson: "+91 8679215898",
  paymentMethods: [
    { label: "UPI", value: "UPI" },
    { label: "Bank Transfer", value: "BANK" },
    { label: "Crypto", value: "CRYPTO" },
  ],
  plans: [
    { amountUsd: 25, code: "PRO", durationDays: 30, priceLabel: "$25/month" },
    { amountUsd: 99, code: "PREMIUM", durationDays: 180, priceLabel: "$99/6 months" },
  ],
};

const EXPIRY_PROMPT_STORAGE_KEY = "ftas_expiry_prompt_dismissed";

function addDaysToIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString();
}

function formatSubscriptionEndsAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(date);
}

function buildPlanUpdate(plan) {
  if (plan === "FREE_TRIAL") {
    return { plan, subscriptionEndsAt: addDaysToIso(7), subscriptionStatus: "ACTIVE" };
  }
  if (plan === "PRO" || plan === "PREMIUM") {
    return { plan, subscriptionEndsAt: addDaysToIso(plan === "PREMIUM" ? 180 : 30), subscriptionStatus: "ACTIVE" };
  }
  return { plan: "FREE", subscriptionEndsAt: null, subscriptionStatus: "INACTIVE" };
}

function hasActivePaidPlan(user) {
  return user?.subscriptionStatus === "ACTIVE" && ["PRO", "PREMIUM"].includes(user?.plan);
}

const FEATURES = [
  {
    icon: "📈",
    title: "Crypto Signals",
    desc: "Real-time Binance-powered signals for top crypto pairs — BTC, ETH, altcoins and more.",
    href: "/market",
    label: "View Crypto",
  },
  {
    icon: "🇮🇳",
    title: "Indian Stock Signals",
    desc: "NSE & BSE equity signals via Angel One SmartAPI — Nifty 500 stocks scanned every 10 min.",
    href: "/stocks",
    label: "View Stocks",
  },
  {
    icon: "⚡",
    title: "Auto Scanner",
    desc: "AI-powered engine continuously scans markets using EMA, RSI, MACD & ADX indicators.",
    href: null,
    label: null,
  },
  {
    icon: "🎯",
    title: "TP1 / TP2 / TP3 Targets",
    desc: "Every signal comes with three take-profit levels and a calculated stop-loss.",
    href: null,
    label: null,
  },
  {
    icon: "📊",
    title: "Commodities",
    desc: "MCX contracts — crude oil, gold, silver and bullion tracked via SmartAPI.",
    href: "/stocks",
    label: "View Commodities",
  },
  {
    icon: "🔔",
    title: "Live Confidence Score",
    desc: "Each signal has a confidence % based on multi-indicator confirmation strength.",
    href: null,
    label: null,
  },
];

export default function Dashboard() {
  const { refreshUser, user } = useSession();
  const isAdmin = user?.role === "ADMIN";
  const subscriptionExpiry = formatSubscriptionEndsAt(user?.subscriptionEndsAt);
  const subscriptionExpiryDate = user?.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
  const subscriptionExpiresSoon =
    !isAdmin &&
    subscriptionExpiryDate &&
    !Number.isNaN(subscriptionExpiryDate.getTime()) &&
    subscriptionExpiryDate.getTime() > Date.now() &&
    subscriptionExpiryDate.getTime() - Date.now() <= 3 * 24 * 60 * 60 * 1000;
  const [expiryPromptDismissed, setExpiryPromptDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(EXPIRY_PROMPT_STORAGE_KEY) === "1";
  });
  const [showExpiryPrompt, setShowExpiryPrompt] = useState(false);
  const paidPlanActive = hasActivePaidPlan(user);
  const [engine, setEngine] = useState(null);
  const [overview, setOverview] = useState(null);
  const [stockOverview, setStockOverview] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [myPayments, setMyPayments] = useState([]);
  const [pendingPayments, setPendingPayments] = useState([]);
  const [paymentSettings, setPaymentSettings] = useState(null);
  const [users, setUsers] = useState([]);
  const [paymentForm, setPaymentForm] = useState(defaultPaymentForm);
  const [manualForm, setManualForm] = useState(defaultManualForm);
  const [paymentMethodDraft, setPaymentMethodDraft] = useState("");
  const [editingMethod, setEditingMethod] = useState(null);
  const [editingMethodLabel, setEditingMethodLabel] = useState("");
  const [editingMethodValue, setEditingMethodValue] = useState("");
  const [contactDraft, setContactDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState("");

  const availablePaymentSettings = useMemo(() => paymentSettings || fallbackPaymentSettings, [paymentSettings]);
  const availablePaymentMethods = useMemo(() => availablePaymentSettings.paymentMethods || [], [availablePaymentSettings]);
  const availablePlans = useMemo(() => availablePaymentSettings.plans || [], [availablePaymentSettings]);
  const hasPendingPayment = useMemo(() => myPayments.some((p) => p.status === "PENDING"), [myPayments]);
  const shouldShowPaymentForm = !paidPlanActive && !hasPendingPayment;

  useEffect(() => {
    if (subscriptionExpiresSoon && !expiryPromptDismissed) setShowExpiryPrompt(true);
    else setShowExpiryPrompt(false);
  }, [subscriptionExpiresSoon, expiryPromptDismissed]);

  useEffect(() => {
    if (!availablePaymentSettings) return;
    setContactDraft((c) => c || availablePaymentSettings.contactPerson || "");
    setPaymentForm((c) => {
      const selectedPlan = availablePlans.find((p) => p.code === c.plan) || availablePlans[0];
      const selectedMethod = availablePaymentMethods.find((m) => m.value === c.method) || availablePaymentMethods[0];
      return { ...c, amount: c.amount || String(selectedPlan?.amountUsd || ""), method: selectedMethod?.value || c.method, plan: selectedPlan?.code || c.plan };
    });
  }, [availablePaymentMethods, availablePaymentSettings, availablePlans]);

  const loadPublicData = useCallback(async () => {
    const results = await Promise.allSettled([
      apiFetch("/signals/active?limit=200"),
      apiFetch("/signals/history?limit=500"),
      apiFetch("/stocks/active?limit=200"),
      apiFetch("/stocks/history?limit=500"),
      apiFetch("/signals/stats/analytics"),
      apiFetch("/signals/stats/performance"),
      apiFetch("/signals/engine/status"),
    ]);
    const [cryptoActiveRes, cryptoHistoryRes, stockActiveRes, stockHistoryRes, analyticsRes, performanceRes, engineRes] = results;

    // Crypto: same filter as Crypto.jsx — 1m/5m, non-SMART_ENGINE only
    const cryptoActive  = cryptoActiveRes.status  === "fulfilled" ? (cryptoActiveRes.value.signals  || []) : null;
    const cryptoHistory = cryptoHistoryRes.status === "fulfilled" ? (cryptoHistoryRes.value.signals || []) : null;
    if (cryptoActive !== null && cryptoHistory !== null) {
      const filteredActive  = cryptoActive.filter(s => s.source !== "SMART_ENGINE" && ["1m","5m"].includes(s.timeframe));
      const filteredHistory = cryptoHistory.filter(s => s.source !== "SMART_ENGINE" && ["1m","5m"].includes(s.timeframe));
      const expiredC  = filteredHistory.filter(s => s.result === "EXPIRED").length;
      const winsC     = filteredHistory.filter(s => ["TP1_HIT","TP2_HIT","TP3_HIT"].includes(s.result)).length;
      const lossesC   = filteredHistory.filter(s => s.result === "SL_HIT").length;
      const resolvedC = filteredHistory.length - expiredC;
      setOverview({
        activeSignals:     filteredActive.length,
        closedSignals:     resolvedC,
        expiredSignals:    expiredC,
        totalSignals:      filteredActive.length + filteredHistory.length,
        totalWins:         winsC,
        totalLosses:       lossesC,
        winRate:           resolvedC > 0 ? Number(((winsC / resolvedC) * 100).toFixed(1)) : 0,
        averageConfidence: filteredActive.length
          ? Number((filteredActive.reduce((s, x) => s + Number(x.confidence || 0), 0) / filteredActive.length).toFixed(1))
          : 0,
      });
    }

    // Stocks: same logic as Stocks.jsx — all stockSignals, no timeframe filter
    const stockActive  = stockActiveRes.status  === "fulfilled" ? (stockActiveRes.value.signals  || []) : null;
    const stockHistory = stockHistoryRes.status === "fulfilled" ? (stockHistoryRes.value.signals || []) : null;
    if (stockActive !== null && stockHistory !== null) {
      const expiredS  = stockHistory.filter(s => s.result === "EXPIRED").length;
      const winsS     = stockHistory.filter(s => ["TP1_HIT","TP2_HIT","TP3_HIT"].includes(s.result)).length;
      const lossesS   = stockHistory.filter(s => s.result === "SL_HIT").length;
      const resolvedS = stockHistory.length - expiredS;
      setStockOverview({
        activeSignals:     stockActive.length,
        closedSignals:     resolvedS,
        expiredSignals:    expiredS,
        totalSignals:      stockActive.length + stockHistory.length,
        totalWins:         winsS,
        totalLosses:       lossesS,
        winRate:           resolvedS > 0 ? Number(((winsS / resolvedS) * 100).toFixed(1)) : 0,
        averageConfidence: stockActive.length
          ? Number((stockActive.reduce((s, x) => s + Number(x.confidence || 0), 0) / stockActive.length).toFixed(1))
          : 0,
      });
    }

    if (analyticsRes.status === "fulfilled") setAnalytics(analyticsRes.value.analytics ?? null);
    if (performanceRes.status === "fulfilled") setPerformance(performanceRes.value.performance ?? null);
    if (engineRes.status === "fulfilled") setEngine(engineRes.value.engine ?? null);

    const rejected = results.find((r) => r.status === "rejected");
    return rejected ? rejected.reason : null;
  }, []);

  const loadPrivateData = useCallback(async () => {
    const privateRequests = [apiFetch("/payments/my"), apiFetch("/payments/settings")];
    if (isAdmin) {
      privateRequests.push(apiFetch("/payments/pending"));
      privateRequests.push(apiFetch("/auth/users"));
    }
    const results = await Promise.allSettled(privateRequests);
    const [myPaymentsResult, paymentSettingsResult, pendingPaymentsResult, usersResult] = results;
    setMyPayments(myPaymentsResult?.status === "fulfilled" ? myPaymentsResult.value.payments || [] : []);
    setPaymentSettings(paymentSettingsResult?.status === "fulfilled" ? paymentSettingsResult.value.settings || null : null);
    if (isAdmin) {
      setPendingPayments(pendingPaymentsResult?.status === "fulfilled" ? pendingPaymentsResult.value.payments || [] : []);
      setUsers(usersResult?.status === "fulfilled" ? usersResult.value.users || [] : []);
    } else {
      setPendingPayments([]);
      setUsers([]);
    }
    const rejected = results.find((r) => r.status === "rejected");
    return rejected ? rejected.reason : null;
  }, [isAdmin]);

  useEffect(() => {
    let active = true;
    async function loadData() {
      if (!active) return;
      try {
        const pubErr = await loadPublicData();
        if (!active) return;
        const privErr = await loadPrivateData();
        if (active) setError(pubErr?.message || privErr?.message || "");
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    // Initial load
    loadData();
    // Poll every 30 seconds for live updates
    const id = window.setInterval(loadData, 30000);
    // Also refresh instantly when user comes back to this tab
    function onVisible() {
      if (document.visibilityState === "visible" && active) loadData();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadPrivateData, loadPublicData]);

  async function refreshWithFeedback(msg) {
    setFeedback(msg);
    setTimeout(() => setFeedback(""), 4000);
    const pe = await loadPublicData();
    const pve = await loadPrivateData();
    setError(pe?.message || pve?.message || "");
    await refreshUser();
  }

  async function handlePaymentSubmit(event) {
    event.preventDefault();
    setActionBusy("payment");
    setError("");
    try {
      await apiFetch("/payments", { method: "POST", body: { ...paymentForm, amount: Number(paymentForm.amount) } });
      setPaymentForm(defaultPaymentForm);
      await refreshWithFeedback("Payment submitted for approval");
    } catch (e) { setError(e.message); } finally { setActionBusy(""); }
  }

  const handleDismissExpiryPrompt = useCallback(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(EXPIRY_PROMPT_STORAGE_KEY, "1");
    setExpiryPromptDismissed(true);
    setShowExpiryPrompt(false);
  }, []);

  const handleRenewPrompt = useCallback(() => {
    document.getElementById("plan-status-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    handleDismissExpiryPrompt();
  }, [handleDismissExpiryPrompt]);

  async function handlePaymentReview(paymentId, status) {
    setActionBusy(paymentId);
    setError("");
    try {
      await apiFetch(`/payments/${paymentId}/review`, { method: "PATCH", body: { status } });
      await refreshWithFeedback(`Payment ${status.toLowerCase()}`);
    } catch (e) { setError(e.message); } finally { setActionBusy(""); }
  }

  async function handleManualSignal(event) {
    event.preventDefault();
    setActionBusy("manual-signal");
    setError("");
    try {
      await apiFetch("/signals/manual", {
        method: "POST",
        body: {
          ...manualForm,
          confidence: Number(manualForm.confidence), entry: Number(manualForm.entry),
          leverage: Number(manualForm.leverage), stopLoss: Number(manualForm.stopLoss),
          tp1: Number(manualForm.tp1), tp2: Number(manualForm.tp2), tp3: Number(manualForm.tp3),
        },
      });
      setManualForm(defaultManualForm);
      await refreshWithFeedback("Manual signal posted");
    } catch (e) { setError(e.message); } finally { setActionBusy(""); }
  }

  async function handleUserUpdate(userId, updates) {
    setActionBusy(userId);
    setError("");
    try {
      await apiFetch(`/auth/users/${userId}`, { method: "PATCH", body: updates });
      await refreshWithFeedback("User updated");
    } catch (e) { setError(e.message); } finally { setActionBusy(""); }
  }

  async function handlePaymentSettingsUpdate(event) {
    event.preventDefault();
    setActionBusy("payment-settings");
    setError("");
    try {
      await apiFetch("/payments/settings", { method: "PATCH", body: { contactPerson: contactDraft } });
      await refreshWithFeedback("Payment contact updated");
    } catch (e) { setError(e.message); } finally { setActionBusy(""); }
  }

  async function handlePaymentMethodAdd(event) {
    event.preventDefault();
    setActionBusy("payment-method-add");
    setError("");
    try {
      await apiFetch("/payments/methods", { method: "POST", body: { label: paymentMethodDraft } });
      setPaymentMethodDraft("");
      await refreshWithFeedback("Payment method added");
    } catch (e) { setError(e.message); } finally { setActionBusy(""); }
  }

  async function handlePaymentMethodRemove(methodValue) {
    setActionBusy(`remove-${methodValue}`);
    setError("");
    try {
      await apiFetch(`/payments/methods/${methodValue}`, { method: "DELETE" });
      await refreshWithFeedback("Payment method removed");
    } catch (e) { setError(e.message); } finally { setActionBusy(""); }
  }

  const startPaymentMethodEdit = useCallback((method) => {
    setEditingMethod(method);
    setEditingMethodLabel(method.label);
    setEditingMethodValue(method.value);
  }, []);

  const cancelPaymentMethodEdit = useCallback(() => {
    setEditingMethod(null);
    setEditingMethodLabel("");
    setEditingMethodValue("");
  }, []);

  async function handlePaymentMethodEdit(event) {
    event.preventDefault();
    if (!editingMethod) return;
    setActionBusy("payment-method-edit");
    setError("");
    try {
      await apiFetch(`/payments/methods/${editingMethod.value}`, {
        method: "PATCH",
        body: { label: editingMethodLabel, value: editingMethodValue },
      });
      cancelPaymentMethodEdit();
      await refreshWithFeedback("Payment method updated");
    } catch (e) { setError(e.message); } finally { setActionBusy(""); }
  }

  async function handleEngineAction(action) {
    setActionBusy(action);
    setError("");
    try {
      if (action === "start") await apiFetch("/signals/engine/start", { method: "POST" });
      if (action === "stop")  await apiFetch("/signals/engine/stop",  { method: "POST" });
      if (action === "scan")  await apiFetch("/signals/scan",          { method: "POST" });
      await refreshWithFeedback(action === "start" ? "Scanner started" : action === "stop" ? "Scanner stopped" : "Scan completed");
    } catch (e) { setError(e.message); }
    finally { setActionBusy(""); }
  }

  const actions = (
    <button className="button button-ghost" onClick={() => refreshWithFeedback("Refreshed")} type="button">
      Refresh
    </button>
  );

  return (
    <AppShell
      actions={actions}
      subtitle="AI-powered signals for crypto, Indian equities, F&O and commodities — live 24/7."
      title="Dashboard"
    >
      {/* ── EXPIRY PROMPT ── */}
      {showExpiryPrompt ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 20, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
          <div className="panel" style={{ maxWidth: "400px", width: "100%", boxShadow: "0 20px 35px rgba(0,0,0,0.35)" }}>
            <div className="panel-header">
              <div><span className="eyebrow">Reminder</span><h2>Your plan is about to expire</h2></div>
            </div>
            <p className="panel-note">
              {subscriptionExpiry ? `Access ends ${subscriptionExpiry}. Renew now to keep signals active.` : "Your plan is ending soon. Renew to keep receiving live signals."}
            </p>
            <div className="button-row">
              <button className="button button-primary" onClick={handleRenewPrompt} type="button">Purchase / Renew</button>
              <button className="button button-ghost" onClick={handleDismissExpiryPrompt} type="button">Remind later</button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <div className="banner banner-error">{error}</div> : null}
      {feedback ? <div className="banner banner-success">{feedback}</div> : null}

      {/* ── HERO ABOUT SECTION ── */}
      <section className="panel" style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.15) 0%, rgba(16,185,129,0.08) 100%)", border: "1px solid rgba(99,102,241,0.3)" }}>
        <div style={{ display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "260px" }}>
            <span className="eyebrow">Fintech Automated Solutions</span>
            <h2 style={{ fontSize: "1.6rem", margin: "8px 0 12px" }}>Professional Trading Signals</h2>
            <p style={{ color: "var(--text-muted)", lineHeight: 1.7, marginBottom: "16px" }}>
              FTAS is an AI-powered signal provider covering <strong>crypto</strong>, <strong>Indian equities</strong>, <strong>F&amp;O</strong> and <strong>commodities</strong>. Our automated engine scans markets 24/7 using multi-indicator analysis — EMA, RSI, MACD, ADX — to deliver high-confidence entry and exit points.
            </p>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <a className="button button-primary" href="/market">Crypto Signals →</a>
              <a className="button button-secondary" href="/stocks">Indian Stocks →</a>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", minWidth: "220px" }}>
            {[
              {
                label: "Active Signals",
                value: (overview?.activeSignals ?? 0) + (stockOverview?.activeSignals ?? 0),
                meta: `${overview?.activeSignals ?? 0} crypto · ${stockOverview?.activeSignals ?? 0} stocks`,
              },
              {
                label: "💹 Crypto Win Rate",
                value: `${overview?.winRate ?? 0}%`,
                meta: `${overview?.totalWins ?? 0}W / ${overview?.totalLosses ?? 0}L · ${overview?.closedSignals ?? 0} resolved`,
              },
              {
                label: "🇮🇳 Stock Win Rate",
                value: `${stockOverview?.winRate ?? 0}%`,
                meta: `${stockOverview?.totalWins ?? 0}W / ${stockOverview?.totalLosses ?? 0}L · ${stockOverview?.closedSignals ?? 0} resolved`,
              },
              {
                label: "Your Plan",
                value: user?.plan || "FREE",
                meta: user?.subscriptionStatus || "INACTIVE",
              },
            ].map((stat) => (
              <div key={stat.label} className="metric-card" style={{ margin: 0 }}>
                <span className="metric-label">{stat.label}</span>
                <strong>{stat.value}</strong>
                <span className="metric-meta">{stat.meta}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURE CARDS ── */}
      <section>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px", marginTop: "4px" }}>
          {FEATURES.map((f) => (
            <article key={f.title} className="panel" style={{ margin: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
              <span style={{ fontSize: "1.8rem" }}>{f.icon}</span>
              <strong style={{ fontSize: "1rem" }}>{f.title}</strong>
              <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", lineHeight: 1.6, flex: 1 }}>{f.desc}</p>
              {f.href ? (
                <a className="button button-ghost" href={f.href} style={{ alignSelf: "flex-start", fontSize: "0.8rem" }}>{f.label} →</a>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      {/* ── WIN RATE COMPARISON ── */}
      <section className="section-grid">
        <article className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Performance</span><h2>💹 Crypto signals</h2></div>
            <span className="pill pill-success">{overview?.winRate ?? 0}% win rate</span>
          </div>
          <div className="detail-grid">
            <div><span className="detail-label">Active</span><strong>{overview?.activeSignals ?? 0}</strong></div>
            <div><span className="detail-label">Resolved</span><strong>{overview?.closedSignals ?? 0}</strong></div>
            <div><span className="detail-label">Wins ✅</span><strong style={{color:"#34d399"}}>{overview?.totalWins ?? 0}</strong></div>
            <div><span className="detail-label">Losses ❌</span><strong style={{color:"#f87171"}}>{overview?.totalLosses ?? 0}</strong></div>
            <div><span className="detail-label">Win Rate</span><strong style={{ color: "#34d399", fontSize: "1.2rem" }}>{overview?.winRate ?? 0}%</strong></div>
            <div><span className="detail-label">Expired</span><strong style={{color:"#94a3b8"}}>{overview?.expiredSignals ?? 0}</strong></div>
            <div><span className="detail-label">Avg Confidence</span><strong>{overview?.averageConfidence ?? 0}%</strong></div>
            <div><span className="detail-label">Total</span><strong>{overview?.totalSignals ?? 0}</strong></div>
          </div>
          <a className="button button-ghost" href="/crypto" style={{ alignSelf: "flex-start", marginTop: "8px", fontSize: "0.82rem" }}>View Crypto →</a>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Performance</span><h2>🇮🇳 Indian stock signals</h2></div>
            <span className="pill pill-success">{stockOverview?.winRate ?? 0}% win rate</span>
          </div>
          <div className="detail-grid">
            <div><span className="detail-label">Active</span><strong>{stockOverview?.activeSignals ?? 0}</strong></div>
            <div><span className="detail-label">Resolved</span><strong>{stockOverview?.closedSignals ?? 0}</strong></div>
            <div><span className="detail-label">Wins ✅</span><strong style={{color:"#34d399"}}>{stockOverview?.totalWins ?? 0}</strong></div>
            <div><span className="detail-label">Losses ❌</span><strong style={{color:"#f87171"}}>{stockOverview?.totalLosses ?? 0}</strong></div>
            <div><span className="detail-label">Win Rate</span><strong style={{ color: "#34d399", fontSize: "1.2rem" }}>{stockOverview?.winRate ?? 0}%</strong></div>
            <div><span className="detail-label">Expired</span><strong style={{color:"#94a3b8"}}>{stockOverview?.expiredSignals ?? 0}</strong></div>
            <div><span className="detail-label">Avg Confidence</span><strong>{stockOverview?.averageConfidence ?? 0}%</strong></div>
            <div><span className="detail-label">Total</span><strong>{stockOverview?.totalSignals ?? 0}</strong></div>
          </div>
          <a className="button button-ghost" href="/stocks" style={{ alignSelf: "flex-start", marginTop: "8px", fontSize: "0.82rem" }}>View Stocks →</a>
        </article>
      </section>

      {/* ── ENGINE STATUS ── */}
      {isAdmin ? (
        <section className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Scanner</span><h2>Engine status</h2></div>
            <span className={`pill ${engine?.running ? "pill-success" : "pill-danger"}`}>
              {engine?.running ? "LIVE" : "OFF"}
            </span>
          </div>
          <div className="detail-grid">
            <div><span className="detail-label">Interval</span><strong>{Math.round((engine?.intervalMs || 60000) / 1000)} sec</strong></div>
            <div><span className="detail-label">Scans</span><strong>{engine?.scanCount || 0}</strong></div>
            <div><span className="detail-label">Last output</span><strong>{engine?.lastGenerated || 0} signals</strong></div>
            <div><span className="detail-label">Last scan</span><strong>{engine?.lastScanAt ? new Date(engine.lastScanAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</strong></div>
          </div>
          <div className="button-row">
            <button className="button button-primary" disabled={actionBusy === "start"} onClick={() => handleEngineAction("start")} type="button">
              {actionBusy === "start" ? "Starting..." : "Start engine"}
            </button>
            <button className="button button-ghost" disabled={actionBusy === "stop"} onClick={() => handleEngineAction("stop")} type="button">
              {actionBusy === "stop" ? "Stopping..." : "Stop engine"}
            </button>
            <button className="button button-secondary" disabled={actionBusy === "scan"} onClick={() => handleEngineAction("scan")} type="button">
              {actionBusy === "scan" ? "Scanning..." : "Run scan now"}
            </button>
          </div>
          {engine?.lastError ? <div className="banner banner-error" style={{marginTop:"12px"}}>{engine.lastError}</div> : null}
        </section>
      ) : null}

      {/* ── HOW IT WORKS ── */}
      <section className="panel">
        <div className="panel-header">
          <div><span className="eyebrow">Platform</span><h2>How FTAS works</h2></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "16px" }}>
          {[
            { step: "01", title: "Market Scan", desc: "Engine scans 100s of instruments every few minutes using technical indicators." },
            { step: "02", title: "Signal Generated", desc: "When multi-indicator conditions align, a LONG or SHORT signal is created with entry, SL and TP levels." },
            { step: "03", title: "Live Monitoring", desc: "Each active signal tracks live price against TP1/TP2/TP3 and stop-loss automatically." },
            { step: "04", title: "Result Logged", desc: "Closed trades are recorded with outcome — win rate and performance data updated in real-time." },
          ].map((s) => (
            <div key={s.step} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <span style={{ fontFamily: "monospace", fontSize: "1.4rem", color: "var(--accent)", fontWeight: 700, lineHeight: 1 }}>{s.step}</span>
              <div>
                <strong style={{ display: "block", marginBottom: "4px" }}>{s.title}</strong>
                <span style={{ color: "var(--text-muted)", fontSize: "0.85rem", lineHeight: 1.5 }}>{s.desc}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── ANALYTICS ── */}
      <section className="section-grid section-grid-analytics">
        <article className="panel">
          <div className="panel-header"><div><span className="eyebrow">Analytics</span><h2>Direction mix</h2></div></div>
          <DistributionList data={analytics?.directionMix || []} tone="success" />
        </article>
        <article className="panel">
          <div className="panel-header"><div><span className="eyebrow">Analytics</span><h2>Timeframe mix</h2></div></div>
          <DistributionList data={analytics?.timeframeMix || []} tone="accent" />
        </article>
        <article className="panel">
          <div className="panel-header"><div><span className="eyebrow">Analytics</span><h2>Status mix</h2></div></div>
          <DistributionList data={analytics?.statusMix || []} tone="warning" />
        </article>
        <article className="panel">
          <div className="panel-header"><div><span className="eyebrow">Analytics</span><h2>Confidence bands</h2></div></div>
          <DistributionList data={analytics?.confidenceBands || []} tone="danger" />
        </article>
      </section>

      {/* ── PERFORMANCE ── */}
      <section className="section-grid">
        <article className="panel">
          <div className="panel-header"><div><span className="eyebrow">Performance</span><h2>Summary</h2></div></div>
          <div className="detail-grid">
            <div><span className="detail-label">Closed trades</span><strong>{performance?.summary?.totalClosed ?? 0}</strong></div>
            <div><span className="detail-label">Wins</span><strong>{performance?.summary?.wins ?? 0}</strong></div>
            <div><span className="detail-label">SL hits</span><strong>{performance?.summary?.losses ?? 0}</strong></div>
            <div><span className="detail-label">Win rate</span><strong>{performance?.summary?.winRate ?? 0}%</strong></div>
          </div>
        </article>
        <article className="panel">
          <div className="panel-header"><div><span className="eyebrow">Performance</span><h2>Recommendations</h2></div></div>
          <div className="list-stack">
            {(performance?.recommendations || []).map((item) => (
              <div className="list-card" key={item}><strong>{item}</strong></div>
            ))}
            {!performance?.recommendations?.length ? <div className="empty-state">Recommendations appear after more trades close.</div> : null}
          </div>
        </article>
      </section>

      {/* ── PLAN / PAYMENT ── */}
      <section className="section-grid">
        <article className="panel" id="plan-status-section">
          <div className="panel-header">
            <div><span className="eyebrow">Subscription</span><h2>{shouldShowPaymentForm ? "Subscribe" : "Plan status"}</h2></div>
            <span className="pill pill-neutral">{myPayments.length} submitted</span>
          </div>
          {paidPlanActive ? (
            <div className="banner banner-success">Your {user.plan} plan is active.</div>
          ) : null}
          {!paidPlanActive && hasPendingPayment ? (
            <div className="banner banner-warning">Payment pending approval.</div>
          ) : null}
          <p className="panel-note">Every new account gets a 7-day free trial. After that, signal access continues with a paid plan.</p>
          <p className="panel-note">Contact: {availablePaymentSettings.contactPerson}</p>
          {!isAdmin ? (
            <p className="panel-note">{subscriptionExpiry ? `Access valid till ${subscriptionExpiry}.` : "Expiry shows here after payment approval."}</p>
          ) : null}
          <div className="list-stack">
            {availablePlans.map((plan) => (
              <div className="list-card" key={plan.code}>
                <div><strong>{plan.code}</strong><span>{plan.priceLabel}</span></div>
                <span className="pill pill-accent">{plan.durationDays} days</span>
              </div>
            ))}
          </div>
          {shouldShowPaymentForm ? (
            <form className="form-grid" onSubmit={handlePaymentSubmit}>
              <label><span>Amount</span>
                <input onChange={(e) => setPaymentForm((c) => ({ ...c, amount: e.target.value }))} placeholder="999" type="number" value={paymentForm.amount} />
              </label>
              <label><span>Method</span>
                <select onChange={(e) => setPaymentForm((c) => ({ ...c, method: e.target.value }))} value={paymentForm.method}>
                  {availablePaymentMethods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <label><span>Plan</span>
                <select onChange={(e) => setPaymentForm((c) => {
                  const sel = availablePlans.find((p) => p.code === e.target.value);
                  return { ...c, amount: sel ? String(sel.amountUsd) : c.amount, plan: e.target.value };
                })} value={paymentForm.plan}>
                  {availablePlans.map((p) => <option key={p.code} value={p.code}>{p.code} • {p.priceLabel}</option>)}
                </select>
              </label>
              <label><span>Reference</span>
                <input onChange={(e) => setPaymentForm((c) => ({ ...c, reference: e.target.value }))} placeholder="UPI ref / txn id" value={paymentForm.reference} />
              </label>
              <label className="form-span-2"><span>Screenshot URL</span>
                <input onChange={(e) => setPaymentForm((c) => ({ ...c, screenshotUrl: e.target.value }))} placeholder="Optional proof URL" value={paymentForm.screenshotUrl} />
              </label>
              <label className="form-span-2"><span>Notes</span>
                <textarea onChange={(e) => setPaymentForm((c) => ({ ...c, notes: e.target.value }))} placeholder="Mention package or special note" rows="3" value={paymentForm.notes} />
              </label>
              <button className="button button-primary" disabled={actionBusy === "payment"} type="submit">
                {actionBusy === "payment" ? "Submitting..." : "Submit payment"}
              </button>
            </form>
          ) : null}
          <div className="list-stack">
            {myPayments.slice(0, 4).map((payment) => (
              <div className="list-card" key={payment.id}>
                <div><strong>{payment.plan}</strong><span>{payment.reference}</span></div>
                <span className={`pill ${payment.status === "APPROVED" ? "pill-success" : payment.status === "REJECTED" ? "pill-danger" : "pill-warning"}`}>{payment.status}</span>
              </div>
            ))}
            {!myPayments.length ? <div className="empty-state">No payments submitted yet.</div> : null}
          </div>
        </article>
      </section>

      {/* ── ADMIN PANELS ── */}
      {isAdmin ? (
        <section className="section-grid">
          <article className="panel">
            <div className="panel-header">
              <div><span className="eyebrow">Admin</span><h2>Pending payments</h2></div>
              <span className="pill pill-warning">{pendingPayments.length} pending</span>
            </div>
            <div className="list-stack">
              {pendingPayments.map((payment) => (
                <div className="list-card list-card-wide" key={payment.id}>
                  <div><strong>{payment.userEmail}</strong><span>{payment.plan} • {payment.amount} • {payment.reference}</span></div>
                  <div className="button-row">
                    <button className="button button-primary" disabled={actionBusy === payment.id} onClick={() => handlePaymentReview(payment.id, "APPROVED")} type="button">Approve</button>
                    <button className="button button-ghost" disabled={actionBusy === payment.id} onClick={() => handlePaymentReview(payment.id, "REJECTED")} type="button">Reject</button>
                  </div>
                </div>
              ))}
              {!pendingPayments.length ? <div className="empty-state">No pending approvals.</div> : null}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div><span className="eyebrow">Admin</span><h2>Post manual signal</h2></div>
              <span className="pill pill-accent">Admin only</span>
            </div>
            <form className="form-grid" onSubmit={handleManualSignal}>
              <label><span>Coin</span><input onChange={(e) => setManualForm((c) => ({ ...c, coin: e.target.value.toUpperCase() }))} value={manualForm.coin} /></label>
              <label><span>Side</span>
                <select onChange={(e) => setManualForm((c) => ({ ...c, side: e.target.value }))} value={manualForm.side}>
                  <option value="LONG">LONG</option><option value="SHORT">SHORT</option>
                </select>
              </label>
              <label><span>Timeframe</span>
                <select onChange={(e) => setManualForm((c) => ({ ...c, timeframe: e.target.value }))} value={manualForm.timeframe}>
                  <option value="1m">1m</option><option value="5m">5m</option><option value="15m">15m</option><option value="1h">1h</option>
                </select>
              </label>
              <label><span>Confidence</span><input max="100" min="50" onChange={(e) => setManualForm((c) => ({ ...c, confidence: e.target.value }))} type="number" value={manualForm.confidence} /></label>
              <label><span>Entry</span><input onChange={(e) => setManualForm((c) => ({ ...c, entry: e.target.value }))} type="number" value={manualForm.entry} /></label>
              <label><span>Leverage</span><input max="50" min="1" onChange={(e) => setManualForm((c) => ({ ...c, leverage: e.target.value }))} type="number" value={manualForm.leverage} /></label>
              <label><span>Stop loss</span><input onChange={(e) => setManualForm((c) => ({ ...c, stopLoss: e.target.value }))} type="number" value={manualForm.stopLoss} /></label>
              <label><span>TP1</span><input onChange={(e) => setManualForm((c) => ({ ...c, tp1: e.target.value }))} type="number" value={manualForm.tp1} /></label>
              <label><span>TP2</span><input onChange={(e) => setManualForm((c) => ({ ...c, tp2: e.target.value }))} type="number" value={manualForm.tp2} /></label>
              <label><span>TP3</span><input onChange={(e) => setManualForm((c) => ({ ...c, tp3: e.target.value }))} type="number" value={manualForm.tp3} /></label>
              <button className="button button-primary" disabled={actionBusy === "manual-signal"} type="submit">
                {actionBusy === "manual-signal" ? "Posting..." : "Post manual signal"}
              </button>
            </form>
          </article>
        </section>
      ) : null}

      {isAdmin ? (
        <section className="section-grid">
          <article className="panel">
            <div className="panel-header">
              <div><span className="eyebrow">Admin</span><h2>Payment settings</h2></div>
              <span className="pill pill-accent">{(paymentSettings?.paymentMethods || []).length} methods</span>
            </div>
            <form className="form-grid" onSubmit={handlePaymentSettingsUpdate}>
              <label className="form-span-2"><span>Contact person</span>
                <input onChange={(e) => setContactDraft(e.target.value)} placeholder="+91 8679215898" value={contactDraft} />
              </label>
              <button className="button button-primary" disabled={actionBusy === "payment-settings"} type="submit">
                {actionBusy === "payment-settings" ? "Saving..." : "Save contact"}
              </button>
            </form>
            <form className="form-grid" onSubmit={handlePaymentMethodAdd}>
              <label className="form-span-2"><span>Add payment method</span>
                <input onChange={(e) => setPaymentMethodDraft(e.target.value)} placeholder="Paytm, Wise, Skrill..." value={paymentMethodDraft} />
              </label>
              <button className="button button-secondary" disabled={actionBusy === "payment-method-add"} type="submit">
                {actionBusy === "payment-method-add" ? "Adding..." : "Add method"}
              </button>
            </form>
            {editingMethod ? (
              <form className="form-grid" onSubmit={handlePaymentMethodEdit}>
                <label><span>Edit label</span><input onChange={(e) => setEditingMethodLabel(e.target.value)} value={editingMethodLabel} /></label>
                <label><span>Edit value</span><input onChange={(e) => setEditingMethodValue(e.target.value)} value={editingMethodValue} /></label>
                <div className="button-row form-span-2">
                  <button className="button button-primary" disabled={actionBusy === "payment-method-edit"} type="submit">Save method</button>
                  <button className="button button-ghost" onClick={cancelPaymentMethodEdit} type="button">Cancel</button>
                </div>
              </form>
            ) : null}
            <div className="list-stack">
              {availablePaymentMethods.map((method) => (
                <div className="list-card list-card-wide" key={method.value}>
                  <div><strong>{method.label}</strong><span>{method.value}</span></div>
                  <div className="button-row">
                    <button className="button button-secondary" onClick={() => startPaymentMethodEdit(method)} type="button">Edit</button>
                    <button className="button button-ghost" disabled={actionBusy === `remove-${method.value}`} onClick={() => handlePaymentMethodRemove(method.value)} type="button">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header"><div><span className="eyebrow">Plans</span><h2>Subscription pricing</h2></div></div>
            <div className="list-stack">
              {availablePlans.map((plan) => (
                <div className="list-card" key={plan.code}>
                  <div><strong>{plan.code}</strong><span>{plan.priceLabel}</span></div>
                  <span className="pill pill-neutral">{plan.durationDays} days</span>
                </div>
              ))}
            </div>
          </article>
        </section>
      ) : null}

      {isAdmin ? (
        <section className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Admin</span><h2>User management</h2></div>
            <span className="pill pill-neutral">{users.length} users</span>
          </div>
          <div className="list-stack">
            {users.map((account) => {
              const expiryLabel = formatSubscriptionEndsAt(account.subscriptionEndsAt);
              const expiryDate = account.subscriptionEndsAt ? new Date(account.subscriptionEndsAt) : null;
              const isExpired = expiryDate && !Number.isNaN(expiryDate.getTime()) && expiryDate.getTime() < Date.now();
              const expiresSoon = expiryDate && !Number.isNaN(expiryDate.getTime()) && expiryDate.getTime() > Date.now() && expiryDate.getTime() - Date.now() <= 5 * 24 * 60 * 60 * 1000;
              return (
                <div className="list-card list-card-wide" key={account.id}>
                  <div>
                    <strong>{account.email}</strong>
                    <span>{account.role} • {account.plan} • {account.subscriptionStatus}</span>
                    <span className={`pill ${expiryLabel ? (isExpired ? "pill-danger" : expiresSoon ? "pill-warning" : "pill-neutral") : "pill-neutral"}`}>
                      {expiryLabel ? `${isExpired ? "Expired" : "Expires"} ${expiryLabel}` : "No expiry set"}
                    </span>
                  </div>
                  <div className="button-row">
                    <button className="button button-secondary" disabled={actionBusy === account.id} onClick={() => handleUserUpdate(account.id, { role: account.role === "ADMIN" ? "USER" : "ADMIN" })} type="button">
                      {account.role === "ADMIN" ? "Make user" : "Make admin"}
                    </button>
                    <button className="button button-ghost" disabled={actionBusy === account.id} onClick={() => handleUserUpdate(account.id, { isActive: !account.isActive })} type="button">
                      {account.isActive ? "Suspend" : "Activate"}
                    </button>
                    <button className="button button-ghost" disabled={actionBusy === account.id} onClick={() => handleUserUpdate(account.id, buildPlanUpdate("FREE_TRIAL"))} type="button">7-day trial</button>
                    <button className="button button-ghost" disabled={actionBusy === account.id} onClick={() => handleUserUpdate(account.id, buildPlanUpdate("PRO"))} type="button">Set PRO</button>
                    <button className="button button-ghost" disabled={actionBusy === account.id} onClick={() => handleUserUpdate(account.id, buildPlanUpdate("PREMIUM"))} type="button">Set PREMIUM</button>
                    <button className="button button-ghost" disabled={actionBusy === account.id} onClick={() => handleUserUpdate(account.id, buildPlanUpdate("FREE"))} type="button">Remove access</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}
