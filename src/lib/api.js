const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const TOKEN_KEY = "ftas_auth_token";
const USER_KEY = "ftas_auth_user";
const inflightGets = new Map(); // key -> Promise (dedupe concurrent GETs)

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
  const { body, headers, skipAuth, token, ...rest } = options;
  const requestHeaders = new Headers(headers || {});
  const sessionToken = token || (!skipAuth ? getStoredToken() : "");

  if (body !== undefined && !requestHeaders.has("Content-Type")) {
    requestHeaders.set("Content-Type", "application/json");
  }

  if (sessionToken) {
    requestHeaders.set("Authorization", `Bearer ${sessionToken}`);
  }

  const method = (rest.method || "GET").toUpperCase();

  async function runFetch() {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
      if (payload.code) err.code = payload.code;
      throw err;
    }

    return payload;
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
