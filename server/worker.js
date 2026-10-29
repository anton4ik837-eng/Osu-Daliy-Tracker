const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(data, status = 200) {
  // Add CORS to every JSON response, including 404s and OAuth diagnostics.
  // Without this, WebViews often turn a useful HTTP error into opaque "Failed to fetch".
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}

function safeAppRedirect(env, params) {
  const target = new URL(env.APP_REDIRECT_URI || "osudailytracker://oauth");
  for (const [key, value] of Object.entries(params)) {
    if (value != null) target.searchParams.set(key, String(value));
  }
  return Response.redirect(target.toString(), 302);
}

function validState(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}


function apiJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}

function validMode(value) {
  return ["osu", "taiko", "fruits", "mania"].includes(value) ? value : null;
}

async function getPublicApiToken(env) {
  const clientId = typeof env.OSU_CLIENT_ID === "string" ? env.OSU_CLIENT_ID.trim() : "";
  const clientSecret = typeof env.OSU_CLIENT_SECRET === "string" ? env.OSU_CLIENT_SECRET.trim() : "";
  if (!clientId || !/^[0-9]+$/.test(clientId) || !clientSecret) {
    throw new Error("osu_api_not_configured");
  }
  const response = await fetch("https://osu.ppy.sh/oauth/token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "public",
    }),
  });
  if (!response.ok) throw new Error("osu_api_token_failed");
  const tokens = await response.json();
  if (!tokens.access_token) throw new Error("osu_api_token_invalid");
  return tokens.access_token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "600",
        },
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "osu-daily-tracker-oauth", version: 2, deploy_marker: "replay-cors-fix-2026-10-29" });
    }

    // Recent scores for the authenticated osu! account.
    if (url.pathname === "/api/me/scores/recent" && request.method === "GET") {
      const auth = request.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match) return apiJson({ error: "missing_bearer_token" }, 401);
      const limitRaw = Number.parseInt(url.searchParams.get("limit") || "20", 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
      const mode = validMode(url.searchParams.get("mode") || "osu");
      if (!mode) return apiJson({ error: "invalid_mode" }, 400);
      const headers = { accept: "application/json", authorization: "Bearer " + match[1] };
      const meResponse = await fetch("https://osu.ppy.sh/api/v2/me/" + mode, { headers });
      const me = await meResponse.json().catch(() => ({}));
      if (!meResponse.ok || !me.id) return apiJson({ error: me.error || "osu_profile_request_failed", status: meResponse.status }, meResponse.status === 401 ? 401 : 502);
      const scoresUrl = new URL("https://osu.ppy.sh/api/v2/users/" + encodeURIComponent(me.id) + "/scores/recent");
      scoresUrl.searchParams.set("mode", mode);
      scoresUrl.searchParams.set("limit", String(limit));
      scoresUrl.searchParams.set("include_fails", "1");
      const response = await fetch(scoresUrl, { headers });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return apiJson({ error: payload.error || "osu_recent_scores_failed", status: response.status }, response.status === 401 ? 401 : 502);
      return apiJson({ user: { id: me.id, username: me.username }, scores: Array.isArray(payload) ? payload : [] });
    }

    // Only permit downloading a score that belongs to this user's recent score list.
    if (url.pathname.startsWith("/api/me/scores/") && url.pathname.endsWith("/download") && request.method === "GET") {
      const auth = request.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match) return apiJson({ error: "missing_bearer_token" }, 401);
      const scoreId = url.pathname.match(/^\/api\/me\/scores\/([0-9]+)\/download$/)?.[1];
      if (!scoreId) return apiJson({ error: "invalid_score_id" }, 400);
      const mode = validMode(url.searchParams.get("mode") || "osu");
      if (!mode) return apiJson({ error: "invalid_mode" }, 400);
      const headers = { accept: "application/json", authorization: "Bearer " + match[1] };
      const meResponse = await fetch("https://osu.ppy.sh/api/v2/me/" + mode, { headers });
      const me = await meResponse.json().catch(() => ({}));
      if (!meResponse.ok || !me.id) return apiJson({ error: me.error || "osu_profile_request_failed", status: meResponse.status }, meResponse.status === 401 ? 401 : 502);
      const scoresUrl = new URL("https://osu.ppy.sh/api/v2/users/" + encodeURIComponent(me.id) + "/scores/recent");
      scoresUrl.searchParams.set("mode", mode);
      scoresUrl.searchParams.set("limit", "50");
      scoresUrl.searchParams.set("include_fails", "1");
      const scoresResponse = await fetch(scoresUrl, { headers });
      const scores = await scoresResponse.json().catch(() => []);
      const ownedScore = Array.isArray(scores) ? scores.find(score => String(score.id) === scoreId) : null;
      if (!ownedScore) return apiJson({ error: "score_not_in_recent_list" }, 404);
      if (!ownedScore.has_replay) return apiJson({ error: "replay_unavailable" }, 404);
      const download = await fetch("https://osu.ppy.sh/api/v2/scores/" + mode + "/" + encodeURIComponent(scoreId) + "/download", { headers: { authorization: "Bearer " + match[1] } });
      if (!download.ok) return apiJson({ error: download.status === 404 ? "replay_unavailable" : "osu_replay_download_failed", status: download.status }, download.status === 401 ? 401 : download.status === 404 ? 404 : 502);
      return new Response(download.body, { status: 200, headers: {
        "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "authorization", "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="osu-score-' + scoreId + '.osr"',
        "x-content-type-options": "nosniff"
      }});
    }

    // Return the authenticated user's own profile using the short-lived OAuth access token.
    if (url.pathname === "/api/me" && request.method === "GET") {
      const auth = request.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match) return apiJson({ error: "missing_bearer_token" }, 401);
      const mode = validMode(url.searchParams.get("mode") || "osu");
      if (!mode) return apiJson({ error: "invalid_mode" }, 400);
      const response = await fetch("https://osu.ppy.sh/api/v2/me/" + mode, {
        headers: { accept: "application/json", authorization: "Bearer " + match[1] },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return apiJson({ error: payload.error || "osu_profile_request_failed", status: response.status }, response.status === 401 ? 401 : 502);
      }
      return apiJson(payload);
    }

    // Public profile lookup used by the manual username/ID search.
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && request.method === "GET") {
      const user = decodeURIComponent(userMatch[1]);
      const mode = validMode(url.searchParams.get("mode") || "osu");
      if (!mode) return apiJson({ error: "invalid_mode" }, 400);
      if (!user || user.length > 80) return apiJson({ error: "invalid_user" }, 400);
      let token;
      try { token = await getPublicApiToken(env); }
      catch (error) { return apiJson({ error: error.message || "osu_api_unavailable" }, 503); }
      const response = await fetch("https://osu.ppy.sh/api/v2/users/" + encodeURIComponent(user) + "/" + mode, {
        headers: { accept: "application/json", authorization: "Bearer " + token },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return apiJson({ error: payload.error || "osu_profile_not_found", status: response.status }, response.status === 404 ? 404 : 502);
      }
      return apiJson(payload);
    }

    // Safe configuration diagnostics: never return credential values.
    if (url.pathname === "/oauth/config-check" && request.method === "GET") {
      const clientId = typeof env.OSU_CLIENT_ID === "string" ? env.OSU_CLIENT_ID.trim() : "";
      const redirectUri = typeof env.OAUTH_REDIRECT_URI === "string" ? env.OAUTH_REDIRECT_URI.trim() : "";
      return json({
        client_id_present: clientId.length > 0,
        client_id_numeric: /^[0-9]+$/.test(clientId),
        client_id_length: clientId.length,
        client_secret_present: typeof env.OSU_CLIENT_SECRET === "string" && env.OSU_CLIENT_SECRET.trim().length > 0,
        redirect_uri_present: redirectUri.length > 0,
        redirect_uri_is_expected: redirectUri === new URL(request.url).origin + "/oauth/callback",
        kv_bound: Boolean(env.OAUTH_KV),
      });
    }

    // Safe OAuth diagnostics: show the exact non-secret authorization parameters without redirecting.
    // This helps distinguish a Worker/KV problem from osu!'s OAuth client configuration.
    if (url.pathname === "/oauth/diagnostics" && request.method === "GET") {
      const clientId = typeof env.OSU_CLIENT_ID === "string" ? env.OSU_CLIENT_ID.trim() : "";
      const redirectUri = typeof env.OAUTH_REDIRECT_URI === "string" ? env.OAUTH_REDIRECT_URI.trim() : "";
      const expectedRedirectUri = new URL(request.url).origin + "/oauth/callback";
      let kvWriteReadDelete = false;
      if (env.OAUTH_KV) {
        const key = "diagnostic:" + crypto.randomUUID();
        try {
          await env.OAUTH_KV.put(key, "ok", { expirationTtl: 60 });
          kvWriteReadDelete = (await env.OAUTH_KV.get(key)) === "ok";
          await env.OAUTH_KV.delete(key);
        } catch {
          try { await env.OAUTH_KV.delete(key); } catch {}
        }
      }
      const authorize = new URL("https://osu.ppy.sh/oauth/authorize");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "public identify");
      return json({
        worker: "osu-daily-tracker-oauth",
        client_id_present: clientId.length > 0,
        client_id_numeric: /^[0-9]+$/.test(clientId),
        redirect_uri: redirectUri || null,
        redirect_uri_matches_worker_callback: redirectUri === expectedRedirectUri,
        expected_redirect_uri: expectedRedirectUri,
        kv_bound: Boolean(env.OAUTH_KV),
        kv_write_read_delete_ok: kvWriteReadDelete,
        authorize_host: authorize.hostname,
        authorize_path: authorize.pathname,
        scope: "public identify",
      });
    }

    if (url.pathname === "/oauth/start" && request.method === "GET") {
      const state = url.searchParams.get("state");
      if (!validState(state)) return json({ error: "invalid_state" }, 400);
      const clientId = typeof env.OSU_CLIENT_ID === "string" ? env.OSU_CLIENT_ID.trim() : "";
      const redirectUri = typeof env.OAUTH_REDIRECT_URI === "string" ? env.OAUTH_REDIRECT_URI.trim() : "";
      if (!clientId || !/^[0-9]+$/.test(clientId) || !redirectUri || !env.OAUTH_KV) {
        return json({ error: "oauth_not_configured" }, 503);
      }

      // Keep failures visible as safe JSON instead of an opaque blank/500 browser page.
      try {
        await env.OAUTH_KV.put("state:" + state, "1", { expirationTtl: 600 });
      } catch {
        return json({ error: "oauth_state_store_failed", stage: "oauth_start" }, 503);
      }

      const authorize = new URL("https://osu.ppy.sh/oauth/authorize");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "public identify");
      authorize.searchParams.set("state", state);

      // Diagnostic mode runs the same state-store and URL-building path but returns the intended redirect as JSON.
      // It never exposes the client secret or tokens.
      if (url.searchParams.get("debug") === "1") {
        return json({
          stage: "oauth_start_ready_to_redirect",
          state_saved: true,
          would_return_status: 302,
          location: authorize.toString(),
        });
      }

      // Explicitly return a no-store redirect to osu!'s consent endpoint.
      return new Response(null, {
        status: 302,
        headers: {
          location: authorize.toString(),
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");
      if (oauthError) return safeAppRedirect(env, { error: "osu_authorization_denied" });
      if (!code || !validState(state) || !env.OAUTH_KV) {
        return safeAppRedirect(env, { error: "invalid_oauth_response" });
      }

      const stateKey = "state:" + state;
      const valid = await env.OAUTH_KV.get(stateKey);
      await env.OAUTH_KV.delete(stateKey);
      if (!valid) return safeAppRedirect(env, { error: "state_mismatch" });
      const clientId = typeof env.OSU_CLIENT_ID === "string" ? env.OSU_CLIENT_ID.trim() : "";
      const clientSecret = typeof env.OSU_CLIENT_SECRET === "string" ? env.OSU_CLIENT_SECRET.trim() : "";
      const redirectUri = typeof env.OAUTH_REDIRECT_URI === "string" ? env.OAUTH_REDIRECT_URI.trim() : "";
      if (!clientId || !/^[0-9]+$/.test(clientId) || !clientSecret || !redirectUri) {
        return safeAppRedirect(env, { error: "oauth_not_configured" });
      }

      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });
      const tokenResponse = await fetch("https://osu.ppy.sh/oauth/token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!tokenResponse.ok) {
        // Do not log authorization codes, client secrets, or token responses.
        return safeAppRedirect(env, { error: "token_exchange_failed" });
      }

      const tokens = await tokenResponse.json();
      if (!tokens.access_token || !tokens.refresh_token) {
        return safeAppRedirect(env, { error: "invalid_token_response" });
      }

      // The token response is held only long enough for the app to redeem a one-time handoff.
      const handoff = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      await env.OAUTH_KV.put("handoff:" + handoff, JSON.stringify(tokens), { expirationTtl: 90 });
      return safeAppRedirect(env, { handoff });
    }

    if (url.pathname === "/oauth/refresh" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const refreshToken = body && body.refresh_token;
      if (typeof refreshToken !== "string" || refreshToken.length < 20 || refreshToken.length > 4096) return apiJson({ error: "invalid_refresh_token" }, 400);
      const clientId = typeof env.OSU_CLIENT_ID === "string" ? env.OSU_CLIENT_ID.trim() : "";
      const clientSecret = typeof env.OSU_CLIENT_SECRET === "string" ? env.OSU_CLIENT_SECRET.trim() : "";
      if (!clientId || !/^[0-9]+$/.test(clientId) || !clientSecret) return apiJson({ error: "oauth_not_configured" }, 503);
      const response = await fetch("https://osu.ppy.sh/oauth/token", {
        method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
      });
      const tokens = await response.json().catch(() => ({}));
      if (!response.ok || !tokens.access_token || !tokens.refresh_token) return apiJson({ error: "refresh_failed", status: response.status }, response.status === 400 || response.status === 401 ? 401 : 502);
      return apiJson(tokens);
    }

    if (url.pathname === "/oauth/exchange" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const handoff = body && body.handoff;
      if (typeof handoff !== "string" || !/^[a-f0-9]{64}$/.test(handoff)) {
        return json({ error: "invalid_handoff" }, 400);
      }
      if (!env.OAUTH_KV) return json({ error: "oauth_not_configured" }, 503);
      const key = "handoff:" + handoff;
      const stored = await env.OAUTH_KV.get(key);
      if (!stored) return json({ error: "handoff_expired_or_used" }, 410);
      // Delete immediately; this endpoint never persists tokens beyond the one-time handoff.
      await env.OAUTH_KV.delete(key);
      return new Response(stored, {
        headers: {
          ...JSON_HEADERS,
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
