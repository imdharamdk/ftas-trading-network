import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signInWithPopup } from "firebase/auth";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";
import { ensureFirebaseAuth, isFirebaseConfigured } from "../lib/firebase";
import { evaluatePasswordStrength } from "../lib/passwordStrength";

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

function isTermsRequiredError(error) {
  const message = String(error?.message || "").trim().toLowerCase();
  return message.includes("terms of service") || message.includes("privacy policy") || message.includes("accept the terms");
}

function mapGoogleError(error) {
  const message = String(error?.message || "").trim();
  const normalized = message.toLowerCase();

  if (normalized.includes("popup closed")) {
    return "Google sign-in was cancelled.";
  }

  return message || "Google sign-in failed";
}

function splitNameParts(name) {
  const normalized = String(name || "").trim();
  if (!normalized) {
    return { firstName: "", lastName: "" };
  }

  const [firstName = "", ...rest] = normalized.split(/\s+/);
  return {
    firstName,
    lastName: rest.join(" ").trim(),
  };
}

export default function Login() {
  const navigate = useNavigate();
  const { login, loginWithFirebase } = useSession();
  const [form, setForm] = useState({
    email: "",
    password: "",
    otp: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [otpRequired, setOtpRequired] = useState(false);
  const [pendingGoogleSignup, setPendingGoogleSignup] = useState(null);
  const [googleTermsAccepted, setGoogleTermsAccepted] = useState(false);

  const [showForgot, setShowForgot] = useState(false);
  const [forgotStep, setForgotStep] = useState("request");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotPassword, setForgotPassword] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotError, setForgotError] = useState("");
  const [forgotMessage, setForgotMessage] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  const resetStrength = evaluatePasswordStrength(forgotPassword);

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
    setPendingGoogleSignup(null);
    setGoogleTermsAccepted(false);

    try {
      await login(form);
      setOtpRequired(false);
      navigate("/dashboard");
    } catch (submissionError) {
      if (submissionError?.code === "OTP_REQUIRED" || String(submissionError?.message || "").toLowerCase().includes("otp required")) {
        setOtpRequired(true);
        setError("2FA enabled hai. Authenticator app ka 6-digit OTP enter karo.");
      } else if (submissionError?.code === "OTP_INVALID" || String(submissionError?.message || "").toLowerCase().includes("invalid otp")) {
        setOtpRequired(true);
        setError("Invalid OTP. Please try again.");
      } else {
        setError(submissionError.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogleSignIn() {
    setGoogleBusy(true);
    setError("");
    setOtpRequired(false);
    setPendingGoogleSignup(null);
    setGoogleTermsAccepted(false);

    try {
      const { auth, googleProvider } = ensureFirebaseAuth();
      const result = await signInWithPopup(auth, googleProvider);
      const firebaseUser = result.user;
      const idToken = await firebaseUser.getIdToken();
      await loginWithFirebase({ idToken });
      navigate("/dashboard");
    } catch (googleError) {
      if (isTermsRequiredError(googleError)) {
        const { auth } = ensureFirebaseAuth();
        const currentUser = auth.currentUser;
        const profileName = String(currentUser?.displayName || "").trim();
        setPendingGoogleSignup({
          email: String(currentUser?.email || "").trim(),
          name: profileName,
          ...splitNameParts(profileName),
        });
        setError("");
      } else {
        setError(mapGoogleError(googleError));
      }
    } finally {
      setGoogleBusy(false);
    }
  }

  async function handleGoogleSignupCompletion() {
    if (!googleTermsAccepted) {
      setError("Please accept the Terms of Service and Privacy Policy to continue.");
      return;
    }

    setGoogleBusy(true);
    setError("");

    try {
      const { auth } = ensureFirebaseAuth();
      const currentUser = auth.currentUser;

      if (!currentUser) {
        throw new Error("Google session expired. Please continue with Google again.");
      }

      const fallbackName = String(currentUser.displayName || pendingGoogleSignup?.name || "").trim();
      const nameParts = splitNameParts(fallbackName);
      const idToken = await currentUser.getIdToken(true);

      await loginWithFirebase({
        idToken,
        name: fallbackName,
        firstName: pendingGoogleSignup?.firstName || nameParts.firstName,
        lastName: pendingGoogleSignup?.lastName || nameParts.lastName,
        termsAccepted: true,
        privacyAccepted: true,
      });
      navigate("/dashboard");
    } catch (googleError) {
      setError(mapGoogleError(googleError));
    } finally {
      setGoogleBusy(false);
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

            {otpRequired && (
              <label>
                <span>Authenticator OTP</span>
                <input
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setForm((current) => ({ ...current, otp: event.target.value.replace(/[^0-9]/g, "").slice(0, 6) }))}
                  placeholder="6-digit OTP"
                  value={form.otp}
                />
              </label>
            )}

            {error ? <div className="form-error">{error}</div> : null}

            <button className="button button-primary" disabled={busy || googleBusy} type="submit">
              {busy ? "Signing in..." : "Login"}
            </button>
          </form>

          {isFirebaseConfigured ? (
            <button
              className="button button-secondary"
              disabled={busy || googleBusy}
              onClick={handleGoogleSignIn}
              style={{ marginTop: "10px", width: "100%" }}
              type="button"
            >
              {googleBusy ? "Connecting to Google..." : "Continue with Google"}
            </button>
          ) : null}

          {pendingGoogleSignup ? (
            <div style={{ marginTop: "12px", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px", padding: "12px" }}>
              <h3 style={{ margin: "0 0 8px", fontSize: "1rem" }}>Complete Google signup</h3>
              <p className="muted-copy" style={{ marginBottom: "10px" }}>
                {pendingGoogleSignup.email
                  ? `${pendingGoogleSignup.email} ka FTAS account abhi create hoga.`
                  : "Aapka FTAS account abhi create hoga."} Terms accept karke direct continue karo.
              </p>
              <label className="auth-checkbox">
                <input
                  checked={googleTermsAccepted}
                  onChange={(event) => setGoogleTermsAccepted(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  I agree to the <Link to="/terms">Terms of Service</Link> and <Link to="/privacy">Privacy Policy</Link>.
                </span>
              </label>
              <button
                className="button button-primary"
                disabled={googleBusy}
                onClick={handleGoogleSignupCompletion}
                style={{ marginTop: "12px", width: "100%" }}
                type="button"
              >
                {googleBusy ? "Creating account..." : "Accept and continue"}
              </button>
            </div>
          ) : null}

          <button
            className="button button-ghost"
            onClick={() => {
              setShowForgot((v) => !v);
              setForgotError("");
              setForgotMessage("");
              setForgotStep("request");
              setOtpRequired(false);
              setForm((current) => ({ ...current, otp: "" }));
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

                    {!!forgotPassword && (
                      <div style={{ marginTop: "-4px", marginBottom: "8px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "6px" }}>
                          <span>Password Strength</span>
                          <span style={{ color: resetStrength.color, fontWeight: 700 }}>{resetStrength.label}</span>
                        </div>
                        <div style={{ height: "6px", borderRadius: "999px", background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
                          <div style={{ width: `${resetStrength.percent}%`, height: "100%", background: resetStrength.color, transition: "width 180ms ease" }} />
                        </div>
                      </div>
                    )}
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
