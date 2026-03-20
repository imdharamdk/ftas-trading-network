const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { readCollection, mutateCollection, writeCollection } = require("../storage/fileStore");
const { createPost, createComment, getTrendingScore, POST_TAGS, TAG_META } = require("../models/Post");

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function canPost(user) {
  if (!user) return false;
  if (user.role === "ADMIN") return true;
  // Paid users: PRO or PREMIUM with active subscription
  return (
    user.subscriptionStatus === "ACTIVE" &&
    ["PRO", "PREMIUM"].includes(user.plan)
  );
}

function sanitizePost(post, requestingUserId = null) {
  if (!post || post.deletedAt) return null;
  return {
    ...post,
    likeCount:   post.likes?.length || 0,
    likedByMe:   requestingUserId ? (post.likes || []).includes(requestingUserId) : false,
    likes:       undefined, // don't expose full likes array to client
  };
}

function sanitizeComment(comment, requestingUserId = null) {
  if (!comment || comment.deletedAt) return null;
  return {
    ...comment,
    likeCount:  comment.likes?.length || 0,
    likedByMe:  requestingUserId ? (comment.likes || []).includes(requestingUserId) : false,
    likes:      undefined,
  };
}

// ─── FOLLOW SYSTEM ─────────────────────────────────────────────────────────────
// Stored in users collection as followingIds: []

async function getFollows(userId) {
  const users = await readCollection("users");
  const user  = users.find(u => u.id === userId);
  return user?.followingIds || [];
}

// ─── GET /community/tags — tag metadata for frontend ─────────────────────────
router.get("/tags", (_req, res) => {
  return res.json({ tags: TAG_META });
});

// ─── GET /community/feed — trending posts ────────────────────────────────────
router.get("/feed", requireAuth, async (req, res) => {
  try {
    const { tag, page = 1, limit = 20 } = req.query;
    const userId = req.userId;

    let posts = await readCollection("communityPosts");

    // Filter deleted
    posts = posts.filter(p => !p.deletedAt);

    // Filter by tag if provided
    if (tag && POST_TAGS.includes(tag.toUpperCase())) {
      posts = posts.filter(p => p.tags?.includes(tag.toUpperCase()));
    }

    // Sort by trending score
    posts.sort((a, b) => getTrendingScore(b) - getTrendingScore(a));

    const total    = posts.length;
    const pageNum  = Math.max(1, Number(page));
    const pageSize = Math.min(50, Math.max(1, Number(limit)));
    const paginated = posts.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    return res.json({
      posts:    paginated.map(p => sanitizePost(p, userId)),
      total,
      page:     pageNum,
      pages:    Math.ceil(total / pageSize),
      canPost:  canPost(req.rawUser || req.user),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /community/post/:id — single post with comments ─────────────────────
router.get("/post/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const posts  = await readCollection("communityPosts");
    const post   = posts.find(p => p.id === req.params.id && !p.deletedAt);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // Increment view count async
    mutateCollection("communityPosts", records => {
      return records.map(p =>
        p.id === post.id ? { ...p, viewCount: (p.viewCount || 0) + 1 } : p
      );
    }).catch(() => {});

    const comments = await readCollection("communityComments");
    const postComments = comments
      .filter(c => c.postId === post.id && !c.deletedAt)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map(c => sanitizeComment(c, userId));

    return res.json({
      post:     sanitizePost(post, userId),
      comments: postComments,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── POST /community/post — create post ──────────────────────────────────────
router.post("/post", requireAuth, async (req, res) => {
  try {
    const user = req.rawUser || req.user;
    if (!canPost(user)) {
      return res.status(403).json({ message: "Only admin and paid members can post." });
    }

    const { content, imageUrl, chartUrl, tags, isPinned } = req.body || {};

    if (!content || String(content).trim().length < 5) {
      return res.status(400).json({ message: "Post content must be at least 5 characters." });
    }
    if (String(content).trim().length > 2000) {
      return res.status(400).json({ message: "Post content cannot exceed 2000 characters." });
    }

    const post = createPost({
      authorId:   user.id,
      authorName: user.name || "FTAS User",
      authorRole: user.role,
      content,
      imageUrl:   imageUrl  || null,
      chartUrl:   chartUrl  || null,
      tags:       Array.isArray(tags) ? tags : [],
      isPinned:   user.role === "ADMIN" ? Boolean(isPinned) : false,
    });

    await mutateCollection("communityPosts", records => [post, ...records]);

    // Broadcast to SSE clients
    try {
      const sse = require("../services/sseManager");
      sse.broadcast("community:post", { post: sanitizePost(post, user.id) });
    } catch {}

    return res.status(201).json({ post: sanitizePost(post, user.id) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /community/post/:id ───────────────────────────────────────────────
router.delete("/post/:id", requireAuth, async (req, res) => {
  try {
    const user   = req.rawUser || req.user;
    const result = await mutateCollection("communityPosts", records => {
      const idx = records.findIndex(p => p.id === req.params.id);
      if (idx === -1) return { records, value: null };
      const post = records[idx];
      // Admin can delete anyone's post; others only their own
      if (user.role !== "ADMIN" && post.authorId !== user.id) {
        return { records, value: "forbidden" };
      }
      const next = [...records];
      next[idx] = { ...post, deletedAt: new Date().toISOString() };
      return { records: next, value: "ok" };
    });
    if (!result)          return res.status(404).json({ message: "Post not found" });
    if (result === "forbidden") return res.status(403).json({ message: "Not allowed" });
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── PATCH /community/post/:id/pin — admin only ───────────────────────────────
router.patch("/post/:id/pin", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { pinned } = req.body || {};
    await mutateCollection("communityPosts", records =>
      records.map(p => p.id === req.params.id ? { ...p, isPinned: Boolean(pinned) } : p)
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── POST /community/post/:id/like — toggle like ─────────────────────────────
router.post("/post/:id/like", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    let liked = false;
    await mutateCollection("communityPosts", records =>
      records.map(p => {
        if (p.id !== req.params.id || p.deletedAt) return p;
        const likes = p.likes || [];
        if (likes.includes(userId)) {
          liked = false;
          return { ...p, likes: likes.filter(id => id !== userId) };
        } else {
          liked = true;
          return { ...p, likes: [...likes, userId] };
        }
      })
    );
    return res.json({ liked });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── POST /community/post/:id/comment ────────────────────────────────────────
router.post("/post/:id/comment", requireAuth, async (req, res) => {
  try {
    const user    = req.rawUser || req.user;
    const { content } = req.body || {};

    if (!content || String(content).trim().length < 1) {
      return res.status(400).json({ message: "Comment cannot be empty." });
    }
    if (String(content).trim().length > 500) {
      return res.status(400).json({ message: "Comment cannot exceed 500 characters." });
    }

    // Verify post exists
    const posts = await readCollection("communityPosts");
    const post  = posts.find(p => p.id === req.params.id && !p.deletedAt);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const comment = createComment({
      postId:     req.params.id,
      authorId:   user.id,
      authorName: user.name || "FTAS User",
      authorRole: user.role,
      content,
    });

    // Save comment + increment post commentCount atomically
    await Promise.all([
      mutateCollection("communityComments", records => [comment, ...records]),
      mutateCollection("communityPosts", records =>
        records.map(p =>
          p.id === req.params.id
            ? { ...p, commentCount: (p.commentCount || 0) + 1 }
            : p
        )
      ),
    ]);

    return res.status(201).json({ comment: sanitizeComment(comment, user.id) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /community/comment/:id ───────────────────────────────────────────
router.delete("/comment/:id", requireAuth, async (req, res) => {
  try {
    const user   = req.rawUser || req.user;
    let postId   = null;
    const result = await mutateCollection("communityComments", records => {
      const idx = records.findIndex(c => c.id === req.params.id);
      if (idx === -1) return { records, value: null };
      const comment = records[idx];
      if (user.role !== "ADMIN" && comment.authorId !== user.id) {
        return { records, value: "forbidden" };
      }
      postId = comment.postId;
      const next = [...records];
      next[idx] = { ...comment, deletedAt: new Date().toISOString() };
      return { records: next, value: "ok" };
    });
    if (!result)          return res.status(404).json({ message: "Comment not found" });
    if (result === "forbidden") return res.status(403).json({ message: "Not allowed" });

    // Decrement post commentCount
    if (postId) {
      mutateCollection("communityPosts", records =>
        records.map(p =>
          p.id === postId
            ? { ...p, commentCount: Math.max(0, (p.commentCount || 1) - 1) }
            : p
        )
      ).catch(() => {});
    }

    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── POST /community/follow/:userId — toggle follow ──────────────────────────
router.post("/follow/:userId", requireAuth, async (req, res) => {
  try {
    const followerId  = req.userId;
    const followingId = req.params.userId;

    if (followerId === followingId) {
      return res.status(400).json({ message: "Cannot follow yourself." });
    }

    let following = false;
    await mutateCollection("users", records =>
      records.map(u => {
        if (u.id !== followerId) return u;
        const followingIds = u.followingIds || [];
        if (followingIds.includes(followingId)) {
          following = false;
          return { ...u, followingIds: followingIds.filter(id => id !== followingId) };
        } else {
          following = true;
          return { ...u, followingIds: [...followingIds, followingId] };
        }
      })
    );

    return res.json({ following });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /community/follow/status/:userId ─────────────────────────────────────
router.get("/follow/status/:userId", requireAuth, async (req, res) => {
  try {
    const follows  = await getFollows(req.userId);
    return res.json({ following: follows.includes(req.params.userId) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /community/stats ─────────────────────────────────────────────────────
router.get("/stats", requireAuth, async (_req, res) => {
  try {
    const posts    = await readCollection("communityPosts");
    const comments = await readCollection("communityComments");
    const active   = posts.filter(p => !p.deletedAt);
    return res.json({
      totalPosts:    active.length,
      totalComments: comments.filter(c => !c.deletedAt).length,
      totalLikes:    active.reduce((s, p) => s + (p.likes?.length || 0), 0),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
