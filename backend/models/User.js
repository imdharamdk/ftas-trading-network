const { createId } = require("../storage/fileStore");

const USER_ROLES = {
  ADMIN: "ADMIN",
  USER: "USER",
};

const USER_PLANS = {
  FREE: "FREE",
  FREE_TRIAL: "FREE_TRIAL",
  PREMIUM: "PREMIUM",
  PRO: "PRO",
};

const SUBSCRIPTION_STATUS = {
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  INACTIVE: "INACTIVE",
};

const FREE_TRIAL_DAYS = 7;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function addDaysToIso(days, baseDate = new Date()) {
  const date = new Date(baseDate);
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString();
}

function resolveSubscriptionStatus(user) {
  if (!user || user.isActive === false) {
    return SUBSCRIPTION_STATUS.INACTIVE;
  }

  if (user.role === USER_ROLES.ADMIN) {
    return SUBSCRIPTION_STATUS.ACTIVE;
  }

  const currentStatus = String(user.subscriptionStatus || SUBSCRIPTION_STATUS.INACTIVE).toUpperCase();

  if (currentStatus !== SUBSCRIPTION_STATUS.ACTIVE) {
    return currentStatus;
  }

  if (!user.subscriptionEndsAt) {
    return SUBSCRIPTION_STATUS.ACTIVE;
  }

  const subscriptionEndsAt = new Date(user.subscriptionEndsAt);

  if (Number.isNaN(subscriptionEndsAt.getTime())) {
    return SUBSCRIPTION_STATUS.ACTIVE;
  }

  return subscriptionEndsAt.getTime() > Date.now()
    ? SUBSCRIPTION_STATUS.ACTIVE
    : SUBSCRIPTION_STATUS.EXPIRED;
}

function hasSignalAccess(user) {
  if (!user || user.isActive === false) {
    return false;
  }

  if (user.role === USER_ROLES.ADMIN) {
    return true;
  }

  return resolveSubscriptionStatus(user) === SUBSCRIPTION_STATUS.ACTIVE;
}

function createUser({
  email,
  isActive = true,
  name,
  passwordHash,
  plan = USER_PLANS.FREE_TRIAL,
  role = USER_ROLES.USER,
  subscriptionEndsAt = addDaysToIso(FREE_TRIAL_DAYS),
  subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE,
}) {
  const now = new Date().toISOString();

  return {
    id: createId("usr"),
    name: String(name || "FTAS User").trim(),
    email: normalizeEmail(email),
    passwordHash,
    role,
    plan,
    isActive,
    subscriptionStatus,
    subscriptionEndsAt,
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const { passwordHash: _passwordHash, ...safeUser } = user;
  return {
    ...safeUser,
    hasSignalAccess: hasSignalAccess(safeUser),
    subscriptionStatus: resolveSubscriptionStatus(safeUser),
  };
}

module.exports = {
  FREE_TRIAL_DAYS,
  SUBSCRIPTION_STATUS,
  USER_ROLES,
  USER_PLANS,
  addDaysToIso,
  createUser,
  hasSignalAccess,
  normalizeEmail,
  resolveSubscriptionStatus,
  sanitizeUser,
};
