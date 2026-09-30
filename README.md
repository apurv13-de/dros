# DROS

DROS is a static frontend with a small Node.js backend for persistent state and routing requests.

## Run locally

```bash
npm start
```

Then open `http://localhost:4173`.

The server provides:

- `GET /api/health` — health check
- `GET /api/state` — load the saved operations state
- `PUT /api/state` — save the operations state to `data/state.json`
- `DELETE /api/state` — remove the saved state
- `GET /api/route?from=lng,lat&to=lng,lat` — same-origin proxy to OSRM

The app still falls back to browser `localStorage` if it is opened directly as a file or the backend is unavailable.
