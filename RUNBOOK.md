# FTAS Local Runbook

## Quick Start

From repo root:

```bash
npm install
cd backend && npm install
```

Optional env setup:

```bash
cp .env.example .env
cd backend && cp .env.example .env
```

Minimum useful backend vars in `backend/.env`:

```env
JWT_SECRET=replace_with_secure_secret
FRONTEND_URL=http://localhost:5173
NEWS_PROVIDER=ALPHA_VANTAGE
ALPHA_VANTAGE_API_KEY=replace_with_free_news_key
```

Start the app in two terminals:

```bash
cd /home/sunny/ftas-trading-network/backend
npm run dev
```

```bash
cd /home/sunny/ftas-trading-network
npm run dev
```

Open:

- Frontend: `http://localhost:5173`
- Backend health: `http://localhost:5000/api/health`

## First Access

- If there are no users yet, the first signup becomes `ADMIN`.
- The repo currently contains a legacy `backend/data/user.json`; the app now reads that file too, so old admin data is not silently ignored.
- If you want a deterministic admin without signup, run:

```bash
cd /home/sunny/ftas-trading-network/backend
npm run bootstrap:admin -- --name="FTAS Admin" --email="admin@example.com" --password="secret123"
```

## Manual QA Checklist

1. Open `/signup`, create a fresh account, and confirm redirect to `/dashboard`.
2. Log out and log back in from `/` with the same credentials.
3. On dashboard, confirm overview cards, active signals, and history sections render without a red error banner.
4. Open `/market` and confirm coins load, search suggestions appear, and clicking a coin opens the chart modal.
5. Open `/news` and confirm either live articles load or the fallback FTAS cards appear with a warning banner.
6. As a normal user, submit a payment with `amount`, `reference`, and a valid method; confirm it appears under your payment history.
7. As an admin, confirm scanner controls render on dashboard and `Start`, `Stop`, `Manual Scan`, and `Seed Demo` complete without API errors.
8. As an admin, review a pending payment and confirm the target user's plan/status updates.
9. As an admin, post a manual signal and confirm it appears in active signals/market view.
10. As an admin, change a user's plan or active state and confirm the badge/status in UI updates after refresh.

## Troubleshooting

- If frontend loads but API calls fail, verify `VITE_API_BASE_URL` and that backend is running on port `5000`.
- If login/signup works but no seeded admin appears, inspect `backend/data/user.json` and `backend/data/users.json`.
- If news fails, app should still work; only Alpha Vantage-backed content is affected.
- To force a stable non-live feed, set `NEWS_PROVIDER=FALLBACK` in `backend/.env`.
- If market data is empty on a hosted environment, outbound exchange API access may be blocked or rate-limited.
