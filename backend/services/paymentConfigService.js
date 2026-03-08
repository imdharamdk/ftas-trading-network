const { mutateCollection, readCollection } = require("../storage/fileStore");

const DEFAULT_CONTACT_PERSON = "maidkhoon@gmail.com";
const DEFAULT_PAYMENT_METHODS = [
  { id: "method_upi", label: "UPI", value: "" },
  { id: "method_bank", label: "Bank Transfer", value: "BANK" },
  { id: "method_crypto", label: "Crypto", value: "CRYPTO" },
];
const DEFAULT_PLANS = [
  {
    amountUsd: 25,
    code: "PRO",
    durationDays: 30,
    priceLabel: "$25/month",
  },
  {
    amountUsd: 99,
    code: "PREMIUM",
    durationDays: 180,
    priceLabel: "$99/6 months",
  },
];

function createDefaultPaymentConfig() {
  return {
    contactPerson: DEFAULT_CONTACT_PERSON,
    id: "payment_config",
    paymentMethods: DEFAULT_PAYMENT_METHODS,
    plans: DEFAULT_PLANS,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePaymentMethod(input, index = 0) {
  if (typeof input === "string") {
    const label = String(input || "").trim();

    return {
      id: `method_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_") || index}`,
      label,
      value: label.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    };
  }

  const label = String(input?.label || input?.value || "").trim();

  return {
    id: String(input?.id || `method_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_") || index}`),
    label,
    value: String(input?.value || label).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
  };
}

function normalizePaymentConfig(config = {}) {
  const merged = {
    ...createDefaultPaymentConfig(),
    ...config,
  };

  const seen = new Set();
  const paymentMethods = (Array.isArray(merged.paymentMethods) ? merged.paymentMethods : DEFAULT_PAYMENT_METHODS)
    .map(normalizePaymentMethod)
    .filter((method) => method.label && method.value)
    .filter((method) => {
      if (seen.has(method.value)) {
        return false;
      }

      seen.add(method.value);
      return true;
    });

  return {
    ...merged,
    contactPerson: String(merged.contactPerson || DEFAULT_CONTACT_PERSON).trim() || DEFAULT_CONTACT_PERSON,
    paymentMethods: paymentMethods.length ? paymentMethods : DEFAULT_PAYMENT_METHODS,
    plans: DEFAULT_PLANS,
    updatedAt: merged.updatedAt || new Date().toISOString(),
  };
}

async function getPaymentConfig() {
  const records = await readCollection("paymentSettings");

  if (records.length) {
    return normalizePaymentConfig(records[0]);
  }

  return mutateCollection("paymentSettings", () => {
    const config = createDefaultPaymentConfig();

    return {
      records: [config],
      value: config,
    };
  });
}

async function updatePaymentConfig(updater) {
  return mutateCollection("paymentSettings", (records) => {
    const current = normalizePaymentConfig(records[0] || createDefaultPaymentConfig());
    const nextPartial = typeof updater === "function" ? updater(current) : updater;
    const nextConfig = normalizePaymentConfig({
      ...current,
      ...(nextPartial || {}),
      updatedAt: new Date().toISOString(),
    });

    return {
      records: [nextConfig],
      value: nextConfig,
    };
  });
}

async function addPaymentMethod(label) {
  return updatePaymentConfig((current) => {
    const method = normalizePaymentMethod(label, current.paymentMethods.length);

    if (current.paymentMethods.some((item) => item.value === method.value)) {
      return current;
    }

    return {
      ...current,
      paymentMethods: [...current.paymentMethods, method],
    };
  });
}

async function removePaymentMethod(methodValue) {
  return updatePaymentConfig((current) => {
    const value = String(methodValue || "").trim().toUpperCase();

    return {
      ...current,
      paymentMethods: current.paymentMethods.filter((method) => method.value !== value),
    };
  });
}

function getPlanConfig(planCode, config = createDefaultPaymentConfig()) {
  return (config.plans || DEFAULT_PLANS).find((plan) => plan.code === String(planCode || "").trim().toUpperCase()) || null;
}

module.exports = {
  DEFAULT_CONTACT_PERSON,
  DEFAULT_PLANS,
  addPaymentMethod,
  getPaymentConfig,
  getPlanConfig,
  removePaymentMethod,
  updatePaymentConfig,
};
