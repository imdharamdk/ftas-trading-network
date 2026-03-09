import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useSession } from "../context/SessionContext";

function navClassName(isActive) {
  return `nav-link${isActive ? " nav-link-active" : ""}`;
}

function formatSubscriptionEndsAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short" }).format(date);
}

export default function AppShell({ children, title, subtitle, actions = null }) {
  const { logout, user } = useSession();
  const planEnd = formatSubscriptionEndsAt(user?.subscriptionEndsAt);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="shell">

      {/* ── Sidebar ──────────────────────────────────────────────── */}
      <aside className={`sidebar${menuOpen ? " sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="sidebar-brand-row">
            <div className="brand-block">
              <span className="brand-mark">FTAS</span>
              <p className="brand-copy">Adaptive futures signal desk.</p>
            </div>
            <button
              className="hamburger"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              type="button"
            >
              {menuOpen ? "✕" : "☰"}
            </button>
          </div>

          <nav className="nav-list">
            <NavLink className={({ isActive }) => navClassName(isActive)} to="/dashboard" onClick={() => setMenuOpen(false)}>
              📊 Dashboard
            </NavLink>
            <NavLink className={({ isActive }) => navClassName(isActive)} to="/market" onClick={() => setMenuOpen(false)}>
              🔍 Scanner
            </NavLink>
            <NavLink className={({ isActive }) => navClassName(isActive)} to="/news" onClick={() => setMenuOpen(false)}>
              📰 News
            </NavLink>
          </nav>
        </div>

        <div className="sidebar-footer">
          <div className="profile-card">
            <div className="profile-row">
              <span className="profile-label">Account</span>
              <span className={`pill ${user?.role === "ADMIN" ? "pill-accent" : "pill-neutral"}`}>
                {user?.role || "USER"}
              </span>
            </div>
            <strong>{user?.name || "FTAS User"}</strong>
            <span style={{ wordBreak: "break-all" }}>{user?.email}</span>
            <span className="profile-muted">
              {user?.plan || "FREE"} • {user?.subscriptionStatus || "INACTIVE"}
              {planEnd ? ` • till ${planEnd}` : ""}
            </span>
          </div>
          <button className="button button-ghost" onClick={logout} type="button">
            Logout
          </button>
        </div>
      </aside>

      {/* Overlay — tap outside to close on mobile */}
      {menuOpen && (
        <div className="sidebar-overlay" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}

      {/* ── Main ─────────────────────────────────────────────────── */}
      <main className="main">
        {/* Mobile top bar — always visible on small screens */}
        <div className="mobile-topbar">
          <span className="brand-mark" style={{ fontSize: "1.4rem" }}>FTAS</span>
          <button
            className="hamburger"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Toggle menu"
            type="button"
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        </div>

        <header className="page-header">
          <div>
            <span className="eyebrow">FTAS Control Surface</span>
            <h1>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </header>

        {children}
      </main>
    </div>
  );
}
