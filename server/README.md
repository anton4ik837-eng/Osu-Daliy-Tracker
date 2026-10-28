# osu! Daily Tracker OAuth broker (pre-alpha)

This is a small Cloudflare Worker for the osu! OAuth **authorization-code** flow. The app must never contain `OSU_CLIENT_SECRET`.

## What it does

1. `GET /oauth/start?state=...` stores a short-lived state value and redirects to osu!'s consent screen.
2. osu! redirects to `GET /oauth/callback`. The Worker validates and consumes state, then exchanges the one-time authorization code with osu! using the secret stored as a Worker secret.
3. The Worker stores the token response in KV for **90 seconds only**, then redirects to the app's custom URL scheme with a random one-time handoff ID.
4. The app calls `POST /oauth/exchange` with that handoff ID. The Worker returns the token response and deletes the KV entry.

The Worker does **not** store user tokens long-term, user profiles, replay files, or play history. The app is responsible for storing the token locally using platform-secure storage. The handoff is short-lived and single-use; KV is not a transactional database, so this is a minimal pre-alpha design, not a high-security financial system.

## Configure osu!

Register an OAuth application in osu! account settings. Set its callback URL to the deployed Worker URL plus `/oauth/callback`, for example:

`https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/oauth/callback`

The osu! API docs currently specify `client_secret` for authorization-code exchange, so keep it server-side. Use only the scopes this app needs: `public identify`.

## Deploy

1. Install Wrangler and authenticate with Cloudflare.
2. Create a KV namespace, then copy its ID into a real `wrangler.toml` based on `wrangler.toml.example`. Do not commit real credentials or IDs if you prefer to keep deployment metadata private.
3. From this directory, create the secrets:
   - `npx wrangler secret put OSU_CLIENT_ID`
   - `npx wrangler secret put OSU_CLIENT_SECRET`
4. Set Worker variables:
   - `OAUTH_REDIRECT_URI=https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/oauth/callback`
   - `APP_REDIRECT_URI=osudailytracker://oauth`
5. Deploy with `npx wrangler deploy` and verify `GET /health`.

The client ID is not a password, but storing both values as Worker secrets simplifies configuration. Never paste the client secret into GitHub source, app HTML, APK, screenshots, or chat.

## Endpoints

- `GET /health` — health check only.
- `GET /oauth/start?state=<32-128 URL-safe random chars>` — starts authorization.
- `GET /oauth/callback` — registered osu! callback.
- `POST /oauth/exchange` with JSON `{"handoff":"<64 hex chars>"}` — redeems the one-time handoff.

## Current limitation

This commit adds the server-side flow scaffold only. It is not live until an OAuth app is registered, Worker secrets/variables and KV are configured, and the Capacitor app has a native deep-link handler plus secure token storage. Do not advertise OAuth as working until the app integration is complete and tested.
