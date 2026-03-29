const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { authenticator } = require("otplib");
const { ipKeyGenerator } = require("express-rate-limit");
const { invalidateUserCache, requireAdmin, requireAuth, signToken } = require("../middleware/auth");
const {
  SUBSCRIPTION_STATUS,
  USER_PLANS,
  USER_ROLES,
  createUser,
  normalizeEmail,
  normalizeRiskPreference,
  normalizeSignalPreferences,
  sanitizeUser,
} = require("../models/User");
const { getStorageDebugInfo, mutateCollection, readCollection, writeCollection } = require("../storage/fileStore");
const { sendResetCodeEmail } = require("../services/emailService");
const { listAuthSecurityEvents, logAuthSecurityEvent } = require("../services/securityEventService");
const { verifyFirebaseIdToken } = require("../services/firebaseAdmin");

const router = express.Router();

const RESET_CODE_TTL_MINUTES = Math.max(5, Number(process.env.RESET_CODE_TTL_MINUTES || 15));
const MAX_RESET_VERIFY_ATTEMPTS = Math.max(3, Number(process.env.RESET_MAX_ATTEMPTS || 6));

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

const exposeResetCode = parseBoolean(
  process.env.EXPOSE_RESET_CODE,
  String(process.env.NODE_ENV || "").toLowerCase() !== "production"
);

function getResetHelpMessage() {
  return "If this email exists, a reset code has been generated.";
}

function generateResetCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getTwoFactorIssuer() {
  return String(process.env.TOTP_ISSUER || "FTAS Trading Network").trim();
}

function hashResetCode(email, code) {
  const secret = process.env.JWT_SECRET || "ftas-reset-secret";
  return crypto
    .createHash("sha256")
    .update(`${normalizeEmail(email)}:${String(code)}:${secret}`)
    .digest("hex");
}

const ONLINE_WINDOW_MINUTES = Math.max(2, Number(process.env.ONLINE_WINDOW_MINUTES || 5));
const ACTIVE_WINDOW_HOURS = Math.max(1, Number(process.env.ACTIVE_WINDOW_HOURS || 24));
const VISIT_SESSION_GAP_MINUTES = Math.max(10, Number(process.env.VISIT_SESSION_GAP_MINUTES || 30));

function toVisitDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildVisitActivityUpdate(user, nowIso, options = {}) {
  const incrementVisit = Boolean(options.incrementVisit);
  const today = toVisitDate(nowIso);
  const lastVisitDate = String((user && user.lastVisitDate) || "").trim();
  let visitCountToday = lastVisitDate === today ? toNumber(user && user.visitCountToday, 0) : 0;
  let totalVisitCount = toNumber(user && user.totalVisitCount, 0);

  if (incrementVisit) {
    visitCountToday += 1;
    totalVisitCount += 1;
  }

  return {
    lastSeenAt: nowIso,
    lastVisitDate: today,
    visitCountToday,
    totalVisitCount,
  };
}

function shouldCountNewVisit(user, nowIso) {
  const lastSeen = new Date((user && user.lastSeenAt) || 0);
  if (Number.isNaN(lastSeen.getTime())) return true;
  const nowMs = new Date(nowIso).getTime();
  return Number.isFinite(nowMs) && (nowMs - lastSeen.getTime()) > VISIT_SESSION_GAP_MINUTES * 60 * 1000;
}

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many reset attempts. Please wait and try again." },
  keyGenerator: (req) => {
    const emailKey = normalizeEmail(req.body?.email || "");
    return emailKey || ipKeyGenerator(req);
  },
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  message: { message: "Too many reset attempts. Please wait and try again." },
  keyGenerator: (req) => {
    const emailKey = normalizeEmail(req.body?.email || "");
    return emailKey || ipKeyGenerator(req);
  },
});

router.post("/register", async (req, res) => {
  try {
    const { adminSetupKey, email, firstName, lastName, name, password, privacyAccepted, termsAccepted } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const normalizedFirstName = String(firstName || "").trim();
    const normalizedLastName = String(lastName || "").trim();
    const fullName = (normalizedFirstName && normalizedLastName)
      ? `${normalizedFirstName} ${normalizedLastName}`
      : String(name || "").trim();

    if (!normalizedFirstName || !normalizedLastName) {
      return res.status(400).json({ message: "First name and last name are required" });
    }

    if (!normalizedEmail || !password || password.length < 6) {
      return res.status(400).json({ message: "Valid email and 6+ char password required" });
    }

    if (termsAccepted !== true || privacyAccepted !== true) {
      return res.status(400).json({ message: "Please accept the Terms of Service and Privacy Policy" });
    }

    const result = await mutateCollection("users", async (records) => {
      if (records.some((user) => user.email === normalizedEmail)) {
        return {
          records,
          value: { error: "Account already exists" },
        };
      }

      const isFirstUser = records.length === 0;
      const role =
        isFirstUser || (adminSetupKey && adminSetupKey === process.env.ADMIN_SETUP_KEY)
          ? USER_ROLES.ADMIN
          : USER_ROLES.USER;

      const passwordHash = await bcrypt.hash(password, 10);
      const acceptedAt = new Date().toISOString();
      const user = createUser({
        email: normalizedEmail,
        name: fullName,
        passwordHash,
        plan: role === USER_ROLES.ADMIN ? USER_PLANS.PREMIUM : USER_PLANS.FREE_TRIAL,
        role,
        subscriptionEndsAt: role === USER_ROLES.ADMIN ? null : undefined,
        subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
        termsAcceptedAt: acceptedAt,
        privacyAcceptedAt: acceptedAt,
      });

      return {
        records: [user, ...records],
        value: { user },
      };
    });

    if (result.error) {
      await logAuthSecurityEvent(req, {
        type: "REGISTER",
        level: "WARN",
        email: normalizedEmail,
        status: "DENY",
        reason: result.error,
      });
      return res.status(409).json({ message: result.error });
    }

    await logAuthSecurityEvent(req, {
      type: "REGISTER",
      userId: result.user.id,
      email: normalizedEmail,
      status: "OK",
    });

    const token = signToken(result.user);
    return res.status(201).json({
      token,
      user: sanitizeUser(result.user),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password, otp } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const users = await readCollection("users");
    let user = users.find((item) => item.email === normalizedEmail);

    if (!user || !user.isActive) {
      await logAuthSecurityEvent(req, {
        type: "LOGIN",
        level: "WARN",
        email: normalizedEmail,
        status: "DENY",
        reason: "invalid_account",
      });
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password || "", user.passwordHash || "");

    if (!isMatch) {
      await logAuthSecurityEvent(req, {
        type: "LOGIN",
        userId: user.id,
        level: "WARN",
        email: normalizedEmail,
        status: "DENY",
        reason: "invalid_password",
      });
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (user?.twoFactor?.enabled) {
      const submittedOtp = String(otp || "").trim();
      if (!submittedOtp) {
        await logAuthSecurityEvent(req, {
          type: "LOGIN_2FA",
          userId: user.id,
          level: "WARN",
          email: normalizedEmail,
          status: "DENY",
          reason: "otp_required",
        });
        return res.status(401).json({ message: "OTP required", code: "OTP_REQUIRED" });
      }

      const isOtpValid = authenticator.check(submittedOtp, user.twoFactor.secret || "");
      if (!isOtpValid) {
        await logAuthSecurityEvent(req, {
          type: "LOGIN_2FA",
          userId: user.id,
          level: "WARN",
          email: normalizedEmail,
          status: "DENY",
          reason: "otp_invalid",
        });
        return res.status(401).json({ message: "Invalid OTP", code: "OTP_INVALID" });
      }
    }

    const nowIso = new Date().toISOString();
    const updatedUser = await mutateCollection("users", (records) => {
      let nextUser = null;
      const nextRecords = records.map((item) => {
        if (item.id !== user.id) return item;
        nextUser = {
          ...item,
          ...buildVisitActivityUpdate(item, nowIso, { incrementVisit: true }),
          updatedAt: nowIso,
        };
        return nextUser;
      });
      return { records: nextRecords, value: nextUser };
    });

    if (updatedUser) {
      user = updatedUser;
      invalidateUserCache(user.id);
    }

    await logAuthSecurityEvent(req, {
      type: "LOGIN",
      userId: user.id,
      email: normalizedEmail,
      status: "OK",
    });

    const token = signToken(user);
    return res.json({
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/firebase", async (req, res) => {
  try {
    const idToken = String(req.body?.idToken || "").trim();
    const requestedName = String(req.body?.name || "").trim();
    const requestedFirstName = String(req.body?.firstName || "").trim();
    const requestedLastName = String(req.body?.lastName || "").trim();
    const termsAccepted = req.body?.termsAccepted === true;
    const privacyAccepted = req.body?.privacyAccepted === true;

    if (!idToken) {
      return res.status(400).json({ message: "Firebase token is required" });
    }

    const decoded = await verifyFirebaseIdToken(idToken);
    const firebaseUid = String(decoded.uid || "").trim();
    const normalizedEmail = normalizeEmail(decoded.email || "");
    const emailVerified = decoded.email_verified === true;
    const firebaseName = String(decoded.name || "").trim();
    const avatarUrl = String(decoded.picture || "").trim();

    if (!firebaseUid) {
      return res.status(401).json({ message: "Invalid Firebase token" });
    }

    if (!normalizedEmail) {
      return res.status(400).json({ message: "Verified email is required" });
    }

    if (!emailVerified) {
      return res.status(403).json({ message: "Google account email is not verified" });
    }

    const fullName = [requestedFirstName, requestedLastName].filter(Boolean).join(" ").trim() || requestedName || firebaseName || normalizedEmail.split("@")[0];

    const result = await mutateCollection("users", (records) => {
      const existing = records.find((user) => user.email === normalizedEmail);

      if (existing) {
        if (existing.firebaseUid && existing.firebaseUid !== firebaseUid) {
          return { records, value: { error: "FIREBASE_UID_CONFLICT" } };
        }

        const nowIso = new Date().toISOString();
        const updatedUser = {
          ...existing,
          firebaseUid,
          authProvider: "FIREBASE",
          avatarUrl: avatarUrl || existing.avatarUrl || "",
          name: existing.name || fullName,
          isActive: true,
          ...buildVisitActivityUpdate(existing, nowIso, { incrementVisit: true }),
          updatedAt: nowIso,
        };

        return {
          records: records.map((user) => (user.id === existing.id ? updatedUser : user)),
          value: { user: updatedUser, isNewUser: false },
        };
      }

      if (!termsAccepted || !privacyAccepted) {
        return { records, value: { error: "TERMS_REQUIRED" } };
      }

      const acceptedAt = new Date().toISOString();
      const user = createUser({
        email: normalizedEmail,
        name: fullName,
        passwordHash: null,
        role: USER_ROLES.USER,
        plan: USER_PLANS.FREE_TRIAL,
        subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
        authProvider: "FIREBASE",
        firebaseUid,
        avatarUrl,
        termsAcceptedAt: acceptedAt,
        privacyAcceptedAt: acceptedAt,
      });

      return {
        records: [user, ...records],
        value: { user, isNewUser: true },
      };
    });

    if (result?.error === "FIREBASE_UID_CONFLICT") {
      return res.status(409).json({ message: "This email is already linked to another Firebase account" });
    }

    if (result?.error === "TERMS_REQUIRED") {
      return res.status(400).json({ message: "Please accept the Terms of Service and Privacy Policy to continue." });
    }

    invalidateUserCache(result.user.id);

    await logAuthSecurityEvent(req, {
      type: result.isNewUser ? "REGISTER" : "LOGIN",
      userId: result.user.id,
      email: normalizedEmail,
      status: "OK",
      reason: "firebase",
    });

    const token = signToken(result.user);
    return res.json({
      token,
      user: sanitizeUser(result.user),
    });
  } catch {
    return res.status(401).json({ message: "Invalid Firebase token" });
  }
});

router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email);
    if (!normalizedEmail) {
      return res.status(400).json({ message: "Email is required" });
    }

    const resetCode = generateResetCode();
    const resetCodeHash = hashResetCode(normalizedEmail, resetCode);
    const now = Date.now();
    const expiresAt = new Date(now + RESET_CODE_TTL_MINUTES * 60 * 1000).toISOString();

    const result = await mutateCollection("users", (records) => {
      let matchedUser = null;
      const nextRecords = records.map((user) => {
        if (user.email !== normalizedEmail || user.isActive === false) return user;
        matchedUser = user;
        return {
          ...user,
          passwordReset: {
            codeHash: resetCodeHash,
            expiresAt,
            requestedAt: new Date(now).toISOString(),
            attempts: 0,
          },
          updatedAt: new Date().toISOString(),
        };
      });

      return {
        records: nextRecords,
        value: matchedUser ? { matched: true, matchedUserId: matchedUser.id, resetCode } : { matched: false },
      };
    });

    const payload = {
      message: getResetHelpMessage(),
      expiresInMinutes: RESET_CODE_TTL_MINUTES,
    };

    if (result?.matched) {
      await logAuthSecurityEvent(req, {
        type: "FORGOT_PASSWORD",
        userId: result.matchedUserId,
        email: normalizedEmail,
        status: "MATCHED",
      });

      const emailResult = await sendResetCodeEmail({
        toEmail: normalizedEmail,
        code: result.resetCode,
        expiresInMinutes: RESET_CODE_TTL_MINUTES,
      });

      if (!emailResult.sent) {
        console.warn("[auth/forgot-password] resend send skipped/failed:", emailResult.reason);
        await logAuthSecurityEvent(req, {
          type: "FORGOT_PASSWORD_EMAIL",
          userId: result.matchedUserId,
          level: "WARN",
          email: normalizedEmail,
          status: "FAILED",
          reason: emailResult.reason,
        });
      }

      if (emailResult.sent) {
        await logAuthSecurityEvent(req, {
          type: "FORGOT_PASSWORD_EMAIL",
          userId: result.matchedUserId,
          email: normalizedEmail,
          status: "SENT",
        });
      }
    } else {
      await logAuthSecurityEvent(req, {
        type: "FORGOT_PASSWORD",
        level: "WARN",
        email: normalizedEmail,
        status: "NOT_FOUND",
      });
    }

    if (exposeResetCode && result?.matched) {
      payload.resetCode = result.resetCode;
    }

    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/reset-password", resetPasswordLimiter, async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email);
    const resetCode = String(req.body?.code || "").trim();
    const newPassword = String(req.body?.newPassword || "");

    if (!normalizedEmail || !resetCode) {
      return res.status(400).json({ message: "Email and reset code are required" });
    }

    if (!/^\d{6}$/.test(resetCode)) {
      return res.status(400).json({ message: "Reset code must be 6 digits" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters" });
    }

    const submittedHash = hashResetCode(normalizedEmail, resetCode);

    const result = await mutateCollection("users", async (records) => {
      let status = "NOT_FOUND";
      let updatedUser = null;

      const nextRecords = records.map((user) => {
        if (user.email !== normalizedEmail || user.isActive === false) return user;

        const reset = user.passwordReset || null;
        if (!reset?.codeHash || !reset?.expiresAt) {
          status = "MISSING_RESET";
          return user;
        }

        if (Date.now() > new Date(reset.expiresAt).getTime()) {
          status = "EXPIRED";
          return {
            ...user,
            passwordReset: null,
            updatedAt: new Date().toISOString(),
          };
        }

        const attempts = Number(reset.attempts || 0);
        if (attempts >= MAX_RESET_VERIFY_ATTEMPTS) {
          status = "LOCKED";
          return {
            ...user,
            passwordReset: null,
            updatedAt: new Date().toISOString(),
          };
        }

        if (reset.codeHash !== submittedHash) {
          status = "INVALID_CODE";
          return {
            ...user,
            passwordReset: {
              ...reset,
              attempts: attempts + 1,
            },
            updatedAt: new Date().toISOString(),
          };
        }

        status = "OK";
        updatedUser = {
          ...user,
          passwordReset: null,
          updatedAt: new Date().toISOString(),
        };

        return updatedUser;
      });

      if (status === "OK") {
        updatedUser.passwordHash = await bcrypt.hash(newPassword, 10);
        return { records: nextRecords, value: { status, user: updatedUser } };
      }

      return { records: nextRecords, value: { status } };
    });

    if (!result || result.status !== "OK") {
      const status = result?.status;
      await logAuthSecurityEvent(req, {
        type: "RESET_PASSWORD",
        level: "WARN",
        email: normalizedEmail,
        status: status || "FAILED",
        reason: "invalid_or_expired",
      });
      if (["NOT_FOUND", "MISSING_RESET", "EXPIRED", "LOCKED", "INVALID_CODE"].includes(status)) {
        return res.status(400).json({ message: "Invalid or expired reset request" });
      }
      return res.status(400).json({ message: "Reset failed" });
    }

    await logAuthSecurityEvent(req, {
      type: "RESET_PASSWORD",
      userId: result.user.id,
      email: normalizedEmail,
      status: "OK",
    });

    invalidateUserCache(result.user.id);
    return res.json({ message: "Password reset successful. Please login with your new password." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/2fa/setup", requireAuth, async (req, res) => {
  try {
    const issuer = getTwoFactorIssuer();
    const email = req.rawUser?.email || req.user?.email || "user@example.com";
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(email, issuer, secret);

    const updated = await mutateCollection("users", (records) => {
      let nextUser = null;
      const nextRecords = records.map((user) => {
        if (user.id !== req.userId) return user;
        nextUser = {
          ...user,
          twoFactor: {
            ...(user.twoFactor || {}),
            enabled: Boolean(user.twoFactor?.enabled),
            secret: user.twoFactor?.secret || null,
            pendingSecret: secret,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        };
        return nextUser;
      });
      return { records: nextRecords, value: nextUser };
    });

    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    invalidateUserCache(req.userId);
    return res.json({
      message: "2FA setup secret generated. Verify OTP to enable.",
      secret,
      otpauthUrl,
      alreadyEnabled: Boolean(updated.twoFactor?.enabled),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/2fa/enable", requireAuth, async (req, res) => {
  try {
    const submittedOtp = String(req.body?.otp || "").trim();
    if (!submittedOtp) {
      return res.status(400).json({ message: "OTP is required" });
    }

    const users = await readCollection("users");
    const user = users.find((item) => item.id === req.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const pendingSecret = user?.twoFactor?.pendingSecret || user?.twoFactor?.secret || null;
    if (!pendingSecret) {
      return res.status(400).json({ message: "Run setup first to generate 2FA secret" });
    }

    if (!authenticator.check(submittedOtp, pendingSecret)) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    const updated = await mutateCollection("users", (records) => {
      let nextUser = null;
      const nextRecords = records.map((item) => {
        if (item.id !== req.userId) return item;
        nextUser = {
          ...item,
          twoFactor: {
            enabled: true,
            secret: pendingSecret,
            pendingSecret: null,
            enabledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        };
        return nextUser;
      });
      return { records: nextRecords, value: nextUser };
    });

    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    await logAuthSecurityEvent(req, {
      type: "2FA_ENABLE",
      userId: req.userId,
      email: updated.email,
      status: "OK",
    });

    invalidateUserCache(req.userId);
    return res.json({ message: "2FA enabled", user: sanitizeUser(updated) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/2fa/disable", requireAuth, async (req, res) => {
  try {
    const submittedOtp = String(req.body?.otp || "").trim();
    if (!submittedOtp) {
      return res.status(400).json({ message: "OTP is required" });
    }

    const users = await readCollection("users");
    const user = users.find((item) => item.id === req.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user?.twoFactor?.enabled || !user?.twoFactor?.secret) {
      return res.status(400).json({ message: "2FA is not enabled" });
    }

    if (!authenticator.check(submittedOtp, user.twoFactor.secret)) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    const updated = await mutateCollection("users", (records) => {
      let nextUser = null;
      const nextRecords = records.map((item) => {
        if (item.id !== req.userId) return item;
        nextUser = {
          ...item,
          twoFactor: {
            enabled: false,
            secret: null,
            pendingSecret: null,
            enabledAt: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        };
        return nextUser;
      });
      return { records: nextRecords, value: nextUser };
    });

    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    await logAuthSecurityEvent(req, {
      type: "2FA_DISABLE",
      userId: req.userId,
      email: updated.email,
      status: "OK",
    });

    invalidateUserCache(req.userId);
    return res.json({ message: "2FA disabled", user: sanitizeUser(updated) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  return res.json({
    user: req.user,
  });
});

router.post("/presence", requireAuth, async (req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const incrementVisit = shouldCountNewVisit(req.rawUser, nowIso);
    const updated = await mutateCollection("users", (records) => {
      let nextUser = null;
      const nextRecords = records.map((item) => {
        if (item.id !== req.userId) return item;
        nextUser = {
          ...item,
          ...buildVisitActivityUpdate(item, nowIso, { incrementVisit }),
          updatedAt: nowIso,
        };
        return nextUser;
      });
      return { records: nextRecords, value: nextUser };
    });

    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    invalidateUserCache(req.userId);
    return res.json({
      user: sanitizeUser(updated),
      presence: {
        incrementVisit,
        onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
        activeWindowHours: ACTIVE_WINDOW_HOURS,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get("/me/activity", requireAuth, async (req, res) => {
  try {
    const events = await listAuthSecurityEvents({
      limit: req.query?.limit || 50,
      userId: req.userId,
    });
    return res.json({ events });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.patch("/me/preferences", requireAuth, async (req, res) => {
  try {
    const nextPreferences = normalizeSignalPreferences(req.body || {});
    const updated = await mutateCollection("users", (records) => {
      let updatedUser = null;
      const nextRecords = records.map((user) => {
        if (user.id !== req.userId) return user;
        updatedUser = {
          ...user,
          signalPreferences: nextPreferences,
          updatedAt: new Date().toISOString(),
        };
        return updatedUser;
      });
      return { records: nextRecords, value: updatedUser };
    });

    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    invalidateUserCache(req.userId);
    return res.json({ user: sanitizeUser(updated) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Update self preferences (admin-only risk profile)
router.patch("/me", requireAuth, async (req, res) => {
  try {
    if (req.body?.riskPreference === undefined) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    if (req.user?.role !== USER_ROLES.ADMIN) {
      return res.status(403).json({ message: "Risk profile can only be set by admin" });
    }

    const preference = normalizeRiskPreference(req.body.riskPreference);
    const settings = await readCollection("appSettings");
    const next = [
      ...settings.filter((s) => s?.id !== "risk"),
      { id: "risk", preference, updatedAt: new Date().toISOString() },
    ];
    await writeCollection("appSettings", next);

    return res.json({
      user: { ...req.user, riskPreference: preference, effectiveRiskPreference: preference },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get("/users/debug/storage", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const users = await readCollection("users");
    const debug = getStorageDebugInfo();
    return res.json({
      ...debug,
      usersCount: users.length,
      sampleUserEmails: users.slice(0, 10).map((user) => user.email),
      sampleUserIds: users.slice(0, 10).map((user) => user.id),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await readCollection("users");
  return res.json({
    users: users.map(sanitizeUser),
  });
});

router.get("/users/activity", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const users = await readCollection("users");
    const nowMs = Date.now();
    const onlineThresholdMs = ONLINE_WINDOW_MINUTES * 60 * 1000;
    const activeThresholdMs = ACTIVE_WINDOW_HOURS * 60 * 60 * 1000;
    const today = toVisitDate();

    const mapped = users.map((user) => {
      const lastSeenAt = user?.lastSeenAt || null;
      const lastSeenMs = new Date(lastSeenAt || 0).getTime();
      const isOnline = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= onlineThresholdMs;
      const isActiveRecently = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= activeThresholdMs;
      const visitCountToday = String(user?.lastVisitDate || "") === today ? toNumber(user?.visitCountToday, 0) : 0;
      const totalVisitCount = toNumber(user?.totalVisitCount, 0);
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
        isActive: user.isActive !== false,
        lastSeenAt,
        isOnline,
        isActiveRecently,
        visitCountToday,
        totalVisitCount,
      };
    }).sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return new Date(b.lastSeenAt || 0).getTime() - new Date(a.lastSeenAt || 0).getTime();
    });

    const summary = {
      totalUsers: mapped.length,
      onlineUsers: mapped.filter((u) => u.isOnline).length,
      activeUsers: mapped.filter((u) => u.isActiveRecently).length,
      visitsToday: mapped.reduce((sum, u) => sum + toNumber(u.visitCountToday, 0), 0),
      onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
      activeWindowHours: ACTIVE_WINDOW_HOURS,
    };

    return res.json({ summary, users: mapped });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get("/security-events", requireAuth, requireAdmin, async (req, res) => {
  try {
    const events = await listAuthSecurityEvents({ limit: req.query?.limit || 100 });
    return res.json({ events });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.patch("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const allowed = ["isActive", "name", "plan", "role", "subscriptionEndsAt", "subscriptionStatus"];
    const result = await mutateCollection("users", (records) => {
      let updatedUser = null;

      const nextRecords = records.map((user) => {
        if (user.id !== req.params.id) {
          return user;
        }

        updatedUser = {
          ...user,
          updatedAt: new Date().toISOString(),
        };

        allowed.forEach((field) => {
          if (req.body[field] !== undefined) {
            updatedUser[field] = field === "riskPreference"
              ? normalizeRiskPreference(req.body[field])
              : req.body[field];
          }
        });

        return updatedUser;
      });

      return {
        records: nextRecords,
        value: updatedUser,
      };
    });

    if (!result) {
      return res.status(404).json({ message: "User not found" });
    }

    invalidateUserCache(req.params.id);
    return res.json({ user: sanitizeUser(result) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
