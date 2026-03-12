import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AppShell from "../components/AppShell";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";

const fallbackNews = [
  {
    headline: "FTAS signal dashboard is active",
    source: "System",
    summary: "Use the dashboard to watch active and closed signals without Telegram dependency.",
    timePublished: "",
    url: "/dashboard",
  },
  {
    headline: "Scanner uses multi-timeframe confirmation",
    source: "System",
    summary: "EMA, RSI, MACD, volume, ATR and pattern scoring are combined before a signal is shown.",
    timePublished: "",
    url: "/market",
  },
  {
    headline: "Admin review flow is now website-based",
    source: "System",
    summary: "Payment submission and approval can be completed directly inside the FTAS website.",
    timePublished: "",
    url: "/dashboard",
  },
];

function formatPublished(value) {
  if (!value) return "";
  const safeValue = value.includes("T")
    ? value
    : `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}`;
  const date = new Date(safeValue);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function NewsContent({ news, loading }) {
  if (loading) {
    return (
      <section className="news-grid">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <article className="news-card" key={i} style={{ opacity: 0.4 }}>
            <div className="news-card-top">
              <span className="pill pill-neutral">Loading...</span>
            </div>
            <h2 style={{ background: "rgba(255,255,255,0.08)", borderRadius: "6px", height: "1.2rem", width: "70%" }}>&nbsp;</h2>
            <p style={{ background: "rgba(255,255,255,0.05)", borderRadius: "4px", height: "3rem" }}>&nbsp;</p>
          </article>
        ))}
      </section>
    );
  }

  return (
    <section className="news-grid">
      {news.map((item, index) => (
        <article className="news-card" key={`${item.headline}-${index}`}>
          <div className="news-card-top">
            <span className="pill pill-neutral">{item.source || "Market"}</span>
            {item.timePublished ? <span className="news-time">{formatPublished(item.timePublished)}</span> : null}
          </div>
          <h2>{item.headline}</h2>
          <p>{item.summary}</p>
          <a href={item.url} rel="noreferrer" target={item.url.startsWith("http") ? "_blank" : undefined}>
            Open story →
          </a>
        </article>
      ))}
    </section>
  );
}

function NewsFilterActions({ kind, setKind }) {
  return (
    <div className="button-row">
      {["mixed", "finance", "stocks", "crypto"].map((k) => (
        <button
          key={k}
          className={`button ${kind === k ? "button-primary" : "button-ghost"}`}
          onClick={() => setKind(k)}
          type="button"
        >
          {k.charAt(0).toUpperCase() + k.slice(1)}
        </button>
      ))}
    </div>
  );
}

export default function News() {
  const { user } = useSession();
  const [news, setNews] = useState(fallbackNews);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("mixed");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadNews() {
      setLoading(true);
      setError("");
      try {
        // apiFetch automatically attaches auth token if user is logged in
        const response = await apiFetch(`/news?kind=${kind}&limit=9`);
        if (!active) return;

        if (Array.isArray(response.articles) && response.articles.length) {
          setNews(response.articles);
          // If degraded (no API key configured), show soft info banner
          if (response.degraded && response.message) {
            setError(response.message);
          }
        } else {
          setNews(fallbackNews);
          setError("No live articles returned — showing FTAS system updates.");
        }
      } catch (e) {
        if (!active) return;
        setNews(fallbackNews);
        setError(`News feed error: ${e.message}`);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadNews();
    // Auto-refresh every 15 minutes
    const id = window.setInterval(loadNews, 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(id); };
  }, [kind]);

  const filters = <NewsFilterActions kind={kind} setKind={setKind} />;

  if (user) {
    return (
      <AppShell
        actions={filters}
        subtitle="Finance, stocks aur crypto news — live feed ya fallback FTAS updates."
        title="Market News"
      >
        {error ? (
          <div className="banner banner-warning" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>ℹ️ {error}</span>
            <span style={{ opacity: 0.6, fontSize: "0.8rem" }}>Fallback content shown below</span>
          </div>
        ) : null}
        <NewsContent news={news} loading={loading} />
      </AppShell>
    );
  }

  return (
    <div className="public-page">
      <header className="public-header">
        <div>
          <span className="eyebrow">Fintech Automated Solutions News</span>
          <h1>Market context</h1>
        </div>
        <nav className="public-links">
          <Link to="/">Login</Link>
          <Link to="/signup">Signup</Link>
        </nav>
      </header>
      {filters}
      {error ? <div className="banner banner-warning">ℹ️ {error}</div> : null}
      <NewsContent news={news} loading={loading} />
    </div>
  );
}
