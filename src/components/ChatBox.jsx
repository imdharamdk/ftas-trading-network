import { useContext, useEffect, useRef, useState } from "react";
import { SessionContext } from "../context/sessionContext";
import { apiFetch } from "../lib/api";

const MAX_CHARS = 500;

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getInitials(name) {
  return (name || "U")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function avatarColor(name) {
  const colors = [
    "#6366f1","#8b5cf6","#ec4899","#06b6d4",
    "#10b981","#f59e0b","#ef4444","#3b82f6",
  ];
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function ChatBox() {
  const { user } = useContext(SessionContext);
  const [open, setOpen]       = useState(false);
  const [messages, setMessages] = useState([]);
  const [text, setText]       = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError]     = useState("");
  const [unread, setUnread]   = useState(0);
  const bottomRef = useRef(null);
  const pollRef   = useRef(null);

  // ── Fetch messages ──────────────────────────────────────────────────────────
  async function fetchMessages(quiet = false) {
    try {
      const res = await apiFetch("/chat/messages");
      setMessages(res.messages || []);
      if (!open && !quiet) setUnread((u) => u + 1);
    } catch { /* silent */ }
  }

  useEffect(() => {
    if (!user) return;
    fetchMessages(true);
    // Only poll when chat panel is open — saves API calls when closed
    if (!open) return;
    pollRef.current = setInterval(() => fetchMessages(true), 8000); // 8s when open
    return () => clearInterval(pollRef.current);
  }, [user, open]);

  useEffect(() => {
    if (open) {
      setUnread(0);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
    }
  }, [open, messages.length]);

  // ── Send ────────────────────────────────────────────────────────────────────
  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError("");
    try {
      const res = await apiFetch("/chat/messages", {
        method: "POST",
        body: { text: trimmed },
      });
      setMessages((prev) => [...prev, res.message]);
      setText("");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 60);
    } catch (e) {
      setError(e.message || "Send failed");
    } finally {
      setSending(false);
    }
  }

  // ── Admin delete ─────────────────────────────────────────────────────────────
  async function deleteMsg(id) {
    try {
      await apiFetch(`/chat/messages/${id}`, { method: "DELETE" });
      setMessages((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      alert(e.message);
    }
  }

  if (!user) return null;

  return (
    <>
      {/* ── Floating Toggle Button ─────────────────────────────────────────── */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 1000,
          width: 56, height: 56, borderRadius: "50%",
          background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
          border: "none", cursor: "pointer",
          boxShadow: "0 4px 20px rgba(99,102,241,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 24, transition: "transform 0.2s",
        }}
        title="Community Chat"
      >
        {open ? "✕" : "💬"}
        {!open && unread > 0 && (
          <span style={{
            position: "absolute", top: -4, right: -4,
            background: "#ef4444", color: "#fff",
            borderRadius: "50%", width: 18, height: 18,
            fontSize: 10, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* ── Chat Panel ────────────────────────────────────────────────────────── */}
      {open && (
        <div style={{
          position: "fixed", bottom: 90, right: 24, zIndex: 999,
          width: 360, maxWidth: "calc(100vw - 48px)",
          height: 480, display: "flex", flexDirection: "column",
          background: "#0f172a",
          border: "1px solid rgba(99,102,241,0.25)",
          borderRadius: 16,
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}>

          {/* Header */}
          <div style={{
            padding: "14px 16px", background: "rgba(99,102,241,0.15)",
            borderBottom: "1px solid rgba(99,102,241,0.2)",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{ fontSize: 20 }}>💬</span>
            <div>
              <div style={{ fontWeight: 700, color: "#e2e8f0", fontSize: 14 }}>
                Community Chat
              </div>
              <div style={{ fontSize: 11, color: "#64748b" }}>
                {messages.length} messages · registered users only
              </div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "#22c55e", display: "inline-block",
                boxShadow: "0 0 6px #22c55e",
              }} />
              <span style={{ fontSize: 11, color: "#22c55e" }}>Live</span>
            </div>
          </div>

          {/* Messages list */}
          <div style={{
            flex: 1, overflowY: "auto", padding: "12px 14px",
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            {messages.length === 0 && (
              <div style={{
                textAlign: "center", color: "#475569",
                marginTop: "30%", fontSize: 13,
              }}>
                No messages yet. Say hello! 👋
              </div>
            )}
            {messages.map((msg) => {
              const isMe = msg.userId === user?.id;
              return (
                <div key={msg.id} style={{
                  display: "flex",
                  flexDirection: isMe ? "row-reverse" : "row",
                  gap: 8, alignItems: "flex-end",
                }}>
                  {/* Avatar */}
                  {!isMe && (
                    <div style={{
                      width: 30, height: 30, borderRadius: "50%",
                      background: avatarColor(msg.userName),
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 700, color: "#fff",
                      flexShrink: 0,
                    }}>
                      {getInitials(msg.userName)}
                    </div>
                  )}

                  <div style={{ maxWidth: "75%", display: "flex", flexDirection: "column", gap: 2, alignItems: isMe ? "flex-end" : "flex-start" }}>
                    {/* Name + time */}
                    <div style={{ fontSize: 10, color: "#64748b", display: "flex", gap: 4, alignItems: "center" }}>
                      {!isMe && (
                        <span style={{ fontWeight: 600, color: avatarColor(msg.userName) }}>
                          {msg.userName}
                          {msg.userRole === "ADMIN" && (
                            <span style={{ marginLeft: 4, background: "#6366f1", color: "#fff", fontSize: 9, padding: "1px 4px", borderRadius: 4 }}>ADMIN</span>
                          )}
                        </span>
                      )}
                      <span>{timeAgo(msg.createdAt)}</span>
                    </div>

                    {/* Bubble */}
                    <div style={{
                      background: isMe
                        ? "linear-gradient(135deg, #6366f1, #8b5cf6)"
                        : "rgba(255,255,255,0.06)",
                      color: isMe ? "#fff" : "#e2e8f0",
                      borderRadius: isMe ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                      padding: "8px 12px",
                      fontSize: 13, lineHeight: 1.45,
                      wordBreak: "break-word",
                      position: "relative",
                    }}>
                      {msg.text}
                      {/* Admin delete */}
                      {user?.role === "ADMIN" && (
                        <button
                          onClick={() => deleteMsg(msg.id)}
                          title="Delete message"
                          style={{
                            position: "absolute", top: -8, right: -8,
                            background: "#ef4444", border: "none",
                            borderRadius: "50%", width: 18, height: 18,
                            fontSize: 9, cursor: "pointer", color: "#fff",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            opacity: 0.8,
                          }}
                        >✕</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Error */}
          {error && (
            <div style={{ padding: "6px 14px", background: "rgba(239,68,68,0.15)", color: "#ef4444", fontSize: 12 }}>
              {error}
            </div>
          )}

          {/* Input area */}
          <div style={{
            padding: "10px 12px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            display: "flex", gap: 8, alignItems: "flex-end",
          }}>
            <div style={{ flex: 1, position: "relative" }}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                placeholder="Type a message… (Enter to send)"
                rows={1}
                style={{
                  width: "100%", resize: "none", boxSizing: "border-box",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(99,102,241,0.3)",
                  borderRadius: 10, padding: "9px 12px",
                  color: "#e2e8f0", fontSize: 13, outline: "none",
                  fontFamily: "inherit", lineHeight: 1.4,
                }}
              />
              <span style={{
                position: "absolute", bottom: 6, right: 8,
                fontSize: 10, color: text.length > MAX_CHARS * 0.85 ? "#ef4444" : "#475569",
              }}>
                {text.length}/{MAX_CHARS}
              </span>
            </div>
            <button
              onClick={send}
              disabled={sending || !text.trim()}
              style={{
                background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                border: "none", borderRadius: 10,
                padding: "9px 14px", cursor: "pointer",
                color: "#fff", fontWeight: 700, fontSize: 16,
                opacity: (sending || !text.trim()) ? 0.4 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {sending ? "…" : "➤"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
