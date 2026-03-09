import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useSession } from "../context/SessionContext";

/* ─────────────────────────────────────────────────────────────────────────────
   navClassName
   Returns the correct CSS class string for a NavLink based on whether it is
   currently active. react-router-dom passes { isActive } to the className
   function prop.
───────────────────────────────────────────────────────────────────────────── */
function navClassName(isActive) {
  return `nav-link${isActive ? " nav-link-active" : ""}`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   formatSubscriptionEndsAt
   Formats a subscription expiry ISO date string into a short human-readable
   label like "12 Jun". Returns an empty string if the value is missing or
   cannot be parsed.
───────────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────────
   AppShell
   The main layout wrapper used by every authenticated page.

   Desktop (> 1024px):
     - Two-column grid: fixed sidebar on left, scrollable main on right.
     - Hamburger button is hidden.
     - Mobile topbar is hidden.

   Tablet / Mobile (<= 1024px):
     - Single-column layout — sidebar is removed from the grid.
     - Sidebar becomes a position:fixed off-canvas drawer.
     - Hamburger button (☰ / ✕) is rendered in BOTH:
         a) the sidebar header (so user can close it from inside)
         b) the sticky mobile topbar at the top of <main>
     - Clicking the overlay (dark backdrop) also closes the sidebar.

   Props:
     children  — page content rendered inside <main>
     title     — large h1 displayed in the page header
     subtitle  — optional paragraph below the title
     actions   — optional JSX buttons/controls shown in top-right of page header
───────────────────────────────────────────────────────────────────────────── */
export default function AppShell({ children, title, subtitle, actions = null }) {
  const { logout, user } = useSession();

  // Format subscription end date for the profile card
  const planEnd = formatSubscriptionEndsAt(user?.subscriptionEndsAt);

  // Controls whether the mobile sidebar drawer is open or closed
  const [menuOpen, setMenuOpen] = useState(false);

  // Toggle helpers
  function openMenu() {
    setMenuOpen(true);
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  function toggleMenu() {
    setMenuOpen((current) => !current);
  }

  return (
    <div className="shell">

      {/* ════════════════════════════════════════════════════════════════
          SIDEBAR
          On desktop: sticky, always-visible left column.
          On mobile: fixed off-canvas drawer — slides in from the left
          when sidebar-open class is present.
      ════════════════════════════════════════════════════════════════ */}
      <aside className={`sidebar${menuOpen ? " sidebar-open" : ""}`}>

        {/* Top section — brand block, hamburger, navigation links */}
        <div className="sidebar-top">

          {/* Row: brand mark on left, close button on right (mobile) */}
          <div className="sidebar-brand-row">
            <div className="brand-block">
              <span className="brand-mark">FTAS</span>
              <p className="brand-copy">
                Adaptive futures signal desk for website-only delivery.
              </p>
            </div>

            {/*
              Hamburger inside sidebar — only visible on mobile via CSS.
              Allows user to close the drawer from inside the sidebar.
              On desktop this button is display:none.
            */}
            <button
              aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
              className="hamburger"
              onClick={toggleMenu}
              type="button"
            >
              {menuOpen ? "✕" : "☰"}
            </button>
          </div>

          {/* Navigation links — each click also closes the mobile drawer */}
          <nav className="nav-list" aria-label="Main navigation">
            <NavLink
              className={({ isActive }) => navClassName(isActive)}
              onClick={closeMenu}
              to="/dashboard"
            >
              📊 Dashboard
            </NavLink>

            <NavLink
              className={({ isActive }) => navClassName(isActive)}
              onClick={closeMenu}
              to="/market"
            >
              🔍 Scanner
            </NavLink>

            <NavLink
              className={({ isActive }) => navClassName(isActive)}
              onClick={closeMenu}
              to="/news"
            >
              📰 News
            </NavLink>
          </nav>
        </div>

        {/* Footer section — user profile card + logout */}
        <div className="sidebar-footer">
          <div className="profile-card">
            <div className="profile-row">
              <span className="profile-label">Account</span>
              <span
                className={`pill ${
                  user?.role === "ADMIN" ? "pill-accent" : "pill-neutral"
                }`}
              >
                {user?.role || "USER"}
              </span>
            </div>

            <strong>{user?.name || "FTAS User"}</strong>

            <span style={{ wordBreak: "break-all", fontSize: "0.85rem" }}>
              {user?.email}
            </span>

            <span className="profile-muted">
              Plan {user?.plan || "FREE"} &bull; {user?.subscriptionStatus || "INACTIVE"}
              {planEnd ? ` • till ${planEnd}` : ""}
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

      {/* ════════════════════════════════════════════════════════════════
          SIDEBAR OVERLAY
          Dark translucent backdrop shown on mobile when sidebar is open.
          Tapping it closes the sidebar.
          Hidden on desktop (display:none via CSS).
      ════════════════════════════════════════════════════════════════ */}
      {menuOpen && (
        <div
          aria-hidden="true"
          className="sidebar-overlay"
          onClick={closeMenu}
        />
      )}

      {/* ════════════════════════════════════════════════════════════════
          MAIN CONTENT AREA
      ════════════════════════════════════════════════════════════════ */}
      <main className="main">

        {/* ────────────────────────────────────────────────────────────
            MOBILE TOPBAR
            Sticky bar shown ONLY on mobile (display:none on desktop
            via CSS, display:flex at <= 1024px via media query).
            Shows the FTAS brand mark and a hamburger toggle button.
        ──────────────────────────────────────────────────────────── */}
        <div className="mobile-topbar">
          <span className="brand-mark" style={{ fontSize: "1.4rem" }}>
            FTAS
          </span>

          <button
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            className="hamburger"
            onClick={toggleMenu}
            type="button"
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        </div>

        {/* ────────────────────────────────────────────────────────────
            PAGE HEADER
            Rendered below the mobile topbar (or at the very top on
            desktop). Contains:
              - eyebrow label "FTAS Control Surface"
              - h1 title (from props)
              - optional subtitle paragraph (from props)
              - optional actions slot (from props, e.g. Refresh button)
        ──────────────────────────────────────────────────────────── */}
        <header className="page-header">
          <div>
            <span className="eyebrow">FTAS Control Surface</span>
            <h1>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>

          {actions ? (
            <div className="page-actions">
              {actions}
            </div>
          ) : null}
        </header>

        {/* ────────────────────────────────────────────────────────────
            PAGE CONTENT
            Rendered by each individual page component as children.
        ──────────────────────────────────────────────────────────── */}
        {children}
      </main>
    </div>
  );
}
