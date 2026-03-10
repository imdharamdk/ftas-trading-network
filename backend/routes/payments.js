const express = require("express");
const { requireAdmin, requireAuth } = require("../middleware/auth");
const { PAYMENT_STATUS, createPayment } = require("../models/Payment");
const {
  addPaymentMethod,
  getPaymentConfig,
  getPlanConfig,
  removePaymentMethod,
  updatePaymentMethod,
  updatePaymentConfig,
} = require("../services/paymentConfigService");
const { mutateCollection, readCollection } = require("../storage/fileStore");

const router = express.Router();

router.post("/", requireAuth, async (req, res) => {
  try {
    const { amount, method, notes, plan, reference, screenshotUrl } = req.body || {};
    const paymentConfig = await getPaymentConfig();
    const normalizedPlan = String(plan || "PRO").trim().toUpperCase();
    const normalizedMethod = String(method || "").trim().toUpperCase();
    const selectedPlan = getPlanConfig(normalizedPlan, paymentConfig);
    const hasMethod = paymentConfig.paymentMethods.some((item) => item.value === normalizedMethod);

    if (!amount || !reference) {
      return res.status(400).json({ message: "Amount and reference are required" });
    }

    if (!selectedPlan) {
      return res.status(400).json({ message: "Plan must be PRO or PREMIUM" });
    }

    if (!hasMethod) {
      return res.status(400).json({ message: "Selected payment method is not available" });
    }

    const payment = createPayment({
      amount,
      method: normalizedMethod,
      notes,
      plan: normalizedPlan,
      reference,
      screenshotUrl,
      userEmail: req.user.email,
      userId: req.user.id,
    });

    await mutateCollection("payments", (records) => [payment, ...records]);
    return res.status(201).json({ payment });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get("/my", requireAuth, async (req, res) => {
  const payments = await readCollection("payments");
  return res.json({
    payments: payments.filter((payment) => payment.userId === req.user.id),
  });
});

router.get("/settings", requireAuth, async (req, res) => {
  const settings = await getPaymentConfig();
  return res.json({ settings });
});

router.get("/", requireAuth, requireAdmin, async (req, res) => {
  const payments = await readCollection("payments");
  return res.json({ payments });
});

router.get("/pending", requireAuth, requireAdmin, async (req, res) => {
  const payments = await readCollection("payments");
  return res.json({
    payments: payments.filter((payment) => payment.status === PAYMENT_STATUS.PENDING),
  });
});

router.patch("/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const contactPerson = String(req.body?.contactPerson || "").trim();

    if (!contactPerson) {
      return res.status(400).json({ message: "Contact person is required" });
    }

    const settings = await updatePaymentConfig((current) => ({
      ...current,
      contactPerson,
    }));

    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/methods", requireAuth, requireAdmin, async (req, res) => {
  try {
    const label = String(req.body?.label || "").trim();

    if (!label) {
      return res.status(400).json({ message: "Method label is required" });
    }

    const settings = await addPaymentMethod(label);
    return res.status(201).json({ settings });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.delete("/methods/:method", requireAuth, requireAdmin, async (req, res) => {
  try {
    const settings = await removePaymentMethod(req.params.method);
    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.patch("/methods/:method", requireAuth, requireAdmin, async (req, res) => {
  try {
    const label = String(req.body?.label || "").trim();
    const value = String(req.body?.value || "").trim();

    if (!label && !value) {
      return res.status(400).json({ message: "Provide a new label and/or value" });
    }

    const settings = await updatePaymentMethod(req.params.method, { label, value });
    return res.json({ settings });
  } catch (error) {
    const status = error.message === "Payment method not found" ? 404 : 400;
    return res.status(status).json({ message: error.message });
  }
});

router.patch("/:id/review", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { durationDays, note = "", status } = req.body || {};
    const paymentConfig = await getPaymentConfig();

    if (![PAYMENT_STATUS.APPROVED, PAYMENT_STATUS.REJECTED].includes(status)) {
      return res.status(400).json({ message: "Status must be APPROVED or REJECTED" });
    }

    const payment = await mutateCollection("payments", (records) => {
      let updatedPayment = null;

      const nextRecords = records.map((item) => {
        if (item.id !== req.params.id) {
          return item;
        }

        updatedPayment = {
          ...item,
          status,
          reviewNote: note,
          reviewedBy: req.user.email,
          reviewedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        return updatedPayment;
      });

      return {
        records: nextRecords,
        value: updatedPayment,
      };
    });

    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    if (status === PAYMENT_STATUS.APPROVED) {
      const selectedPlan = getPlanConfig(payment.plan, paymentConfig);
      const resolvedDurationDays = Number(durationDays || selectedPlan?.durationDays || 30);

      await mutateCollection("users", (records) => {
        return records.map((user) => {
          if (user.id !== payment.userId) {
            return user;
          }

          const subscriptionEndsAt = new Date(
            Date.now() + resolvedDurationDays * 24 * 60 * 60 * 1000,
          ).toISOString();

          return {
            ...user,
            plan: payment.plan || user.plan,
            subscriptionStatus: "ACTIVE",
            subscriptionEndsAt,
            updatedAt: new Date().toISOString(),
          };
        });
      });
    }

    return res.json({ payment });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
