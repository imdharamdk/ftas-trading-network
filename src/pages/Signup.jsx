import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../context/useSession";
import { evaluatePasswordStrength } from "../lib/passwordStrength";

export default function Signup() {
  const navigate = useNavigate();
  const { register } = useSession();
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
  });
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const strength = evaluatePasswordStrength(form.password);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError("First name and last name are required.");
      return;
    }

    if (!acceptedTerms) {
      setError("Please accept the Terms of Service and Privacy Policy to continue.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      await register({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        name: `${form.firstName.trim()} ${form.lastName.trim()}`,
        email: form.email,
        password: form.password,
        termsAccepted: acceptedTerms,
        privacyAccepted: acceptedTerms,
      });
      navigate("/dashboard");
    } catch (submissionError) {
      setError(submissionError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-split">
        <div className="auth-panel">
          <span className="pill pill-neutral">Create FTAS Account</span>
          <h2>Signup</h2>
          <p className="muted-copy">Every new user gets a 7-day free trial. The very first account automatically becomes admin so the platform can be initialized.</p>

          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              <span>First Name</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))}
                placeholder="Dharmender"
                type="text"
                value={form.firstName}
              />
            </label>

            <label>
              <span>Last Name</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))}
                placeholder="Kumar"
                type="text"
                value={form.lastName}
              />
            </label>

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
                placeholder="Minimum 6 characters"
                type="password"
                value={form.password}
              />
            </label>

            {!!form.password && (
              <div style={{ marginTop: "-4px", marginBottom: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "6px" }}>
                  <span>Password Strength</span>
                  <span style={{ color: strength.color, fontWeight: 700 }}>{strength.label}</span>
                </div>
                <div style={{ height: "6px", borderRadius: "999px", background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
                  <div style={{ width: `${strength.percent}%`, height: "100%", background: strength.color, transition: "width 180ms ease" }} />
                </div>
                <div style={{ marginTop: "6px", fontSize: "0.75rem", color: "rgba(255,255,255,0.72)" }}>
                  Use 8+ chars with upper, lower, number, and symbol.
                </div>
              </div>
            )}

            <label className="auth-checkbox">
              <input
                checked={acceptedTerms}
                onChange={(event) => setAcceptedTerms(event.target.checked)}
                type="checkbox"
              />
              <span>
                I agree to the <Link to="/terms">Terms of Service</Link> and <Link to="/privacy">Privacy Policy</Link>.
              </span>
            </label>

            {error ? <div className="form-error">{error}</div> : null}

            <button className="button button-primary" disabled={busy} type="submit">
              {busy ? "Creating..." : "Create account"}
            </button>
          </form>

          <div className="auth-links">
            <span>
              Already registered? <Link to="/">Login</Link>
            </span>
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
          </div>
        </div>

        <div className="auth-copy auth-copy-compact">
          <span className="eyebrow">Why Fintech Automated Solutions</span>
          <h1>Scanner, signals, payments and admin approvals in one website.</h1>
          <p>
            No Telegram dependency. Users see active trades, closed trades, confidence score and
            subscription flow directly inside the product. New accounts get full signal access for the first 7 days.
          </p>
        </div>
      </div>
    </div>
  );
}
