import { NavLink } from "react-router-dom";
import { useSession } from "../context/SessionContext";

function navClassName(isActive) {
  return `nav-link${isActive ? " nav-link-active" : ""}`;
}

function formatSubscriptionEndsAt(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

export default function AppShell({ children, title, subtitle, actions = null }) {
  const { logout, user } = useSession();
  const planEnd = formatSubscriptionEndsAt(user?.subscriptionEndsAt);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-block">
            <span className="brand-mark">FTAS</span>
            <p className="brand-copy">Adaptive futures signal desk for website-only delivery.</p>
          </div>

          <nav className="nav-list">
            <NavLink className={({ isActive }) => navClassName(isActive)} to="/dashboard">
              Dashboard
            </NavLink>
            <NavLink className={({ isActive }) => navClassName(isActive)} to="/market">
              Scanner
            </NavLink>
            <NavLink className={({ isActive }) => navClassName(isActive)} to="/news">
              News
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
            <span>{user?.email}</span>
            <span className="profile-muted">
              Plan {user?.plan || "FREE"} • {user?.subscriptionStatus || "INACTIVE"}{planEnd ? ` • till ${planEnd}` : ""}
            </span>
          </div>

          <button className="button button-ghost" onClick={logout} type="button">
            Logout
          </button>
        </div>
      </aside>

      <main className="main">
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
