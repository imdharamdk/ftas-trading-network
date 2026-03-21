export function evaluatePasswordStrength(password) {
  const value = String(password || "");
  const checks = {
    length: value.length >= 8,
    upper: /[A-Z]/.test(value),
    lower: /[a-z]/.test(value),
    number: /\d/.test(value),
    symbol: /[^A-Za-z0-9]/.test(value),
  };

  const score = Object.values(checks).filter(Boolean).length;
  const percent = Math.max(10, Math.min(100, score * 20));

  if (score <= 2) {
    return { score, percent, label: "Weak", color: "#ef4444", checks };
  }

  if (score <= 4) {
    return { score, percent, label: "Medium", color: "#f59e0b", checks };
  }

  return { score, percent, label: "Strong", color: "#22c55e", checks };
}
