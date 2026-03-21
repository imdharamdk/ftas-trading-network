const { Resend } = require("resend");

function hasResendConfig() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

function buildResendClient() {
  // Replace `re_xxxxxxxxx` with your real API key in backend/.env as RESEND_API_KEY.
  return new Resend(process.env.RESEND_API_KEY || "re_xxxxxxxxx");
}

function formatResendError(error) {
  if (!error) return "resend_failed";
  const statusCode = error.statusCode || error.status || null;
  const code = error.name || error.code || null;
  const message = error.message || "resend_failed";
  if (statusCode && code) return `${statusCode}:${code}:${message}`;
  if (statusCode) return `${statusCode}:${message}`;
  if (code) return `${code}:${message}`;
  return message;
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
    const resend = buildResendClient();
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: [toEmail],
      subject,
      html,
      text,
    });

    if (error) {
      return {
        sent: false,
        skipped: false,
        reason: formatResendError(error),
      };
    }

    return {
      sent: true,
      id: data?.id || null,
    };
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      reason: formatResendError(error),
    };
  }
}

module.exports = {
  hasResendConfig,
  sendResetCodeEmail,
};
