const axios = require("axios");

const client = axios.create({
  baseURL: "https://www.alphavantage.co/query",
  timeout: 15000,
});

const cache = new Map();
const NEWS_CACHE_MS = Number(process.env.NEWS_CACHE_MS || 15 * 60 * 1000);

function getTopicFilter(kind) {
  if (kind === "crypto") {
    return "blockchain";
  }

  if (kind === "finance") {
    return "financial_markets,economy_macro";
  }

  return "financial_markets,blockchain,economy_macro";
}

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

async function fetchNews({ kind = "mixed", limit = 9 } = {}) {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

  if (!apiKey) {
    throw new Error("ALPHA_VANTAGE_API_KEY is not configured");
  }

  const normalizedKind = ["crypto", "finance", "mixed"].includes(kind) ? kind : "mixed";
  const cacheKey = `${normalizedKind}:${limit}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < NEWS_CACHE_MS) {
    return cached.articles;
  }

  const response = await client.get("", {
    params: {
      apikey: apiKey,
      function: "NEWS_SENTIMENT",
      limit: Math.min(Math.max(Number(limit) || 9, 3), 20),
      sort: "LATEST",
      topics: getTopicFilter(normalizedKind),
    },
  });

  const feed = Array.isArray(response.data?.feed) ? response.data.feed : [];
  const articles = feed.map(normalizeArticle);

  cache.set(cacheKey, {
    articles,
    createdAt: Date.now(),
  });

  return articles;
}

module.exports = {
  fetchNews,
};
