const axios  = require("axios");
const crypto = require("crypto");

const SMART_API_BASE_URL    = process.env.SMART_API_BASE_URL    || "https://apiconnect.angelone.in";
const SMART_API_TIMEOUT_MS  = Number(process.env.SMART_API_TIMEOUT_MS || 8000);
const SESSION_REFRESH_BUFFER_MS = 10 * 60 * 1000;

// ─── TIMEZONE FIX ────────────────────────────────────────────────────────────
// Render server UTC mein run karta hai.
// Angel One API dates IST (UTC+5:30) mein expect karta hai.
// Agar UTC bhejte hain toh Angel One 5.5 hours purana data samajhta hai
// aur 0 candles return karta hai.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +5:30

function toIST(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getTime() + IST_OFFSET_MS);
}

function formatSmartDate(value) {
  // Always convert to IST before formatting
  const ist = toIST(value instanceof Date ? value : new Date(value));
  const pad = n => String(n).padStart(2, "0");
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
}

const sessionState = {
  token:        null,
  refreshToken: null,
  expiresAt:    0,
  loginPromise: null,
};

function getSmartApiConfig() {
  const apiKey     = process.env.SMART_API_KEY;
  const clientCode = process.env.SMART_API_CLIENT_CODE;
  const mpin       = process.env.SMART_API_MPIN || process.env.SMART_API_PASSWORD;
  const totpSecret = process.env.SMART_API_TOTP_SECRET;

  if (!apiKey || !clientCode || !mpin || !totpSecret) {
    throw new Error("SMART_API_KEY / CLIENT_CODE / MPIN / TOTP_SECRET must be configured");
  }
  return {
    apiKey, clientCode, mpin, totpSecret,
    clientLocalIp:  process.env.SMART_API_CLIENT_LOCAL_IP  || "127.0.0.1",
    clientPublicIp: process.env.SMART_API_CLIENT_PUBLIC_IP || "127.0.0.1",
    macAddress:     process.env.SMART_API_CLIENT_MAC        || "00:00:00:00:00:00",
    sourceId:       process.env.SMART_API_SOURCE_ID         || "WEB",
  };
}

function buildHeaders(apiKey, token = null) {
  const h = {
    "Content-Type":     "application/json",
    Accept:             "application/json",
    "X-UserType":       "USER",
    "X-SourceID":       process.env.SMART_API_SOURCE_ID         || "WEB",
    "X-ClientLocalIP":  process.env.SMART_API_CLIENT_LOCAL_IP  || "127.0.0.1",
    "X-ClientPublicIP": process.env.SMART_API_CLIENT_PUBLIC_IP || "127.0.0.1",
    "X-PrivateKey":     apiKey,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function base32ToBuffer(secret) {
  const alpha   = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = String(secret || "").toUpperCase()
    .replace(/0/g, "O").replace(/1/g, "L").replace(/[^A-Z2-7]/g, "");
  if (!cleaned.length) return Buffer.alloc(0);
  let bits = "";
  for (const c of cleaned) {
    const v = alpha.indexOf(c);
    if (v !== -1) bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateTotp(secret) {
  const key     = base32ToBuffer(secret);
  if (!key.length) throw new Error("Invalid SMART_API_TOTP_SECRET");
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf     = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac   = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset+1] & 0xff) << 16) |
                  ((hmac[offset+2] & 0xff) << 8) | (hmac[offset+3] & 0xff);
  return (code % 1000000).toString().padStart(6, "0");
}

async function _doLogin() {
  const config = getSmartApiConfig();
  const totp   = generateTotp(config.totpSecret);
  const url    = `${SMART_API_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`;

  let response;
  try {
    response = await axios.post(url,
      { clientcode: config.clientCode, password: config.mpin, totp },
      {
        headers: {
          ...buildHeaders(config.apiKey),
          "X-ClientLocalIP":  config.clientLocalIp,
          "X-ClientPublicIP": config.clientPublicIp,
          "X-MACAddress":     config.macAddress,
        },
        timeout: SMART_API_TIMEOUT_MS,
      }
    );
  } catch (err) {
    const status  = err.response?.status;
    const payload = err.response?.data;
    console.error("[smartApi] Login failed:", status, JSON.stringify(payload || {}));
    throw new Error(payload?.message
      ? `SmartAPI login failed — ${payload.message}`
      : `SmartAPI login request failed (status ${status || "network"})`);
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
  if (sessionState.loginPromise) return sessionState.loginPromise;
  sessionState.loginPromise = _doLogin().finally(() => { sessionState.loginPromise = null; });
  return sessionState.loginPromise;
}

async function ensureSession() {
  const now = Date.now();
  if (sessionState.token && now < sessionState.expiresAt - SESSION_REFRESH_BUFFER_MS)
    return sessionState.token;
  await login();
  return sessionState.token;
}

async function postSecure(path, payload = {}) {
  const config = getSmartApiConfig();
  const token  = await ensureSession();
  const url    = `${SMART_API_BASE_URL}${path}`;
  try {
    const res = await axios.post(url, payload, {
      headers: {
        ...buildHeaders(config.apiKey, token),
        "X-ClientLocalIP":  config.clientLocalIp,
        "X-ClientPublicIP": config.clientPublicIp,
        "X-MACAddress":     config.macAddress,
      },
      timeout: SMART_API_TIMEOUT_MS,
    });
    return res.data;
  } catch (err) {
    const status  = err.response?.status;
    const payload = err.response?.data;
    console.error(`[smartApi] Request to ${path} failed:`, status, JSON.stringify(payload || {}));
    throw new Error(payload?.message || `SmartAPI request failed with status ${status || "network"}`);
  }
}

async function getQuote({ exchange, symbolToken, tradingSymbol, symbolName }) {
  if (!exchange || !symbolToken) throw new Error("getQuote requires exchange and symbolToken");
  const data = await postSecure("/rest/secure/angelbroking/market/v1/quote/", {
    mode: "FULL", exchange, symboltoken: symbolToken,
    tradingsymbol: tradingSymbol, symbol: symbolName,
  });
  return data?.data || null;
}

async function getLtp({ exchange, symbolToken }) {
  if (!exchange || !symbolToken) throw new Error("getLtp requires exchange and symbolToken");
  const data = await postSecure("/rest/secure/angelbroking/market/v1/ltp/", {
    exchange, symboltoken: symbolToken,
  });
  return data?.data || null;
}

async function getCandles({ exchange, symbolToken, interval, from, to }) {
  if (!exchange || !symbolToken || !interval)
    throw new Error("getCandles requires exchange, symbolToken, and interval");

  const fromDate = from ? (from instanceof Date ? from : new Date(from)) : new Date(Date.now() - 24*60*60*1000);
  const toDate   = to   ? (to   instanceof Date ? to   : new Date(to))   : new Date();

  const payload = {
    exchange,
    symboltoken: symbolToken,
    interval,
    fromdate: formatSmartDate(fromDate),
    todate:   formatSmartDate(toDate),
  };

  console.log(`[smartApi] Candle req: ${exchange} ${symbolToken} ${interval} from=${payload.fromdate} to=${payload.todate}`);

  const data = await postSecure("/rest/secure/angelbroking/historical/v1/getCandleData", payload);
  return data?.data?.candles || [];
}

module.exports = { login, ensureSession, getQuote, getLtp, getCandles, _sessionState: sessionState };
