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

const RISK_PREFERENCES = {
  AGGRESSIVE: "AGGRESSIVE",
  BALANCED: "BALANCED",
  CONSERVATIVE: "CONSERVATIVE",
};

const SUBSCRIPTION_STATUS = {
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  INACTIVE: "INACTIVE",
};

const AUTH_PROVIDERS = {
  FIREBASE: "FIREBASE",
  LOCAL: "LOCAL",
};

const FREE_TRIAL_DAYS = 7;

const DEFAULT_SIGNAL_PREFERENCES = {
  minConfidence: 0,
  sides: ["LONG", "SHORT"],
  timeframes: [],
  blockedTimeframes: [],
  excludedCoins: [],
  onlyStrong: false,
};

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeRiskPreference(value) {
  const pref = String(value || "").trim().toUpperCase();
  if (pref === RISK_PREFERENCES.AGGRESSIVE) return RISK_PREFERENCES.AGGRESSIVE;
  if (pref === RISK_PREFERENCES.CONSERVATIVE) return RISK_PREFERENCES.CONSERVATIVE;
  return RISK_PREFERENCES.BALANCED;
}

function normalizeTwoFactor(value = {}) {
  return {
    enabled: Boolean(value?.enabled),
    secret: value?.secret ? String(value.secret) : null,
    pendingSecret: value?.pendingSecret ? String(value.pendingSecret) : null,
    enabledAt: value?.enabledAt || null,
    updatedAt: value?.updatedAt || null,
  };
}

function normalizeSignalPreferences(value = {}) {
  const minConfidence = Math.min(100, Math.max(0, Number(value?.minConfidence || 0)));
  const onlyStrong = Boolean(value?.onlyStrong);

  const sideValues = Array.isArray(value?.sides)
    ? value.sides.map((v) => String(v || "").toUpperCase()).filter((v) => v === "LONG" || v === "SHORT")
    : DEFAULT_SIGNAL_PREFERENCES.sides;
  const sides = [...new Set(sideValues)];

  const timeframeValues = Array.isArray(value?.timeframes)
    ? value.timeframes.map((v) => String(v || "").toLowerCase()).filter(Boolean)
    : [];
  const timeframes = [...new Set(timeframeValues)];

  const blockedTimeframeValues = Array.isArray(value?.blockedTimeframes)
    ? value.blockedTimeframes.map((v) => String(v || "").toLowerCase()).filter(Boolean)
    : [];
  const blockedTimeframes = [...new Set(blockedTimeframeValues)];

  const excludedCoinValues = Array.isArray(value?.excludedCoins)
    ? value.excludedCoins.map((v) => String(v || "").toUpperCase()).filter(Boolean)
    : [];
  const excludedCoins = [...new Set(excludedCoinValues)];

  return {
    minConfidence,
    onlyStrong,
    sides: sides.length ? sides : [...DEFAULT_SIGNAL_PREFERENCES.sides],
    timeframes,
    blockedTimeframes,
    excludedCoins,
  };
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
  passwordHash = null,
  plan = USER_PLANS.FREE_TRIAL,
  riskPreference = RISK_PREFERENCES.BALANCED,
  role = USER_ROLES.USER,
  signalPreferences = DEFAULT_SIGNAL_PREFERENCES,
  twoFactor = {},
  subscriptionEndsAt = addDaysToIso(FREE_TRIAL_DAYS),
  subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE,
  authProvider = AUTH_PROVIDERS.LOCAL,
  firebaseUid = "",
  avatarUrl = "",
  termsAcceptedAt = null,
  privacyAcceptedAt = null,
}) {
  const now = new Date().toISOString();
  const visitDate = now.slice(0, 10);

  return {
    id: createId("usr"),
    name: String(name || "FTAS User").trim(),
    email: normalizeEmail(email),
    passwordHash,
    role,
    plan,
    authProvider: String(authProvider || AUTH_PROVIDERS.LOCAL).trim().toUpperCase(),
    firebaseUid: String(firebaseUid || "").trim(),
    avatarUrl: String(avatarUrl || "").trim(),
    riskPreference: normalizeRiskPreference(riskPreference),
    signalPreferences: normalizeSignalPreferences(signalPreferences),
    twoFactor: normalizeTwoFactor(twoFactor),
    isActive,
    subscriptionStatus,
    subscriptionEndsAt,
    termsAcceptedAt,
    privacyAcceptedAt,
    lastSeenAt: now,
    lastVisitDate: visitDate,
    visitCountToday: 1,
    totalVisitCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const { passwordHash: _passwordHash, passwordReset: _passwordReset, twoFactor: _twoFactor, ...safeUser } = user;
  return {
    ...safeUser,
    hasSignalAccess: hasSignalAccess(safeUser),
    twoFactorEnabled: Boolean(user?.twoFactor?.enabled),
    subscriptionStatus: resolveSubscriptionStatus(safeUser),
  };
}

module.exports = {
  DEFAULT_SIGNAL_PREFERENCES,
  FREE_TRIAL_DAYS,
  SUBSCRIPTION_STATUS,
  AUTH_PROVIDERS,
  USER_ROLES,
  USER_PLANS,
  RISK_PREFERENCES,
  addDaysToIso,
  createUser,
  hasSignalAccess,
  normalizeEmail,
  normalizeRiskPreference,
  normalizeSignalPreferences,
  normalizeTwoFactor,
  resolveSubscriptionStatus,
  sanitizeUser,
};
