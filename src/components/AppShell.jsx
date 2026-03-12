import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useSession } from "../context/useSession";

function navCls({ isActive }) {
  return `nav-link${isActive ? " nav-link-active" : ""}`;
}

function fmtExpiry(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" }).format(d);
}

export default function AppShell({ actions = null, children, subtitle, title }) {
  const { logout, user } = useSession();
  const [open, setOpen] = useState(false);
  const planEnd = fmtExpiry(user?.subscriptionEndsAt);
  const showPlanEnd = user?.role !== "ADMIN" && planEnd;

  const close = () => setOpen(false);
  const toggle = () => setOpen(o => !o);

  return (
    <div className="shell">

      {/* ── SIDEBAR (off-canvas on mobile, sticky on desktop) ── */}
      <aside className={`sidebar${open ? " sidebar-open" : ""}`}>
        <div className="sidebar-top">

          {/* Brand row + close button */}
          <div className="sidebar-brand-row">
            <div className="brand-block">
              <span className="brand-mark">FTAS</span>
              <p className="brand-copy">Fintech automated solutions for futures signals, payments, and scanner control.</p>
            </div>
            {/* Close button inside sidebar (mobile) */}
            <button
              aria-label="Close menu"
              className="hamburger"
              onClick={toggle}
              type="button"
            >
              {open ? "✕" : "☰"}
            </button>
          </div>

          {/* Nav links */}
          <nav aria-label="Main navigation" className="nav-list">
            <NavLink className={navCls} onClick={close} to="/dashboard">
              📊 Dashboard
            </NavLink>
            <NavLink className={navCls} onClick={close} to="/market">
              🔍 Scanner
            </NavLink>
            <NavLink className={navCls} onClick={close} to="/crypto">
              💹 Crypto
            </NavLink>
            <NavLink className={navCls} onClick={close} to="/stocks">
              🇮🇳 Stocks
            </NavLink>
            <NavLink className={navCls} onClick={close} to="/news">
              📰 News
            </NavLink>
          </nav>
        </div>

        {/* Profile + logout */}
        <div className="sidebar-footer">
          <div className="profile-card">
            <div className="profile-row">
              <span className="profile-label">Account</span>
              <span className={`pill ${user?.role === "ADMIN" ? "pill-accent" : "pill-neutral"}`}>
                {user?.role || "USER"}
              </span>
            </div>
            <strong>{user?.name || "FTAS Member"}</strong>
            <span>{user?.email}</span>
            <span className="profile-muted">
              {user?.plan || "FREE"} &bull; {user?.subscriptionStatus || "INACTIVE"}
              {showPlanEnd ? ` · valid till ${planEnd}` : ""}
            </span>
          </div>
          <button
            className="button button-ghost"
            onClick={logout}
            style={{ width: "100%" }}
            type="button"
          >
            Logout
          </button>
        </div>
      </aside>

      {/* ── OVERLAY (mobile only, tap to close) ── */}
      {open && (
        <div
          aria-hidden="true"
          className="sidebar-overlay"
          onClick={close}
        />
      )}

      {/* ── MAIN ── */}
      <main className="main">

        {/* Mobile sticky topbar — shown only on mobile via CSS */}
        <div className="mobile-topbar">
          <span className="brand-mark" style={{ fontSize: "1.4rem" }}>FTAS</span>
          <button
            aria-label={open ? "Close menu" : "Open menu"}
            className="hamburger"
            onClick={toggle}
            type="button"
          >
            {open ? "✕" : "☰"}
          </button>
        </div>

        {/* Page header */}
        <header className="page-header">
          <div>
            <span className="eyebrow">Fintech Automated Solutions</span>
            <h1>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </header>

        {/* Page content */}
        {children}
      </main>
    </div>
  );
}
