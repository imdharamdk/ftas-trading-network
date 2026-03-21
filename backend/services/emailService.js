const axios = require("axios");

const RESEND_API_BASE = "https://api.resend.com";

function hasResendConfig() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

async function sendResetCodeEmail({ toEmail, code, expiresInMinutes }) {
  if (!hasResendConfig()) {
    return { sent: false, skipped: true, reason: "missing_resend_config" };
  }

  const subject = "FTAS Password Reset Code";
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
      <h2 style="margin: 0 0 12px;">Password Reset Request</h2>
      <p style="margin: 0 0 10px;">Use this verification code to reset your FTAS account password:</p>
      <div style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 8px 0 12px;">${code}</div>
      <p style="margin: 0 0 8px;">This code will expire in <strong>${expiresInMinutes} minutes</strong>.</p>
      <p style="margin: 0; color: #555;">If you did not request this, you can ignore this email.</p>
    </div>
  `;

  const text = [
    "Password Reset Request",
    `Your FTAS reset code is: ${code}`,
    `This code expires in ${expiresInMinutes} minutes`,
    "If you did not request this, ignore this message.",
  ].join("\n");

  try {
    const response = await axios.post(
      `${RESEND_API_BASE}/emails`,
      {
        from: process.env.RESEND_FROM_EMAIL,
        to: [toEmail],
        subject,
        html,
        text,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: Number(process.env.RESEND_TIMEOUT_MS || 10000),
      }
    );

    return {
      sent: true,
      id: response?.data?.id || null,
    };
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      reason: error?.response?.data?.message || error.message || "resend_failed",
    };
  }
}

module.exports = {
  hasResendConfig,
  sendResetCodeEmail,
};
