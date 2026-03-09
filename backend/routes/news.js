const express = require("express");
const { fetchNews } = require("../services/newsService");

const router = express.Router();

router.get("/", async (req, res) => {
  const payload = await fetchNews({
    kind: String(req.query.kind || "mixed").toLowerCase(),
    limit: Number(req.query.limit || 9),
  });

  return res.json(payload);
});

module.exports = router;
