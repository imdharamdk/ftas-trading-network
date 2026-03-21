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

function buildResetEmailHtml(code, expiresInMinutes) {
  const appUrl = String(process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || "https://ftas-trading-network.vercel.app")
    .split(",")[0]
    .trim();

  return `
    <div style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
        <div style="padding:18px 20px;background:linear-gradient(90deg,#111827,#1f2937);color:#f9fafb;">
          <div style="font-size:12px;opacity:0.85;letter-spacing:0.6px;">FTAS TRADING NETWORK</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Password Reset Request</div>
        </div>
        <div style="padding:20px;line-height:1.6;">
          <p style="margin:0 0 10px;">We received a request to reset your FTAS account password.</p>
          <p style="margin:0 0 12px;">Use this verification code:</p>
          <div style="display:inline-block;padding:12px 16px;border-radius:10px;background:#0f172a;color:#f8fafc;font-size:30px;font-weight:700;letter-spacing:5px;">${code}</div>
          <p style="margin:14px 0 0;">This code expires in <strong>${expiresInMinutes} minutes</strong>.</p>
          <p style="margin:12px 0 0;color:#4b5563;">If you did not request this, you can safely ignore this email.</p>
        </div>
        <div style="padding:14px 20px;background:#f9fafb;border-top:1px solid #e5e7eb;">
          <a href="${appUrl}" style="color:#1d4ed8;text-decoration:none;font-weight:600;">Open FTAS Dashboard</a>
        </div>
      </div>
    </div>
  `;
}

async function sendResetCodeEmail({ toEmail, code, expiresInMinutes }) {
  if (!hasResendConfig()) {
    return { sent: false, skipped: true, reason: "missing_resend_config" };
  }

  const subject = "FTAS Password Reset Code";
  const html = buildResetEmailHtml(code, expiresInMinutes);
  const text = [
    "FTAS Password Reset Request",
    `Your verification code is: ${code}`,
    `This code expires in ${expiresInMinutes} minutes.`,
    "If you did not request this, ignore this email.",
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
