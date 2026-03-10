const axios = require("axios");

const client = axios.create({
  baseURL: "https://www.alphavantage.co/query",
  timeout: 15000,
});

const cache = new Map();
const NEWS_CACHE_MS = Number(process.env.NEWS_CACHE_MS || 15 * 60 * 1000);
const FALLBACK_ARTICLES = {
  crypto: [
    {
      bannerImage: "",
      headline: "Crypto watchlist stays available even without a third-party news key",
      source: "FTAS Fallback",
      summary: "Configure ALPHA_VANTAGE_API_KEY for live headlines, or keep fallback mode enabled for a stable feed.",
      timePublished: "",
      url: "/news",
    },
    {
      bannerImage: "",
      headline: "Signal board continues to work independently of the news provider",
      source: "FTAS Fallback",
      summary: "Scanner, active signals, and payment flow keep running even if the external news API is disabled.",
      timePublished: "",
      url: "/dashboard",
    },
    {
      bannerImage: "",
      headline: "Use market view for live pair discovery while news runs in fallback mode",
      source: "FTAS Fallback",
      summary: "The market page still loads futures pairs and chart data separately from the news provider.",
      timePublished: "",
      url: "/market",
    },
  ],
  finance: [
    {
      bannerImage: "",
      headline: "Payment review and subscription updates remain available during news degradation",
      source: "FTAS Fallback",
      summary: "Admin plan approvals and account state changes do not depend on Alpha Vantage availability.",
      timePublished: "",
      url: "/dashboard",
    },
    {
      bannerImage: "",
      headline: "Deploy backend with a real news API key for production finance headlines",
      source: "FTAS Fallback",
      summary: "Set ALPHA_VANTAGE_API_KEY in backend environment settings to replace fallback articles with live feed data.",
      timePublished: "",
      url: "/news",
    },
    {
      bannerImage: "",
      headline: "Static frontend and Node backend should be deployed separately",
      source: "FTAS Fallback",
      summary: "Keep Vercel for the React app and a Node host such as Render for the API and scheduled scanner.",
      timePublished: "",
      url: "/news",
    },
  ],
  stocks: [
    {
      bannerImage: "",
      headline: "Indian indices dashboard",
      source: "FTAS Fallback",
      summary: "Monitor NIFTY, BANKNIFTY, and F&O signals in the Stocks tab once your SmartAPI keys are configured.",
      timePublished: "",
      url: "/stocks",
    },
    {
      bannerImage: "",
      headline: "Angel One SmartAPI connected",
      source: "FTAS Fallback",
      summary: "Upload SmartAPI credentials in Render to fetch live quotes, candles, and scan F&O contracts.",
      timePublished: "",
      url: "/render.yaml",
    },
    {
      bannerImage: "",
      headline: "Stock engine controls live in dashboard",
      source: "FTAS Fallback",
      summary: "Start, stop, or manually scan the Indian market engine from Mission Control just like the crypto scanner.",
      timePublished: "",
      url: "/dashboard",
    },
  ],
};
FALLBACK_ARTICLES.mixed = [
  ...FALLBACK_ARTICLES.finance,
  ...FALLBACK_ARTICLES.crypto,
  ...FALLBACK_ARTICLES.stocks,
];

function getTopicFilter(kind) {
  if (kind === "crypto") {
    return "blockchain";
  }

  if (kind === "finance") {
    return "financial_markets,economy_macro";
  }

  if (kind === "stocks") {
    return "financial_markets,earnings,ipo";
  }

  return "financial_markets,blockchain,economy_macro";
}

function normalizeKind(kind) {
  return ["crypto", "finance", "stocks", "mixed"].includes(kind) ? kind : "mixed";
}

function normalizeLimit(limit) {
  return Math.min(Math.max(Number(limit) || 9, 3), 20);
}

const CRYPTO_RELEVANCE_PATTERNS = [
  /\bcrypto(?:currency|currencies)?\b/i,
  /\bblockchain\b/i,
  /\bbitcoin\b/i,
  /\bbtc\b/i,
  /\beth(?:ereum)?\b/i,
  /\bsol(?:ana)?\b/i,
  /\bxrp\b/i,
  /\bdoge(?:coin)?\b/i,
  /\bstablecoin(?:s)?\b/i,
  /\btoken(?:s)?\b/i,
  /\bdigital asset(?:s)?\b/i,
  /\bdefi\b/i,
  /\bweb3\b/i,
  /\bbinance\b/i,
  /\bcoinbase\b/i,
  /\bokx\b/i,
  /\bkraken\b/i,
  /\bcrypto\.com\b/i,
];

function normalizeArticle(article) {
  return {
    bannerImage: article.banner_image || "",
    source: article.source || "Alpha Vantage",
    headline: article.title || "Untitled story",
    summary: article.summary || "No summary available.",
    timePublished: article.time_published || "",
    url: article.url || "#",
  };
}

function getCryptoRelevanceScore(article) {
  const haystack = [
    article?.title || "",
    article?.summary || "",
    article?.source || "",
    article?.url || "",
  ].join(" ");

  let score = 0;

  for (const pattern of CRYPTO_RELEVANCE_PATTERNS) {
    if (pattern.test(haystack)) {
      score += 1;
    }
  }

  return score;
}

function selectArticles(feed, kind, limit) {
  const normalized = (Array.isArray(feed) ? feed : []).map((article, index) => ({
    article,
    index,
    normalized: normalizeArticle(article),
    cryptoScore: getCryptoRelevanceScore(article),
  }));

  if (kind === "crypto") {
    const relevant = normalized.filter((item) => item.cryptoScore > 0);
    const fallback = normalized.filter((item) => item.cryptoScore === 0);
    relevant.sort((left, right) => right.cryptoScore - left.cryptoScore || left.index - right.index);
    return [...relevant, ...fallback]
      .slice(0, limit)
      .map((item) => item.normalized);
  }

  return normalized.slice(0, limit).map((item) => item.normalized);
}

function buildFallbackPayload(kind, limit, message = "") {
  return {
    articles: (FALLBACK_ARTICLES[kind] || FALLBACK_ARTICLES.mixed).slice(0, limit),
    degraded: true,
    message,
    provider: "FTAS_FALLBACK",
  };
}

async function fetchNews({ kind = "mixed", limit = 9 } = {}) {
  const normalizedKind = normalizeKind(kind);
  const normalizedLimit = normalizeLimit(limit);
  const provider = String(process.env.NEWS_PROVIDER || "ALPHA_VANTAGE").trim().toUpperCase();
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  const cacheKey = `${provider}:${normalizedKind}:${normalizedLimit}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < NEWS_CACHE_MS) {
    return cached.payload;
  }

  if (provider === "FALLBACK") {
    const payload = buildFallbackPayload(normalizedKind, normalizedLimit, "NEWS_PROVIDER is set to FALLBACK.");
    cache.set(cacheKey, {
      createdAt: Date.now(),
      payload,
    });
    return payload;
  }

  if (!apiKey) {
    const payload = buildFallbackPayload(normalizedKind, normalizedLimit, "ALPHA_VANTAGE_API_KEY is not configured.");
    cache.set(cacheKey, {
      createdAt: Date.now(),
      payload,
    });
    return payload;
  }

  try {
    const response = await client.get("", {
      params: {
        apikey: apiKey,
        function: "NEWS_SENTIMENT",
        limit: normalizedLimit,
        sort: "LATEST",
        topics: getTopicFilter(normalizedKind),
      },
    });

    const feed = Array.isArray(response.data?.feed) ? response.data.feed : [];
    const articles = selectArticles(feed, normalizedKind, normalizedLimit);
    const payload = articles.length
      ? {
          articles,
          degraded: false,
          message: "",
          provider: "ALPHA_VANTAGE",
        }
      : buildFallbackPayload(normalizedKind, normalizedLimit, "Alpha Vantage returned no articles for this filter.");

    cache.set(cacheKey, {
      createdAt: Date.now(),
      payload,
    });

    return payload;
  } catch (error) {
    const payload = buildFallbackPayload(normalizedKind, normalizedLimit, `Live news unavailable: ${error.message}`);
    cache.set(cacheKey, {
      createdAt: Date.now(),
      payload,
    });
    return payload;
  }
}

module.exports = {
  fetchNews,
};
