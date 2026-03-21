import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
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

// Bottom nav — 5 items for regular users
const NAV_ITEMS = [
  { to: "/dashboard", icon: "📊", label: "Dashboard" },
  { to: "/market",    icon: "🔍", label: "Scanner"   },
  { to: "/crypto",    icon: "💹", label: "Crypto"    },
  { to: "/stocks",    icon: "🇮🇳", label: "Stocks"    },
  { to: "/news",      icon: "📰", label: "News"      },
  { to: "/community", icon: "👥", label: "Community" },
];

// Sidebar only (all users)
const SIDEBAR_EXTRA = [
  { to: "/settings", icon: "⚙️", label: "Settings" },
];

// Admin-only tools
const ADMIN_NAV_ITEMS = [
  { to: "/analytics",      icon: "📈", label: "Analytics" },
  { to: "/post-generator", icon: "✍️", label: "Post Gen"  },
];

export default function AppShell({ actions = null, children, subtitle, title }) {
  const { logout, user } = useSession();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // FIX: Keep Render backend alive — ping every 4 min to prevent 30-50s cold start
  // Render free tier spins down after 15 min of inactivity. 4 min gap = safe buffer.
  // Also ping on tab focus so returning users don't hit a cold backend.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const [, _keepAlive] = useState(() => {
    const API = (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL || "/api").replace(/\/+$/, "");
    const ping = () => fetch(API + "/health", { method: "GET", cache: "no-store" }).catch(() => {});
    ping(); // immediate ping on mount
    const id = setInterval(ping, 4 * 60 * 1000); // every 4 min
    // Also wake backend when user returns to tab
    const onFocus = () => ping();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus); };
  });
  const isAdmin  = user?.role === "ADMIN";
  const planEnd  = fmtExpiry(user?.subscriptionEndsAt);
  const showPlanEnd = !isAdmin && planEnd;

  const close  = () => setOpen(false);
  const toggle = () => setOpen(o => !o);

  // Check if current page is an admin page (for bottom nav active state)
  const isAdminPage = ADMIN_NAV_ITEMS.some(i => location.pathname.startsWith(i.to))
    || location.pathname.startsWith("/settings");

  return (
    <div className="shell">

      {/* ── SIDEBAR ── */}
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
            {SIDEBAR_EXTRA.map(item => (
              <NavLink key={item.to} className={navCls} onClick={close} to={item.to}>
                {item.icon} {item.label}
              </NavLink>
            ))}

            {/* Admin tools section */}
            {isAdmin && (
              <>
                <div style={{ borderTop: "1px solid rgba(255,255,255,0.07)", margin: "8px 0 4px", paddingTop: 8 }}>
                  <span style={{ color: "rgba(255,138,61,0.7)", fontSize: "0.65rem", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase" }}>
                    Admin Tools
                  </span>
                </div>
                {ADMIN_NAV_ITEMS.map(item => (
                  <NavLink key={item.to} className={navCls} onClick={close} to={item.to}>
                    {item.icon} {item.label}
                  </NavLink>
                ))}
              </>
            )}
          </nav>
        </div>

        <div className="sidebar-footer">
          <div className="profile-card">
            <div className="profile-row">
              <span className="profile-label">Account</span>
              <span className={`pill ${isAdmin ? "pill-accent" : "pill-neutral"}`}>
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
          <div className="legal-links">
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
          </div>
        </div>
      </aside>

      {open && <div aria-hidden="true" className="sidebar-overlay" onClick={close} />}

      {/* ── MAIN ── */}
      <main className="main">
        <div className="mobile-topbar">
          <span className="brand-mark" style={{ fontSize: "1.35rem" }}>FTAS</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Admin badge */}
            {isAdmin && (
              <button
                onClick={toggle}
                type="button"
                style={{
                  background: "rgba(255,138,61,0.15)",
                  border: "1px solid rgba(255,138,61,0.3)",
                  borderRadius: 8, color: "var(--c-accent)",
                  cursor: "pointer", fontSize: "0.72rem",
                  fontWeight: 700, padding: "5px 10px",
                  letterSpacing: "0.05em",
                }}
              >
                ⚡ ADMIN
              </button>
            )}
            {/* LIVE dot for regular users */}
            {!isAdmin && <div className="topbar-live">LIVE</div>}
            {/* Logout button — always visible on mobile topbar */}
            <button
              onClick={logout}
              type="button"
              title="Logout"
              style={{
                alignItems: "center",
                background: "rgba(255,85,119,0.1)",
                border: "1px solid rgba(255,85,119,0.25)",
                borderRadius: 8,
                color: "#ff5577",
                cursor: "pointer",
                display: "flex",
                fontSize: "0.75rem",
                fontWeight: 700,
                gap: 4,
                padding: "5px 10px",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span>⏻</span>
              <span>Logout</span>
            </button>
          </div>
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

      {/* ── BOTTOM NAV ── */}
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

        {/* Admin: replace last item with "More" that opens sidebar showing admin tools */}
        {isAdmin ? (
          <button
            type="button"
            onClick={toggle}
            className={`bottom-nav-item${isAdminPage ? " active" : ""}`}
          >
            <span className="nav-icon">🛠️</span>
            <span>Admin</span>
          </button>
        ) : (
          <NavLink
            to="/settings"
            className={({ isActive }) => `bottom-nav-item${isActive ? " active" : ""}`}
          >
            <span className="nav-icon">⚙️</span>
            <span>Settings</span>
          </NavLink>
        )}
      </nav>

      <ChatBox />
    </div>
  );
}
