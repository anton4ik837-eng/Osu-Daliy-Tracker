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

## Gemini LLM Gateway (beta)

The Worker proxies LLM requests to Gemini. The Gemini API key is a Cloudflare Worker secret; it must never be placed in the APK, app HTML, or public repository.

Configure secrets in the Worker environment:

```sh
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put AI_RESEARCH_TOKEN
```

Optional Worker variable: `GEMINI_MODEL` (defaults to `gemini-2.5-flash`).

### Player coach

`POST /api/ai/chat`

- Requires the user's existing osu! OAuth access token in `Authorization: Bearer ...`.
- Revalidates the token against osu! API before accepting the request.
- Accepts `messages` (1–12 user/assistant messages) and an optional structured `context` object.
- Limits requests to 20 per authenticated account per hour.
- Does not persist chat content or replay data. Do not send raw `.osr` files or identifying information.

Example body:

```json
{
  "messages": [{ "role": "user", "content": "Разбери стабильность стримов по этим метрикам." }],
  "context": { "bpm": 180, "ur": 95, "stream_stability": 72 }
}
```

### Research assistant

`POST /api/ai/research`

- Requires `Authorization: Bearer <AI_RESEARCH_TOKEN>`.
- The token is server/admin-only and must not be embedded in the Android app or distributed to users.
- Accepts curated aggregate reports and metrics only; no automatic repository writes, training runs, or publishing.
- Limited to 10 requests per hour.

Both endpoints return `{ ok, reply, provider, model, usage }` on success. Requests are size-limited; the gateway accepts only user/assistant chat roles and supplies its own system instructions. Gemini provider failures are returned as safe error codes without forwarding provider diagnostics or credentials.

The gateway is server-side infrastructure only. It is not yet wired to a chat screen in the Android app, and a successful source commit does not mean the Worker has been deployed. Configure the two Worker secrets and verify the deployment before enabling client calls.
