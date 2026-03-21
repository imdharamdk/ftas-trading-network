const jwt = require("jsonwebtoken");
const { readCollection } = require("../storage/fileStore");
const { hasSignalAccess, sanitizeUser, normalizeRiskPreference } = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET || "";

// FIX: Fail loudly in production if JWT_SECRET is not set.
// Previously the fallback "ftas_super_secret" was silently used.
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("[auth] FATAL: JWT_SECRET env var is not set. Refusing to start in production.");
    process.exit(1);
  } else {
    console.warn("[auth] WARNING: JWT_SECRET not set — using insecure dev fallback. Set JWT_SECRET in .env");
  }
}

const EFFECTIVE_SECRET = JWT_SECRET || "ftas_super_secret_dev_only";

// ─── User lookup cache ─────────────────────────────────────────────────────────
// FIX: Previously every authenticated request read the entire users collection
// from MongoDB just to find one user by ID. With many concurrent requests this
// causes unnecessary load. Cache entries for TTL_MS and invalidate on writes.
//
// TTL: 90 seconds — short enough to reflect plan changes quickly,
// long enough to avoid hammering the DB on every request.
const USER_CACHE     = new Map(); // userId → { user, expiresAt }
const USER_CACHE_TTL = 90 * 1000; // 90 seconds

const RISK_CACHE_TTL = 30 * 1000; // 30 seconds
let RISK_CACHE = { value: null, expiresAt: 0 };

async function getGlobalRiskPreference() {
  if (Date.now() < RISK_CACHE.expiresAt && RISK_CACHE.value) {
    return RISK_CACHE.value;
  }
  try {
    const settings = await readCollection("appSettings");
    const record = settings.find((s) => s?.id === "risk") || {};
    const pref = normalizeRiskPreference(record.preference);
    RISK_CACHE = { value: pref, expiresAt: Date.now() + RISK_CACHE_TTL };
    return pref;
  } catch {
    return null;
  }
}

function getCachedUser(userId) {
  const entry = USER_CACHE.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    USER_CACHE.delete(userId);
    return null;
  }
  return entry.user;
}

function setCachedUser(userId, user) {
  USER_CACHE.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL });
}

// Call this when a user record is modified (plan change, deactivation, etc.)
function invalidateUserCache(userId) {
  if (userId) USER_CACHE.delete(userId);
  else USER_CACHE.clear(); // full flush if no specific user
}

// ─── Sign JWT token ───────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    {
      sub:  user.id,
      role: user.role,
    },
    EFFECTIVE_SECRET,
    { expiresIn: "7d" },
  );
}

// ─── requireAuth — verifies JWT and attaches user to req ──────────────────────
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");

    if (!token) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const payload = jwt.verify(token, EFFECTIVE_SECRET);
    const userId  = payload.sub;

    // Try cache first
    let user = getCachedUser(userId);

    if (!user) {
      // Cache miss — read from DB (findOne-style: get all and find)
      // TODO: replace readCollection with a direct MongoDB findOne when
      //       fileStore exposes a getOne(name, id) helper.
      const users = await readCollection("users");
      user = users.find((item) => item.id === userId);

      if (user && user.isActive) {
        setCachedUser(userId, user);
      }
    }

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Invalid session" });
    }

    req.user    = sanitizeUser(user);
    req.userId  = user.id;
    req.rawUser = user;

    try {
      const pref = await getGlobalRiskPreference();
      if (pref) {
        req.user.riskPreference = pref;
        req.user.effectiveRiskPreference = pref;
      }
    } catch {}

    return next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ─── requireAdmin — must be called AFTER requireAuth ─────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required" });
  }
  return next();
}

// ─── requireSignalAccess — active plan or free trial ─────────────────────────
function requireSignalAccess(req, res, next) {
  const user = req.rawUser || req.user;

  if (!hasSignalAccess(user)) {
    return res.status(403).json({
      message: "Active plan or 7-day free trial required to view signals",
    });
  }
  return next();
}

module.exports = {
  invalidateUserCache,
  requireAdmin,
  requireAuth,
  requireSignalAccess,
  signToken,
};
