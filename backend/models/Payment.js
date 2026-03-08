const { createId } = require("../storage/fileStore");

const PAYMENT_STATUS = {
  APPROVED: "APPROVED",
  PENDING: "PENDING",
  REJECTED: "REJECTED",
};

function createPayment({
  amount,
  method = "UPI",
  notes = "",
  plan = "PRO",
  reference,
  screenshotUrl = "",
  userEmail,
  userId,
}) {
  const now = new Date().toISOString();

  return {
    id: createId("pay"),
    userId,
    userEmail: String(userEmail || "").trim().toLowerCase(),
    amount: Number(amount || 0),
    method: String(method || "UPI").trim(),
    reference: String(reference || "").trim(),
    plan: String(plan || "PRO").trim().toUpperCase(),
    screenshotUrl: String(screenshotUrl || "").trim(),
    notes: String(notes || "").trim(),
    status: PAYMENT_STATUS.PENDING,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

module.exports = {
  PAYMENT_STATUS,
  createPayment,
};
