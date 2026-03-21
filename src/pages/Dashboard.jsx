import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppShell from "../components/AppShell";
import DistributionList from "../components/DistributionList";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";
import { useWebSocket } from "../lib/useWebSocket";

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
const ANALYTICS_REFRESH_MS = 10 * 60 * 1000;
const MISSED_SIGNALS_LAST_SEEN_KEY = "ftas_missed_signals_last_seen";
const AUTO_RECO_APPLY_STORAGE_KEY = "ftas_auto_reco_applied_v1";

function deferTask(fn) {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    window.requestIdleCallback(fn, { timeout: 2500 });
  } else {
    setTimeout(fn, 2500);
  }
}

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

function normalizeDashboardSignalPrefs(value = {}) {
  return {
    minConfidence: Number(value?.minConfidence || 0),
    sides: Array.isArray(value?.sides) && value.sides.length ? value.sides : ["LONG", "SHORT"],
    timeframes: Array.isArray(value?.timeframes) ? value.timeframes : [],
    blockedTimeframes: Array.isArray(value?.blockedTimeframes) ? value.blockedTimeframes : [],
    excludedCoins: Array.isArray(value?.excludedCoins) ? value.excludedCoins : [],
    onlyStrong: Boolean(value?.onlyStrong),
  };
}

function buildSignalPreferencePayload(prefs = {}) {
  const normalized = normalizeDashboardSignalPrefs(prefs);
  return {
    minConfidence: Number(normalized.minConfidence || 0),
    onlyStrong: Boolean(normalized.onlyStrong),
    sides: normalized.sides,
    timeframes: normalized.timeframes,
    blockedTimeframes: normalized.blockedTimeframes,
    excludedCoins: normalized.excludedCoins,
  };
}

function deriveAutoRecommendationPrefs(recommendations = [], currentPrefs = {}) {
  const next = normalizeDashboardSignalPrefs(currentPrefs);
  const actions = [];

  recommendations.forEach((item) => {
    const rec = String(item || "").trim();
    if (!rec) return;

    const confidenceMatch = rec.match(/signals in\s+([0-9]+)(?:-([0-9]+)|\+)\s+confidence band/i);
    if (confidenceMatch) {
      const lower = Number(confidenceMatch[1] || 0);
      const upper = Number(confidenceMatch[2] || lower);
      const target = Math.min(100, Math.max(next.minConfidence, upper + 1));
      if (target > next.minConfidence) {
        next.minConfidence = target;
        actions.push("raise_min_conf_" + String(target));
      }
      return;
    }

    const sideMatch = rec.match(/\b(LONG|SHORT)\b\s+side is underperforming/i);
    if (sideMatch) {
      const weakSide = sideMatch[1].toUpperCase();
      if (next.sides.includes(weakSide) && next.sides.length > 1) {
        next.sides = next.sides.filter((side) => side !== weakSide);
        actions.push("disable_side_" + weakSide);
      }
      return;
    }

    const timeframeMatch = rec.match(/^([0-9]+[mhd])\s+setups are underperforming/i);
    if (timeframeMatch) {
      const weakTimeframe = timeframeMatch[1].toLowerCase();
      if (!next.blockedTimeframes.includes(weakTimeframe)) {
        next.blockedTimeframes = [...next.blockedTimeframes, weakTimeframe];
        actions.push("block_tf_" + weakTimeframe);
      }
      return;
    }

    const coinMatch = rec.match(/^([A-Z0-9:_-]+)\s+is causing repeated stop losses/i);
    if (coinMatch) {
      const weakCoin = coinMatch[1].toUpperCase();
      if (!next.excludedCoins.includes(weakCoin)) {
        next.excludedCoins = [...next.excludedCoins, weakCoin];
        actions.push("exclude_coin_" + weakCoin);
      }
    }
  });

  return { actions, next };
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
  const analyticsFetchedAtRef = useRef(0);

  const [signalPrefs, setSignalPrefs] = useState({
    minConfidence: 0,
    sides: ["LONG", "SHORT"],
    timeframes: [],
    blockedTimeframes: [],
    excludedCoins: [],
    onlyStrong: false,
  });
  const [missedSignals, setMissedSignals] = useState([]);
  const [activityEvents, setActivityEvents] = useState([]);

  // ── WebSocket — realtime stats ────────────────────────────────────────────
  const onStatsUpdate = useCallback(({ crypto, stocks }) => {
    if (crypto) setOverview(prev => prev ? { ...prev, ...crypto } : crypto);
    if (stocks) setStockOverview(prev => prev ? { ...prev, ...stocks } : stocks);
  }, []);
  const { connected: wsConnected } = useWebSocket({ onStatsUpdate });
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
    if (!user?.signalPreferences) return;
    setSignalPrefs(normalizeDashboardSignalPrefs(user.signalPreferences));
  }, [user?.signalPreferences]);

  useEffect(() => {
    if (!availablePaymentSettings) return;
    setContactDraft((c) => c || availablePaymentSettings.contactPerson || "");
    setPaymentForm((c) => {
      const selectedPlan = availablePlans.find((p) => p.code === c.plan) || availablePlans[0];
      const selectedMethod = availablePaymentMethods.find((m) => m.value === c.method) || availablePaymentMethods[0];
      return { ...c, amount: c.amount || String(selectedPlan?.amountUsd || ""), method: selectedMethod?.value || c.method, plan: selectedPlan?.code || c.plan };
    });
  }, [availablePaymentMethods, availablePaymentSettings, availablePlans]);

  useEffect(() => {
    const recommendations = performance?.recommendations || [];
    if (!user?.id || !recommendations.length) return;
    if (actionBusy === "signal-preferences") return;

    const currentPrefs = normalizeDashboardSignalPrefs(user?.signalPreferences || signalPrefs);
    const { actions, next } = deriveAutoRecommendationPrefs(recommendations, currentPrefs);
    if (!actions.length) return;

    const signature = user.id + ":" + JSON.stringify(recommendations) + ":" + JSON.stringify(next);
    if (typeof window !== "undefined" && window.localStorage.getItem(AUTO_RECO_APPLY_STORAGE_KEY) === signature) return;

    let active = true;
    (async () => {
      try {
        setActionBusy("signal-preferences");
        setError("");
        await apiFetch("/auth/me/preferences", {
          method: "PATCH",
          body: buildSignalPreferencePayload(next),
        });

        if (typeof window !== "undefined") {
          window.localStorage.setItem(AUTO_RECO_APPLY_STORAGE_KEY, signature);
        }
        if (!active) return;

        setSignalPrefs(next);
        setFeedback("AI recommendations auto-applied (" + actions.length + " changes)");
        setTimeout(() => setFeedback(""), 4000);
        await refreshUser();
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setActionBusy("");
      }
    })();

    return () => {
      active = false;
    };
  }, [actionBusy, performance?.recommendations, refreshUser, signalPrefs, user?.id, user?.signalPreferences]);

  const loadPublicData = useCallback(async () => {
    // Phase 1: fast endpoints first so dashboard renders quickly
    const [overviewRes, stockOverviewRes] = await Promise.all([
      apiFetch("/signals/stats/overview").catch(() => null),
      apiFetch("/stocks/stats/overview").catch(() => null),
    ]);

    if (overviewRes?.stats)      setOverview(overviewRes.stats);
    if (stockOverviewRes?.stats) setStockOverview(stockOverviewRes.stats);
    setLoading(false);

    // Phase 2: heavier analytics/performance — defer and throttle
    const now = Date.now();
    if (now - analyticsFetchedAtRef.current > ANALYTICS_REFRESH_MS) {
      analyticsFetchedAtRef.current = now;
      deferTask(async () => {
        const [analyticsRes, performanceRes] = await Promise.allSettled([
          apiFetch("/signals/stats/analytics"),
          apiFetch("/signals/stats/performance"),
        ]);
        if (analyticsRes.status === "fulfilled" && analyticsRes.value?.analytics) {
          setAnalytics(analyticsRes.value.analytics);
        }
        if (performanceRes.status === "fulfilled" && performanceRes.value?.performance) {
          setPerformance(performanceRes.value.performance);
        }
      });
    }

    return null;
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
        // Run public and private data in parallel — don't wait for one to finish before the other
        await Promise.all([
          loadPublicData().catch(e => { if (active) setError(e?.message || ""); }),
          loadPrivateData().catch(() => {}),
          loadPersonalizationData().catch(() => {}),
        ]);
      } catch (e) {
        if (active) setError(e.message);
      }
    }
    loadData();
    const id = window.setInterval(loadData, 300_000); // WS handles realtime — 5min fallback only
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

  async function loadPersonalizationData() {
    try {
      const nowIso = new Date().toISOString();
      const since = window.localStorage.getItem(MISSED_SIGNALS_LAST_SEEN_KEY) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [activityRes, missedRes] = await Promise.allSettled([
        apiFetch("/auth/me/activity?limit=25"),
        apiFetch(`/signals/missed?since=${encodeURIComponent(since)}&scope=all&limit=30&fields=lite`),
      ]);

      if (activityRes.status === "fulfilled") {
        setActivityEvents(activityRes.value.events || []);
      }
      if (missedRes.status === "fulfilled") {
        setMissedSignals(missedRes.value.signals || []);
      }

      window.localStorage.setItem(MISSED_SIGNALS_LAST_SEEN_KEY, nowIso);
    } catch {}
  }

  async function handleSignalPreferenceSave(event) {
    event.preventDefault();
    setActionBusy("signal-preferences");
    setError("");
    try {
      const payload = buildSignalPreferencePayload(signalPrefs);
      await apiFetch("/auth/me/preferences", { method: "PATCH", body: payload });
      await refreshWithFeedback("Signal preferences updated");
    } catch (e) {
      setError(e.message);
    } finally {
      setActionBusy("");
    }
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
                badge: wsConnected ? { text: "● LIVE", color: "#2bd48f" } : { text: "○ polling", color: "#8da0bc" },
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
                label: "Archived Signals",
                value: (overview?.archiveSize ?? 0) + (stockOverview?.archiveSize ?? 0),
                meta: `${overview?.archiveSize ?? 0} crypto · ${stockOverview?.archiveSize ?? 0} stocks`,
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
                {stat.badge && (
                  <span style={{ fontSize: "0.65rem", fontWeight: 700, color: stat.badge.color, letterSpacing: "0.05em" }}>
                    {stat.badge.text}
                  </span>
                )}
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

      {/* ── COMMUNITY ── */}
      <section className="section-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>

        {/* WhatsApp Channel */}
        <article className="panel" style={{
          background: "linear-gradient(135deg, rgba(37,211,102,0.12) 0%, rgba(37,211,102,0.04) 100%)",
          border: "1px solid rgba(37,211,102,0.25)",
          display: "flex", flexDirection: "column", gap: "16px",
        }}>
          <div className="panel-header" style={{ marginBottom: 0 }}>
            <div>
              <span className="eyebrow" style={{ color: "#25d366" }}>Community</span>
              <h2 style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#25d366" xmlns="http://www.w3.org/2000/svg">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
                WhatsApp Channel
              </h2>
            </div>
            <span className="pill pill-success">Free</span>
          </div>

          <p style={{ color: "var(--c-muted)", fontSize: "0.86rem", lineHeight: 1.6, margin: 0 }}>
            Join our official WhatsApp channel for instant signal alerts, market updates, and trading tips directly on your phone.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "0.82rem", color: "var(--c-muted)" }}>
            {["📢 Signal Alerts", "📊 Market Updates", "💡 Trading Tips"].map(t => (
              <span key={t} style={{ background: "rgba(37,211,102,0.1)", border: "1px solid rgba(37,211,102,0.15)", borderRadius: "20px", padding: "4px 10px", color: "#25d366", fontWeight: 600 }}>{t}</span>
            ))}
          </div>

          <a
            href="https://whatsapp.com/channel/0029VbCbHW97tkizw2PxR61c"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
              background: "linear-gradient(135deg, #25d366, #128c7e)",
              color: "#fff", fontWeight: 700, fontSize: "0.92rem",
              padding: "12px 20px", borderRadius: "12px", textDecoration: "none",
              boxShadow: "0 4px 16px rgba(37,211,102,0.3)",
              transition: "transform 0.15s, box-shadow 0.15s",
              marginTop: "auto",
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(37,211,102,0.4)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(37,211,102,0.3)"; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            Join WhatsApp Channel
          </a>
        </article>

        {/* Facebook Page */}
        <article className="panel" style={{
          background: "linear-gradient(135deg, rgba(24,119,242,0.12) 0%, rgba(24,119,242,0.04) 100%)",
          border: "1px solid rgba(24,119,242,0.25)",
          display: "flex", flexDirection: "column", gap: "16px",
        }}>
          <div className="panel-header" style={{ marginBottom: 0 }}>
            <div>
              <span className="eyebrow" style={{ color: "#1877f2" }}>Community</span>
              <h2 style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#1877f2" xmlns="http://www.w3.org/2000/svg">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
                Facebook Page
              </h2>
            </div>
            <span className="pill pill-accent">Follow</span>
          </div>

          <p style={{ color: "var(--c-muted)", fontSize: "0.86rem", lineHeight: 1.6, margin: 0 }}>
            Follow our Facebook page for in-depth analysis, educational content, community discussions, and exclusive trading insights.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "0.82rem", color: "var(--c-muted)" }}>
            {["📈 Analysis", "🎓 Education", "💬 Discussions"].map(t => (
              <span key={t} style={{ background: "rgba(24,119,242,0.1)", border: "1px solid rgba(24,119,242,0.15)", borderRadius: "20px", padding: "4px 10px", color: "#1877f2", fontWeight: 600 }}>{t}</span>
            ))}
          </div>

          {/* Embedded Facebook Page Plugin */}
          <div style={{ borderRadius: "10px", overflow: "hidden", border: "1px solid rgba(24,119,242,0.15)", background: "rgba(0,0,0,0.2)" }}>
            <iframe
              src="https://www.facebook.com/plugins/page.php?href=https%3A%2F%2Fwww.facebook.com%2FFtas.trading.network&tabs=timeline&width=340&height=200&small_header=true&adapt_container_width=true&hide_cover=false&show_facepile=true&appId"
              width="100%"
              height="200"
              style={{ border: "none", overflow: "hidden", display: "block" }}
              scrolling="no"
              frameBorder="0"
              allowFullScreen
              allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
              title="FTAS Facebook Page"
            />
          </div>

          <a
            href="https://www.facebook.com/Ftas.trading.network"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
              background: "linear-gradient(135deg, #1877f2, #0d65d9)",
              color: "#fff", fontWeight: 700, fontSize: "0.92rem",
              padding: "12px 20px", borderRadius: "12px", textDecoration: "none",
              boxShadow: "0 4px 16px rgba(24,119,242,0.3)",
              transition: "transform 0.15s, box-shadow 0.15s",
              marginTop: "auto",
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(24,119,242,0.4)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(24,119,242,0.3)"; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>
            Follow on Facebook
          </a>
        </article>
      </section>

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

      <section className="section-grid">
        <article className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Personalization</span><h2>Signal Preferences</h2></div>
            <span className="pill pill-accent">Applied in API</span>
          </div>
          <form className="form-grid" onSubmit={handleSignalPreferenceSave}>
            <label>
              <span>Minimum confidence</span>
              <input
                max="100"
                min="0"
                onChange={(e) => setSignalPrefs((c) => ({ ...c, minConfidence: e.target.value }))}
                type="number"
                value={signalPrefs.minConfidence}
              />
            </label>

            <label>
              <span>Allowed sides</span>
              <div className="button-row">
                <button
                  className={`button ${signalPrefs.sides.includes("LONG") ? "button-primary" : "button-ghost"}`}
                  onClick={() => setSignalPrefs((c) => ({
                    ...c,
                    sides: c.sides.includes("LONG") ? c.sides.filter((v) => v !== "LONG") : [...c.sides, "LONG"],
                  }))}
                  type="button"
                >
                  LONG
                </button>
                <button
                  className={`button ${signalPrefs.sides.includes("SHORT") ? "button-primary" : "button-ghost"}`}
                  onClick={() => setSignalPrefs((c) => ({
                    ...c,
                    sides: c.sides.includes("SHORT") ? c.sides.filter((v) => v !== "SHORT") : [...c.sides, "SHORT"],
                  }))}
                  type="button"
                >
                  SHORT
                </button>
              </div>
            </label>

            <label className="auth-checkbox">
              <input
                checked={signalPrefs.onlyStrong}
                onChange={(e) => setSignalPrefs((c) => ({ ...c, onlyStrong: e.target.checked }))}
                type="checkbox"
              />
              <span>Show only strong signals</span>
            </label>

            <button className="button button-primary" disabled={actionBusy === "signal-preferences"} type="submit">
              {actionBusy === "signal-preferences" ? "Saving..." : "Save preferences"}
            </button>
          </form>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Recovery</span><h2>Missed Signals</h2></div>
            <span className="pill pill-neutral">{missedSignals.length} found</span>
          </div>
          <div className="list-stack">
            {missedSignals.slice(0, 8).map((signal) => (
              <div className="list-card" key={signal.id}>
                <div><strong>{signal.coin} • {signal.side}</strong><span>{signal.timeframe} • {signal.confidence}%</span></div>
                <span className="pill pill-neutral">{signal.status}</span>
              </div>
            ))}
            {!missedSignals.length ? <div className="empty-state">No missed signals since your last visit.</div> : null}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div><span className="eyebrow">Security</span><h2>Account Activity</h2></div>
            <span className="pill pill-warning">{activityEvents.length} events</span>
          </div>
          <div className="list-stack">
            {activityEvents.slice(0, 8).map((event) => (
              <div className="list-card" key={event.id}>
                <div><strong>{event.type}</strong><span>{event.status}{event.reason ? ` • ${event.reason}` : ""}</span></div>
                <span className={`pill ${event.level === "WARN" ? "pill-warning" : "pill-neutral"}`}>{new Date(event.createdAt).toLocaleDateString("en-IN")}</span>
              </div>
            ))}
            {!activityEvents.length ? <div className="empty-state">No recent activity.</div> : null}
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
