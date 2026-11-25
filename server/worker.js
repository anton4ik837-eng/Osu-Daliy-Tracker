import { handleAiChat, handleAiResearch } from "./ai-gateway.js";
export { ChatRoom } from "./chat-room.js";
import { makeRoom, invitePlayer, invokeReferee, makeRoomPersistent } from "./referee-hub.js";

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
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
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
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}


async function waitForApiBudget() { await new Promise(resolve => setTimeout(resolve, 1050)); }

function osuRetryAfterSeconds(response, fallback = 60) {
  const raw = Number(response.headers.get("retry-after"));
  if (Number.isFinite(raw) && raw > 0) return Math.min(3600, Math.max(5, Math.ceil(raw)));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const seconds = reset > 1e12 ? Math.ceil((reset - Date.now()) / 1000) : Math.ceil(reset - Date.now() / 1000);
    if (seconds > 0) return Math.min(3600, Math.max(5, seconds));
  }
  return fallback;
}

function readOsuString(bytes, offset) {
  if (offset >= bytes.length) throw new Error("invalid_osr_string");
  const start = offset;
  const marker = bytes[offset++];
  if (marker === 0) return { start, end: offset };
  if (marker !== 0x0b) throw new Error("invalid_osr_string_marker");
  let length = 0, shift = 0;
  while (offset < bytes.length && shift <= 28) {
    const value = bytes[offset++];
    length |= (value & 0x7f) << shift;
    if ((value & 0x80) === 0) {
      const end = offset + length;
      if (end > bytes.length) throw new Error("invalid_osr_string_length");
      return { start, end };
    }
    shift += 7;
  }
  throw new Error("invalid_osr_string_length");
}

function encodeOsuString(value) {
  const encoded = new TextEncoder().encode(value);
  const out = [0x0b];
  let length = encoded.length;
  while (length >= 0x80) { out.push((length & 0x7f) | 0x80); length >>>= 7; }
  out.push(length);
  return new Uint8Array([...out, ...encoded]);
}

function anonymizeOsr(input, participantId, expectedMode) {
  const bytes = new Uint8Array(input);
  const modeByte = expectedMode === "osu" ? 0 : 3;
  if (bytes.length < 32 || bytes[0] !== modeByte) throw new Error("invalid_replay_mode_or_file");
  const beatmap = readOsuString(bytes, 5);
  const player = readOsuString(bytes, beatmap.end);
  const replacement = encodeOsuString("participant_" + participantId);
  const output = new Uint8Array(bytes.length - (player.end - player.start) + replacement.length);
  output.set(bytes.subarray(0, player.start), 0);
  output.set(replacement, player.start);
  output.set(bytes.subarray(player.end), player.start + replacement.length);
  return output;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode("blob " + bytes.length + "\0");
  const blob = new Uint8Array(header.length + bytes.length);
  blob.set(header, 0);
  blob.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", blob));
  return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
}

async function uploadAnonymizedReplay(env, path, bytes) {
  const token = typeof env.DATASET_GITHUB_TOKEN === "string" ? env.DATASET_GITHUB_TOKEN.trim() : "";
  if (!token) throw new Error("dataset_upload_not_configured");

  // GitHub's Contents API can return 409 when two independent best/recent
  // queues update the same branch concurrently. Retry the same path if the
  // branch update raced; if the path already exists, verify its blob and
  // either treat an identical upload as success or allocate the next number.
  const expectedSha = await gitBlobSha(bytes);
  const directory = path.slice(0, path.lastIndexOf("/"));
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const sequenceMatch = fileName.match(/^(.*?)(\d+)\.osr$/);
  if (!sequenceMatch) throw new Error("dataset_filename_invalid");
  const prefix = sequenceMatch[1];
  const headers = {
    accept: "application/vnd.github+json",
    authorization: "Bearer " + token,
    "user-agent": "OsuDailyTracker-ReplaySync",
    "x-github-api-version": "2022-11-28"
  };
  let targetPath = path;

  for (let attempt = 0; attempt < 8; attempt++) {
    const endpoint = "https://api.github.com/repos/anton4ik837-eng/Osu-Replay-Dataset/contents/"
      + targetPath.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        message: "Add anonymized opt-in replay",
        content: bytesToBase64(bytes),
        branch: "main"
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.content?.sha) {
      return { sha: payload.content.sha, path: payload.content.path || targetPath };
    }
    if (response.status !== 409) {
      throw new Error("dataset_upload_failed_" + response.status);
    }

    const existingResponse = await fetch(endpoint, { headers });
    const existing = await existingResponse.json().catch(() => ({}));
    if (existingResponse.ok && existing?.sha) {
      if (existing.sha === expectedSha) {
        return { sha: existing.sha, path: existing.path || targetPath, already_present: true };
      }
      const next = await getNextReplaySequence(env, directory, prefix);
      targetPath = directory + "/" + prefix + String(next).padStart(6, "0") + ".osr";
    } else if (existingResponse.status === 404) {
      // The 409 was a branch-head race, not a filename collision.
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    } else {
      throw new Error("dataset_conflict_check_failed_" + existingResponse.status);
    }
  }
  throw new Error("dataset_upload_conflict_retry_exhausted");
}

// Continue the existing six-digit sequence in the private dataset folder.
// UUID-named legacy files are ignored; the highest numeric filename is authoritative.
async function getNextReplaySequence(env, directory, prefix) {
  const token = typeof env.DATASET_GITHUB_TOKEN === "string" ? env.DATASET_GITHUB_TOKEN.trim() : "";
  if (!token) throw new Error("dataset_upload_not_configured");
  const endpoint = "https://api.github.com/repos/anton4ik837-eng/Osu-Replay-Dataset/contents/"
    + directory.split("/").map(encodeURIComponent).join("/") + "?ref=main";
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "user-agent": "OsuDailyTracker-ReplaySync",
      "x-github-api-version": "2022-11-28"
    }
  });
  const entries = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(entries)) {
    throw new Error("dataset_sequence_lookup_failed_" + response.status);
  }
  const pattern = new RegExp("^" + prefix + "(\\d+)\\.osr$", "i");
  let highest = 0;
  for (const entry of entries) {
    if (entry?.type !== "file" || typeof entry.name !== "string") continue;
    const match = entry.name.match(pattern);
    if (match) highest = Math.max(highest, Number(match[1]) || 0);
  }
  return highest + 1;
}

function validMode(value) {
  return ["osu", "taiko", "fruits", "mania"].includes(value) ? value : null;
}

let cachedPublicToken = { value: "", expiresAt: 0 };

async function getPublicApiToken(env) {
  const now = Date.now();
  if (cachedPublicToken.value && cachedPublicToken.expiresAt > now + 60000) return cachedPublicToken.value;
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
  cachedPublicToken = {
    value: tokens.access_token,
    expiresAt: now + Math.max(60, Number(tokens.expires_in) || 0) * 1000
  };
  return tokens.access_token;
}

// Single retry for transient osu! rate limits / server hiccups.
async function fetchOsuWithRetry(url, options, label) {
  let response = await fetch(url, options);
  if (response.status === 429 || response.status === 503) {
    const delay = osuRetryAfterSeconds(response, label === "scores" ? 2 : 1) * 1000;
    await new Promise(resolve => setTimeout(resolve, Math.min(5000, delay)));
    response = await fetch(url, options);
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "600",
        },
      });
    }

    if (url.pathname === "/api/ai/chat" && request.method === "POST") {
      return handleAiChat(request, env);
    }

    // Research access is server-admin only; never embed AI_RESEARCH_TOKEN in the app.
    if (url.pathname === "/api/ai/research" && request.method === "POST") {
      return handleAiResearch(request, env);
    }

    // Exact difficulty rating for a specific mods combination (e.g. HD+DT).
    // The public token lives in the Worker, so the browser never sees client credentials.
    if (/^\/api\/beatmaps\/[0-9]+\/difficulty$/.test(url.pathname) && request.method === "GET") {
      const beatmapId = url.pathname.match(/^\/api\/beatmaps\/([0-9]+)\/difficulty$/)[1];
      const modsRaw = Number.parseInt(url.searchParams.get("mods") || "0", 10);
      const mods = Number.isFinite(modsRaw) && modsRaw >= 0 ? modsRaw : 0;
      let token;
      try { token = await getPublicApiToken(env); }
      catch (error) { return apiJson({ error: error.message || "osu_api_unavailable" }, 503); }
      const rulesetRaw = Number.parseInt(url.searchParams.get("ruleset_id") || "0", 10);
      const rulesetId = Number.isFinite(rulesetRaw) && rulesetRaw >= 0 ? rulesetRaw : 0;
      const apiUrl = "https://osu.ppy.sh/api/v2/beatmaps/" + encodeURIComponent(beatmapId) + "/attributes";
      const headers = { accept: "application/json", "content-type": "application/json", "x-api-version": "20220705", authorization: "Bearer " + token };
      const response = await fetchOsuWithRetry(apiUrl, { method: "POST", headers, body: JSON.stringify({ mods, ruleset_id: rulesetId }) }, "difficulty_attributes");
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.attributes) {
        return apiJson({ error: "difficulty_lookup_failed", upstream_status: response.status }, response.status === 404 ? 404 : 502);
      }
      const attributes = payload.attributes;
      const rating = Number(attributes.star_rating ?? attributes.difficulty_rating ?? attributes.stars);
      return apiJson({ beatmap_id: beatmapId, mods, ruleset_id: rulesetId, difficulty_rating: Number.isFinite(rating) ? rating : null, attributes, diagnostics: { endpoint: "POST /api/v2/beatmaps/{beatmap}/attributes", upstream_status: response.status } });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "osu-daily-tracker-oauth", version: 33, deploy_marker: "coop-chat-scope-check-2026-11-25", dataset_upload_configured: Boolean(env.DATASET_GITHUB_TOKEN), consent_store_configured: Boolean(env.OAUTH_KV), gemini_configured: Boolean(env.GEMINI_API_KEY), gemini_model: "gemini-3.5-flash-lite", gemini_thinking_level: "MINIMAL", gemini_timeout_ms: 90000, ai_research_configured: Boolean(env.AI_RESEARCH_TOKEN) });
    }

    // Proxy GitHub Releases so the in-app update check works even when the device
    // cannot reach api.github.com directly (common on mobile/captive networks).
    if (url.pathname === "/api/releases" && request.method === "GET") {
      try {
        const upstream = await fetch("https://api.github.com/repos/anton4ik837-eng/Osu-Daliy-Tracker/releases?per_page=15", {
          headers: { accept: "application/vnd.github+json", "user-agent": "osu-daily-tracker" },
        });
        if (!upstream.ok) return apiJson({ error: "github_http_" + upstream.status }, 502);
        const releases = await upstream.json();
        return new Response(JSON.stringify(releases), { status: 200, headers: { ...JSON_HEADERS, "access-control-allow-origin": "*" } });
      } catch (error) {
        return apiJson({ error: "github_unreachable", details: String(error?.message || error) }, 502);
      }
    }

    // Download the complete public beatmapset archive by the replay checksum.
    // The .osz includes both the exact .osu difficulty and its audio file.
    if (url.pathname === "/api/me/beatmapset-by-checksum" && request.method === "GET") {
      const checksum = String(url.searchParams.get("checksum") || "").trim().toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(checksum)) return apiJson({ error: "invalid_beatmap_checksum" }, 400);
      let token;
      try { token = await getPublicApiToken(env); }
      catch (error) { return apiJson({ error: error.message || "osu_api_unavailable" }, 503); }
      const headers = { accept: "application/json", "x-api-version": "20220705", authorization: "Bearer " + token };
      const lookup = await fetch("https://osu.ppy.sh/api/v2/beatmaps/lookup?checksum=" + encodeURIComponent(checksum), { headers });
      const beatmap = await lookup.json().catch(() => ({}));
      if (!lookup.ok || !beatmap.id || !beatmap.beatmapset_id) {
        return apiJson({ error: "beatmap_lookup_failed", upstream_status: lookup.status }, lookup.status === 404 ? 404 : 502);
      }
      // osu.ppy.sh may return an HTML challenge to server-side Workers instead of the .osz.
      // Try the official endpoint first, then public osu! beatmap mirrors.
      const candidates = [
        { url: "https://osu.ppy.sh/beatmapsets/" + encodeURIComponent(beatmap.beatmapset_id) + "/download", headers: { authorization: "Bearer " + token, accept: "application/octet-stream", "user-agent": "Mozilla/5.0 (compatible; OsuDailyTracker/1.0)" } },
        { url: "https://catboy.best/d/" + encodeURIComponent(beatmap.beatmapset_id), headers: { accept: "application/octet-stream", "user-agent": "Mozilla/5.0 (compatible; OsuDailyTracker/1.0)" } },
        { url: "https://beatconnect.io/b/" + encodeURIComponent(beatmap.beatmapset_id), headers: { accept: "application/octet-stream", "user-agent": "Mozilla/5.0 (compatible; OsuDailyTracker/1.0)" } }
      ];
      let archive = null;
      let bytes = null;
      const attempts = [];
      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate.url, { headers: candidate.headers, redirect: "follow" });
          const type = response.headers.get("content-type") || "";
          if (!response.ok) {
            attempts.push({ host: new URL(candidate.url).host, status: response.status, content_type: type });
            continue;
          }
          const body = await response.arrayBuffer();
          const signature = new Uint8Array(body.slice(0, 4));
          if (body.byteLength >= 4 && signature[0] === 0x50 && signature[1] === 0x4b) {
            archive = response;
            bytes = body;
            break;
          }
          attempts.push({ host: new URL(candidate.url).host, status: response.status, content_type: type, invalid_zip: true });
        } catch (error) {
          attempts.push({ host: new URL(candidate.url).host, error: String(error?.message || error) });
        }
      }
      if (!bytes) {
        return apiJson({
          error: "beatmapset_download_failed",
          beatmapset_id: beatmap.beatmapset_id,
          attempts
        }, 502);
      }
      return new Response(bytes, { status: 200, headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="beatmapset-' + beatmap.beatmapset_id + '.osz"',
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff"
      }});
    }

    // Recent or best scores for the authenticated osu! account.
    if ((url.pathname === "/api/me/scores" || url.pathname === "/api/me/scores/recent") && request.method === "GET") {
      const auth = request.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match) return apiJson({ error: "missing_bearer_token" }, 401);
      const limitRaw = Number.parseInt(url.searchParams.get("limit") || "20", 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
      const mode = validMode(url.searchParams.get("mode") || "osu");
      if (!mode) return apiJson({ error: "invalid_mode" }, 400);
      const scoreType = url.searchParams.get("type") || "recent";
      if (scoreType !== "recent" && scoreType !== "best") return apiJson({ error: "invalid_score_type" }, 400);
      const headers = { accept: "application/json", "x-api-version": "20220705", authorization: "Bearer " + match[1] };
      const meResponse = await fetch("https://osu.ppy.sh/api/v2/me/" + mode, { headers });
      const me = await meResponse.json().catch(() => ({}));
      if (!meResponse.ok || !me.id) return apiJson({ error: me.error || "osu_profile_request_failed", status: meResponse.status }, meResponse.status === 401 ? 401 : 502);
      const scoresUrl = new URL("https://osu.ppy.sh/api/v2/users/" + encodeURIComponent(me.id) + "/scores/" + scoreType);
      scoresUrl.searchParams.set("mode", mode);
      scoresUrl.searchParams.set("limit", String(limit));
      const offsetRaw = Number.parseInt(url.searchParams.get("offset") || "0", 10);
      const offset = Number.isFinite(offsetRaw) ? Math.min(1000, Math.max(0, offsetRaw)) : 0;
      if (offset > 0) scoresUrl.searchParams.set("offset", String(offset));
      if (scoreType === "recent") scoresUrl.searchParams.set("include_fails", "1");
      const response = await fetch(scoresUrl, { headers });
      const payload = await response.json().catch(() => null);
      if (!response.ok) return apiJson({ error: (payload && payload.error) || "osu_scores_failed", stage: scoreType + "_scores", upstream_status: response.status }, response.status === 401 ? 401 : 502);
      if (!Array.isArray(payload)) {
        return apiJson({
          error: "osu_scores_unexpected_response",
          stage: scoreType + "_scores",
          upstream_status: response.status,
          response_type: payload === null ? "invalid_json" : typeof payload,
          response_keys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 10) : [],
          user: { id: me.id, username: me.username }
        }, 502);
      }
      return apiJson({
        user: { id: me.id, username: me.username },
        scores: payload,
        diagnostics: { endpoint: "/api/v2/users/{id}/scores/" + scoreType, type: scoreType, mode, limit, offset, include_fails: scoreType === "recent" ? 1 : null, upstream_status: response.status, returned_count: payload.length }
      });
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
      const headers = { accept: "application/json", "x-api-version": "20220705", authorization: "Bearer " + match[1] };
      const meResponse = await fetch("https://osu.ppy.sh/api/v2/me/" + mode, { headers });
      const me = await meResponse.json().catch(() => ({}));
      if (!meResponse.ok || !me.id) return apiJson({ error: me.error || "osu_profile_request_failed", status: meResponse.status }, meResponse.status === 401 ? 401 : 502);
      // osu! API v2 single-score lookup is /api/v2/scores/{score_id}; the ruleset-qualified
      // route is not valid for this lookup and returns 404 even for real scores.
      // Look up the exact score by ID instead of searching only the latest 50 plays.
      const scoreResponse = await fetch("https://osu.ppy.sh/api/v2/scores/" + encodeURIComponent(scoreId), { headers });
      const ownedScore = await scoreResponse.json().catch(() => ({}));
      if (!scoreResponse.ok || !ownedScore || String(ownedScore.user_id ?? ownedScore.user?.id ?? "") !== String(me.id)) {
        return apiJson({ error: "score_not_found_or_not_owned", stage: "score_lookup", upstream_status: scoreResponse.status }, scoreResponse.status === 401 ? 401 : 404);
      }
      if (ownedScore.has_replay !== true) return apiJson({ error: "replay_unavailable", stage: "score_lookup", recent_score_has_replay: ownedScore.has_replay ?? null }, 404);
      // Try the documented score replay endpoint first, then the ruleset-qualified variant for compatibility.
      const replayHeaders = {
        accept: "application/octet-stream",
        "x-api-version": "20220705",
        authorization: "Bearer " + match[1]
      };
      let download = await fetch("https://osu.ppy.sh/api/v2/scores/" + encodeURIComponent(scoreId) + "/download", {
        headers: replayHeaders
      });
      let firstBody = "";
      if (download.status === 404) {
        firstBody = await download.text().catch(() => "");
        download = await fetch("https://osu.ppy.sh/api/v2/scores/" + mode + "/" + encodeURIComponent(scoreId) + "/download", {
          headers: replayHeaders
        });
      }
      if (!download.ok) {
        const upstreamContentType = download.headers.get("content-type") || "";
        const upstreamBody = await download.text().catch(() => "");
        let upstreamError = null;
        if (upstreamContentType.includes("json") && upstreamBody) {
          try {
            const parsed = JSON.parse(upstreamBody);
            upstreamError = typeof parsed.error === "string" ? parsed.error : null;
          } catch {}
        }
        return apiJson({
          error: "osu_replay_download_failed",
          stage: "upstream_replay_download",
          upstream_status: download.status,
          upstream_content_type: upstreamContentType,
          upstream_error: upstreamError,
          upstream_body_excerpt: upstreamBody.slice(0, 500),
          score_id: scoreId,
          mode,
          recent_score_has_replay: ownedScore.has_replay === true,
          recent_score_passed: ownedScore.passed === true
        }, download.status === 401 ? 401 : download.status === 404 ? 404 : 502);
      }
      return new Response(download.body, { status: 200, headers: {
        "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "authorization", "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="osu-score-' + scoreId + '.osr"',
        "x-content-type-options": "nosniff"
      }});
    }

    // Public score list for another osu! player, resolved by nickname or id.
    // Uses the app's client-credentials token; no user secret is required.
    const publicScoresMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/scores$/);
    if (publicScoresMatch && request.method === "GET") {
      const user = decodeURIComponent(publicScoresMatch[1]).trim();
      const mode = validMode(url.searchParams.get("mode") || "osu");
      if (!user || user.length > 80) return apiJson({ error: "invalid_user" }, 400);
      if (!mode) return apiJson({ error: "invalid_mode" }, 400);
      const scoreType = url.searchParams.get("type") || "recent";
      if (scoreType !== "recent" && scoreType !== "best") return apiJson({ error: "invalid_score_type" }, 400);
      const limitRaw = Number.parseInt(url.searchParams.get("limit") || "20", 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
      const offsetRaw = Number.parseInt(url.searchParams.get("offset") || "0", 10);
      const offset = Number.isFinite(offsetRaw) ? Math.min(1000, Math.max(0, offsetRaw)) : 0;
      let token;
      try { token = await getPublicApiToken(env); }
      catch (error) { return apiJson({ error: error.message || "osu_api_unavailable" }, 503); }
      // osu! API v2 requires an @ prefix for username lookup; numeric ids pass through.
      const resolvedUser = /^[0-9]+$/.test(user) ? user : "@" + user;
      const headers = { accept: "application/json", "x-api-version": "20220705", authorization: "Bearer " + token };
      const profileUrl = "https://osu.ppy.sh/api/v2/users/" + encodeURIComponent(resolvedUser) + "/" + mode;
      const profileResponse = await fetchOsuWithRetry(profileUrl, { headers }, "profile");
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok || !profile.id) {
        return apiJson({ error: profile.error || "osu_user_not_found", stage: "user_lookup", upstream_status: profileResponse.status }, profileResponse.status === 404 ? 404 : 502);
      }
      // The scores route does not accept the @username form, so use the resolved id.
      const scoresUrl = new URL("https://osu.ppy.sh/api/v2/users/" + encodeURIComponent(profile.id) + "/scores/" + scoreType);
      scoresUrl.searchParams.set("mode", mode);
      scoresUrl.searchParams.set("limit", String(limit));
      if (offset > 0) scoresUrl.searchParams.set("offset", String(offset));
      if (scoreType === "recent") scoresUrl.searchParams.set("include_fails", "1");
      const response = await fetchOsuWithRetry(scoresUrl, { headers }, "scores");
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        return apiJson({ error: (payload && payload.error) || "osu_scores_failed", stage: scoreType + "_scores", upstream_status: response.status }, response.status === 404 ? 404 : 502);
      }
      if (!Array.isArray(payload)) {
        return apiJson({ error: "osu_scores_unexpected_response", stage: scoreType + "_scores", upstream_status: response.status }, 502);
      }
      return apiJson({
        user: { id: profile.id, username: profile.username },
        scores: payload,
        diagnostics: { endpoint: "/api/v2/users/{user}/scores/" + scoreType, type: scoreType, mode, limit, offset, include_fails: scoreType === "recent" ? 1 : null, upstream_status: response.status, returned_count: payload.length }
      });
    }

    // Public replay download. osu! API allows downloading any score with a
    // replay using a public-scope token; ownership is not required here.
    const publicDownloadMatch = url.pathname.match(/^\/api\/scores\/([0-9]+)\/download$/);
    if (publicDownloadMatch && request.method === "GET") {
      const scoreId = publicDownloadMatch[1];
      const mode = validMode(url.searchParams.get("mode") || "osu");
      if (!mode) return apiJson({ error: "invalid_mode" }, 400);
      let token;
      try { token = await getPublicApiToken(env); }
      catch (error) { return apiJson({ error: error.message || "osu_api_unavailable" }, 503); }
      const headers = { accept: "application/json", "x-api-version": "20220705", authorization: "Bearer " + token };
      const scoreResponse = await fetchOsuWithRetry("https://osu.ppy.sh/api/v2/scores/" + encodeURIComponent(scoreId), { headers }, "score");
      const score = await scoreResponse.json().catch(() => ({}));
      if (!scoreResponse.ok || !score.id) {
        return apiJson({ error: score.error || "score_not_found", stage: "score_lookup", upstream_status: scoreResponse.status }, scoreResponse.status === 404 ? 404 : 502);
      }
      // The API hides has_replay from non-owners, so let the download endpoint decide.
      const replayHeaders = { accept: "application/octet-stream", "x-api-version": "20220705", authorization: "Bearer " + token };
      let download = await fetchOsuWithRetry("https://osu.ppy.sh/api/v2/scores/" + encodeURIComponent(scoreId) + "/download", { headers: replayHeaders }, "download");
      if (download.status === 404) {
        download = await fetchOsuWithRetry("https://osu.ppy.sh/api/v2/scores/" + mode + "/" + encodeURIComponent(scoreId) + "/download", { headers: replayHeaders }, "download-legacy");
      }
      if (!download.ok) {
        const contentType = download.headers.get("content-type") || "";
        const body = await download.text().catch(() => "");
        let upstreamError = null;
        if (contentType.includes("json") && body) {
          try { upstreamError = JSON.parse(body).error || null; } catch {}
        }
        return apiJson({
          error: "osu_replay_download_failed", stage: "upstream_replay_download",
          upstream_status: download.status, upstream_error: upstreamError,
          upstream_body_excerpt: body.slice(0, 500), score_id: scoreId, mode
        }, download.status === 401 ? 401 : download.status === 404 ? 404 : 502);
      }
      return new Response(download.body, { status: 200, headers: {
        "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type, authorization", "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="osu-score-' + scoreId + '.osr"',
        "x-content-type-options": "nosniff"
      }});
    }

    // Register files committed by the scheduled collector so consent withdrawal
    // can remove exactly this participant's contributions from the private dataset.
    if (url.pathname === "/api/internal/replay-files" && request.method === "POST") {
      const expected = (typeof env.REPLAY_CONSENT_TOKEN === "string" ? env.REPLAY_CONSENT_TOKEN : typeof env.INGEST_TOKEN === "string" ? env.INGEST_TOKEN : "").trim();
      const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!expected || !supplied || supplied !== expected) return apiJson({ error: "unauthorized" }, 401);
      if (!env.OAUTH_KV) return apiJson({ error: "consent_store_unavailable" }, 503);
      let body; try { body = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      if (!Array.isArray(body?.files) || body.files.length > 500) return apiJson({ error: "invalid_files" }, 400);
      const grouped = new Map();
      for (const item of body.files) {
        const userId = String(item?.user_id || "");
        const path = String(item?.path || "");
        const sha = String(item?.sha || "");
        if (!/^\d{1,15}$/.test(userId) || !/^replays\/(?:standard\/std_|mania\/mania_)[a-f0-9]{32}\.osr$/.test(path) || !/^[a-f0-9]{64}$/.test(sha)) {
          return apiJson({ error: "invalid_file_record" }, 400);
        }
        if (!grouped.has(userId)) grouped.set(userId, []);
        grouped.get(userId).push({ path, sha });
      }
      let registered = 0, skipped = 0;
      for (const [userId, files] of grouped) {
        const key = "replay-consent:" + userId;
        const raw = await env.OAUTH_KV.get(key);
        let consent; try { consent = raw ? JSON.parse(raw) : null; } catch { consent = null; }
        if (consent?.consent !== true || consent?.consent_version !== "replay-dataset-v2") { skipped += files.length; continue; }
        const existing = Array.isArray(consent.files) ? consent.files : [];
        const byPath = new Map(existing.map(file => [file.path, file]));
        for (const file of files) byPath.set(file.path, file);
        consent.files = [...byPath.values()];
        await env.OAUTH_KV.put(key, JSON.stringify(consent));
        registered += files.length;
      }
      return apiJson({ ok: true, registered, skipped });
    }

    // Private server-to-server consent registry for the scheduled dataset collector.
    // Never expose this endpoint to app clients: it is protected by INGEST_TOKEN.
    if (url.pathname === "/api/internal/replay-consents" && request.method === "GET") {
      const expected = (typeof env.REPLAY_CONSENT_TOKEN === "string" ? env.REPLAY_CONSENT_TOKEN : typeof env.INGEST_TOKEN === "string" ? env.INGEST_TOKEN : "").trim();
      const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!expected || !supplied || supplied !== expected) return apiJson({ error: "unauthorized" }, 401);
      if (!env.OAUTH_KV) return apiJson({ error: "consent_store_unavailable" }, 503);
      const players = [];
      let cursor;
      do {
        const page = await env.OAUTH_KV.list({ prefix: "replay-consent:", cursor, limit: 1000 });
        for (const key of page.keys || []) {
          const raw = await env.OAUTH_KV.get(key.name);
          if (!raw) continue;
          let record;
          try { record = JSON.parse(raw); } catch { continue; }
          if (record?.consent !== true || record?.consent_version !== "replay-dataset-v2") continue;
          const userId = Number(record.user_id);
          if (!Number.isSafeInteger(userId) || userId <= 0) continue;
          players.push({
            user_id: userId,
            consent: true,
            consent_date: record.accepted_at || null,
            consent_scope: "replay_download_private_storage_and_ml_training",
            consent_withdrawn: false,
            modes: Array.isArray(record.modes) ? record.modes.filter(mode => ["osu", "mania"].includes(mode)) : ["osu", "mania"]
          });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return apiJson({ schema_version: 1, generated_at: new Date().toISOString(), players });
    }

    // Explicit opt-in registry. Consent is tied to the osu! account returned by OAuth.
    if (url.pathname === "/api/me/replay-consent" && (request.method === "GET" || request.method === "POST")) {
      const auth = request.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match) return apiJson({ error: "missing_bearer_token" }, 401);
      if (!env.OAUTH_KV) return apiJson({ error: "consent_store_unavailable" }, 503);
      const profileResponse = await fetch("https://osu.ppy.sh/api/v2/me/osu", { headers: { accept: "application/json", authorization: "Bearer " + match[1] } });
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok || !profile.id) return apiJson({ error: "osu_profile_request_failed" }, profileResponse.status === 401 ? 401 : 502);
      const key = "replay-consent:" + String(profile.id);
      const stored = await env.OAUTH_KV.get(key);
      let consent = null; try { consent = stored ? JSON.parse(stored) : null; } catch {}
      if (request.method === "GET") {
        return apiJson({ enabled: consent?.consent === true && consent?.consent_version === "replay-dataset-v2", consent_version: consent?.consent_version || null, accepted_at: consent?.accepted_at || null });
      }
      let body; try { body = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      if (body?.enabled === false) {
        const files = Array.isArray(consent?.files) ? consent.files : [];
        const pending = []; let deleted = 0;
        await env.OAUTH_KV.delete("replay-sync-last:" + String(profile.id));
        for (const file of files) {
          if (!env.DATASET_GITHUB_TOKEN) { pending.push(file); continue; }
          const fileUrl = "https://api.github.com/repos/anton4ik837-eng/Osu-Replay-Dataset/contents/" + file.path.split("/").map(encodeURIComponent).join("/");
          const githubHeaders = { accept: "application/vnd.github+json", authorization: "Bearer " + env.DATASET_GITHUB_TOKEN, "user-agent": "Osu-Daily-Tracker-Replay-Collector", "x-github-api-version": "2022-11-28" };
          // The collector stores the content SHA-256, but GitHub's Contents DELETE
          // requires Git's blob SHA. Resolve the current blob SHA at revocation time.
          const current = await fetch(fileUrl + "?ref=main", { headers: githubHeaders });
          if (!current.ok) { pending.push(file); continue; }
          const currentData = await current.json();
          if (!currentData?.sha) { pending.push(file); continue; }
          const removed = await fetch(fileUrl, {
            method: "DELETE",
            headers: { ...githubHeaders, "content-type": "application/json" },
            body: JSON.stringify({ message: "Remove replay after consent withdrawal", sha: currentData.sha, branch: "main" })
          });
          if (removed.ok) { if (file.kv_key) await env.OAUTH_KV.delete(file.kv_key); deleted++; }
          else pending.push(file);
        }
        if (pending.length) await env.OAUTH_KV.put(key, JSON.stringify({ user_id: String(profile.id), consent: false, consent_version: consent?.consent_version || "replay-dataset-v2", revoked_at: new Date().toISOString(), files: pending }));
        else await env.OAUTH_KV.delete(key);
        return apiJson({ enabled: false, deleted_files: deleted, pending_deletions: pending.length });
      }
      if (body?.enabled !== true || body?.consent !== true || body?.consent_version !== "replay-dataset-v2") return apiJson({ error: "explicit_consent_required" }, 400);
      // Re-saving an already active consent must not replace its participant ID or
      // clear the uploaded-file registry; those records are required for dedupe/revocation.
      if (consent?.consent === true && consent?.consent_version === "replay-dataset-v2") {
        return apiJson({ enabled: true, consent_version: consent.consent_version, accepted_at: consent.accepted_at || null, unchanged: true });
      }
      if (consent?.consent === false && Array.isArray(consent.files) && consent.files.length) return apiJson({ error: "previous_replay_deletion_pending" }, 409);
      const record = { user_id: String(profile.id), consent: true, consent_version: "replay-dataset-v2", accepted_at: new Date().toISOString(), participant_id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), consent_scope: "own_replays_private_dataset_anonymized_filename_and_player_name_ai_training", modes: ["osu", "mania"], files: [] };
      await env.OAUTH_KV.put(key, JSON.stringify(record));
      return apiJson({ enabled: true, consent_version: record.consent_version, accepted_at: record.accepted_at });
    }

    // Upload the authenticated participant's own replays after explicit opt-in.
    // Best and recent are independent resumable queues. Each invocation handles at most 5 files.
    if (url.pathname === "/api/me/replay-sync" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match) return apiJson({ error: "missing_bearer_token" }, 401);
      if (!env.OAUTH_KV) return apiJson({ error: "consent_store_unavailable" }, 503);
      if (!env.DATASET_GITHUB_TOKEN) return apiJson({ error: "dataset_upload_not_configured" }, 503);
      const type = url.searchParams.get("type") || "recent";
      if (type !== "best" && type !== "recent") return apiJson({ error: "invalid_score_type" }, 400);
      const userHeaders = { accept: "application/json", "x-api-version": "20220705", authorization: "Bearer " + match[1] };
      const profileResponse = await fetch("https://osu.ppy.sh/api/v2/me/osu", { headers: userHeaders });
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok || !profile.id) return apiJson({ error: "osu_profile_request_failed" }, profileResponse.status === 401 ? 401 : 502);
      const userId = String(profile.id), consentKey = "replay-consent:" + userId;
      const storedConsent = await env.OAUTH_KV.get(consentKey);
      let consent = null; try { consent = storedConsent ? JSON.parse(storedConsent) : null; } catch {}
      if (consent?.consent !== true || consent?.consent_version !== "replay-dataset-v2") return apiJson({ error: "replay_consent_required" }, 403);
      const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
      const dailyKey = "replay-sync-count:" + userId + ":" + day;
      let dailyUploaded = Number(await env.OAUTH_KV.get(dailyKey) || 0);
      const nextDay = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1));
      const dailyLimit = 600, batchLimit = 30;
      if (dailyUploaded >= dailyLimit) return apiJson({ ok: true, skipped: "daily_limit", daily_uploaded: dailyUploaded, daily_limit: dailyLimit, uploaded: 0, next_sync_at: nextDay.toISOString() });
      const cooldownKey = "replay-sync-cooldown:" + userId + ":" + type;
      const cooldownUntil = Number(await env.OAUTH_KV.get(cooldownKey) || 0);
      if (cooldownUntil > now) {
        return apiJson({ error: "replay_sync_cooldown", retry_after: Math.max(1, Math.ceil((cooldownUntil - now) / 1000)) }, 429);
      }
      await env.OAUTH_KV.put(cooldownKey, String(now + 60000), { expirationTtl: 60 });
      const participantId = String(consent.participant_id || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "anonymous";
      const uploaded = [], skipped = { already_present: 0, unavailable: 0 };
      let apiCalls = 1, processed = 0, complete = true;

      // Detect modes the account actually plays. If both are present, allocate
      // half of this 30-score session to each; otherwise use all 30 for one mode.
      const modeAvailability = { osu: Number(profile.statistics?.play_count || 0) > 0, mania: false };
      const maniaProfileResponse = await fetch("https://osu.ppy.sh/api/v2/me/mania", { headers: userHeaders });
      apiCalls++;
      if (maniaProfileResponse.ok) {
        const maniaProfile = await maniaProfileResponse.json().catch(() => ({}));
        modeAvailability.mania = Number(maniaProfile.statistics?.play_count || 0) > 0;
      }
      const activeModes = ["osu", "mania"].filter(mode => modeAvailability[mode]);
      const perModeLimit = activeModes.length > 1 ? 15 : 30;

      for (const mode of ["osu", "mania"]) {
        if (!modeAvailability[mode]) continue;
        if (processed >= batchLimit || dailyUploaded >= dailyLimit) { complete = false; break; }
        let modeProcessed = 0;
        const prefix = mode === "osu" ? "standard" : "mania";
        const filePrefix = mode === "osu" ? "std_" : "mania_";
        const target = type === "best" ? 100 : 50;
        const queueKey = "replay-queue:" + userId + ":" + mode + ":" + type;
        let queue = null; try { queue = JSON.parse(await env.OAUTH_KV.get(queueKey) || "null"); } catch {}
        if (!queue || !Array.isArray(queue.scores) || queue.target !== target) queue = { offset: 0, index: 0, target, scores: [] };
        if (queue.offset >= target && queue.index >= queue.scores.length) continue;
        if (queue.index >= queue.scores.length) {
          await waitForApiBudget();
          const scoresUrl = new URL("https://osu.ppy.sh/api/v2/users/" + encodeURIComponent(userId) + "/scores/" + type);
          scoresUrl.searchParams.set("mode", mode);
          scoresUrl.searchParams.set("limit", "50");
          scoresUrl.searchParams.set("offset", String(queue.offset));
          if (type === "recent") scoresUrl.searchParams.set("include_fails", "1");
          const scoresResponse = await fetch(scoresUrl, { headers: userHeaders }); apiCalls++;
          if (!scoresResponse.ok) {
            const retryAfter = scoresResponse.status === 429 ? osuRetryAfterSeconds(scoresResponse) : null;
            if (retryAfter) await env.OAUTH_KV.put(cooldownKey, String(Date.now() + retryAfter * 1000), { expirationTtl: retryAfter });
            return apiJson({ error: "osu_" + type + "_scores_failed", upstream_status: scoresResponse.status, retry_after: retryAfter, uploaded: uploaded.length, daily_uploaded: dailyUploaded }, scoresResponse.status === 401 ? 401 : scoresResponse.status === 429 ? 429 : 502);
          }
          const scores = await scoresResponse.json().catch(() => null);
          if (!Array.isArray(scores)) return apiJson({ error: "osu_" + type + "_scores_invalid_response", uploaded: uploaded.length, daily_uploaded: dailyUploaded }, 502);
          queue.scores = scores.slice(0, Math.min(50, target - queue.offset)); queue.index = 0;
          if (!queue.scores.length) { queue.offset = target; await env.OAUTH_KV.put(queueKey, JSON.stringify(queue)); continue; }
        }
        let nextReplayNumber;
        try { nextReplayNumber = await getNextReplaySequence(env, "replays/" + prefix, filePrefix); }
        catch (error) { return apiJson({ error: error.message || "dataset_sequence_lookup_failed", uploaded: uploaded.length, daily_uploaded: dailyUploaded }, 502); }
        while (queue.index < queue.scores.length && processed < batchLimit && modeProcessed < perModeLimit && dailyUploaded < dailyLimit) {
          const score = queue.scores[queue.index]; queue.index++; processed++; modeProcessed++;
          if (score?.has_replay !== true || !score.id) { skipped.unavailable++; continue; }
          const scoreId = String(score.id), uploadedKey = "replay-uploaded:" + userId + ":" + mode + ":" + scoreId;
          if (await env.OAUTH_KV.get(uploadedKey)) { skipped.already_present++; continue; }
          await waitForApiBudget();
          const replayHeaders = { ...userHeaders, accept: "application/octet-stream" };
          let replayResponse = await fetch("https://osu.ppy.sh/api/v2/scores/" + encodeURIComponent(scoreId) + "/download", { headers: replayHeaders }); apiCalls++;
          if (replayResponse.status === 404) {
            await replayResponse.arrayBuffer().catch(() => new ArrayBuffer(0));
            await waitForApiBudget();
            replayResponse = await fetch("https://osu.ppy.sh/api/v2/scores/" + mode + "/" + encodeURIComponent(scoreId) + "/download", { headers: replayHeaders }); apiCalls++;
          }
          if (!replayResponse.ok) {
            if (replayResponse.status === 404) { skipped.unavailable++; continue; }
            queue.index--;
            await env.OAUTH_KV.put(queueKey, JSON.stringify(queue));
            const retryAfter = replayResponse.status === 429 ? osuRetryAfterSeconds(replayResponse) : null;
            if (retryAfter) await env.OAUTH_KV.put(cooldownKey, String(Date.now() + retryAfter * 1000), { expirationTtl: retryAfter });
            return apiJson({ error: "osu_replay_download_failed", upstream_status: replayResponse.status, retry_after: retryAfter, uploaded: uploaded.length, daily_uploaded: dailyUploaded }, replayResponse.status === 401 ? 401 : replayResponse.status === 429 ? 429 : 502);
          }
          const raw = await replayResponse.arrayBuffer();
          let clean; try { clean = anonymizeOsr(raw, participantId, mode); }
          catch { queue.index--; await env.OAUTH_KV.put(queueKey, JSON.stringify(queue)); return apiJson({ error: "replay_anonymization_failed", uploaded: uploaded.length, daily_uploaded: dailyUploaded }, 422); }
          const fileName = filePrefix + String(nextReplayNumber).padStart(6, "0") + ".osr", path = "replays/" + prefix + "/" + fileName;
          let result; try { result = await uploadAnonymizedReplay(env, path, clean); }
          catch (error) { queue.index--; await env.OAUTH_KV.put(queueKey, JSON.stringify(queue)); return apiJson({ error: error.message || "dataset_upload_failed", uploaded: uploaded.length, daily_uploaded: dailyUploaded }, 502); }
          const fileRecord = { path: result.path, sha: result.sha, hash: scoreId, kv_key: uploadedKey };
          consent.files = Array.isArray(consent.files) ? consent.files : []; consent.files.push(fileRecord);
          await env.OAUTH_KV.put(uploadedKey, JSON.stringify({ path: result.path, sha: result.sha, uploaded_at: new Date().toISOString() }));
          await env.OAUTH_KV.put(consentKey, JSON.stringify(consent));
          uploaded.push({ mode, file: fileName }); nextReplayNumber++; dailyUploaded++;
          await env.OAUTH_KV.put(dailyKey, String(dailyUploaded));
        }
        if (queue.index >= queue.scores.length) { queue.offset += queue.scores.length; queue.scores = []; queue.index = 0; }
        await env.OAUTH_KV.put(queueKey, JSON.stringify(queue));
        if (queue.offset < target || queue.index < queue.scores.length) complete = false;
      }
      return apiJson({ ok: true, type, uploaded: uploaded.length, files: uploaded, skipped, api_calls: apiCalls, daily_uploaded: dailyUploaded, daily_limit: dailyLimit, batch_limit: batchLimit, mode_batch_limit: perModeLimit, active_modes: activeModes, complete, next_sync_at: nextDay.toISOString() });
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
      const wantsRooms = url.searchParams.get("rooms") === "1";
      try {
        await env.OAUTH_KV.put("state:" + state, wantsRooms ? "rooms" : "1", { expirationTtl: 600 });
        await env.OAUTH_KV.put("osu:login:" + state, JSON.stringify({ status: "pending", createdAt: Date.now() }), { expirationTtl: 900 });
      } catch {
        return json({ error: "oauth_state_store_failed", stage: "oauth_start" }, 503);
      }

      const authorize = new URL("https://osu.ppy.sh/oauth/authorize");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", wantsRooms ? "public identify multiplayer.write_manage chat.read chat.write chat.write_manage" : "public identify");
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
      await env.OAUTH_KV.put("handoff:" + handoff, JSON.stringify({ ...tokens, canHost: valid === "rooms" }), { expirationTtl: 90 });
      // Polling fallback: on Android the deep-link return event is not always delivered
      // to the WebView, so the app can also pick the tokens up by its original state.
      await env.OAUTH_KV.put("osu:login:" + state, JSON.stringify({ status: "done", tokens, createdAt: Date.now() }), { expirationTtl: 600 });
      return safeAppRedirect(env, { handoff });
    }

    // --- Google sign-in and cross-device sync ---
    const googleRedirectUri = () => new URL("/oauth/google/callback", request.url).toString();

    if (url.pathname === "/oauth/google/config-check" && request.method === "GET") {
      return apiJson({
        service: "osu-daily-tracker-oauth",
        client_id_present: Boolean(String(env.GOOGLE_CLIENT_ID || "").trim()),
        client_secret_present: Boolean(String(env.GOOGLE_CLIENT_SECRET || "").trim()),
        kv_bound: Boolean(env.OAUTH_KV),
        redirect_uri: googleRedirectUri(),
        app_redirect_uri: env.APP_REDIRECT_URI || "osudailytracker://oauth",
      });
    }

    // Safe probe: uses a deliberately invalid code and reports only Google's error code.
    // invalid_grant => client/secret and endpoint are fine; invalid_client => bad secret;
    // 403/429 with a location message => Google blocks the Worker's egress region.
    if (url.pathname === "/oauth/google/token-check" && request.method === "GET") {
      const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
      const clientSecret = String(env.GOOGLE_CLIENT_SECRET || "").trim();
      if (!clientId || !clientSecret) return apiJson({ error: "not_configured" }, 503);
      try {
        const probe = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: "invalid_probe_code", grant_type: "authorization_code", redirect_uri: googleRedirectUri() }),
        });
        const text = await probe.text();
        let parsed = {};
        try { parsed = JSON.parse(text); } catch {}
        return apiJson({
          upstream_status: probe.status,
          error: parsed.error || null,
          error_description: parsed.error_description ? String(parsed.error_description).slice(0, 200) : null,
        });
      } catch (error) {
        return apiJson({ error: "fetch_failed", details: String(error?.message || error).slice(0, 200) }, 502);
      }
    }

    // A failed callback must be visible to the user, not silently bounced back to the app.
    const googleErrorPage = (code) => {
      const messages = {
        invalid_response: "Google вернул некорректный ответ.",
        state_mismatch: "Не совпал защитный код запроса. Попробуй войти ещё раз.",
        not_configured: "На сервере не настроен вход через Google.",
        token_exchange_failed: "Не удалось обменять код авторизации на сессию. Проверь настройки OAuth-клиента в Google Cloud.",
        invalid_token_response: "Google вернул некорректный ответ при обмене кода.",
        userinfo_failed: "Не удалось получить профиль Google.",
      };
      const text = messages[code] || ("Ошибка входа: " + String(code));
      const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>osu! Daily Tracker — ошибка входа</title>' +
        '<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0f17;color:#fff7fc;max-width:520px;margin:8vh auto;padding:24px}code{background:#141b28;padding:4px 8px;border-radius:6px}</style></head><body>' +
        '<h2>Не удалось войти через Google</h2><p>' + text + '</p><p><code>' + String(code) + '</code></p>' +
        '<p>Вернись в приложение и попробуй ещё раз.</p></body></html>';
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    };

    if (url.pathname === "/oauth/google/start" && request.method === "GET") {
      const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
      if (!clientId || !env.OAUTH_KV) return apiJson({ error: "google_not_configured" }, 503);
      const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const loginId = String(url.searchParams.get("login_id") || "").trim();
      const validLoginId = /^[a-f0-9]{16,64}$/i.test(loginId) ? loginId : null;
      if (validLoginId) {
        await env.OAUTH_KV.put("google:login:" + validLoginId, JSON.stringify({ status: "pending", createdAt: Date.now() }), { expirationTtl: 900 });
      }
      await env.OAUTH_KV.put("google:state:" + state, JSON.stringify({ createdAt: Date.now(), loginId: validLoginId }), { expirationTtl: 600 });
      const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", googleRedirectUri());
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "openid email profile");
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("access_type", "online");
      authorize.searchParams.set("prompt", "select_account");
      return new Response(null, { status: 302, headers: { location: authorize.toString(), "cache-control": "no-store" } });
    }

    if (url.pathname === "/oauth/google/callback" && request.method === "GET") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");
      if (oauthError) return googleErrorPage(oauthError);
      if (!code || !state || !env.OAUTH_KV) return googleErrorPage("invalid_response");
      const stateKey = "google:state:" + state;
      const stateData = await env.OAUTH_KV.get(stateKey);
      if (!stateData) return googleErrorPage("state_mismatch");
      let stateInfo = {};
      try { stateInfo = JSON.parse(stateData) || {}; } catch { stateInfo = {}; }
      await env.OAUTH_KV.delete(stateKey);
      const clientId = String(env.GOOGLE_CLIENT_ID || "").trim(), clientSecret = String(env.GOOGLE_CLIENT_SECRET || "").trim();
      if (!clientId || !clientSecret) return googleErrorPage("not_configured");
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: googleRedirectUri() }),
      });
      if (!tokenResponse.ok) {
        const upstreamBody = await tokenResponse.text().catch(() => "");
        let upstreamError = "";
        try { upstreamError = String((JSON.parse(upstreamBody) || {}).error || "").replace(/[^a-z_]/gi, ""); } catch {}
        return googleErrorPage("token_exchange_failed_http_" + tokenResponse.status + (upstreamError ? "_" + upstreamError : ""));
      }
      const tokens = await tokenResponse.json();
      if (!tokens.access_token) return googleErrorPage("invalid_token_response");
      const infoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: "Bearer " + tokens.access_token, accept: "application/json" } });
      const profile = await infoResponse.json().catch(() => ({}));
      if (!infoResponse.ok || !profile.sub) return googleErrorPage("userinfo_failed");
      const session = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const user = { sub: profile.sub, email: profile.email || "", name: profile.name || "", picture: profile.picture || "" };
      await env.OAUTH_KV.put("google:session:" + session, JSON.stringify({ ...user, createdAt: Date.now() }), { expirationTtl: 60 * 60 * 24 * 90 });
      await env.OAUTH_KV.put("google:user:" + user.sub, JSON.stringify({ ...user, updatedAt: Date.now() }));
      // The app also polls for this result: on Android the deep-link/return event is
      // not always delivered to the WebView, so polling is the reliable completion path.
      if (stateInfo.loginId && /^[a-f0-9]{16,64}$/i.test(stateInfo.loginId)) {
        await env.OAUTH_KV.put("google:login:" + stateInfo.loginId, JSON.stringify({ status: "done", session, createdAt: Date.now() }), { expirationTtl: 900 });
      }
      // Only our own opaque session token is handed to the app; Google tokens stay server-side.
      // The page also shows the code so the flow can be completed manually if the deep link
      // is not delivered by the OS/browser.
      const appUrl = new URL(env.APP_REDIRECT_URI || "osudailytracker://oauth");
      appUrl.searchParams.set("google_session", session);
      const destination = appUrl.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>osu! Daily Tracker — вход через Google</title>' +
        '<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0f17;color:#fff7fc;max-width:520px;margin:6vh auto;padding:24px}h2{margin-top:0}code{display:block;word-break:break-all;background:#141b28;padding:14px;border-radius:8px;margin:12px 0;font-size:15px;user-select:all}button{display:block;width:100%;padding:14px;border-radius:10px;border:0;background:#57c9e8;color:#0b0f17;font-weight:700;font-size:16px;margin:10px 0;cursor:pointer}a{color:#a9e7ff}.muted{color:#91a3b9;font-size:14px}</style></head><body>' +
        '<h2>Вход через Google выполнен</h2>' +
        '<p>Скопируй код ниже, вернись в приложение и вставь его в Настройках → «Синхронизация Google» → поле «Код входа из страницы Google», затем нажми «Ввести код».</p>' +
        '<code id="googleCode">' + session + '</code>' +
        '<button type="button" onclick="var b=this;var c=document.getElementById(\'googleCode\').textContent;if(navigator.clipboard){navigator.clipboard.writeText(c).then(function(){b.textContent=\'Скопировано ✓\'},function(){b.textContent=\'Выдели код вручную\'})}else{b.textContent=\'Выдели код вручную\'}">Скопировать код</button>' +
        '<p><a href="' + destination + '">Открыть приложение автоматически ↗</a></p>' +
        '<p class="muted">Если переход в приложение не сработал — не переживай, ручной ввод кода работает одинаково надёжно.</p>' +
        '</body></html>';
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    const googleAuthUser = async () => {
      const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
      if (!match || !env.OAUTH_KV) return null;
      const raw = await env.OAUTH_KV.get("google:session:" + match[1].trim());
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    };

    if (url.pathname === "/api/osu/poll" && request.method === "GET") {
      const state = String(url.searchParams.get("state") || "").trim();
      if (!validState(state)) return apiJson({ error: "invalid_state" }, 400);
      const raw = await env.OAUTH_KV.get("osu:login:" + state);
      if (!raw) return apiJson({ status: "unknown" });
      let data = {};
      try { data = JSON.parse(raw) || {}; } catch {}
      return apiJson({ status: data.status === "done" ? "done" : "pending", tokens: data.status === "done" ? data.tokens : undefined });
    }

    if (url.pathname === "/api/google/poll" && request.method === "GET") {
      const loginId = String(url.searchParams.get("login_id") || "").trim();
      if (!/^[a-f0-9]{16,64}$/i.test(loginId)) return apiJson({ error: "invalid_login_id" }, 400);
      const raw = await env.OAUTH_KV.get("google:login:" + loginId);
      if (!raw) return apiJson({ status: "unknown" });
      let data = {};
      try { data = JSON.parse(raw) || {}; } catch {}
      return apiJson({ status: data.status === "done" ? "done" : "pending", session: data.status === "done" ? data.session : undefined });
    }

    if (url.pathname === "/api/google/me" && request.method === "GET") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      return apiJson({ user: { sub: user.sub, email: user.email, name: user.name, picture: user.picture } });
    }

    if (url.pathname === "/api/google/sync" && (request.method === "GET" || request.method === "PUT")) {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      const key = "google:sync:" + user.sub;
      if (request.method === "GET") {
        const raw = await env.OAUTH_KV.get(key);
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}
        return apiJson({ viewed: Array.isArray(data.viewed) ? data.viewed : [], theme: data.theme || null, dailyGoal: Number.isFinite(data.dailyGoal) ? data.dailyGoal : null, updatedAt: data.updatedAt || null });
      }
      let payload;
      try { payload = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const viewed = (Array.isArray(payload?.viewed) ? payload.viewed : []).slice(0, 300).map(item => ({
        id: String(item?.id || "").slice(0, 80), md5: String(item?.md5 || "").slice(0, 40),
        player: String(item?.player || "").slice(0, 80), map: String(item?.map || "").slice(0, 200),
        pp: Number.isFinite(Number(item?.pp)) ? Number(item.pp) : null,
        stars: Number.isFinite(Number(item?.stars)) ? Number(item.stars) : null,
        viewedAt: Number(item?.viewedAt) || Date.now()
      })).filter(item => item.id || item.md5);
      const theme = payload?.theme && typeof payload.theme === "object" ? payload.theme : null;
      const dailyGoal = Number.isFinite(Number(payload?.dailyGoal)) ? Math.max(1, Math.min(200, Number(payload.dailyGoal))) : null;
      const data = { viewed, theme, dailyGoal, updatedAt: Date.now() };
      await env.OAUTH_KV.put(key, JSON.stringify(data));
      return apiJson({ ok: true, updatedAt: data.updatedAt });
    }

    // --- In-app account profile: avatar/name live here, not in the Google account ---
    const profileDefaults = (user) => ({
      username: "user_" + String(user.sub || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase(),
      displayName: String(user.name || "").slice(0, 40) || "Игрок",
      bio: "",
      avatar: null,
      updatedAt: null,
    });
    const readProfile = async (user) => {
      const raw = await env.OAUTH_KV.get("google:profile:" + user.sub);
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}
      const base = profileDefaults(user);
      return {
        username: typeof data.username === "string" ? data.username : base.username,
        displayName: typeof data.displayName === "string" && data.displayName.trim() ? data.displayName : base.displayName,
        bio: typeof data.bio === "string" ? data.bio : "",
        avatar: typeof data.avatar === "string" && data.avatar.startsWith("data:image/") ? data.avatar : null,
        email: user.email || "",
        googlePicture: user.picture || "",
        updatedAt: data.updatedAt || null,
      };
    };

    if (url.pathname === "/api/profile" && request.method === "GET") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      return apiJson({ profile: await readProfile(user) });
    }

    if (url.pathname === "/api/profile" && request.method === "PUT") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      let payload;
      try { payload = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const username = String(payload?.username || "").trim();
      if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) return apiJson({ error: "invalid_username" }, 400);
      const displayName = String(payload?.displayName || "").trim().slice(0, 40);
      if (!displayName) return apiJson({ error: "invalid_display_name" }, 400);
      const bio = String(payload?.bio || "").trim().slice(0, 160);
      let avatar = null;
      const rawAvatar = payload?.avatar;
      if (rawAvatar === null || rawAvatar === "") {
        avatar = null;
      } else if (typeof rawAvatar === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(rawAvatar)) {
        let bytes = 0;
        try { bytes = atob(rawAvatar.slice(rawAvatar.indexOf(",") + 1)).length; } catch { return apiJson({ error: "invalid_avatar" }, 400); }
        if (bytes > 700000) return apiJson({ error: "avatar_too_large" }, 413);
        avatar = rawAvatar;
      } else return apiJson({ error: "invalid_avatar" }, 400);

      const current = await readProfile(user);
      const lower = username.toLowerCase();
      const owner = await env.OAUTH_KV.get("google:username:" + lower);
      if (owner && owner !== user.sub) return apiJson({ error: "username_taken" }, 409);
      if (current.username.toLowerCase() !== lower) await env.OAUTH_KV.delete("google:username:" + current.username.toLowerCase());
      await env.OAUTH_KV.put("google:username:" + lower, user.sub);
      const profile = { username, displayName, bio, avatar, updatedAt: Date.now() };
      await env.OAUTH_KV.put("google:profile:" + user.sub, JSON.stringify(profile));
      return apiJson({ ok: true, profile: await readProfile(user) });
    }

    if (/^\/api\/profiles\/[A-Za-z0-9_.-]{3,24}$/.test(url.pathname) && request.method === "GET") {
      const username = decodeURIComponent(url.pathname.split("/").pop()).toLowerCase();
      const sub = await env.OAUTH_KV.get("google:username:" + username);
      if (!sub) return apiJson({ error: "profile_not_found" }, 404);
      const raw = await env.OAUTH_KV.get("google:profile:" + sub);
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}
      return apiJson({ profile: { username: data.username || username, displayName: data.displayName || "Игрок", bio: data.bio || "", avatar: data.avatar || null } });
    }

    // --- Chat: Durable Object rooms, WebSocket upgrade and room management ---
    const chatRoomStub = (roomId) => env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(roomId));
    const googleAuthToken = async (token) => {
      if (!token || !env.OAUTH_KV) return null;
      const raw = await env.OAUTH_KV.get("google:session:" + String(token).trim());
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    };
    const chatProfile = async (sub) => {
      const raw = await env.OAUTH_KV.get("google:profile:" + sub);
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}
      return { sub, username: data.username || "user", name: data.displayName || "Игрок", avatar: data.avatar || null };
    };
    const chatRoomList = async (sub) => {
      const raw = await env.OAUTH_KV.get("chat:rooms:" + sub);
      let rooms = [];
      try { rooms = raw ? JSON.parse(raw) : []; } catch {}
      return Array.isArray(rooms) ? rooms.slice(0, 100) : [];
    };
    const addRoomFor = async (sub, descriptor) => {
      const rooms = await chatRoomList(sub);
      const index = rooms.findIndex(room => room.id === descriptor.id);
      if (index >= 0) rooms[index] = { ...rooms[index], ...descriptor };
      else rooms.unshift(descriptor);
      await env.OAUTH_KV.put("chat:rooms:" + sub, JSON.stringify(rooms.slice(0, 100)));
    };

    if (url.pathname === "/api/chat/rooms" && request.method === "GET") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      return apiJson({ rooms: await chatRoomList(user.sub) });
    }

    if (url.pathname === "/api/chat/dm" && request.method === "POST") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      let payload;
      try { payload = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const username = String(payload?.username || "").replace(/^@/, "").trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,24}$/.test(username)) return apiJson({ error: "invalid_username" }, 400);
      const targetSub = await env.OAUTH_KV.get("google:username:" + username);
      if (!targetSub || targetSub === user.sub) return apiJson({ error: "user_not_found" }, 404);
      const pair = [user.sub, targetSub].sort();
      const roomId = "dm:" + pair.join(":");
      const me = await chatProfile(user.sub), other = await chatProfile(targetSub);
      await chatRoomStub(roomId).fetch(new Request("https://chat-room/members?room=" + encodeURIComponent(roomId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ members: [me, other] }),
      }));
      await addRoomFor(user.sub, { id: roomId, kind: "dm", name: other.name, username: other.username, avatar: other.avatar, with: targetSub, updatedAt: Date.now() });
      await addRoomFor(targetSub, { id: roomId, kind: "dm", name: me.name, username: me.username, avatar: me.avatar, with: user.sub, updatedAt: Date.now() });
      return apiJson({ ok: true, roomId });
    }

    if (url.pathname === "/api/chat/groups" && request.method === "POST") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      let payload;
      try { payload = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const name = String(payload?.name || "").trim().slice(0, 60);
      if (!name) return apiJson({ error: "invalid_group_name" }, 400);
      const usernames = Array.isArray(payload?.members) ? payload.members.slice(0, 50) : [];
      const subs = new Set([user.sub]);
      for (const item of usernames) {
        const handle = String(item || "").replace(/^@/, "").trim().toLowerCase();
        const sub = handle ? await env.OAUTH_KV.get("google:username:" + handle) : null;
        if (sub) subs.add(sub);
      }
      if (subs.size < 2) return apiJson({ error: "need_members" }, 400);
      const roomId = "grp:" + crypto.randomUUID().replaceAll("-", "");
      const members = await Promise.all([...subs].map(chatProfile));
      await chatRoomStub(roomId).fetch(new Request("https://chat-room/members?room=" + encodeURIComponent(roomId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ members }),
      }));
      for (const member of members) {
        await addRoomFor(member.sub, {
          id: roomId, kind: "group", name, members: members.map(m => ({ sub: m.sub, name: m.name, username: m.username, avatar: m.avatar })),
          updatedAt: Date.now(),
        });
      }
      return apiJson({ ok: true, roomId });
    }

    let chatMatch = url.pathname.match(/^\/api\/chat\/rooms\/([^/]+)\/messages$/);
    if (chatMatch && request.method === "GET") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      const roomId = decodeURIComponent(chatMatch[1]);
      const rooms = await chatRoomList(user.sub);
      if (!rooms.some(room => room.id === roomId)) return apiJson({ error: "forbidden" }, 403);
      // KV mirror is authoritative for the transcript: it is not affected by
      // Durable Object eviction/restarts and survives any code deployment.
      const rawHistory = await env.OAUTH_KV.get("chat:messages:" + roomId);
      let mirrored = [];
      try { mirrored = rawHistory ? JSON.parse(rawHistory) : []; } catch { mirrored = []; }
      if (Array.isArray(mirrored) && mirrored.length) {
        const merged = new Map();
        for (const item of mirrored) if (item?.id) merged.set(item.id, item);
        try {
          const probe = await chatRoomStub(roomId).fetch(new Request("https://chat-room/info?room=" + encodeURIComponent(roomId), { headers: { "x-chat-sub": user.sub, "x-chat-room": roomId } }));
          const info = await probe.json().catch(() => ({}));
          if (info?.count && info.count > merged.size) {
            const target = new URL("https://chat-room/history");
            target.searchParams.set("room", roomId);
            target.searchParams.set("sub", user.sub);
            for (const [key, value] of url.searchParams) target.searchParams.set(key, value);
            const response = await chatRoomStub(roomId).fetch(new Request(target.toString(), { headers: { "x-chat-sub": user.sub, "x-chat-room": roomId } }));
            const data = await response.json().catch(() => ({}));
            for (const item of data.messages || []) if (item?.id) merged.set(item.id, item);
          }
        } catch { /* DO is optional for history as long as KV mirror exists */ }
        const items = [...merged.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-300);
        return apiJson({ messages: items, members: [], source: "kv" });
      }
      const target = new URL("https://chat-room/history");
      target.searchParams.set("room", roomId);
      target.searchParams.set("sub", user.sub);
      for (const [key, value] of url.searchParams) target.searchParams.set(key, value);
      return chatRoomStub(roomId).fetch(new Request(target.toString(), { headers: { "x-chat-sub": user.sub, "x-chat-room": roomId } }));
    }

    if (url.pathname === "/api/chat/ws-ticket" && request.method === "GET") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      const ticket = crypto.randomUUID().replaceAll("-", "");
      await env.OAUTH_KV.put("chat:ws-ticket:" + ticket, JSON.stringify(user), { expirationTtl: 120 });
      return apiJson({ ticket });
    }

    chatMatch = url.pathname.match(/^\/api\/chat\/ws\/([^/]+)$/);
    if (chatMatch && request.headers.get("Upgrade") === "websocket") {
      let user = null;
      const ticket = String(url.searchParams.get("ticket") || "");
      if (/^[a-f0-9]{32}$/i.test(ticket)) {
        const rawTicket = await env.OAUTH_KV.get("chat:ws-ticket:" + ticket);
        if (rawTicket) {
          await env.OAUTH_KV.delete("chat:ws-ticket:" + ticket);
          try { user = JSON.parse(rawTicket); } catch { user = null; }
        }
      }
      if (!user) user = await googleAuthToken(url.searchParams.get("session"));
      if (!user) return new Response("unauthorized", { status: 401 });
      const roomId = decodeURIComponent(chatMatch[1]);
      const rooms = await chatRoomList(user.sub);
      if (!rooms.some(room => room.id === roomId)) return new Response("forbidden", { status: 403 });
      const target = new URL(request.url);
      target.pathname = "/";
      target.searchParams.set("room", roomId);
      target.searchParams.set("sub", user.sub);
      return chatRoomStub(roomId).fetch(new Request(target.toString(), {
        headers: request.headers,
      }));
    }

    // --- Coop rooms created through osu!'s referee hub (lazer multiplayer) ---
    const osuTokenFromRequest = () => {
      const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
      return match ? match[1].trim() : "";
    };
    const coopRoomList = async () => {
      const raw = await env.OAUTH_KV.get("coop:rooms");
      let rooms = [];
      try { rooms = raw ? JSON.parse(raw) : []; } catch {}
      return Array.isArray(rooms) ? rooms.slice(0, 50) : [];
    };

    const osuPublicToken = async () => {
      const cached = await env.OAUTH_KV.get("osu:public-token");
      if (cached) {
        try { const parsed = JSON.parse(cached); if (parsed.expiresAt > Date.now() && parsed.token) return parsed.token; } catch {}
      }
      const clientId = String(env.OSU_CLIENT_ID || "").trim(), clientSecret = String(env.OSU_CLIENT_SECRET || "").trim();
      if (!clientId || !clientSecret) throw new Error("osu_api_not_configured");
      const response = await fetch("https://osu.ppy.sh/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials", scope: "public" }),
      });
      if (!response.ok) throw new Error("osu_token_http_" + response.status);
      const tokens = await response.json();
      const token = String(tokens.access_token || "");
      if (!token) throw new Error("osu_token_missing");
      await env.OAUTH_KV.put("osu:public-token", JSON.stringify({ token, expiresAt: Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000 }), { expirationTtl: 3600 });
      return token;
    };

    const botOsuToken = async () => {
      const raw = await env.OAUTH_KV.get("coop:bot-session");
      if (!raw) return "";
      let session;
      try { session = JSON.parse(raw); } catch { return ""; }
      if (!session?.accessToken || !session?.refreshToken) return "";
      if (session.expiresAt && session.expiresAt > Date.now() + 30000) return session.accessToken;
      const clientId = String(env.OSU_CLIENT_ID || "").trim(), clientSecret = String(env.OSU_CLIENT_SECRET || "").trim();
      const response = await fetch("https://osu.ppy.sh/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: session.refreshToken }),
      });
      if (!response.ok) return "";
      const tokens = await response.json();
      if (!tokens.access_token) return "";
      const next = { ...session, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || session.refreshToken, expiresAt: Date.now() + Number(tokens.expires_in || 0) * 1000 };
      await env.OAUTH_KV.put("coop:bot-session", JSON.stringify(next));
      return next.accessToken;
    };

    if (url.pathname === "/api/coop/bot-session" && request.method === "GET") {
      const raw = await env.OAUTH_KV.get("coop:bot-session");
      let configured = false, username = "", chatRead = false;
      if (raw) {
        try {
          const session = JSON.parse(raw);
          const validToken = await botOsuToken();
          const probe = await fetch("https://osu.ppy.sh/api/v2/me", { headers: { Authorization: "Bearer " + validToken, Accept: "application/json" } });
          if (probe.ok) {
            const profile = await probe.json().catch(() => ({}));
            configured = Boolean(session?.refreshToken);
            username = String(profile?.username || session?.username || "");
            try {
              const channels = await fetch("https://osu.ppy.sh/api/v2/chat/channels?limit=1", { headers: { Authorization: "Bearer " + validToken, Accept: "application/json" } });
              chatRead = channels.ok;
            } catch {}
          } else {
            await env.OAUTH_KV.delete("coop:bot-session");
          }
        } catch { /* ignore */ }
      }
      return apiJson({ configured, username, chat_read: chatRead });
    }

    if (url.pathname === "/api/coop/bot-session/disconnect" && request.method === "POST") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      await env.OAUTH_KV.delete("coop:bot-session");
      return apiJson({ ok: true });
    }

    if (url.pathname === "/api/coop/bot-session" && request.method === "POST") {
      const user = await googleAuthUser();
      if (!user) return apiJson({ error: "google_session_invalid" }, 401);
      let payload;
      try { payload = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const accessToken = String(payload?.accessToken || "").trim(), refreshToken = String(payload?.refreshToken || "").trim();
      if (!accessToken || !refreshToken) return apiJson({ error: "invalid_session" }, 400);
      const probe = await fetch("https://osu.ppy.sh/api/v2/me", { headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" } });
      if (!probe.ok) return apiJson({ error: "bot_token_invalid" }, 401);
      const profile = await probe.json().catch(() => ({}));
      await env.OAUTH_KV.put("coop:bot-session", JSON.stringify({
        accessToken, refreshToken,
        expiresAt: Date.now() + Number(payload?.expiresIn || 3600) * 1000,
        username: String(profile?.username || ""),
        registeredBy: user.sub,
      }));
      return apiJson({ ok: true, username: String(profile?.username || "") });
    }

    if (url.pathname === "/api/coop/popular-beatmaps" && request.method === "GET") {
      const mode = url.searchParams.get("mode") === "mania" ? "3" : "0";
      try {
        const token = await osuPublicToken();
        const response = await fetch("https://osu.ppy.sh/api/v2/beatmapsets/search?m=" + mode + "&sort=plays_desc", {
          headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        });
        if (!response.ok) return apiJson({ error: "popular_beatmaps_http_" + response.status }, 502);
        const data = await response.json();
        const sets = Array.isArray(data?.beatmapsets) ? data.beatmapsets : [];
        const maps = sets.flatMap(set => (set.beatmaps || [])
          .filter(beatmap => Number(beatmap.mode_int ?? set.mode_int ?? 0) === Number(mode))
          .map(beatmap => ({
            id: Number(beatmap.id || 0),
            artist: String(set.artist || ""),
            title: String(set.title || ""),
            version: String(beatmap.version || ""),
            stars: Number(beatmap.difficulty_rating || 0) || null,
            plays: Number(beatmap.playcount ?? set.play_count ?? 0) || 0,
          })))
          .sort((a, b) => b.plays - a.plays)
          .slice(0, 25)
          .filter(map => map.id > 0);
        return apiJson({ maps });
      } catch (error) {
        return apiJson({ error: "popular_beatmaps_failed", details: String(error?.message || error).slice(0, 200) }, 502);
      }
    }

    if (url.pathname === "/coop" && request.method === "GET") {
      const roomId = String(url.searchParams.get("room") || "").replace(/[^0-9]/g, "");
      let room = null;
      if (roomId) {
        try {
          const raw = await env.OAUTH_KV.get("coop:room:" + roomId);
          if (raw) room = JSON.parse(raw);
        } catch { /* ignore */ }
      }
      const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
      const id = esc(roomId || room?.id || "");
      const password = esc(room?.password || "");
      const name = esc(room?.name || "Coop-комната");
      const beatmap = esc(room?.beatmapId || "—");
      const ruleset = esc(room?.rulesetId === 3 ? "mania" : "standard");
      const deepLink = id ? "osu://room/" + id : "";
      const webLink = id ? "https://osu.ppy.sh/multiplayer/rooms/" + id : "";
      const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Приглашение в мультиплеер · osu! Daily Tracker</title><style>
      :root{color-scheme:dark;--bg:#0b0f17;--card:#141b28;--line:#2d4054;--ice:#a9e7ff;--cyan:#57c9e8;--text:#f0f6ff;--muted:#91a3b9}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 80% -10%,#20364b 0,transparent 40%),var(--bg);color:var(--text);font:16px/1.5 Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px}.card{width:min(520px,100%);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 20px 60px #0008}h1{margin:0 0 6px;font-size:24px}.sub{color:var(--muted);margin:0 0 18px}.row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}.row span:first-child{color:var(--muted)}.value{font-variant-numeric:tabular-nums;word-break:break-all;text-align:right}.big{font-size:28px;color:var(--ice);font-weight:800}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}button,a.button{border:1px solid var(--cyan);background:var(--cyan);color:#08121c;border-radius:10px;padding:10px 14px;font:600 15px inherit;text-decoration:none;cursor:pointer}a.button.secondary,button.secondary{background:transparent;color:var(--ice)}.hint{margin-top:16px;color:var(--muted);font-size:14px}a{color:var(--ice)}#status{min-height:20px;margin-top:10px;color:var(--cyan)}
      </style></head><body><div class="card"><h1>🎮 Вас пригласили в мультиплеер</h1><p class="sub">Комната создана через osu! Daily Tracker</p><div class="row"><span>Название</span><span class="value">${name}</span></div><div class="row"><span>ID комнаты</span><span class="value big">${id || "—"}</span></div>${password ? '<div class="row"><span>Пароль</span><span class="value">' + password + "</span></div>" : ""}<div class="row"><span>Режим / карта</span><span class="value">${ruleset} · ${beatmap}</span></div><div class="actions">${deepLink ? '<a class="button" href="' + deepLink + '">Открыть в osu! ↗</a>' : ""}${webLink ? '<a class="button secondary" href="' + webLink + '" target="_blank" rel="noopener">Страница на osu.ppy.sh ↗</a>' : ""}<button class="secondary" id="copyId" type="button">Скопировать ID</button>${password ? '<button class="secondary" id="copyPw" type="button">Скопировать пароль</button>' : ""}</div><div class="hint">Если игра не открылась: запусти lazer → «Мультиплеер» → найди комнату по ID${password ? " и введи пароль" : ""}.</div><div id="status"></div></div><script>
      function copy(text){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(()=>done('Скопировано: '+text),()=>fallback(text))}else fallback(text)}
      function fallback(text){var i=document.createElement('textarea');i.value=text;i.style.position='fixed';i.style.opacity='0';document.body.appendChild(i);i.select();try{document.execCommand('copy');done('Скопировано: '+text)}catch(e){done('Не удалось скопировать')}i.remove()}
      function done(text){document.getElementById('status').textContent=text}
      document.getElementById('copyId')&&document.getElementById('copyId').addEventListener('click',function(){copy('${id}')});
      document.getElementById('copyPw')&&document.getElementById('copyPw').addEventListener('click',function(){copy('${password}')});
      </script></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    let startMatchMatch = url.pathname.match(/^\/api\/coop\/rooms\/(\d+)\/start$/);
    if (startMatchMatch && request.method === "POST") {
      const token = await botOsuToken();
      if (!token) return apiJson({ error: "bot_session_required" }, 503);
      try {
        await invokeReferee(token, "StartMatch", [Number(startMatchMatch[1]), {}]);
        return apiJson({ ok: true });
      } catch (error) {
        return apiJson({ error: "coop_start_failed", details: String(error?.message || error).slice(0, 200) }, 502);
      }
    }

    let closeRoomMatch = url.pathname.match(/^\/api\/coop\/rooms\/(\d+)\/close$/);
    if (closeRoomMatch && request.method === "POST") {
      const token = await botOsuToken();
      if (!token) return apiJson({ error: "bot_session_required" }, 503);
      let note = "";
      try { await invokeReferee(token, "CloseRoom", [Number(closeRoomMatch[1])]); }
      catch (error) {
        const text = String(error?.message || error);
        if (!/not a referee/i.test(text)) return apiJson({ error: "coop_close_failed", details: text.slice(0, 200) }, 502);
        note = "Комната создана другим аккаунтом, поэтому бот не смог её закрыть; она убрана из списка.";
      }
      const rooms = (await coopRoomList()).filter(room => String(room?.id) !== closeRoomMatch[1]);
      await env.OAUTH_KV.put("coop:rooms", JSON.stringify(rooms.slice(0, 50)));
      await env.OAUTH_KV.delete("coop:room:" + closeRoomMatch[1]);
      return apiJson({ ok: true, note });
    }

    let setMapMatch = url.pathname.match(/^\/api\/coop\/rooms\/(\d+)\/beatmap$/);
    if (setMapMatch && request.method === "POST") {
      const token = await botOsuToken();
      if (!token) return apiJson({ error: "bot_session_required" }, 503);
      let payload;
      try { payload = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const beatmapId = Number(payload?.beatmapId) || 0;
      const rulesetId = Number(payload?.rulesetId) || 3;
      if (!beatmapId) return apiJson({ error: "invalid_beatmap" }, 400);
      try {
        await invokeReferee(token, "EditCurrentPlaylistItem", [Number(setMapMatch[1]), { beatmap_id: beatmapId, ruleset_id: rulesetId }]);
        return apiJson({ ok: true });
      } catch (error) {
        return apiJson({ error: "coop_map_failed", details: String(error?.message || error).slice(0, 200) }, 502);
      }
    }

    if (url.pathname === "/api/coop/rooms" && request.method === "GET") {
      return apiJson({ rooms: await coopRoomList() });
    }

    if (url.pathname === "/api/coop/rooms" && request.method === "POST") {
      const token = await botOsuToken();
      if (!token) return apiJson({ error: "bot_session_required" }, 503);
      let payload;
      try { payload = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const name = String(payload?.name || "").trim().slice(0, 80);
      const beatmapId = Number(payload?.beatmapId) || 0;
      if (!name || !beatmapId) return apiJson({ error: "invalid_room" }, 400);
      // Old rooms with the same name: close if empty, otherwise refuse.
      try {
        const knownRooms = await coopRoomList();
        const duplicates = knownRooms.filter(room => String(room?.name || "").trim().toLowerCase() === name.toLowerCase());
        for (const duplicate of duplicates) {
          let participants = null;
          try {
            const publicToken = await osuPublicToken();
            const info = await fetch("https://osu.ppy.sh/api/v2/rooms/" + encodeURIComponent(duplicate.id), {
              headers: { Authorization: "Bearer " + publicToken, Accept: "application/json" },
            });
            if (info.ok) {
              const data = await info.json();
              participants = Number(data?.participant_count ?? 0) || 0;
            }
          } catch { /* unknown occupancy */ }
          if (participants !== null && participants > 0) {
            return apiJson({ error: "room_name_exists", details: "Комната с таким названием уже идёт. Закрой её в lazer или придумай другое название." }, 409);
          }
          try { await invokeReferee(token, "CloseRoom", [Number(duplicate.id)]); } catch { /* not ours to close */ }
          const remaining = knownRooms.filter(room => String(room?.id) !== String(duplicate.id));
          await env.OAUTH_KV.put("coop:rooms", JSON.stringify(remaining.slice(0, 50)));
          await env.OAUTH_KV.delete("coop:room:" + duplicate.id);
        }
      } catch { /* name check is best-effort */ }
      try {
        const rulesetId = Number(payload?.rulesetId) || 3;
        // The bot is seated as host/referee, so add one slot for it.
        const maxParticipants = Math.max(0, Math.min(50, (Number(payload?.maxParticipants) || 2) + 1));
        const variants = [
          { label: "numbers", request: { name, beatmap_id: beatmapId, ruleset_id: rulesetId, type: 0, queue_mode: 1, max_participants: maxParticipants } },
          { label: "string-enums", request: { name, beatmap_id: beatmapId, ruleset_id: rulesetId, type: "head_to_head", queue_mode: "all_players", max_participants: maxParticipants } },
          { label: "minimal", request: { name, beatmap_id: beatmapId, ruleset_id: rulesetId, queue_mode: 1 } },
          { label: "no-max", request: { name, beatmap_id: beatmapId, ruleset_id: rulesetId, type: "head_to_head", queue_mode: "all_players" } },
          { label: "ascii-name", request: { name: "Coop " + Date.now(), beatmap_id: beatmapId, ruleset_id: rulesetId, type: "head_to_head", queue_mode: "all_players", max_participants: maxParticipants } },
          { label: "std-map", request: { name, beatmap_id: 5677987, ruleset_id: 0, type: "head_to_head", queue_mode: "all_players", max_participants: maxParticipants } },
        ];
        const attempts = [];
        let result = null;
        let usedVariant = "";
        let passwordCleared = false;
        for (const variant of variants) {
          try {
            const created = await makeRoomPersistent(token, variant.request);
            result = created.result;
            passwordCleared = created.passwordCleared;
            usedVariant = variant.label;
            if (ctx?.waitUntil) {
              ctx.waitUntil(created.keepAlive);
              const roomIdForExit = Number(created.result?.room_id || 0);
              ctx.waitUntil((async () => {
                for (let attempt = 0; attempt < 20; attempt++) {
                  await new Promise(resolve => setTimeout(resolve, 3000));
                  try {
                    const publicToken = await osuPublicToken();
                    const response = await fetch("https://osu.ppy.sh/api/v2/rooms/" + roomIdForExit, { headers: { Authorization: "Bearer " + publicToken, Accept: "application/json" } });
                    if (response.ok) {
                      const info = await response.json();
                      if (Number(info?.participant_count || 0) > 0) break;
                    }
                  } catch { /* keep waiting */ }
                }
                created.close();
              })());
              const roomIdForAutoStart = Number(created.result?.room_id || 0);
              ctx.waitUntil((async () => {
                let countdownStarted = false;
                let countdownTicks = 0;
                for (let tick = 0; tick < 300; tick++) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  try {
                    const info = await invokeReferee(token, "JoinRoom", [roomIdForAutoStart]);
                    const players = Array.isArray(info?.players) ? info.players : [];
                    const allReady = players.length > 0 && players.every(player => String(player?.status || "").toLowerCase() === "ready");
                    if (allReady && !countdownStarted) {
                      await invokeReferee(token, "StartMatch", [roomIdForAutoStart, { countdown: 10 }]);
                      countdownStarted = true;
                      countdownTicks = 0;
                    } else if (!allReady && countdownStarted) {
                      try { await invokeReferee(token, "StopMatchCountdown", [roomIdForAutoStart]); } catch {}
                      countdownStarted = false;
                    } else if (countdownStarted && ++countdownTicks >= 5) {
                      break;
                    }
                  } catch { /* keep polling */ }
                }
              })());
              const roomIdForChat = Number(created.result?.room_id || 0);
              const channelIdForChat = Number(created.result?.chat_channel_id || 0);
              if (channelIdForChat) ctx.waitUntil((async () => {
                let lastId = 0;
                for (let tick = 0; tick < 300; tick++) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  try {
                    const chatToken = await botOsuToken();
                    const response = await fetch("https://osu.ppy.sh/api/v2/chat/channels/" + channelIdForChat + "/messages?limit=20", { headers: { Authorization: "Bearer " + chatToken, Accept: "application/json" } });
                    if (!response.ok) continue;
                    const payload = await response.json();
                    const messages = Array.isArray(payload) ? payload : (payload.messages || []);
                    for (const message of messages) {
                      const messageId = Number(message?.message_id || message?.id || 0);
                      if (messageId <= lastId) continue;
                      lastId = Math.max(lastId, messageId);
                      const text = String(message?.content || message?.message || "").trim();
                      if (!text.startsWith("!")) continue;
                      const parts = text.split(/\s+/);
                      const command = parts[0].toLowerCase();
                      const argument = parts[1] || "";
                      let reply = "";
                      try {
                        if (command === "!help") reply = "Команды: !start, !map <beatmap_id>, !dt, !close";
                        else if (command === "!start") {
                          await invokeReferee(chatToken, "StartMatch", [roomIdForChat, {}]);
                          reply = "Матч запущен.";
                        } else if (command === "!map" && Number(argument)) {
                          await invokeReferee(chatToken, "EditCurrentPlaylistItem", [roomIdForChat, { beatmap_id: Number(argument), ruleset_id: Number(rulesetId) || 3 }]);
                          reply = "Карта сменена.";
                        } else if (command === "!dt") {
                          await invokeReferee(chatToken, "EditCurrentPlaylistItem", [roomIdForChat, {
                            beatmap_id: Number(beatmapId) || 0,
                            ruleset_id: Number(rulesetId) || 3,
                            required_mods: [{ acronym: "DT" }],
                            freestyle: true,
                          }]);
                          reply = "DT включён.";
                        } else if (command === "!close") {
                          await invokeReferee(chatToken, "CloseRoom", [roomIdForChat]);
                          reply = "Комната закрыта.";
                        } else reply = "Неизвестная команда. Напиши !help";
                      } catch (error) {
                        reply = "Ошибка: " + String(error?.message || error).slice(0, 120);
                      }
                      if (reply) await fetch("https://osu.ppy.sh/api/v2/chat/channels/" + channelIdForChat + "/messages", {
                        method: "POST",
                        headers: { Authorization: "Bearer " + chatToken, "Content-Type": "application/json", Accept: "application/json" },
                        body: JSON.stringify({ message: reply }),
                      });
                    }
                  } catch { /* keep polling */ }
                }
              })());
            }
            break;
          } catch (error) {
            attempts.push({ variant: variant.label, error: String(error?.message || error).slice(0, 220) });
          }
        }
        if (!result) return apiJson({ error: "referee_hub_failed", details: attempts.map(a => a.variant + '=' + a.error).join(' | ').slice(0, 600), attempts }, 502);
        const roomId = Number(result?.room_id || result?.roomId || 0);
        if (!roomId) return apiJson({ error: "room_id_missing", usedVariant }, 502);
        const room = {
          id: roomId,
          name: result.name || name,
          chatChannelId: Number(result?.chat_channel_id || 0),
          password: passwordCleared ? "" : String(result?.password || ""),
          beatmapId,
          rulesetId: Number(payload?.rulesetId) || 3,
          createdAt: Date.now(),
          host: payload?.host || null,
          osuLink: "osu://room/" + roomId,
        };
        const rooms = await coopRoomList();
        rooms.unshift(room);
        await env.OAUTH_KV.put("coop:rooms", JSON.stringify(rooms.slice(0, 50)));
        await env.OAUTH_KV.put("coop:room:" + roomId, JSON.stringify(room), { expirationTtl: 60 * 60 * 24 * 7 });
        return apiJson({ ok: true, room, usedVariant });
      } catch (error) {
        return apiJson({ error: "referee_hub_failed", details: String(error?.message || error).slice(0, 200) }, 502);
      }
    }

    let coopMatch = url.pathname.match(/^\/api\/coop\/rooms\/(\d+)$/);
    if (coopMatch && request.method === "GET") {
      const raw = await env.OAUTH_KV.get("coop:room:" + coopMatch[1]);
      if (!raw) return apiJson({ error: "room_not_found" }, 404);
      return apiJson({ room: JSON.parse(raw) });
    }

    coopMatch = url.pathname.match(/^\/api\/coop\/rooms\/(\d+)\/invite$/);
    if (coopMatch && request.method === "POST") {
      const token = await botOsuToken();
      if (!token) return apiJson({ error: "bot_session_required" }, 503);
      let payload;
      try { payload = await request.json(); } catch { return apiJson({ error: "invalid_json" }, 400); }
      const userId = Number(payload?.userId) || 0;
      if (!userId) return apiJson({ error: "invalid_user" }, 400);
      try {
        await invitePlayer(token, Number(coopMatch[1]), userId);
        return apiJson({ ok: true });
      } catch (error) {
        return apiJson({ error: "invite_failed", details: String(error?.message || error).slice(0, 200) }, 502);
      }
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
