const { createId, mutateCollection, readCollection } = require("../storage/fileStore");

const MAX_SECURITY_EVENTS = Math.max(200, Number(process.env.AUTH_SECURITY_EVENTS_LIMIT || 2000));

function getClientIp(req) {
  const xff = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req?.ip || req?.socket?.remoteAddress || "unknown";
}

function scrubEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const at = value.indexOf("@");
  if (at <= 1) return value;
  return `${value.slice(0, 2)}***${value.slice(at - 1)}`;
}

async function logAuthSecurityEvent(req, event) {
  const now = new Date().toISOString();
  const record = {
    id: createId("ase"),
    type: String(event?.type || "AUTH_EVENT"),
    level: String(event?.level || "INFO"),
    email: scrubEmail(event?.email),
    status: String(event?.status || "OK"),
    reason: event?.reason ? String(event.reason).slice(0, 240) : null,
    meta: event?.meta || null,
    ip: getClientIp(req),
    userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 240) || null,
    createdAt: now,
  };

  await mutateCollection("authSecurityEvents", (records) => {
    const next = [record, ...(Array.isArray(records) ? records : [])];
    return next.slice(0, MAX_SECURITY_EVENTS);
  });

  return record;
}

async function listAuthSecurityEvents(limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit || 100)));
  const records = await readCollection("authSecurityEvents");
  return (Array.isArray(records) ? records : []).slice(0, safeLimit);
}

module.exports = {
  logAuthSecurityEvent,
  listAuthSecurityEvents,
};
