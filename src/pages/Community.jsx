import { useCallback, useEffect, useRef, useState } from "react";
import AppShell from "../components/AppShell";
import { useSession } from "../context/useSession";
import { apiFetch } from "../lib/api";

// ─── Tag config ───────────────────────────────────────────────────────────────
const TAG_META = {
  HOT:      { label: "🔥 Hot",      color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  BULLISH:  { label: "📈 Bullish",  color: "#22c55e", bg: "rgba(34,197,94,0.12)"  },
  BEARISH:  { label: "📉 Bearish",  color: "#ef4444", bg: "rgba(239,68,68,0.12)"  },
  ANALYSIS: { label: "💡 Analysis", color: "#a78bfa", bg: "rgba(167,139,250,0.12)"},
  ALERT:    { label: "🚨 Alert",    color: "#facc15", bg: "rgba(250,204,21,0.12)" },
};

const ALL_TAGS = Object.keys(TAG_META);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return "just now";
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function Avatar({ name, role, size = 38 }) {
  const initials = String(name || "?").slice(0, 2).toUpperCase();
  const bg = role === "ADMIN" ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "linear-gradient(135deg,#334155,#475569)";
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: bg, display: "flex", alignItems: "center",
      justifyContent: "center", fontWeight: 700, fontSize: size * 0.35,
      color: "#fff", flexShrink: 0, letterSpacing: 0.5,
    }}>{initials}</div>
  );
}

function TagBadge({ tag }) {
  const meta = TAG_META[tag];
  if (!meta) return null;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
      background: meta.bg, color: meta.color, border: `1px solid ${meta.color}40`,
    }}>{meta.label}</span>
  );
}

// ─── Comment Box ──────────────────────────────────────────────────────────────
function CommentBox({ postId, onCommentAdded }) {
  const [text, setText]   = useState("");
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState("");

  async function submit() {
    if (!text.trim()) return;
    setBusy(true); setErr("");
    try {
      const res = await apiFetch(`/community/post/${postId}/comment`, {
        method: "POST", body: { content: text.trim() },
      });
      setText("");
      onCommentAdded?.(res.comment);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Write a comment..."
          maxLength={500}
          rows={2}
          style={{
            flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8, color: "#e2e8f0", padding: "8px 12px", fontSize: 13,
            resize: "none", outline: "none", fontFamily: "inherit",
          }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <button
          onClick={submit} disabled={busy || !text.trim()}
          style={{
            background: "rgba(99,102,241,0.2)", color: "#818cf8",
            border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8,
            padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600,
            opacity: busy || !text.trim() ? 0.5 : 1,
          }}
        >{busy ? "..." : "Reply"}</button>
      </div>
      {err && <p style={{ color: "#f87171", fontSize: 12, margin: "4px 0 0" }}>{err}</p>}
    </div>
  );
}

// ─── Single Post Card ─────────────────────────────────────────────────────────
function PostCard({ post: initialPost, isAdmin, currentUserId, onDelete }) {
  const [post, setPost]           = useState(initialPost);
  const [expanded, setExpanded]   = useState(false);
  const [comments, setComments]   = useState([]);
  const [loadingCmts, setLoadingCmts] = useState(false);
  const [showComments, setShowComments] = useState(false);

  useEffect(() => { setPost(initialPost); }, [initialPost]);

  async function toggleLike() {
    try {
      const res = await apiFetch(`/community/post/${post.id}/like`, { method: "POST" });
      setPost(p => ({
        ...p,
        likedByMe: res.liked,
        likeCount: res.liked ? (p.likeCount + 1) : Math.max(0, p.likeCount - 1),
      }));
    } catch {}
  }

  async function loadComments() {
    if (loadingCmts) return;
    setLoadingCmts(true);
    try {
      const res = await apiFetch(`/community/post/${post.id}`);
      setComments(res.comments || []);
    } catch {}
    finally { setLoadingCmts(false); }
  }

  function toggleComments() {
    if (!showComments && comments.length === 0) loadComments();
    setShowComments(v => !v);
  }

  async function deletePost() {
    if (!window.confirm("Delete this post?")) return;
    try {
      await apiFetch(`/community/post/${post.id}`, { method: "DELETE" });
      onDelete?.(post.id);
    } catch {}
  }

  async function togglePin() {
    try {
      await apiFetch(`/community/post/${post.id}/pin`, {
        method: "PATCH", body: { pinned: !post.isPinned },
      });
      setPost(p => ({ ...p, isPinned: !p.isPinned }));
    } catch {}
  }

  const contentLines = post.content?.split("\n") || [];
  const isLong = post.content?.length > 280;

  return (
    <article style={{
      background: "rgba(255,255,255,0.03)",
      border: post.isPinned ? "1px solid rgba(99,102,241,0.4)" : "1px solid rgba(255,255,255,0.07)",
      borderRadius: 14, padding: "18px 20px", marginBottom: 14,
      position: "relative",
    }}>
      {/* Pin badge */}
      {post.isPinned && (
        <div style={{
          position: "absolute", top: 12, right: 14,
          fontSize: 11, color: "#818cf8", fontWeight: 700,
          background: "rgba(99,102,241,0.12)", padding: "2px 8px",
          borderRadius: 20, border: "1px solid rgba(99,102,241,0.25)",
        }}>📌 Pinned</div>
      )}

      {/* Header */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
        <Avatar name={post.authorName} role={post.authorRole} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#e2e8f0" }}>{post.authorName}</span>
            {post.authorRole === "ADMIN" && (
              <span style={{
                fontSize: 10, fontWeight: 700, color: "#818cf8",
                background: "rgba(99,102,241,0.15)", padding: "1px 7px",
                borderRadius: 20, border: "1px solid rgba(99,102,241,0.3)",
              }}>ADMIN</span>
            )}
            <span style={{ fontSize: 12, color: "#475569" }}>{timeAgo(post.createdAt)}</span>
          </div>
          {/* Tags */}
          {post.tags?.length > 0 && (
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {post.tags.map(t => <TagBadge key={t} tag={t} />)}
            </div>
          )}
        </div>

        {/* Admin actions */}
        {(isAdmin || post.authorId === currentUserId) && (
          <div style={{ display: "flex", gap: 6 }}>
            {isAdmin && (
              <button onClick={togglePin} title={post.isPinned ? "Unpin" : "Pin"} style={{
                background: "none", border: "none", cursor: "pointer",
                color: post.isPinned ? "#818cf8" : "#475569", fontSize: 15, padding: 4,
              }}>📌</button>
            )}
            <button onClick={deletePost} title="Delete" style={{
              background: "none", border: "none", cursor: "pointer",
              color: "#ef4444", fontSize: 15, padding: 4, opacity: 0.7,
            }}>🗑️</button>
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ fontSize: 14, color: "#cbd5e1", lineHeight: 1.7, marginBottom: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {isLong && !expanded
          ? post.content.slice(0, 280) + "..."
          : post.content}
        {isLong && (
          <button onClick={() => setExpanded(v => !v)} style={{
            background: "none", border: "none", color: "#818cf8",
            cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "0 0 0 6px",
          }}>{expanded ? "Show less" : "Read more"}</button>
        )}
      </div>

      {/* Image */}
      {post.imageUrl && (
        <img
          src={post.imageUrl} alt="post"
          style={{ width: "100%", maxHeight: 420, objectFit: "cover", borderRadius: 10, marginBottom: 12 }}
          onError={e => { e.target.style.display = "none"; }}
        />
      )}

      {/* Chart */}
      {post.chartUrl && (
        <img
          src={post.chartUrl} alt="chart"
          style={{ width: "100%", maxHeight: 380, objectFit: "contain", borderRadius: 10, marginBottom: 12, background: "rgba(0,0,0,0.2)" }}
          onError={e => { e.target.style.display = "none"; }}
        />
      )}

      {/* Action bar */}
      <div style={{ display: "flex", gap: 20, alignItems: "center", paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <button onClick={toggleLike} style={{
          background: "none", border: "none", cursor: "pointer",
          color: post.likedByMe ? "#f97316" : "#64748b",
          fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 5,
          transition: "color 0.15s",
        }}>
          {post.likedByMe ? "❤️" : "🤍"} {post.likeCount || 0}
        </button>

        <button onClick={toggleComments} style={{
          background: "none", border: "none", cursor: "pointer",
          color: showComments ? "#818cf8" : "#64748b",
          fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 5,
        }}>
          💬 {post.commentCount || 0}
        </button>

        <span style={{ fontSize: 12, color: "#334155", marginLeft: "auto" }}>
          👁 {post.viewCount || 0}
        </span>
      </div>

      {/* Comments section */}
      {showComments && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          {loadingCmts ? (
            <p style={{ color: "#475569", fontSize: 13 }}>Loading comments...</p>
          ) : comments.length === 0 ? (
            <p style={{ color: "#475569", fontSize: 13 }}>No comments yet. Be the first!</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
              {comments.map(c => (
                <div key={c.id} style={{
                  display: "flex", gap: 10,
                  background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "10px 12px",
                }}>
                  <Avatar name={c.authorName} role={c.authorRole} size={30} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: "#e2e8f0" }}>{c.authorName}</span>
                      {c.authorRole === "ADMIN" && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#818cf8", background: "rgba(99,102,241,0.15)", padding: "1px 6px", borderRadius: 20 }}>ADMIN</span>
                      )}
                      <span style={{ fontSize: 11, color: "#475569" }}>{timeAgo(c.createdAt)}</span>
                    </div>
                    <p style={{ fontSize: 13, color: "#94a3b8", margin: 0, wordBreak: "break-word" }}>{c.content}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <CommentBox
            postId={post.id}
            onCommentAdded={newComment => {
              setComments(prev => [...prev, newComment]);
              setPost(p => ({ ...p, commentCount: (p.commentCount || 0) + 1 }));
            }}
          />
        </div>
      )}
    </article>
  );
}

// ─── Image Upload Helper ──────────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

// ─── Image Picker Component ───────────────────────────────────────────────────
function ImagePicker({ label, value, onChange }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { alert("Only image files allowed."); return; }
    if (file.size > 5 * 1024 * 1024) { alert("Image must be under 5 MB."); return; }
    try {
      const b64 = await fileToBase64(file);
      onChange(b64);
    } catch { alert("Could not read image."); }
  }

  function handleDrop(e) {
    e.preventDefault(); setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 6px", fontWeight: 600 }}>{label}</p>

      {value ? (
        <div style={{ position: "relative" }}>
          <img
            src={value} alt="preview"
            style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: 10, display: "block" }}
          />
          <button
            onClick={() => onChange("")}
            style={{
              position: "absolute", top: 8, right: 8,
              background: "rgba(0,0,0,0.7)", border: "none", borderRadius: "50%",
              color: "#fff", width: 28, height: 28, cursor: "pointer",
              fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >✕</button>
        </div>
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${dragOver ? "#818cf8" : "rgba(255,255,255,0.12)"}`,
            borderRadius: 10, padding: "20px 16px", textAlign: "center",
            cursor: "pointer", transition: "all 0.15s",
            background: dragOver ? "rgba(99,102,241,0.08)" : "rgba(255,255,255,0.02)",
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 6 }}>🖼️</div>
          <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
            Click to upload or drag & drop
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 11, color: "#334155" }}>PNG, JPG, GIF — max 5 MB</p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={e => handleFile(e.target.files[0])}
      />
    </div>
  );
}

// ─── Create Post Modal ────────────────────────────────────────────────────────
function CreatePostModal({ onClose, onCreated }) {
  const [content, setContent]   = useState("");
  const [imageData, setImageData] = useState("");   // base64 or URL
  const [chartData, setChartData] = useState("");   // base64 or URL
  const [tags, setTags]         = useState([]);
  const [isPinned, setIsPinned] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState("");
  const { user } = useSession();
  const isAdmin = user?.role === "ADMIN";

  function toggleTag(tag) {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  }

  async function submit() {
    if (!content.trim()) { setErr("Post content is required."); return; }
    setBusy(true); setErr("");
    try {
      const res = await apiFetch("/community/post", {
        method: "POST",
        body: {
          content:  content.trim(),
          imageUrl: imageData || null,
          chartUrl: chartData || null,
          tags,
          isPinned,
        },
      });
      onCreated?.(res.post);
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: 16,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 16, padding: "24px", width: "100%", maxWidth: 560,
        maxHeight: "90vh", overflowY: "auto",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "#e2e8f0" }}>✍️ Create Post</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 20 }}>✕</button>
        </div>

        {/* Content */}
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="Share your analysis, trade idea, or market update..."
          rows={5}
          maxLength={2000}
          style={{
            width: "100%", background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10,
            color: "#e2e8f0", padding: "12px", fontSize: 14,
            resize: "vertical", outline: "none", fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        <p style={{ fontSize: 11, color: "#475569", margin: "4px 0 16px", textAlign: "right" }}>{content.length}/2000</p>

        {/* Image Upload */}
        <ImagePicker label="📷 IMAGE (optional)" value={imageData} onChange={setImageData} />

        {/* Chart Upload */}
        <ImagePicker label="📊 CHART SCREENSHOT (optional)" value={chartData} onChange={setChartData} />

        {/* Tags */}
        <div style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 8px", fontWeight: 600 }}>TAGS</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {ALL_TAGS.map(tag => {
              const meta = TAG_META[tag];
              const active = tags.includes(tag);
              return (
                <button key={tag} onClick={() => toggleTag(tag)} style={{
                  padding: "5px 12px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 700,
                  background: active ? meta.bg : "rgba(255,255,255,0.04)",
                  color: active ? meta.color : "#64748b",
                  border: `1px solid ${active ? meta.color + "60" : "rgba(255,255,255,0.08)"}`,
                  transition: "all 0.15s",
                }}>{meta.label}</button>
              );
            })}
          </div>
        </div>

        {/* Pin toggle (admin only) */}
        {isAdmin && (
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, cursor: "pointer" }}>
            <input type="checkbox" checked={isPinned} onChange={e => setIsPinned(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: "#818cf8" }} />
            <span style={{ fontSize: 13, color: "#94a3b8" }}>📌 Pin this post to top</span>
          </label>
        )}

        {err && <p style={{ color: "#f87171", fontSize: 13, margin: "0 0 12px" }}>{err}</p>}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{
            background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
            color: "#94a3b8", borderRadius: 8, padding: "10px 20px", cursor: "pointer", fontSize: 14,
          }}>Cancel</button>
          <button onClick={submit} disabled={busy || !content.trim()} style={{
            background: busy || !content.trim() ? "rgba(99,102,241,0.2)" : "rgba(99,102,241,0.3)",
            border: "1px solid rgba(99,102,241,0.4)", color: "#818cf8",
            borderRadius: 8, padding: "10px 24px", cursor: busy || !content.trim() ? "not-allowed" : "pointer",
            fontSize: 14, fontWeight: 700, opacity: busy || !content.trim() ? 0.6 : 1,
          }}>{busy ? "Posting..." : "Post"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Community Page ──────────────────────────────────────────────────────
export default function Community() {
  const { user } = useSession();
  const isAdmin  = user?.role === "ADMIN";
  const canPost  = isAdmin || (user?.subscriptionStatus === "ACTIVE" && ["PRO","PREMIUM"].includes(user?.plan));

  const [posts, setPosts]         = useState([]);
  const [stats, setStats]         = useState(null);
  const [loading, setLoading]     = useState(true);
  const [activeTag, setActiveTag] = useState("ALL");
  const [page, setPage]           = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [following, setFollowing]   = useState(false);

  // Admin userId for follow button
  const ADMIN_FOLLOW_KEY = "ftas_admin_following";

  useEffect(() => {
    const stored = localStorage.getItem(ADMIN_FOLLOW_KEY);
    if (stored) setFollowing(JSON.parse(stored));
  }, []);

  const loadFeed = useCallback(async (tag = activeTag, pg = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: pg, limit: 15 });
      if (tag !== "ALL") params.set("tag", tag);
      const res = await apiFetch(`/community/feed?${params}`);
      if (pg === 1) setPosts(res.posts || []);
      else setPosts(prev => [...prev, ...(res.posts || [])]);
      setTotalPages(res.pages || 1);
    } catch {}
    finally { setLoading(false); }
  }, [activeTag]);

  const loadStats = useCallback(async () => {
    try {
      const res = await apiFetch("/community/stats");
      setStats(res);
    } catch {}
  }, []);

  useEffect(() => {
    setPage(1);
    loadFeed(activeTag, 1);
    loadStats();
  }, [activeTag]);

  function handleTagChange(tag) {
    setActiveTag(tag);
    setPage(1);
  }

  function handleLoadMore() {
    const nextPage = page + 1;
    setPage(nextPage);
    loadFeed(activeTag, nextPage);
  }

  function handlePostCreated(newPost) {
    setPosts(prev => [newPost, ...prev]);
    loadStats();
  }

  function handlePostDeleted(postId) {
    setPosts(prev => prev.filter(p => p.id !== postId));
    loadStats();
  }

  async function handleFollowAdmin() {
    // Find admin user — for now toggle local state and call API
    try {
      // We follow the first ADMIN we see in posts
      const adminPost = posts.find(p => p.authorRole === "ADMIN");
      if (adminPost) {
        const res = await apiFetch(`/community/follow/${adminPost.authorId}`, { method: "POST" });
        setFollowing(res.following);
        localStorage.setItem(ADMIN_FOLLOW_KEY, JSON.stringify(res.following));
      }
    } catch {}
  }

  return (
    <AppShell title="Community" subtitle="FTAS trading community — analysis, signals, and discussions.">
      <style>{`
        .community-layout { display: grid; grid-template-columns: 1fr 300px; gap: 20px; align-items: start; }
        @media (max-width: 900px) { .community-layout { grid-template-columns: 1fr; } .community-sidebar { display: none; } }
        .tag-filter { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
        .tag-filter-btn { padding: 6px 14px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); cursor: pointer; font-size: 12px; font-weight: 700; transition: all 0.15s; background: rgba(255,255,255,0.04); color: #64748b; }
        .tag-filter-btn.active { background: rgba(99,102,241,0.2); color: #818cf8; border-color: rgba(99,102,241,0.4); }
        .tag-filter-btn:hover:not(.active) { background: rgba(255,255,255,0.08); color: #94a3b8; }
      `}</style>

      <div className="community-layout">
        {/* ── Main Feed ── */}
        <div>
          {/* Top bar */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <h2 style={{ margin: 0, fontSize: 20, color: "#e2e8f0" }}>📣 Community Feed</h2>
            {canPost && (
              <button onClick={() => setShowCreate(true)} style={{
                background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.4)",
                color: "#818cf8", borderRadius: 10, padding: "9px 20px",
                cursor: "pointer", fontSize: 13, fontWeight: 700,
              }}>✍️ Create Post</button>
            )}
          </div>

          {/* Tag filter */}
          <div className="tag-filter">
            <button
              className={`tag-filter-btn${activeTag === "ALL" ? " active" : ""}`}
              onClick={() => handleTagChange("ALL")}
            >🌐 All</button>
            {ALL_TAGS.map(tag => (
              <button
                key={tag}
                className={`tag-filter-btn${activeTag === tag ? " active" : ""}`}
                onClick={() => handleTagChange(tag)}
              >{TAG_META[tag].label}</button>
            ))}
          </div>

          {/* Posts */}
          {loading && posts.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: "#475569" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
              <p>Loading community feed...</p>
            </div>
          ) : posts.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: "#475569" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>📭</div>
              <p style={{ fontSize: 15 }}>No posts yet{activeTag !== "ALL" ? ` for ${TAG_META[activeTag]?.label}` : ""}.</p>
              {canPost && (
                <button onClick={() => setShowCreate(true)} style={{
                  marginTop: 12, background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.4)",
                  color: "#818cf8", borderRadius: 10, padding: "10px 24px", cursor: "pointer", fontWeight: 700,
                }}>Be the first to post ✍️</button>
              )}
            </div>
          ) : (
            <>
              {posts.map(post => (
                <PostCard
                  key={post.id}
                  post={post}
                  isAdmin={isAdmin}
                  currentUserId={user?.id}
                  onDelete={handlePostDeleted}
                />
              ))}
              {page < totalPages && (
                <div style={{ textAlign: "center", padding: "16px 0" }}>
                  <button
                    onClick={handleLoadMore}
                    disabled={loading}
                    style={{
                      background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                      color: "#94a3b8", borderRadius: 10, padding: "10px 32px",
                      cursor: "pointer", fontSize: 13, fontWeight: 600,
                    }}
                  >{loading ? "Loading..." : "Load more"}</button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Sidebar ── */}
        <aside className="community-sidebar">
          {/* Stats card */}
          <div style={{
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 14, padding: "18px 20px", marginBottom: 16,
          }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 14, color: "#94a3b8", fontWeight: 700, letterSpacing: 1 }}>COMMUNITY STATS</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { label: "Total Posts",    value: stats?.totalPosts    ?? "—", icon: "📝" },
                { label: "Comments",       value: stats?.totalComments ?? "—", icon: "💬" },
                { label: "Total Likes",    value: stats?.totalLikes    ?? "—", icon: "❤️" },
              ].map(item => (
                <div key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: "#64748b" }}>{item.icon} {item.label}</span>
                  <strong style={{ fontSize: 15, color: "#e2e8f0" }}>{item.value}</strong>
                </div>
              ))}
            </div>
          </div>

          {/* Follow admin card */}
          <div style={{
            background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.2)",
            borderRadius: 14, padding: "18px 20px", marginBottom: 16,
          }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
              <Avatar name="FTAS" role="ADMIN" size={44} />
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: "#e2e8f0" }}>FTAS Admin</p>
                <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>Official signals & analysis</p>
              </div>
            </div>
            {!isAdmin && (
              <button
                onClick={handleFollowAdmin}
                style={{
                  width: "100%", padding: "9px 0", borderRadius: 8, cursor: "pointer",
                  fontWeight: 700, fontSize: 13, transition: "all 0.15s",
                  background: following ? "rgba(255,255,255,0.06)" : "rgba(99,102,241,0.25)",
                  border: following ? "1px solid rgba(255,255,255,0.1)" : "1px solid rgba(99,102,241,0.4)",
                  color: following ? "#64748b" : "#818cf8",
                }}
              >{following ? "✓ Following" : "+ Follow"}</button>
            )}
          </div>

          {/* Tags legend */}
          <div style={{
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 14, padding: "18px 20px",
          }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 14, color: "#94a3b8", fontWeight: 700, letterSpacing: 1 }}>POST CATEGORIES</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ALL_TAGS.map(tag => (
                <button key={tag} onClick={() => handleTagChange(tag)} style={{
                  background: activeTag === tag ? TAG_META[tag].bg : "none",
                  border: "none", cursor: "pointer", textAlign: "left",
                  padding: "6px 10px", borderRadius: 8,
                  color: activeTag === tag ? TAG_META[tag].color : "#64748b",
                  fontSize: 13, fontWeight: 600, transition: "all 0.15s",
                }}>
                  {TAG_META[tag].label}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {/* Create Post Modal */}
      {showCreate && (
        <CreatePostModal
          onClose={() => setShowCreate(false)}
          onCreated={handlePostCreated}
        />
      )}
    </AppShell>
  );
}
