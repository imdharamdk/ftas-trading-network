import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../context/SessionContext";

export default function Login() {
  const navigate = useNavigate();
  const { login } = useSession();
  const [form, setForm] = useState({
    email: "",
    password: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <div className="auth-copy">
          <span className="eyebrow">FTAS Trading Network</span>
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

          <div className="auth-links">
            <span>
              No account yet? <Link to="/signup">Create one</Link>
            </span>
            <Link to="/news">View market news</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
