const axios = require("axios");
const { authenticator } = require("otplib/authenticator");

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

async function login() {
  const config = getSmartApiConfig();
  const totp = authenticator.generate(config.totpSecret);
  const url = `${SMART_API_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`;

  const response = await axios.post(
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

  const data = response.data?.data || {};
  sessionState.token = data.jwtToken;
  sessionState.refreshToken = data.refreshToken;
  sessionState.expiresAt = Date.now() + 22 * 60 * 60 * 1000; // refresh a bit earlier than 24h

  if (!sessionState.token) {
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
