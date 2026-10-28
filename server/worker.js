const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        },
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "osu-daily-tracker-oauth", version: 1 });
    }

    if (url.pathname === "/oauth/start" && request.method === "GET") {
      const state = url.searchParams.get("state");
      if (!validState(state)) return json({ error: "invalid_state" }, 400);
      if (!env.OSU_CLIENT_ID || !env.OAUTH_REDIRECT_URI || !env.OAUTH_KV) {
        return json({ error: "oauth_not_configured" }, 503);
      }

      await env.OAUTH_KV.put("state:" + state, "1", { expirationTtl: 600 });
      const authorize = new URL("https://osu.ppy.sh/oauth/authorize");
      authorize.searchParams.set("client_id", env.OSU_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", env.OAUTH_REDIRECT_URI);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "public identify");
      authorize.searchParams.set("state", state);
      return Response.redirect(authorize.toString(), 302);
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
      if (!env.OSU_CLIENT_ID || !env.OSU_CLIENT_SECRET || !env.OAUTH_REDIRECT_URI) {
        return safeAppRedirect(env, { error: "oauth_not_configured" });
      }

      const body = new URLSearchParams({
        client_id: env.OSU_CLIENT_ID,
        client_secret: env.OSU_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: env.OAUTH_REDIRECT_URI,
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
