const axios = require("axios");
const crypto = require("crypto");

const SMART_API_BASE_URL = process.env.SMART_API_BASE_URL || "https://apiconnect.angelbroking.com";
const SMART_API_TIMEOUT_MS = Number(process.env.SMART_API_TIMEOUT_MS || 8000);
const SESSION_REFRESH_BUFFER_MS = 10 * 60 * 1000;

function formatSmartDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const sessionState = {
  token: null,
  refreshToken: null,
  expiresAt: 0,
  // FIX 1: Login ke dauran parallel calls ko block karne ke liye promise share karo
  loginPromise: null,
};

function getSmartApiConfig() {
  const apiKey     = process.env.SMART_API_KEY;
  const clientCode = process.env.SMART_API_CLIENT_CODE;
  const mpin       = process.env.SMART_API_MPIN || process.env.SMART_API_PASSWORD;
  const totpSecret = process.env.SMART_API_TOTP_SECRET;

  if (!apiKey || !clientCode || !mpin || !totpSecret) {
    throw new Error("SMART_API_KEY / CLIENT_CODE / MPIN (or PASSWORD) / TOTP_SECRET must be configured");
  }

  return {
    apiKey,
    clientCode,
    mpin,
    totpSecret,
    clientLocalIp:  process.env.SMART_API_CLIENT_LOCAL_IP  || "127.0.0.1",
    clientPublicIp: process.env.SMART_API_CLIENT_PUBLIC_IP || "127.0.0.1",
    macAddress:     process.env.SMART_API_CLIENT_MAC        || "00:00:00:00:00:00",
    sourceId:       process.env.SMART_API_SOURCE_ID         || "WEB",
  };
}

function buildHeaders(apiKey, token = null) {
  const headers = {
    "Content-Type":    "application/json",
    Accept:            "application/json",
    "X-UserType":      "USER",
    "X-SourceID":      process.env.SMART_API_SOURCE_ID         || "WEB",
    "X-ClientLocalIP": process.env.SMART_API_CLIENT_LOCAL_IP  || "127.0.0.1",
    "X-ClientPublicIP":process.env.SMART_API_CLIENT_PUBLIC_IP || "127.0.0.1",
    "X-PrivateKey":    apiKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function base32ToBuffer(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned  = String(secret || "")
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "L")
    .replace(/[^A-Z2-7]/g, "");

  if (!cleaned.length) return Buffer.alloc(0);

  let bits = "";
  for (const char of cleaned) {
    const value = alphabet.indexOf(char);
    if (value !== -1) bits += value.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, options = {}) {
  const step   = Number(options.step   || 30);
  const digits = Number(options.digits || 6);
  const key    = base32ToBuffer(secret);

  if (!key.length) throw new Error("Invalid SMART_API_TOTP_SECRET");

  const counter = Math.floor(Date.now() / 1000 / step);
  const buffer  = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac   = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   =
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8)  |
     (hmac[offset + 3] & 0xff);

  return (code % 10 ** digits).toString().padStart(digits, "0");
}

// FIX 2: MPIN login endpoint use karo — Angel One ne password login band kar diya hai
async function _doLogin() {
  const config = getSmartApiConfig();
  const totp   = generateTotp(config.totpSecret);

  // Angel One ka naya MPIN login endpoint
  const url = `${SMART_API_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`;

  let response;
  try {
    response = await axios.post(
      url,
      {
        clientcode: config.clientCode,
        password:   config.mpin,   // MPIN bhejo yahan (env var SMART_API_MPIN set karo)
        totp,
      },
      {
        headers: {
          ...buildHeaders(config.apiKey),
          "X-ClientLocalIP":  config.clientLocalIp,
          "X-ClientPublicIP": config.clientPublicIp,
          "X-MACAddress":     config.macAddress,
        },
        timeout: SMART_API_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const status  = error.response?.status;
    const payload = error.response?.data;
    console.error("[smartApi] Login request failed:", status, JSON.stringify(payload || {}));
    throw new Error(
      payload?.message
        ? `SmartAPI login failed — ${payload.message}`
        : `SmartAPI login request failed (status ${status || "network"})`,
    );
  }

  const data = response.data?.data || {};
  sessionState.token        = data.jwtToken;
  sessionState.refreshToken = data.refreshToken;
  sessionState.expiresAt    = Date.now() + 22 * 60 * 60 * 1000;

  if (!sessionState.token) {
    console.error("[smartApi] Login response missing token:", JSON.stringify(response.data));
    throw new Error("SmartAPI login failed — token missing in response");
  }

  console.log("[smartApi] Session established successfully");
  return { token: sessionState.token, refreshToken: sessionState.refreshToken, data };
}

async function login() {
  // FIX 1: Ek hi waqt par sirf ek login hoga — baaki sab wait karenge
  if (sessionState.loginPromise) {
    return sessionState.loginPromise;
  }
  sessionState.loginPromise = _doLogin().finally(() => {
    sessionState.loginPromise = null;
  });
  return sessionState.loginPromise;
}

async function ensureSession() {
  const now = Date.now();
  if (sessionState.token && now < sessionState.expiresAt - SESSION_REFRESH_BUFFER_MS) {
    return sessionState.token;
  }
  await login();
  return sessionState.token;
}

async function postSecure(path, payload = {}) {
  const config = getSmartApiConfig();
  const token  = await ensureSession();
  const url    = `${SMART_API_BASE_URL}${path}`;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        ...buildHeaders(config.apiKey, token),
        "X-ClientLocalIP":  config.clientLocalIp,
        "X-ClientPublicIP": config.clientPublicIp,
        "X-MACAddress":     config.macAddress,
      },
      timeout: SMART_API_TIMEOUT_MS,
    });
    return response.data;
  } catch (error) {
    const status  = error.response?.status;
    const payload = error.response?.data;
    console.error(`[smartApi] Request to ${path} failed:`, status, JSON.stringify(payload || {}));
    throw new Error(payload?.message || `SmartAPI request failed with status ${status || "network"}`);
  }
}

async function getQuote({ exchange, symbolToken, tradingSymbol, symbolName }) {
  if (!exchange || !symbolToken) throw new Error("SmartAPI getQuote requires exchange and symbolToken");
  const payload = { mode: "FULL", exchange, symboltoken: symbolToken, tradingsymbol: tradingSymbol, symbol: symbolName };
  const data = await postSecure("/rest/secure/angelbroking/market/v1/quote/", payload);
  return data?.data || null;
}

async function getLtp({ exchange, symbolToken }) {
  if (!exchange || !symbolToken) throw new Error("SmartAPI getLtp requires exchange and symbolToken");
  const payload = { exchange, symboltoken: symbolToken };
  const data = await postSecure("/rest/secure/angelbroking/market/v1/ltp/", payload);
  return data?.data || null;
}

async function getCandles({ exchange, symbolToken, interval, from, to }) {
  if (!exchange || !symbolToken || !interval) throw new Error("SmartAPI getCandles requires exchange, symbolToken, and interval");
  const payload = {
    exchange,
    symboltoken: symbolToken,
    interval,
    fromdate: formatSmartDate(from || Date.now() - 24 * 60 * 60 * 1000),
    todate:   formatSmartDate(to   || Date.now()),
  };
  const data = await postSecure("/rest/secure/angelbroking/historical/v1/getCandleData", payload);
  return data?.data?.candles || [];
}

module.exports = {
  login,
  ensureSession,
  getQuote,
  getLtp,
  getCandles,
  _sessionState: sessionState,
};const axios = require("axios");
const crypto = require("crypto");

const SMART_API_BASE_URL = process.env.SMART_API_BASE_URL || "https://apiconnect.angelbroking.com";
const SMART_API_TIMEOUT_MS = Number(process.env.SMART_API_TIMEOUT_MS || 8000);
const SESSION_REFRESH_BUFFER_MS = 10 * 60 * 1000; // refresh 10 minutes before expiry

function formatSmartDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const sessionState = {
  token: null,
  refreshToken: null,
  expiresAt: 0,
};

function getSmartApiConfig() {
  const apiKey = process.env.SMART_API_KEY;
  const clientCode = process.env.SMART_API_CLIENT_CODE;
  const password = process.env.SMART_API_PASSWORD || process.env.SMART_API_CLIENT_PASSWORD;
  const totpSecret = process.env.SMART_API_TOTP_SECRET;

  if (!apiKey || !clientCode || !password || !totpSecret) {
    throw new Error("SMART_API_KEY/CLIENT_CODE/PASSWORD/TOTP_SECRET must be configured");
  }

  return {
    apiKey,
    clientCode,
    password,
    totpSecret,
    clientLocalIp: process.env.SMART_API_CLIENT_LOCAL_IP || "127.0.0.1",
    clientPublicIp: process.env.SMART_API_CLIENT_PUBLIC_IP || "127.0.0.1",
    macAddress: process.env.SMART_API_CLIENT_MAC || "00:00:00:00:00:00",
    sourceId: process.env.SMART_API_SOURCE_ID || "WEB",
  };
}

function buildHeaders(apiKey, token = null) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": process.env.SMART_API_SOURCE_ID || "WEB",
    "X-ClientLocalIP": process.env.SMART_API_CLIENT_LOCAL_IP || "127.0.0.1",
    "X-ClientPublicIP": process.env.SMART_API_CLIENT_PUBLIC_IP || "127.0.0.1",
    "X-PrivateKey": apiKey,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function base32ToBuffer(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = String(secret || "")
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "L")
    .replace(/[^A-Z2-7]/g, "");

  if (!cleaned.length) {
    return Buffer.alloc(0);
  }

  let bits = "";
  for (const char of cleaned) {
    const value = alphabet.indexOf(char);
    if (value === -1) {
      continue;
    }
    bits += value.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTotp(secret, options = {}) {
  const step = Number(options.step || 30);
  const digits = Number(options.digits || 6);
  const key = base32ToBuffer(secret);

  if (!key.length) {
    throw new Error("Invalid SMART_API_TOTP_SECRET");
  }

  const counter = Math.floor(Date.now() / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = (code % 10 ** digits).toString().padStart(digits, "0");
  return otp;
}

async function login() {
  const config = getSmartApiConfig();
  const totp = generateTotp(config.totpSecret);
  const url = `${SMART_API_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`;

  let response;

  try {
    response = await axios.post(
      url,
      {
        clientcode: config.clientCode,
        password: config.password,
        totp,
      },
      {
        headers: {
          ...buildHeaders(config.apiKey),
          "X-ClientLocalIP": config.clientLocalIp,
          "X-ClientPublicIP": config.clientPublicIp,
          "X-MACAddress": config.macAddress,
        },
        timeout: SMART_API_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const status = error.response?.status;
    const payload = error.response?.data;
    console.error("[smartApi] Login request failed:", status, JSON.stringify(payload || {}));
    throw new Error(
      payload?.message
        ? `SmartAPI login failed — ${payload.message}`
        : `SmartAPI login request failed (status ${status || "network"})`,
    );
  }

  const data = response.data?.data || {};
  sessionState.token = data.jwtToken;
  sessionState.refreshToken = data.refreshToken;
  sessionState.expiresAt = Date.now() + 22 * 60 * 60 * 1000; // refresh a bit earlier than 24h

  if (!sessionState.token) {
    console.error("[smartApi] Login response missing token:", JSON.stringify(response.data));
    throw new Error("SmartAPI login failed — token missing in response");
  }

  return {
    token: sessionState.token,
    refreshToken: sessionState.refreshToken,
    data,
  };
}

async function ensureSession() {
  const now = Date.now();
  if (sessionState.token && now < sessionState.expiresAt - SESSION_REFRESH_BUFFER_MS) {
    return sessionState.token;
  }
  await login();
  return sessionState.token;
}

async function postSecure(path, payload = {}) {
  const config = getSmartApiConfig();
  const token = await ensureSession();
  const url = `${SMART_API_BASE_URL}${path}`;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        ...buildHeaders(config.apiKey, token),
        "X-ClientLocalIP": config.clientLocalIp,
        "X-ClientPublicIP": config.clientPublicIp,
        "X-MACAddress": config.macAddress,
      },
      timeout: SMART_API_TIMEOUT_MS,
    });

    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const payload = error.response?.data;
    console.error(`[smartApi] Request to ${path} failed:`, status, JSON.stringify(payload || {}));
    throw new Error(payload?.message || `SmartAPI request failed with status ${status || "network"}`);
  }
}

async function getQuote({ exchange, symbolToken, tradingSymbol, symbolName }) {
  if (!exchange || !symbolToken) {
    throw new Error("SmartAPI getQuote requires exchange and symbolToken");
  }

  const payload = {
    mode: "FULL",
    exchange,
    symboltoken: symbolToken,
    tradingsymbol: tradingSymbol,
    symbol: symbolName,
  };

  const data = await postSecure("/rest/secure/angelbroking/market/v1/quote/", payload);
  return data?.data || null;
}

async function getLtp({ exchange, symbolToken }) {
  if (!exchange || !symbolToken) {
    throw new Error("SmartAPI getLtp requires exchange and symbolToken");
  }

  const payload = { exchange, symboltoken: symbolToken };

  const data = await postSecure("/rest/secure/angelbroking/market/v1/ltp/", payload);
  return data?.data || null;
}

async function getCandles({ exchange, symbolToken, interval, from, to }) {
  if (!exchange || !symbolToken || !interval) {
    throw new Error("SmartAPI getCandles requires exchange, symbolToken, and interval");
  }

  const payload = {
    exchange,
    symboltoken: symbolToken,
    interval,
    fromdate: formatSmartDate(from || Date.now() - 24 * 60 * 60 * 1000),
    todate: formatSmartDate(to || Date.now()),
  };

  const data = await postSecure("/rest/secure/angelbroking/historical/v1/getCandleData", payload);
  return data?.data?.candles || [];
}

module.exports = {
  login,
  ensureSession,
  getQuote,
  getLtp,
  getCandles,
  _sessionState: sessionState,
};
