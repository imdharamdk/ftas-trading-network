# FTAS Trading Network

Website-based crypto futures signal platform with:

- React frontend for login, dashboard, scanner, news, payments, and admin control
- Node.js backend for auth, payment approval, manual signals, and auto-scanner control
- Advanced signal engine using Binance Futures candles and `technicalindicators`
- Local file storage for users, payments, and signals so the app runs without Mongo/Firebase

## Features

- Multi-timeframe scanner: `1m`, `5m`, `15m`, `1h`, `4h`
- Weighted confirmations: EMA, RSI, MACD, volume, Bollinger, candlestick patterns
- ATR stop loss and Fibonacci-style take profits
- Website-only signals view
- User auth and session handling
- Payment submission and admin approval flow
- Manual signal posting for admins
- Signal history, confidence analytics, and engine controls

## Project Structure

```text
ftas-trading-network/
  backend/
    data/              # local JSON storage
    routes/            # auth, payments, signals
    services/          # signal engine, Binance, indicators
    scripts/           # admin bootstrap, one-time scan
  src/
    pages/             # login, signup, dashboard, market, news
    components/        # shell, tables, analytics widgets
    context/           # session state
    lib/               # API helpers
```

## Environment Setup

Frontend:

```bash
cp .env.example .env
```

Set:

- `VITE_API_BASE_URL=/api`
- For a frontend-only deploy on Vercel or any static host, set `VITE_API_BASE_URL` to your hosted backend URL instead of `/api`
- For a Vercel frontend with a Render backend, use `VITE_API_BASE_URL=https://your-render-service.onrender.com/api`

Backend:

```bash
cd backend
cp .env.example .env
```

Important backend vars:

- `PORT=5000`
- `JWT_SECRET=replace_with_secure_secret`
- `ADMIN_SETUP_KEY=make_first_admin_secure`
- `AUTO_START_ENGINE=false`
- `SCAN_INTERVAL_MS=60000`
- `SCAN_MAX_COINS=60`
- `EXCHANGE_TIMEOUT_MS=15000`
- `EXCHANGE_RETRIES=1`
- `ADMIN_BOOTSTRAP_EMAIL=admin@example.com`
- `ADMIN_BOOTSTRAP_PASSWORD=change_this_password`
- `NEWS_PROVIDER=ALPHA_VANTAGE`
- `ALPHA_VANTAGE_API_KEY=replace_with_free_news_key`
- `NEWS_CACHE_MS=900000`
- `FRONTEND_URL=http://localhost:5173,http://127.0.0.1:5173`
- `SMART_API_KEY=from_Angel_One_portal`
- `SMART_API_CLIENT_CODE=your_angel_broking_id`
- `SMART_API_PASSWORD=angel_portal_password`
- `SMART_API_TOTP_SECRET=base32_seed_for_totp`
- `SMART_MAX_INSTRUMENTS=80`
- `SMART_SCAN_INTERVAL_MS=120000`
- `SMART_TRADE_TIMEFRAMES=5m,15m,1h,4h`
- `SMART_ALLOWED_SEGMENTS=EQUITY,FNO,COMMODITY`
- `AUTO_START_STOCK_ENGINE=false`
- `SMART_SIGNALS_PER_INSTRUMENT=2`
- Optional helpers: `SMART_API_CLIENT_LOCAL_IP`, `SMART_API_CLIENT_PUBLIC_IP`, `SMART_API_CLIENT_MAC`, `SMART_API_SOURCE_ID`, `SMART_API_BASE_URL`, `SMART_API_TIMEOUT_MS`

SmartAPI instruments can be provided in two ways:

1. Drop the official `OpenAPIScripMaster.json` (downloaded from Angel One) into `backend/config/` and the engine will automatically ingest the full scrip universe.
2. Or continue using the smaller curated list in `backend/config/smart-instruments.json`.

Each entry needs `symbol`, `tradingSymbol`, `exchange`, `segment`, and `token`; optional fields such as `lotSize`, `instrumentType`, or `expiry` are picked up by the stock engine. Use `SMART_MAX_INSTRUMENTS` and `SMART_SIGNALS_PER_INSTRUMENT` to control how many contracts are scanned per cycle.

## Install

Frontend:

```bash
npm install
```

Backend:

```bash
cd backend
npm install
```

## First Admin Bootstrap

Option 1: use the bootstrap script

```bash
cd backend
npm run bootstrap:admin -- --name="FTAS Admin" --email="admin@example.com" --password="secret123"
```

Option 2: set these in `backend/.env` and run:

```bash
cd backend
npm run bootstrap:admin
```

What it does:

- creates the admin if missing
- upgrades the matching account to `ADMIN` if it already exists
- resets the admin password to the value you provide

## Run Locally

Terminal 1:

```bash
cd backend
npm run dev
```

Terminal 2:

```bash
npm run dev
```

Frontend: `http://localhost:5173`

Backend API: `http://localhost:5000`

## Deployment Notes

- Vercel is suitable for the React frontend build.
- Deploy the Node backend separately on a Node host such as Render, Railway, or VPS.
- In hosted environments, point `VITE_API_BASE_URL` at the backend origin, for example `https://your-backend.example.com/api`.
- Set `FRONTEND_URL` in `backend/.env` to your frontend origin so CORS stays restricted in production.
- The included `render.yaml` omits the Render `plan` field so an existing service can keep its current tier instead of being forced to a new one on sync.
- If you do not want live Alpha Vantage news yet, set `NEWS_PROVIDER=FALLBACK` and the API will return built-in FTAS fallback articles with HTTP `200`.
- If you are using Vercel + Render, set Vercel `VITE_API_BASE_URL` to your Render API URL and set Render `FRONTEND_URL` to your Vercel domain.

## Useful Scripts

Frontend:

- `npm run dev`
- `npm run build`

Backend:

- `npm run dev`
- `npm start`
- `npm run scan:once`
- `npm run bootstrap:admin`

## Notes

- Signals are shown on the website only.
- Live auto-scanning needs internet access to Binance Futures API.
- Market news uses Alpha Vantage free news API through the backend route.
- Trading coin market data uses Binance Futures 24h ticker data.
- App data is stored in `backend/data/*.json`.
- `backend/data` is runtime state, not source-controlled app code.
