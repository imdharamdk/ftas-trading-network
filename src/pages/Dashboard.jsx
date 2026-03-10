import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "../components/AppShell";
import DistributionList from "../components/DistributionList";
import SignalTable from "../components/SignalTable";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";
import { getSignalCoins, mergeSignalLivePrices } from "../lib/liveSignalPrices";

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
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function buildPlanUpdate(plan) {
  if (plan === "FREE_TRIAL") {
    return {
      plan,
      subscriptionEndsAt: addDaysToIso(7),
      subscriptionStatus: "ACTIVE",
    };
  }

  if (plan === "PRO" || plan === "PREMIUM") {
    return {
      plan,
      subscriptionEndsAt: addDaysToIso(plan === "PREMIUM" ? 180 : 30),
      subscriptionStatus: "ACTIVE",
    };
  }

  return {
    plan: "FREE",
    subscriptionEndsAt: null,
    subscriptionStatus: "INACTIVE",
  };
}

function hasActivePaidPlan(user) {
  return user?.subscriptionStatus === "ACTIVE" && ["PRO", "PREMIUM"].includes(user?.plan);
}

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
  const [analytics, setAnalytics] = useState(null);
  const [engine, setEngine] = useState(null);
  const [activeSignals, setActiveSignals] = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
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
  const availablePaymentSettings = useMemo(
    () => paymentSettings || fallbackPaymentSettings,
    [paymentSettings]
  );
  const availablePaymentMethods = useMemo(
    () => availablePaymentSettings.paymentMethods || [],
    [availablePaymentSettings]
  );
  const availablePlans = useMemo(
    () => availablePaymentSettings.plans || [],
    [availablePaymentSettings]
  );
  const hasPendingPayment = useMemo(
    () => myPayments.some((payment) => payment.status === "PENDING"),
    [myPayments]
  );
  const shouldShowPaymentForm = !paidPlanActive && !hasPendingPayment;

  useEffect(() => {
    if (subscriptionExpiresSoon && !expiryPromptDismissed) {
      setShowExpiryPrompt(true);
    } else {
      setShowExpiryPrompt(false);
    }
  }, [subscriptionExpiresSoon, expiryPromptDismissed]);

  useEffect(() => {
    if (!availablePaymentSettings) {
      return;
    }

    setContactDraft((current) => current || availablePaymentSettings.contactPerson || "");
    setPaymentForm((current) => {
      const selectedPlan = availablePlans.find((plan) => plan.code === current.plan) || availablePlans[0];
      const selectedMethod = availablePaymentMethods.find((method) => method.value === current.method) || availablePaymentMethods[0];

      return {
        ...current,
        amount: current.amount || String(selectedPlan?.amountUsd || ""),
        method: selectedMethod?.value || current.method,
        plan: selectedPlan?.code || current.plan,
      };
    });
  }, [availablePaymentMethods, availablePaymentSettings, availablePlans]);

  // Stable string of active coin symbols — only changes when coins list changes
  const activeCoinsParam = useMemo(
    () => getSignalCoins(activeSignals).join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSignals.map((s) => s.coin).join(",")]
  );

  useEffect(() => {
    let active = true;

    async function refreshLivePrices() {
      if (!activeCoinsParam) return;
      try {
        const response = await apiFetch(`/signals/live-prices?coins=${activeCoinsParam}`);
        if (!active) return;
        setActiveSignals((current) => mergeSignalLivePrices(current, response.prices || []));
      } catch {
        // Keep the board stable if a lightweight live-price refresh fails.
      }
    }

    refreshLivePrices();
    const intervalId = window.setInterval(refreshLivePrices, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [activeCoinsParam]);

  const loadPublicDashboardData = useCallback(async () => {
    const results = await Promise.allSettled([
      apiFetch("/signals/stats/overview"),
      apiFetch("/signals/stats/analytics"),
      apiFetch("/signals/stats/performance"),
      apiFetch("/signals/active?limit=12"),
      apiFetch("/signals/history?limit=12"),
      apiFetch("/signals/engine/status"),
    ]);

    const [overviewResponse, analyticsResponse, performanceResponse, activeResponse, historyResponse, engineResponse] = results;

    setOverview(overviewResponse.status === "fulfilled" ? overviewResponse.value.stats : null);
    setAnalytics(analyticsResponse.status === "fulfilled" ? analyticsResponse.value.analytics : null);
    setPerformance(performanceResponse.status === "fulfilled" ? performanceResponse.value.performance : null);
    setActiveSignals(activeResponse.status === "fulfilled" ? activeResponse.value.signals || [] : []);
    setHistorySignals(
      historyResponse.status === "fulfilled"
        ? (historyResponse.value.signals || []).filter((signal) => signal.result !== "EXPIRED")
        : [],
    );
    setEngine(engineResponse.status === "fulfilled" ? engineResponse.value.engine : null);

    const rejected = results.find((result) => result.status === "rejected");
    return rejected ? rejected.reason : null;
  }, []);

  const loadPrivateDashboardData = useCallback(async () => {
    const privateRequests = [apiFetch("/payments/my"), apiFetch("/payments/settings")];

    if (isAdmin) {
      privateRequests.push(apiFetch("/payments/pending"));
      privateRequests.push(apiFetch("/auth/users"));
    }

    const results = await Promise.allSettled(privateRequests);
    const [myPaymentsResult, paymentSettingsResult, pendingPaymentsResult, usersResult] = results;

    if (myPaymentsResult?.status === "fulfilled") {
      setMyPayments(myPaymentsResult.value.payments || []);
    } else {
      setMyPayments([]);
    }

    if (paymentSettingsResult?.status === "fulfilled") {
      setPaymentSettings(paymentSettingsResult.value.settings || null);
    } else {
      setPaymentSettings(null);
    }

    if (isAdmin) {
      if (pendingPaymentsResult?.status === "fulfilled") {
        setPendingPayments(pendingPaymentsResult.value.payments || []);
      } else {
        setPendingPayments([]);
      }

      if (usersResult?.status === "fulfilled") {
        setUsers(usersResult.value.users || []);
      } else {
        setUsers([]);
      }
    } else {
      setPendingPayments([]);
      setUsers([]);
    }

    const rejected = results.find((result) => result.status === "rejected");
    return rejected ? rejected.reason : null;
  }, [isAdmin]);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const publicError = await loadPublicDashboardData();

        if (!active) {
          return;
        }

        const privateError = await loadPrivateDashboardData();

        if (active) {
          setError(publicError?.message || privateError?.message || "");
        }
      } catch (loadError) {
        if (active) {
          setError(loadError.message);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadData();
    const intervalId = window.setInterval(loadData, 30000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [loadPrivateDashboardData, loadPublicDashboardData]);

  async function refreshDataWithFeedback(message) {
    setFeedback(message);
    const publicError = await loadPublicDashboardData();
    const privateError = await loadPrivateDashboardData();
    setError(publicError?.message || privateError?.message || "");
    await refreshUser();
  }

  async function handleEngineAction(action) {
    setActionBusy(action);
    setError("");

    try {
      if (action === "start") {
        await apiFetch("/signals/engine/start", { method: "POST" });
        await refreshDataWithFeedback("Scanner started");
      }

      if (action === "stop") {
        await apiFetch("/signals/engine/stop", { method: "POST" });
        await refreshDataWithFeedback("Scanner stopped");
      }

      if (action === "scan") {
        await apiFetch("/signals/scan", { method: "POST" });
        await refreshDataWithFeedback("Manual scan completed");
      }

    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  async function handleArchiveAction(action) {
    setActionBusy(action);
    setError("");

    try {
      await apiFetch("/signals/archive", {
        method: "POST",
        body: { action },
      });
      let message = "Archive cleared";
      if (action === "ARCHIVE_CLOSED") message = "Closed signals archived";
      if (action === "CLEAR_HISTORY") message = "Closed history cleared";
      await refreshDataWithFeedback(message);
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  async function handlePaymentSubmit(event) {
    event.preventDefault();
    setActionBusy("payment");
    setError("");

    try {
      await apiFetch("/payments", {
        method: "POST",
        body: {
          ...paymentForm,
          amount: Number(paymentForm.amount),
        },
      });
      setPaymentForm(defaultPaymentForm);
      await refreshDataWithFeedback("Payment submitted for approval");
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  const handleDismissExpiryPrompt = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(EXPIRY_PROMPT_STORAGE_KEY, "1");
    }
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
      await apiFetch(`/payments/${paymentId}/review`, {
        method: "PATCH",
        body: { status },
      });
      await refreshDataWithFeedback(`Payment ${status.toLowerCase()}`);
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
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
          confidence: Number(manualForm.confidence),
          entry: Number(manualForm.entry),
          leverage: Number(manualForm.leverage),
          stopLoss: Number(manualForm.stopLoss),
          tp1: Number(manualForm.tp1),
          tp2: Number(manualForm.tp2),
          tp3: Number(manualForm.tp3),
        },
      });
      setManualForm(defaultManualForm);
      await refreshDataWithFeedback("Manual signal posted");
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  async function handleUserUpdate(userId, updates) {
    setActionBusy(userId);
    setError("");

    try {
      await apiFetch(`/auth/users/${userId}`, {
        method: "PATCH",
        body: updates,
      });
      await refreshDataWithFeedback("User updated");
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  async function handlePaymentSettingsUpdate(event) {
    event.preventDefault();
    setActionBusy("payment-settings");
    setError("");

    try {
      await apiFetch("/payments/settings", {
        method: "PATCH",
        body: {
          contactPerson: contactDraft,
        },
      });
      await refreshDataWithFeedback("Payment contact updated");
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  async function handlePaymentMethodAdd(event) {
    event.preventDefault();
    setActionBusy("payment-method-add");
    setError("");

    try {
      await apiFetch("/payments/methods", {
        method: "POST",
        body: {
          label: paymentMethodDraft,
        },
      });
      setPaymentMethodDraft("");
      await refreshDataWithFeedback("Payment method added");
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  async function handlePaymentMethodRemove(methodValue) {
    setActionBusy(`remove-${methodValue}`);
    setError("");

    try {
      await apiFetch(`/payments/methods/${methodValue}`, {
        method: "DELETE",
      });
      await refreshDataWithFeedback("Payment method removed");
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
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
        body: {
          label: editingMethodLabel,
          value: editingMethodValue,
        },
      });
      cancelPaymentMethodEdit();
      await refreshDataWithFeedback("Payment method updated");
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setActionBusy("");
    }
  }

  const actions = (
    <button className="button button-ghost" onClick={() => refreshDataWithFeedback("Dashboard refreshed")} type="button">
      Refresh now
    </button>
  );

  return (
    <AppShell
      actions={actions}
      subtitle="Active signals, confidence analytics, payment approvals and engine controls live on the website."
      title="Mission Control"
    >
      {showExpiryPrompt ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            className="panel"
            style={{
              maxWidth: "400px",
              width: "100%",
              boxShadow: "0 20px 35px rgba(0,0,0,0.35)",
            }}
          >
            <div className="panel-header">
              <div>
                <span className="eyebrow">Reminder</span>
                <h2>Your plan is about to expire</h2>
              </div>
            </div>
            <p className="panel-note">
              {subscriptionExpiry
                ? `Current access ends on ${subscriptionExpiry}. Renew now to avoid losing live signals.`
                : "Your current plan is ending soon. Renew now to keep receiving live signals."}
            </p>
            <div className="button-row">
              <button className="button button-primary" onClick={handleRenewPrompt} type="button">
                Purchase / Renew
              </button>
              <button className="button button-ghost" onClick={handleDismissExpiryPrompt} type="button">
                Remind later
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {error ? <div className="banner banner-error">{error}</div> : null}
      {feedback ? <div className="banner banner-success">{feedback}</div> : null}

      <section className="stats-grid">
        <article className="metric-card">
          <span className="metric-label">Engine</span>
          <strong>{engine?.running ? "Running" : "Stopped"}</strong>
          <span className="metric-meta">
            {engine?.lastScanAt ? `Last scan ${new Date(engine.lastScanAt).toLocaleTimeString("en-IN")}` : "No scan yet"}
          </span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Active Signals</span>
          <strong>{overview?.activeSignals ?? 0}</strong>
          <span className="metric-meta">{overview?.strongSignals ?? 0} strong setups</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Win Rate</span>
          <strong>{overview?.winRate ?? 0}%</strong>
          <span className="metric-meta">{overview?.closedSignals ?? 0} closed trades</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Subscription</span>
          <strong>{user?.subscriptionStatus || "INACTIVE"}</strong>
          <span className="metric-meta">{user?.plan || "FREE"} plan</span>
        </article>
      </section>

      <section className="section-grid">
        <article className="panel panel-engine">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Scanner</span>
              <h2>Engine status</h2>
            </div>
            <span className={`pill ${engine?.running ? "pill-success" : "pill-danger"}`}>
              {engine?.running ? "LIVE" : "OFF"}
            </span>
          </div>
          <div className="detail-grid">
            <div>
              <span className="detail-label">Interval</span>
              <strong>{Math.round((engine?.intervalMs || 60000) / 1000)} sec</strong>
            </div>
            <div>
              <span className="detail-label">Scans completed</span>
              <strong>{engine?.scanCount || 0}</strong>
            </div>
            <div>
              <span className="detail-label">Last output</span>
              <strong>{engine?.lastGenerated || 0} signals</strong>
            </div>
            <div>
              <span className="detail-label">Average confidence</span>
              <strong>{overview?.averageConfidence ?? 0}%</strong>
            </div>
          </div>
          {isAdmin ? (
            <div className="button-row">
              <button className="button button-primary" disabled={actionBusy === "start"} onClick={() => handleEngineAction("start")} type="button">
                Start engine
              </button>
              <button className="button button-ghost" disabled={actionBusy === "stop"} onClick={() => handleEngineAction("stop")} type="button">
                Stop engine
              </button>
              <button className="button button-secondary" disabled={actionBusy === "scan"} onClick={() => handleEngineAction("scan")} type="button">
                Run scan now
              </button>
            </div>
          ) : (
            <p className="panel-note">Scanner controls are restricted to admin accounts.</p>
          )}
        </article>

        <article className="panel" id="plan-status-section">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Payments</span>
              <h2>{shouldShowPaymentForm ? "Submit subscription proof" : "Plan status"}</h2>
            </div>
            <span className="pill pill-neutral">{myPayments.length} submitted</span>
          </div>
          {paidPlanActive ? (
            <div className="banner banner-success">
              Your {user.plan} plan is active, so the purchase form stays hidden because access is already enabled.
            </div>
          ) : null}
          {!paidPlanActive && hasPendingPayment ? (
            <div className="banner banner-warning">
              A payment proof is already pending admin approval, so the purchase form is hidden for now.
            </div>
          ) : null}
          <p className="panel-note">Every new account gets a 7-day free trial. After that, signal access continues once a paid plan is approved.</p>
          <p className="panel-note">Contact for payment confirmation: {availablePaymentSettings.contactPerson}</p>
          {!isAdmin ? (
            <p className="panel-note">
              {subscriptionExpiry ? `Access valid till ${subscriptionExpiry}.` : "Subscription expiry will show here after your next payment approval."}
            </p>
          ) : null}

          <div className="list-stack">
            {availablePlans.map((plan) => (
              <div className="list-card" key={plan.code}>
                <div>
                  <strong>{plan.code}</strong>
                  <span>{plan.priceLabel}</span>
                </div>
                <span className="pill pill-accent">{plan.durationDays} days access</span>
              </div>
            ))}
          </div>

          {shouldShowPaymentForm ? (
            <form className="form-grid" onSubmit={handlePaymentSubmit}>
              <label>
                <span>Amount</span>
                <input
                  onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))}
                  placeholder="999"
                  type="number"
                  value={paymentForm.amount}
                />
              </label>
              <label>
                <span>Method</span>
                <select
                  onChange={(event) => setPaymentForm((current) => ({ ...current, method: event.target.value }))}
                  value={paymentForm.method}
                >
                  {availablePaymentMethods.map((method) => (
                    <option key={method.value} value={method.value}>
                      {method.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Plan</span>
                <select
                  onChange={(event) =>
                    setPaymentForm((current) => {
                      const selectedPlan = availablePlans.find((plan) => plan.code === event.target.value);

                      return {
                        ...current,
                        amount: selectedPlan ? String(selectedPlan.amountUsd) : current.amount,
                        plan: event.target.value,
                      };
                    })
                  }
                  value={paymentForm.plan}
                >
                  {availablePlans.map((plan) => (
                    <option key={plan.code} value={plan.code}>
                      {plan.code} • {plan.priceLabel}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Reference</span>
                <input
                  onChange={(event) => setPaymentForm((current) => ({ ...current, reference: event.target.value }))}
                  placeholder="UPI ref / txn id"
                  value={paymentForm.reference}
                />
              </label>
              <label className="form-span-2">
                <span>Screenshot URL</span>
                <input
                  onChange={(event) => setPaymentForm((current) => ({ ...current, screenshotUrl: event.target.value }))}
                  placeholder="Optional proof URL"
                  value={paymentForm.screenshotUrl}
                />
              </label>
              <label className="form-span-2">
                <span>Notes</span>
                <textarea
                  onChange={(event) => setPaymentForm((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="Mention package or special note"
                  rows="3"
                  value={paymentForm.notes}
                />
              </label>
              <button className="button button-primary" disabled={actionBusy === "payment"} type="submit">
                {actionBusy === "payment" ? "Submitting..." : "Submit payment"}
              </button>
            </form>
          ) : null}

          <div className="list-stack">
            {myPayments.slice(0, 4).map((payment) => (
              <div className="list-card" key={payment.id}>
                <div>
                  <strong>{payment.plan}</strong>
                  <span>{payment.reference}</span>
                </div>
                <span className={`pill ${payment.status === "APPROVED" ? "pill-success" : payment.status === "REJECTED" ? "pill-danger" : "pill-warning"}`}>
                  {payment.status}
                </span>
              </div>
            ))}
            {!myPayments.length ? <div className="empty-state">No payments submitted yet.</div> : null}
          </div>
        </article>
      </section>

      <section className="section-grid section-grid-analytics">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Analytics</span>
              <h2>Direction mix</h2>
            </div>
          </div>
          <DistributionList data={analytics?.directionMix || []} tone="success" />
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Analytics</span>
              <h2>Timeframe mix</h2>
            </div>
          </div>
          <DistributionList data={analytics?.timeframeMix || []} tone="accent" />
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Analytics</span>
              <h2>Status mix</h2>
            </div>
          </div>
          <DistributionList data={analytics?.statusMix || []} tone="warning" />
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Analytics</span>
              <h2>Confidence bands</h2>
            </div>
          </div>
          <DistributionList data={analytics?.confidenceBands || []} tone="danger" />
        </article>
      </section>

      <section className="section-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Diagnostics</span>
              <h2>Performance summary</h2>
            </div>
          </div>
          <div className="detail-grid">
            <div>
              <span className="detail-label">Closed trades</span>
              <strong>{performance?.summary?.totalClosed ?? 0}</strong>
            </div>
            <div>
              <span className="detail-label">Wins</span>
              <strong>{performance?.summary?.wins ?? 0}</strong>
            </div>
            <div>
              <span className="detail-label">SL hits</span>
              <strong>{performance?.summary?.losses ?? 0}</strong>
            </div>
            <div>
              <span className="detail-label">Win rate</span>
              <strong>{performance?.summary?.winRate ?? 0}%</strong>
            </div>
          </div>
          <p className="panel-note">Ye closed-trade diagnostics live history se bante hain. Fresh scan ke baad quality trend yahin se measure hoga.</p>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Diagnostics</span>
              <h2>Engine recommendations</h2>
            </div>
          </div>
          <div className="list-stack">
            {(performance?.recommendations || []).map((item) => (
              <div className="list-card" key={item}>
                <strong>{item}</strong>
              </div>
            ))}
            {!performance?.recommendations?.length ? <div className="empty-state">Recommendations will appear after more trades close.</div> : null}
          </div>
        </article>
      </section>

      <section className="section-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Diagnostics</span>
              <h2>Timeframe quality</h2>
            </div>
          </div>
          <div className="list-stack">
            {(performance?.timeframeBreakdown || []).map((item) => (
              <div className="list-card list-card-wide" key={item.label}>
                <div>
                  <strong>{item.label}</strong>
                  <span>
                    Win {item.winRate}% • W {item.wins} • SL {item.losses}
                  </span>
                </div>
                <span className={`pill ${item.winRate >= 50 ? "pill-success" : "pill-danger"}`}>{item.total} trades</span>
              </div>
            ))}
            {!performance?.timeframeBreakdown?.length ? <div className="empty-state">No timeframe diagnostics yet.</div> : null}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Diagnostics</span>
              <h2>Confidence quality</h2>
            </div>
          </div>
          <div className="list-stack">
            {(performance?.confidenceBreakdown || []).map((item) => (
              <div className="list-card list-card-wide" key={item.label}>
                <div>
                  <strong>{item.label}</strong>
                  <span>
                    Win {item.winRate}% • W {item.wins} • SL {item.losses}
                  </span>
                </div>
                <span className={`pill ${item.winRate >= 50 ? "pill-success" : "pill-danger"}`}>{item.total} signals</span>
              </div>
            ))}
            {!performance?.confidenceBreakdown?.length ? <div className="empty-state">No confidence diagnostics yet.</div> : null}
          </div>
        </article>
      </section>

      <section className="section-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Diagnostics</span>
              <h2>Side breakdown</h2>
            </div>
          </div>
          <DistributionList
            data={(performance?.sideBreakdown || []).map((item) => ({ label: `${item.label} • ${item.winRate}%`, value: item.total }))}
            emptyLabel="No side breakdown yet"
            tone="accent"
          />
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Diagnostics</span>
              <h2>Coins under pressure</h2>
            </div>
          </div>
          <div className="list-stack">
            {(performance?.troubleCoins || []).map((item) => (
              <div className="list-card list-card-wide" key={item.coin}>
                <div>
                  <strong>{item.coin}</strong>
                  <span>
                    SL {item.slHits} • Win {item.winRate}% • Closed {item.totalClosed}
                  </span>
                </div>
                <span className="pill pill-danger">{item.slHits} SL</span>
              </div>
            ))}
            {!performance?.troubleCoins?.length ? <div className="empty-state">No coin-level pressure clusters yet.</div> : null}
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Live board</span>
            <h2>Active signals</h2>
          </div>
          <span className="pill pill-success">{activeSignals.length} active</span>
        </div>
        <SignalTable
          emptyLabel={
            loading
              ? "Loading active signals..."
              : isAdmin
                ? "No active signals yet. Use Run scan now or post a manual signal."
                : "No active signals yet. Admin ko scan ya manual signal create karna hoga."
          }
          signals={activeSignals}
        />
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Archive</span>
            <h2>Closed signal history</h2>
          </div>
          <span className="pill pill-neutral">{historySignals.length} recent closes</span>
        </div>
        {isAdmin ? (
          <>
            <p className="panel-note">
              Move CLOSED trades out of the live dataset or wipe the archive to keep the board snappy.
            </p>
            <div className="button-row">
              <button
                className="button button-secondary"
                disabled={actionBusy === "ARCHIVE_CLOSED"}
                onClick={() => handleArchiveAction("ARCHIVE_CLOSED")}
                type="button"
              >
                Archive closed signals
              </button>
              <button
                className="button button-secondary"
                disabled={actionBusy === "CLEAR_HISTORY"}
                onClick={() => handleArchiveAction("CLEAR_HISTORY")}
                type="button"
              >
                Clear history
              </button>
              <button
                className="button button-ghost"
                disabled={actionBusy === "CLEAR_ARCHIVE"}
                onClick={() => handleArchiveAction("CLEAR_ARCHIVE")}
                type="button"
              >
                Clear archive
              </button>
            </div>
          </>
        ) : null}
        <SignalTable emptyLabel={loading ? "Loading history..." : "No closed signals yet."} signals={historySignals} />
      </section>

      {isAdmin ? (
        <section className="section-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Admin</span>
                <h2>Pending payments</h2>
              </div>
              <span className="pill pill-warning">{pendingPayments.length} pending</span>
            </div>

            <div className="list-stack">
              {pendingPayments.map((payment) => (
                <div className="list-card list-card-wide" key={payment.id}>
                  <div>
                    <strong>{payment.userEmail}</strong>
                    <span>
                      {payment.plan} • {payment.amount} • {payment.reference}
                    </span>
                  </div>
                  <div className="button-row">
                    <button
                      className="button button-primary"
                      disabled={actionBusy === payment.id}
                      onClick={() => handlePaymentReview(payment.id, "APPROVED")}
                      type="button"
                    >
                      Approve
                    </button>
                    <button
                      className="button button-ghost"
                      disabled={actionBusy === payment.id}
                      onClick={() => handlePaymentReview(payment.id, "REJECTED")}
                      type="button"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
              {!pendingPayments.length ? <div className="empty-state">No pending approvals.</div> : null}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Admin</span>
                <h2>Post manual signal</h2>
              </div>
              <span className="pill pill-accent">Admin only</span>
            </div>

            <form className="form-grid" onSubmit={handleManualSignal}>
              <label>
                <span>Coin</span>
                <input
                  onChange={(event) => setManualForm((current) => ({ ...current, coin: event.target.value.toUpperCase() }))}
                  value={manualForm.coin}
                />
              </label>
              <label>
                <span>Side</span>
                <select
                  onChange={(event) => setManualForm((current) => ({ ...current, side: event.target.value }))}
                  value={manualForm.side}
                >
                  <option value="LONG">LONG</option>
                  <option value="SHORT">SHORT</option>
                </select>
              </label>
              <label>
                <span>Timeframe</span>
                <select
                  onChange={(event) => setManualForm((current) => ({ ...current, timeframe: event.target.value }))}
                  value={manualForm.timeframe}
                >
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                  <option value="1h">1h</option>
                </select>
              </label>
              <label>
                <span>Confidence</span>
                <input
                  max="100"
                  min="50"
                  onChange={(event) => setManualForm((current) => ({ ...current, confidence: event.target.value }))}
                  type="number"
                  value={manualForm.confidence}
                />
              </label>
              <label>
                <span>Entry</span>
                <input
                  onChange={(event) => setManualForm((current) => ({ ...current, entry: event.target.value }))}
                  type="number"
                  value={manualForm.entry}
                />
              </label>
              <label>
                <span>Leverage</span>
                <input
                  max="50"
                  min="10"
                  onChange={(event) => setManualForm((current) => ({ ...current, leverage: event.target.value }))}
                  type="number"
                  value={manualForm.leverage}
                />
              </label>
              <label>
                <span>Stop loss</span>
                <input
                  onChange={(event) => setManualForm((current) => ({ ...current, stopLoss: event.target.value }))}
                  type="number"
                  value={manualForm.stopLoss}
                />
              </label>
              <label>
                <span>TP1</span>
                <input
                  onChange={(event) => setManualForm((current) => ({ ...current, tp1: event.target.value }))}
                  type="number"
                  value={manualForm.tp1}
                />
              </label>
              <label>
                <span>TP2</span>
                <input
                  onChange={(event) => setManualForm((current) => ({ ...current, tp2: event.target.value }))}
                  type="number"
                  value={manualForm.tp2}
                />
              </label>
              <label>
                <span>TP3</span>
                <input
                  onChange={(event) => setManualForm((current) => ({ ...current, tp3: event.target.value }))}
                  type="number"
                  value={manualForm.tp3}
                />
              </label>
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
              <div>
                <span className="eyebrow">Admin</span>
                <h2>Payment settings</h2>
              </div>
              <span className="pill pill-accent">{(paymentSettings?.paymentMethods || []).length} methods</span>
            </div>

            <form className="form-grid" onSubmit={handlePaymentSettingsUpdate}>
              <label className="form-span-2">
                <span>Contact person</span>
                <input
                  onChange={(event) => setContactDraft(event.target.value)}
                  placeholder="+91 8679215898"
                  value={contactDraft}
                />
              </label>
              <button className="button button-primary" disabled={actionBusy === "payment-settings"} type="submit">
                {actionBusy === "payment-settings" ? "Saving..." : "Save contact"}
              </button>
            </form>

            <form className="form-grid" onSubmit={handlePaymentMethodAdd}>
              <label className="form-span-2">
                <span>Add payment method</span>
                <input
                  onChange={(event) => setPaymentMethodDraft(event.target.value)}
                  placeholder="Paytm, Wise, Skrill..."
                  value={paymentMethodDraft}
                />
              </label>
              <button className="button button-secondary" disabled={actionBusy === "payment-method-add"} type="submit">
                {actionBusy === "payment-method-add" ? "Adding..." : "Add method"}
              </button>
            </form>
            {editingMethod ? (
              <form className="form-grid" onSubmit={handlePaymentMethodEdit}>
                <label>
                  <span>Edit method label</span>
                  <input
                    onChange={(event) => setEditingMethodLabel(event.target.value)}
                    placeholder="Readable label"
                    value={editingMethodLabel}
                  />
                </label>
                <label>
                  <span>Edit method value</span>
                  <input
                    onChange={(event) => setEditingMethodValue(event.target.value)}
                    placeholder="VALUE_TOKEN"
                    value={editingMethodValue}
                  />
                </label>
                <div className="button-row form-span-2">
                  <button className="button button-primary" disabled={actionBusy === "payment-method-edit"} type="submit">
                    {actionBusy === "payment-method-edit" ? "Saving..." : "Save method"}
                  </button>
                  <button className="button button-ghost" onClick={cancelPaymentMethodEdit} type="button">
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}

            <div className="list-stack">
              {availablePaymentMethods.map((method) => (
                <div className="list-card list-card-wide" key={method.value}>
                  <div>
                    <strong>{method.label}</strong>
                    <span>{method.value}</span>
                  </div>
                  <div className="button-row">
                    <button
                      className="button button-secondary"
                      disabled={actionBusy === "payment-method-edit" && editingMethod?.value === method.value}
                      onClick={() => startPaymentMethodEdit(method)}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="button button-ghost"
                      disabled={actionBusy === `remove-${method.value}`}
                      onClick={() => handlePaymentMethodRemove(method.value)}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Plans</span>
                <h2>Subscription pricing</h2>
              </div>
            </div>

            <div className="list-stack">
              {availablePlans.map((plan) => (
                <div className="list-card" key={plan.code}>
                  <div>
                    <strong>{plan.code}</strong>
                    <span>{plan.priceLabel}</span>
                  </div>
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
            <div>
              <span className="eyebrow">Admin</span>
              <h2>User management</h2>
            </div>
            <span className="pill pill-neutral">{users.length} users</span>
          </div>

          <div className="list-stack">
            {users.map((account) => {
              const accountExpiryLabel = formatSubscriptionEndsAt(account.subscriptionEndsAt);
              const expiryDate = account.subscriptionEndsAt ? new Date(account.subscriptionEndsAt) : null;
              const isExpired = expiryDate && !Number.isNaN(expiryDate.getTime()) && expiryDate.getTime() < Date.now();
              const accountExpiresSoon =
                expiryDate &&
                !Number.isNaN(expiryDate.getTime()) &&
                expiryDate.getTime() > Date.now() &&
                expiryDate.getTime() - Date.now() <= 5 * 24 * 60 * 60 * 1000;
              return (
                <div className="list-card list-card-wide" key={account.id}>
                  <div>
                    <strong>{account.email}</strong>
                    <span>
                      {account.role} • {account.plan} • {account.subscriptionStatus}
                    </span>
                    <span
                      className={`pill ${
                        accountExpiryLabel ? (isExpired ? "pill-danger" : accountExpiresSoon ? "pill-warning" : "pill-neutral") : "pill-neutral"
                      }`}
                    >
                      {accountExpiryLabel ? `${isExpired ? "Expired" : "Expires"} ${accountExpiryLabel}` : "No expiry set"}
                    </span>
                  </div>

                  <div className="button-row">
                  <button
                    className="button button-secondary"
                    disabled={actionBusy === account.id}
                    onClick={() =>
                      handleUserUpdate(account.id, {
                        role: account.role === "ADMIN" ? "USER" : "ADMIN",
                      })
                    }
                    type="button"
                  >
                    {account.role === "ADMIN" ? "Make user" : "Make admin"}
                  </button>
                  <button
                    className="button button-ghost"
                    disabled={actionBusy === account.id}
                    onClick={() =>
                      handleUserUpdate(account.id, {
                        isActive: !account.isActive,
                      })
                    }
                    type="button"
                  >
                    {account.isActive ? "Suspend" : "Activate"}
                  </button>
                  <button
                    className="button button-ghost"
                    disabled={actionBusy === account.id}
                    onClick={() => handleUserUpdate(account.id, buildPlanUpdate("FREE_TRIAL"))}
                    type="button"
                  >
                    7-day trial
                  </button>
                  <button
                    className="button button-ghost"
                    disabled={actionBusy === account.id}
                    onClick={() => handleUserUpdate(account.id, buildPlanUpdate("PRO"))}
                    type="button"
                  >
                    Set PRO
                  </button>
                  <button
                    className="button button-ghost"
                    disabled={actionBusy === account.id}
                    onClick={() => handleUserUpdate(account.id, buildPlanUpdate("PREMIUM"))}
                    type="button"
                  >
                    Set PREMIUM
                  </button>
                  <button
                    className="button button-ghost"
                    disabled={actionBusy === account.id}
                    onClick={() => handleUserUpdate(account.id, buildPlanUpdate("FREE"))}
                    type="button"
                  >
                    Remove access
                  </button>
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
