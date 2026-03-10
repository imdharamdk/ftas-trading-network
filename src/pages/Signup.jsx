import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../context/useSession";

export default function Signup() {
  const navigate = useNavigate();
  const { register } = useSession();
  const [form, setForm] = useState({
    name: "",
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
      await register(form);
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
              <span>Name</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Dharmender"
                type="text"
                value={form.name}
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

            {error ? <div className="form-error">{error}</div> : null}

            <button className="button button-primary" disabled={busy} type="submit">
              {busy ? "Creating..." : "Create account"}
            </button>
          </form>

          <div className="auth-links">
            <span>
              Already registered? <Link to="/">Login</Link>
            </span>
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
