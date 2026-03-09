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
  if (!value) {
    return "";
  }

  const safeValue = value.includes("T")
    ? value
    : `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}`;

  const date = new Date(safeValue);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

function NewsContent({ news }) {
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
            Open story
          </a>
        </article>
      ))}
    </section>
  );
}

function NewsFilterActions({ kind, setKind }) {
  return (
    <div className="button-row">
      <button
        className={`button ${kind === "mixed" ? "button-primary" : "button-ghost"}`}
        onClick={() => setKind("mixed")}
        type="button"
      >
        Mixed
      </button>
      <button
        className={`button ${kind === "finance" ? "button-primary" : "button-ghost"}`}
        onClick={() => setKind("finance")}
        type="button"
      >
        Finance
      </button>
      <button
        className={`button ${kind === "crypto" ? "button-primary" : "button-ghost"}`}
        onClick={() => setKind("crypto")}
        type="button"
      >
        Crypto
      </button>
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
      try {
        const response = await apiFetch(`/news?kind=${kind}&limit=9`, { skipAuth: true });

        if (!active) {
          return;
        }

        if (Array.isArray(response.articles) && response.articles.length) {
          setNews(response.articles);
          setError(response.degraded ? response.message || "Live news feed unavailable, fallback FTAS updates shown." : "");
        } else {
          setNews(fallbackNews);
          setError("Live news API se data nahi mila, fallback FTAS updates shown.");
        }
      } catch {
        if (!active) {
          return;
        }

        setNews(fallbackNews);
        setError("Live news API unavailable hai, fallback FTAS updates shown.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    setLoading(true);
    loadNews();

    return () => {
      active = false;
    };
  }, [kind]);

  const filters = <NewsFilterActions kind={kind} setKind={setKind} />;

  if (user) {
    return (
      <AppShell
        actions={filters}
        subtitle="Free news API se finance aur crypto stories, fallback content ke saath."
        title="Market News"
      >
        {error ? <div className="banner banner-warning">{error}</div> : null}
        {loading ? <div className="banner banner-warning">Loading news feed...</div> : null}
        <NewsContent news={news} />
      </AppShell>
    );
  }

  return (
    <div className="public-page">
      <header className="public-header">
        <div>
          <span className="eyebrow">Fintech Automated Solutions News</span>
          <h1>Market context before login</h1>
        </div>
        <nav className="public-links">
          <Link to="/">Login</Link>
          <Link to="/signup">Signup</Link>
        </nav>
      </header>
      {filters}
      {error ? <div className="banner banner-warning">{error}</div> : null}
      {loading ? <div className="banner banner-warning">Loading news feed...</div> : null}
      <NewsContent news={news} />
    </div>
  );
}
