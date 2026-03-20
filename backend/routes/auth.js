const express = require("express");
const bcrypt = require("bcryptjs");
const { invalidateUserCache, requireAdmin, requireAuth, signToken } = require("../middleware/auth");
const {
  SUBSCRIPTION_STATUS,
  USER_PLANS,
  USER_ROLES,
  createUser,
  normalizeEmail,
  sanitizeUser,
} = require("../models/User");
const { mutateCollection, readCollection } = require("../storage/fileStore");

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { adminSetupKey, email, name, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !password || password.length < 6) {
      return res.status(400).json({ message: "Valid email and 6+ char password required" });
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
      const user = createUser({
        email: normalizedEmail,
        name,
        passwordHash,
        plan: role === USER_ROLES.ADMIN ? USER_PLANS.PREMIUM : USER_PLANS.FREE_TRIAL,
        role,
        subscriptionEndsAt: role === USER_ROLES.ADMIN ? null : undefined,
        subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      });

      return {
        records: [user, ...records],
        value: { user },
      };
    });

    if (result.error) {
      return res.status(409).json({ message: result.error });
    }

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
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password || "", user.passwordHash || "");

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = signToken(user);
    return res.json({
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  return res.json({
    user: req.user,
  });
});

router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await readCollection("users");
  return res.json({
    users: users.map(sanitizeUser),
  });
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
            updatedUser[field] = req.body[field];
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

    return res.json({
      user: sanitizeUser(result),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
