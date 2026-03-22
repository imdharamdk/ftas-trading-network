import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
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
  { to: "/market", icon: "🔍", label: "Scanner" },
  { to: "/crypto", icon: "💹", label: "Crypto" },
  { to: "/stocks", icon: "🇮🇳", label: "Stocks" },
  { to: "/news", icon: "📰", label: "News" },
  { to: "/community", icon: "👥", label: "Community" },
];

const SIDEBAR_EXTRA = [{ to: "/settings", icon: "⚙️", label: "Settings" }];

export default function AppShell({ actions = null, children, subtitle, title }) {
  const { logout, user } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [lastSyncAt, setLastSyncAt] = useState(Date.now());
  const [toasts, setToasts] = useState([]);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");

  const isAdmin = user?.role === "ADMIN";
  const planEnd = fmtExpiry(user?.subscriptionEndsAt);
  const showPlanEnd = !isAdmin && planEnd;

  const close = () => setOpen(false);
  const toggle = () => setOpen((o) => !o);

  const isAdminPage = location.pathname.startsWith("/settings");

  const allCommands = useMemo(() => {
    const base = [...NAV_ITEMS, ...SIDEBAR_EXTRA];
    return base.map((item) => ({
      id: item.to,
      label: item.label,
      icon: item.icon,
      to: item.to,
    }));
  }, []);

  const visibleCommands = useMemo(() => {
    const q = commandQuery.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter((item) => item.label.toLowerCase().includes(q) || item.to.includes(q));
  }, [allCommands, commandQuery]);

  function pushToast(kind, text) {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current, { id, kind, text }].slice(-4));
    setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, 3000);
  }

  useEffect(() => {
    const API = (import.meta.env?.VITE_API_BASE_URL || "/api").replace(/\/+$/, "");
    const ping = () =>
      fetch(API + "/health", { method: "GET", cache: "no-store" })
        .then(() => setLastSyncAt(Date.now()))
        .catch(() => {});

    ping();
    const id = setInterval(ping, 4 * 60 * 1000);
    const onFocus = () => ping();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      pushToast("success", "Back online");
    };
    const onOffline = () => {
      setIsOnline(false);
      pushToast("danger", "You are offline");
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    function onApiSuccess() {
      setLastSyncAt(Date.now());
    }

    function onKeyDown(event) {
      const targetTag = String(event.target?.tagName || "").toLowerCase();
      const editable = targetTag === "input" || targetTag === "textarea" || event.target?.isContentEditable;
      if (event.key === "/" && !editable) {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
      }
    }

    window.addEventListener("ftas:api-success", onApiSuccess);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("ftas:api-success", onApiSuccess);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  function selectCommand(item) {
    setCommandOpen(false);
    setCommandQuery("");
    navigate(item.to);
  }

  const lastSyncLabel = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date(lastSyncAt));

  return (
    <div className="shell">
      {!isOnline ? <div className="offline-banner">Offline mode: reconnecting when network is back.</div> : null}

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
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} className={navCls} onClick={close} to={item.to}>
                {item.icon} {item.label}
              </NavLink>
            ))}
            {SIDEBAR_EXTRA.map((item) => (
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
              <span className={`pill ${isAdmin ? "pill-accent" : "pill-neutral"}`}>{user?.role || "USER"}</span>
            </div>
            <strong>{user?.name || "FTAS Member"}</strong>
            <span>{user?.email}</span>
            <span className="profile-muted">
              {user?.plan || "FREE"} &bull; {user?.subscriptionStatus || "INACTIVE"}
              {showPlanEnd ? ` · valid till ${planEnd}` : ""}
            </span>
          </div>
          <button className="button button-ghost" onClick={logout} style={{ width: "100%" }} type="button">Logout</button>
          <div className="legal-links">
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
          </div>
        </div>
      </aside>

      {open ? <div aria-hidden="true" className="sidebar-overlay" onClick={close} /> : null}

      <main className="main">
        <div className="mobile-topbar">
          <span className="brand-mark" style={{ fontSize: "1.35rem" }}>FTAS</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="button button-ghost" onClick={() => setCommandOpen(true)} style={{ minHeight: 32, padding: "0 10px" }} type="button">⌘</button>
            {isAdmin ? (
              <button
                onClick={toggle}
                type="button"
                style={{
                  background: "rgba(255,138,61,0.15)",
                  border: "1px solid rgba(255,138,61,0.3)",
                  borderRadius: 8,
                  color: "var(--c-accent)",
                  cursor: "pointer",
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  padding: "5px 10px",
                  letterSpacing: "0.05em",
                }}
              >
                ⚡ ADMIN
              </button>
            ) : (
              <div className="topbar-live">LIVE</div>
            )}
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
            <p style={{ fontSize: "0.72rem", opacity: 0.7, marginTop: 4 }}>Last sync: {lastSyncLabel}</p>
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </header>

        {children}
      </main>

      <nav aria-label="Mobile navigation" className="bottom-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => `bottom-nav-item${isActive ? " active" : ""}`}>
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}

        {isAdmin ? (
          <button type="button" onClick={toggle} className={`bottom-nav-item${isAdminPage ? " active" : ""}`}>
            <span className="nav-icon">🛠️</span>
            <span>Admin</span>
          </button>
        ) : (
          <NavLink to="/settings" className={({ isActive }) => `bottom-nav-item${isActive ? " active" : ""}`}>
            <span className="nav-icon">⚙️</span>
            <span>Settings</span>
          </NavLink>
        )}
      </nav>

      {commandOpen ? (
        <div className="command-overlay" onClick={() => setCommandOpen(false)}>
          <div className="command-modal" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              className="command-input"
              onChange={(event) => setCommandQuery(event.target.value)}
              placeholder="Type page name or path..."
              value={commandQuery}
            />
            <div className="command-list">
              {visibleCommands.map((item) => (
                <button key={item.id} className="command-item" onClick={() => selectCommand(item)} type="button">
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                  <span style={{ marginLeft: "auto", opacity: 0.55 }}>{item.to}</span>
                </button>
              ))}
              {!visibleCommands.length ? <div className="empty-state" style={{ padding: 12 }}>No matches</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            {toast.text}
          </div>
        ))}
      </div>

      <ChatBox />
    </div>
  );
}
