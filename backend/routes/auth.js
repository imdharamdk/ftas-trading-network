const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { invalidateUserCache, requireAdmin, requireAuth, signToken } = require("../middleware/auth");
const {
  SUBSCRIPTION_STATUS,
  USER_PLANS,
  USER_ROLES,
  createUser,
  normalizeEmail,
  normalizeRiskPreference,
  sanitizeUser,
} = require("../models/User");
const { mutateCollection, readCollection, writeCollection } = require("../storage/fileStore");
const { sendResetCodeEmail } = require("../services/emailService");
const { listAuthSecurityEvents, logAuthSecurityEvent } = require("../services/securityEventService");

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

function hashResetCode(email, code) {
  const secret = process.env.JWT_SECRET || "ftas-reset-secret";
  return crypto
    .createHash("sha256")
    .update(`${normalizeEmail(email)}:${String(code)}:${secret}`)
    .digest("hex");
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
    const { adminSetupKey, email, name, password, privacyAccepted, termsAccepted } = req.body || {};
    const normalizedEmail = normalizeEmail(email);

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
        name,
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
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const users = await readCollection("users");
    const user = users.find((item) => item.email === normalizedEmail);

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
        level: "WARN",
        email: normalizedEmail,
        status: "DENY",
        reason: "invalid_password",
      });
      return res.status(401).json({ message: "Invalid email or password" });
    }

    await logAuthSecurityEvent(req, {
      type: "LOGIN",
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
        value: matchedUser ? { matched: true, resetCode } : { matched: false },
      };
    });

    const payload = {
      message: getResetHelpMessage(),
      expiresInMinutes: RESET_CODE_TTL_MINUTES,
    };

    if (result?.matched) {
      await logAuthSecurityEvent(req, {
        type: "FORGOT_PASSWORD",
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
          level: "WARN",
          email: normalizedEmail,
          status: "FAILED",
          reason: emailResult.reason,
        });
      }

      if (emailResult.sent) {
        await logAuthSecurityEvent(req, {
          type: "FORGOT_PASSWORD_EMAIL",
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
      email: normalizedEmail,
      status: "OK",
    });

    invalidateUserCache(result.user.id);
    return res.json({ message: "Password reset successful. Please login with your new password." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  return res.json({
    user: req.user,
  });
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

router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await readCollection("users");
  return res.json({
    users: users.map(sanitizeUser),
  });
});

router.get("/security-events", requireAuth, requireAdmin, async (req, res) => {
  try {
    const events = await listAuthSecurityEvents(req.query?.limit || 100);
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
