const { createId } = require("../storage/fileStore");

const POST_TAGS = ["HOT", "BULLISH", "BEARISH", "ANALYSIS", "ALERT"];

const TAG_META = {
  HOT:      { label: "🔥 Hot",      color: "#f97316" },
  BULLISH:  { label: "📈 Bullish",  color: "#22c55e" },
  BEARISH:  { label: "📉 Bearish",  color: "#ef4444" },
  ANALYSIS: { label: "💡 Analysis", color: "#a78bfa" },
  ALERT:    { label: "🚨 Alert",    color: "#facc15" },
};

function createPost({
  authorId,
  authorName,
  authorRole,
  content,
  imageUrl   = null,
  chartUrl   = null,
  tags       = [],
  isPinned   = false,
}) {
  const now = new Date().toISOString();
  return {
    id:          createId("post"),
    authorId,
    authorName,
    authorRole,   // "ADMIN" | "USER"
    content:     String(content || "").trim(),
    imageUrl,
    chartUrl,
    tags:        tags.filter(t => POST_TAGS.includes(t)),
    isPinned,
    likes:       [],   // array of userIds
    commentCount: 0,
    viewCount:   0,
    createdAt:   now,
    updatedAt:   now,
    deletedAt:   null,
  };
}

function createComment({ postId, authorId, authorName, authorRole, content }) {
  const now = new Date().toISOString();
  return {
    id:         createId("cmt"),
    postId,
    authorId,
    authorName,
    authorRole,
    content:    String(content || "").trim(),
    likes:      [],
    createdAt:  now,
    updatedAt:  now,
    deletedAt:  null,
  };
}

// Trending score: likes * 3 + comments * 2 + views * 0.1 — recency decay over 48h
function getTrendingScore(post) {
  const ageHours = (Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60 * 60);
  const decay    = Math.max(0.1, 1 - ageHours / 48);
  const raw      = (post.likes?.length || 0) * 3
                 + (post.commentCount  || 0) * 2
                 + (post.viewCount     || 0) * 0.1;
  // Pinned posts always float to top
  return post.isPinned ? raw + 10000 : raw * decay;
}

module.exports = {
  POST_TAGS,
  TAG_META,
  createPost,
  createComment,
  getTrendingScore,
};
