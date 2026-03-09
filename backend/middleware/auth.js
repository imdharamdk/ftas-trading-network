const jwt = require("jsonwebtoken");
const { readCollection } = require("../storage/fileStore");
const { hasSignalAccess, sanitizeUser } = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET || "ftas_super_secret";

// ─── Sign JWT token ───────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    {
      sub:  user.id,
      role: user.role,
    },
    JWT_SECRET,
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

    const payload = jwt.verify(token, JWT_SECRET);
    const users   = await readCollection("users");
    const user    = users.find((item) => item.id === payload.sub);

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Invalid session" });
    }

    req.user    = sanitizeUser(user);
    req.userId  = user.id;
    req.rawUser = user;
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
  requireAdmin,
  requireAuth,
  requireSignalAccess,
  signToken,
};
