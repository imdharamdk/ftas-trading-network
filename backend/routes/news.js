const express = require("express");
const { fetchNews } = require("../services/newsService");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const articles = await fetchNews({
      kind: String(req.query.kind || "mixed").toLowerCase(),
      limit: Number(req.query.limit || 9),
    });

    return res.json({
      articles,
      provider: "ALPHA_VANTAGE",
    });
  } catch (error) {
    return res.status(503).json({
      articles: [],
      message: error.message,
      provider: "ALPHA_VANTAGE",
    });
  }
});

module.exports = router;
