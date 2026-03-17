import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useSession } from "../context/useSession";
import ChatBox from "./ChatBox";

function navCls({ isActive }) {
  return `nav-link${isActive ? " nav-link-active" : ""}`;
}

function fmtExpiry(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" }).format(d);
}

const NAV_ITEMS = [
  { to: "/dashboard", icon: "📊", label: "Dashboard" },
  { to: "/market",    icon: "🔍", label: "Scanner"   },
  { to: "/crypto",    icon: "💹", label: "Crypto"    },
  { to: "/stocks",    icon: "🇮🇳", label: "Stocks"    },
  { to: "/news",      icon: "📰", label: "News"      },
];

export default function AppShell({ actions = null, children, subtitle, title }) {
  const { logout, user } = useSession();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const planEnd = fmtExpiry(user?.subscriptionEndsAt);
  const showPlanEnd = user?.role !== "ADMIN" && planEnd;

  const close  = () => setOpen(false);
  const toggle = () => setOpen(o => !o);

  return (
    <div className="shell">

      <aside className={`sidebar${open ? " sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="sidebar-brand-row">
            <div className="brand-block">
              <span className="brand-mark">FTAS</span>
              <p className="brand-copy">AI-powered signals for crypto, Indian equities, F&O and commodities.</p>
            </div>
            <button aria-label="Close menu" className="hamburger" onClick={toggle} type="button">✕</button>
          </div>

          <nav aria-label="Main navigation" className="nav-list">
            {NAV_ITEMS.map(item => (
              <NavLink key={item.to} className={navCls} onClick={close} to={item.to}>
                {item.icon} {item.label}
              </NavLink>
            ))}
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
            <strong>{user?.name || "FTAS Member"}</strong>
            <span>{user?.email}</span>
            <span className="profile-muted">
              {user?.plan || "FREE"} &bull; {user?.subscriptionStatus || "INACTIVE"}
              {showPlanEnd ? ` · valid till ${planEnd}` : ""}
            </span>
          </div>
          <button className="button button-ghost" onClick={logout} style={{ width: "100%" }} type="button">
            Logout
          </button>
        </div>
      </aside>

      {open && <div aria-hidden="true" className="sidebar-overlay" onClick={close} />}

      <main className="main">
        <div className="mobile-topbar">
          <span className="brand-mark" style={{ fontSize: "1.35rem" }}>FTAS</span>
          <div className="topbar-live">LIVE</div>
        </div>

        <header className="page-header">
          <div>
            <span className="eyebrow">Fintech Automated Solutions</span>
            <h1>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </header>

        {children}
      </main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        {NAV_ITEMS.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `bottom-nav-item${isActive ? " active" : ""}`}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <ChatBox />
    </div>
  );
}
