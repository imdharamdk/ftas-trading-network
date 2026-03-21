import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";

const RESEND_COOLDOWN_SECONDS = 60;

function mapForgotError(errorMessage, step) {
  const raw = String(errorMessage || "").trim();
  const normalized = raw.toLowerCase();

  if (!raw) {
    return step === "request" ? "Unable to send reset code" : "Unable to reset password";
  }

  if (normalized.includes("email is required")) {
    return "Please enter your email first.";
  }

  if (normalized.includes("too many reset attempts") || normalized.includes("too many auth attempts")) {
    return "Too many attempts. Please wait a minute and try again.";
  }

  if (normalized.includes("reset code must be 6 digits")) {
    return "Reset code must be exactly 6 digits.";
  }

  if (normalized.includes("new password must be at least 6 characters")) {
    return "New password must be at least 6 characters long.";
  }

  if (normalized.includes("invalid or expired reset request")) {
    return "Reset code invalid or expired. Please request a new code.";
  }

  return raw;
}

export default function Login() {
  const navigate = useNavigate();
  const { login } = useSession();
  const [form, setForm] = useState({
    email: "",
    password: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [showForgot, setShowForgot] = useState(false);
  const [forgotStep, setForgotStep] = useState("request");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotPassword, setForgotPassword] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotError, setForgotError] = useState("");
  const [forgotMessage, setForgotMessage] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  // Pre-warm Render backend as soon as Login page loads — user fills credentials
  // in ~10-20s, by then backend is already warm, no cold start on first real request.
  useEffect(() => {
    const API = (import.meta.env?.VITE_API_BASE_URL || "/api").replace(/\/+$/, "");
    fetch(API + "/health", { method: "GET", cache: "no-store" }).catch(() => {});
  }, []);

  useEffect(() => {
    if (resendCooldown <= 0) {
      return undefined;
    }

    const timer = setInterval(() => {
      setResendCooldown((current) => (current > 0 ? current - 1 : 0));
    }, 1000);

    return () => clearInterval(timer);
  }, [resendCooldown]);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      await login(form);
      navigate("/dashboard");
    } catch (submissionError) {
      setError(submissionError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleForgotRequest(event) {
    event.preventDefault();
    setForgotBusy(true);
    setForgotError("");
    setForgotMessage("");

    try {
      const payload = await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: { email: forgotEmail },
        skipAuth: true,
      });

      setForgotStep("reset");
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setForgotMessage(payload?.resetCode
        ? `Reset code: ${payload.resetCode} (dev mode)`
        : "If your account exists, reset code has been sent. Check inbox/spam.");
    } catch (requestError) {
      setForgotError(mapForgotError(requestError.message, "request"));
    } finally {
      setForgotBusy(false);
    }
  }

  async function handleResetPassword(event) {
    event.preventDefault();
    setForgotBusy(true);
    setForgotError("");
    setForgotMessage("");

    try {
      await apiFetch("/auth/reset-password", {
        method: "POST",
        body: {
          email: forgotEmail,
          code: forgotCode,
          newPassword: forgotPassword,
        },
        skipAuth: true,
      });
      setForgotMessage("Password reset successful. Please login with new password.");
      setForgotCode("");
      setForgotPassword("");
      setShowForgot(false);
      setForgotStep("request");
      setResendCooldown(0);
    } catch (resetError) {
      setForgotError(mapForgotError(resetError.message, "reset"));
    } finally {
      setForgotBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <div className="auth-copy">
          <span className="eyebrow">Fintech Automated Solutions</span>
          <h1>Website-only crypto signal engine for real futures flow.</h1>
          <p>
            Login to monitor live signals, payment approvals, confidence analytics, and scanner control
            from one desk.
          </p>
          <div className="hero-metrics">
            <div>
              <strong>20+</strong>
              <span>Coins scanned</span>
            </div>
            <div>
              <strong>1m-4h</strong>
              <span>Multi-timeframe</span>
            </div>
            <div>
              <strong>ATR + Fib</strong>
              <span>Risk engine</span>
            </div>
          </div>
        </div>

        <div className="auth-panel">
          <span className="pill pill-accent">Secure Access</span>
          <h2>Login</h2>
          <p className="muted-copy">Use your FTAS account to open the dashboard.</p>

          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              <span>Email</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="you@example.com"
                type="email"
                value={form.email}
              />
            </label>

            <label>
              <span>Password</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="Enter password"
                type="password"
                value={form.password}
              />
            </label>

            {error ? <div className="form-error">{error}</div> : null}

            <button className="button button-primary" disabled={busy} type="submit">
              {busy ? "Signing in..." : "Login"}
            </button>
          </form>

          <button
            className="button button-ghost"
            onClick={() => {
              setShowForgot((v) => !v);
              setForgotError("");
              setForgotMessage("");
              setForgotStep("request");
            }}
            style={{ marginTop: "10px", width: "100%" }}
            type="button"
          >
            {showForgot ? "Close Forgot Password" : "Forgot Password?"}
          </button>

          {showForgot && (
            <div style={{ marginTop: "12px", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px", padding: "12px" }}>
              <h3 style={{ margin: "0 0 8px", fontSize: "1rem" }}>Reset Password</h3>

              <form className="auth-form" onSubmit={forgotStep === "request" ? handleForgotRequest : handleResetPassword}>
                <label>
                  <span>Email</span>
                  <input
                    onChange={(event) => setForgotEmail(event.target.value)}
                    placeholder="you@example.com"
                    type="email"
                    value={forgotEmail}
                  />
                </label>

                {forgotStep === "reset" && (
                  <>
                    <label>
                      <span>Reset Code</span>
                      <input
                        inputMode="numeric"
                        maxLength={6}
                        onChange={(event) => setForgotCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                        placeholder="6-digit code"
                        value={forgotCode}
                      />
                    </label>

                    <label>
                      <span>New Password</span>
                      <input
                        onChange={(event) => setForgotPassword(event.target.value)}
                        placeholder="At least 6 characters"
                        type="password"
                        value={forgotPassword}
                      />
                    </label>
                  </>
                )}

                {forgotError ? <div className="form-error">{forgotError}</div> : null}
                {forgotMessage ? <div className="banner" style={{ marginTop: 0 }}>{forgotMessage}</div> : null}

                <button
                  className="button button-primary"
                  disabled={forgotBusy || (forgotStep === "request" && resendCooldown > 0)}
                  type="submit"
                >
                  {forgotBusy
                    ? "Please wait..."
                    : forgotStep === "request"
                      ? resendCooldown > 0
                        ? `Resend in ${resendCooldown}s`
                        : "Send Reset Code"
                      : "Reset Password"}
                </button>

                {forgotStep === "reset" && (
                  <button
                    className="button button-ghost"
                    disabled={forgotBusy || resendCooldown > 0}
                    onClick={() => {
                      setForgotStep("request");
                      setForgotCode("");
                      setForgotPassword("");
                      setForgotError("");
                      setForgotMessage("");
                    }}
                    type="button"
                  >
                    {resendCooldown > 0 ? `Request New Code (${resendCooldown}s)` : "Request New Code"}
                  </button>
                )}
              </form>
            </div>
          )}

          <div className="auth-links">
            <span>
              No account yet? <Link to="/signup">Create one</Link>
            </span>
            <Link to="/news">View market news</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
