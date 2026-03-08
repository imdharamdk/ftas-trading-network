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
- `ADMIN_BOOTSTRAP_EMAIL=admin@example.com`
- `ADMIN_BOOTSTRAP_PASSWORD=change_this_password`
- `ALPHA_VANTAGE_API_KEY=replace_with_free_news_key`
- `NEWS_CACHE_MS=900000`

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
