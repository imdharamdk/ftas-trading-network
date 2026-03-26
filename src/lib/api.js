const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const TOKEN_KEY = "ftas_auth_token";
const USER_KEY = "ftas_auth_user";
const inflightGets = new Map(); // key -> Promise (dedupe concurrent GETs)

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_GET_RETRIES = 1;

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isNetworkError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("network") || message.includes("fetch") || error?.name === "AbortError";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function getStoredUser() {
  const raw = localStorage.getItem(USER_KEY);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function storeSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function apiFetch(path, options = {}) {
  const { body, headers, skipAuth, token, timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options;
  const requestHeaders = new Headers(headers || {});
  const sessionToken = token || (!skipAuth ? getStoredToken() : "");

  if (body !== undefined && !requestHeaders.has("Content-Type")) {
    requestHeaders.set("Content-Type", "application/json");
  }

  if (sessionToken) {
    requestHeaders.set("Authorization", `Bearer ${sessionToken}`);
  }

  const method = (rest.method || "GET").toUpperCase();

  async function runFetch(attempt = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || DEFAULT_TIMEOUT_MS)));

    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        ...rest,
        headers: requestHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      let payload = {};

      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = {};
      }

      if (!response.ok) {
        const err = new Error(payload.message || "Request failed");
        err.status = response.status;
        if (payload.code) err.code = payload.code;

        const canRetry = method === "GET" && attempt < MAX_GET_RETRIES && isRetryableStatus(response.status);
        if (canRetry) {
          await delay(250 * (attempt + 1));
          return runFetch(attempt + 1);
        }

        throw err;
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ftas:api-success", { detail: { path, method, at: Date.now() } }));
      }

      return payload;
    } catch (error) {
      const canRetry = method === "GET" && attempt < MAX_GET_RETRIES && isNetworkError(error);
      if (canRetry) {
        await delay(250 * (attempt + 1));
        return runFetch(attempt + 1);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (method === "GET") {
    const key = `${sessionToken || "anon"}|${path}`;
    const inflight = inflightGets.get(key);
    if (inflight) return inflight;
    const task = runFetch();
    inflightGets.set(key, task);
    try {
      return await task;
    } finally {
      inflightGets.delete(key);
    }
  }

  return runFetch();
}

export function loginWithFirebase(payload) {
  return apiFetch("/auth/firebase", {
    method: "POST",
    body: payload,
    skipAuth: true,
  });
}
