# Deployment

## Frontend

Use Vercel for the React app at repo root.

Required frontend environment variable:

```env
VITE_API_BASE_URL=https://your-backend-domain.example.com/api
```

For Vercel + Render specifically:

```env
VITE_API_BASE_URL=https://your-render-service.onrender.com/api
```

Notes:

- The existing [vercel.json](/home/sunny/ftas-trading-network/vercel.json) keeps SPA routing working.
- Do not leave `VITE_API_BASE_URL=/api` in production unless you are proxying `/api` on the same host.

## Backend

Use Render, Railway, or another Node host for `backend/`.

This repo now includes [render.yaml](/home/sunny/ftas-trading-network/render.yaml) for a basic Render web service.

The Blueprint intentionally leaves out the Render `plan` field so an existing service keeps its current instance type, and a new service can choose its tier in the Render dashboard.

Minimum backend environment variables:

```env
NODE_ENV=production
JWT_SECRET=replace_with_secure_secret
FRONTEND_URL=https://your-frontend-domain.example.com
NEWS_PROVIDER=ALPHA_VANTAGE
ALPHA_VANTAGE_API_KEY=replace_with_real_key
AUTO_START_ENGINE=true
SCAN_INTERVAL_MS=30000
SCAN_MAX_COINS=20
EXCHANGE_TIMEOUT_MS=15000
EXCHANGE_RETRIES=1
```

Optional:

```env
ADMIN_SETUP_KEY=make_first_admin_secure
ADMIN_BOOTSTRAP_EMAIL=admin@example.com
ADMIN_BOOTSTRAP_PASSWORD=change_this_password
AUTO_START_ENGINE=false
```

## News Provider

- `NEWS_PROVIDER=ALPHA_VANTAGE` uses the live provider when `ALPHA_VANTAGE_API_KEY` is set.
- `NEWS_PROVIDER=FALLBACK` always returns built-in FTAS articles and avoids third-party dependency during deploy bring-up.
- The included [render.yaml](/home/sunny/ftas-trading-network/render.yaml) now defaults to automatic scanner start with a 30-second interval and a 20-coin scan cap.
- Pick the Render instance type in the dashboard when creating a new service, or keep your current plan if the service already exists.

## CORS

- `FRONTEND_URL` supports comma-separated origins.
- In development, localhost origins for Vite are allowed automatically.
- In production, only configured origins receive CORS headers.
