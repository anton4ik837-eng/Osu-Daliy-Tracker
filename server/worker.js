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


async function waitForApiBudget() { await new Promise(resolve => setTimeout(resolve, 1050)); }

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

async function uploadAnonymizedReplay(env, path, bytes) {
  const token = typeof env.DATASET_GITHUB_TOKEN === "string" ? env.DATASET_GITHUB_TOKEN.trim() : "";
  if (!token) throw new Error("dataset_upload_not_configured");
  const response = await fetch("https://api.github.com/repos/anton4ik837-eng/Osu-Replay-Dataset/contents/" + path.split("/").map(encodeURIComponent).join("/"), {
    method: "PUT",
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "user-agent": "OsuDailyTracker-ReplaySync",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({ message: "Add anonymized opt-in replay", content: bytesToBase64(bytes), branch: "main" })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.content?.sha) throw new Error("dataset_upload_failed_" + response.status);
  return { sha: payload.content.sha, path: payload.content.path || path };
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
      return json({ ok: true, service: "osu-daily-tracker-oauth", version: 2, deploy_marker: "replay-dataset-token-check-2026-10-31", dataset_upload_configured: Boolean(env.DATASET_GITHUB_TOKEN), consent_store_configured: Boolean(env.OAUTH_KV) });
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
          const removed = await fetch("https://api.github.com/repos/anton4ik837-eng/Osu-Replay-Dataset/contents/" + file.path.split("/").map(encodeURIComponent).join("/"), {
            method: "DELETE",
            headers: { accept: "application/vnd.github+json", authorization: "Bearer " + env.DATASET_GITHUB_TOKEN, "content-type": "application/json", "user-agent": "Osu-Daily-Tracker-Replay-Collector", "x-github-api-version": "2022-11-28" },
            body: JSON.stringify({ message: "Remove replay after consent withdrawal", sha: file.sha, branch: "main" })
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

    // Upload only the authenticated participant's own replays after explicit opt-in.
    // The foreground app triggers sync every 30 minutes; each request is capped at 10 uploads,
    // with a rolling UTC-day quota of 100 uploads per participant.
    if (url.pathname === "/api/me/replay-sync" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match) return apiJson({ error: "missing_bearer_token" }, 401);
      if (!env.OAUTH_KV) return apiJson({ error: "consent_store_unavailable" }, 503);
      if (!env.DATASET_GITHUB_TOKEN) return apiJson({ error: "dataset_upload_not_configured" }, 503);
      const userHeaders = { accept: "application/json", "x-api-version": "20220705", authorization: "Bearer " + match[1] };
      const profileResponse = await fetch("https://osu.ppy.sh/api/v2/me/osu", { headers: userHeaders });
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok || !profile.id) return apiJson({ error: "osu_profile_request_failed" }, profileResponse.status === 401 ? 401 : 502);
      const userId = String(profile.id);
      const consentKey = "replay-consent:" + userId;
      const storedConsent = await env.OAUTH_KV.get(consentKey);
      let consent = null; try { consent = storedConsent ? JSON.parse(storedConsent) : null; } catch {}
      if (consent?.consent !== true || consent?.consent_version !== "replay-dataset-v2") return apiJson({ error: "replay_consent_required" }, 403);

      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const dailyKey = "replay-sync-count:" + userId + ":" + day;
      let dailyUploaded = Number(await env.OAUTH_KV.get(dailyKey) || 0);
      const nextDay = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1));
      if (dailyUploaded >= 100) {
        return apiJson({ ok: true, skipped: "daily_limit", daily_uploaded: dailyUploaded, uploaded: 0, next_sync_at: nextDay.toISOString() });
      }

      const participantId = String(consent.participant_id || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "anonymous";
      const uploaded = [];
      const skipped = { already_present: 0, unavailable: 0 };
      let apiCalls = 1;
      for (const mode of ["osu", "mania"]) {
        if (uploaded.length >= 10 || dailyUploaded >= 100) break;
        const prefix = mode === "osu" ? "standard" : "mania";
        const filePrefix = mode === "osu" ? "std_" : "mania_";
        let nextReplayNumber;
        try { nextReplayNumber = await getNextReplaySequence(env, "replays/" + prefix, filePrefix); }
        catch (error) {
          return apiJson({ error: error.message || "dataset_sequence_lookup_failed", uploaded: uploaded.length, daily_uploaded: dailyUploaded }, 502);
        }
        await waitForApiBudget();
        const scoresUrl = new URL("https://osu.ppy.sh/api/v2/users/" + encodeURIComponent(userId) + "/scores/recent");
        scoresUrl.searchParams.set("mode", mode);
        scoresUrl.searchParams.set("limit", "100");
        scoresUrl.searchParams.set("include_fails", "1");
        const scoresResponse = await fetch(scoresUrl, { headers: userHeaders });
        apiCalls++;
        if (!scoresResponse.ok) return apiJson({ error: "osu_recent_scores_failed", upstream_status: scoresResponse.status, uploaded: uploaded.length, daily_uploaded: dailyUploaded }, scoresResponse.status === 401 ? 401 : 502);
        const scores = await scoresResponse.json().catch(() => null);
        if (!Array.isArray(scores)) return apiJson({ error: "osu_recent_scores_invalid_response", uploaded: uploaded.length, daily_uploaded: dailyUploaded }, 502);
        let modeUploads = 0;
        for (const score of scores) {
          if (modeUploads >= 5 || uploaded.length >= 10 || dailyUploaded >= 100) break;
          if (score?.has_replay !== true || !score.id) { skipped.unavailable++; continue; }
          const scoreId = String(score.id);
          const uploadedKey = "replay-uploaded:" + userId + ":" + mode + ":" + scoreId;
          if (await env.OAUTH_KV.get(uploadedKey)) { skipped.already_present++; continue; }
          await waitForApiBudget();
          const replayHeaders = { ...userHeaders, accept: "application/octet-stream" };
          let replayResponse = await fetch("https://osu.ppy.sh/api/v2/scores/" + encodeURIComponent(scoreId) + "/download", { headers: replayHeaders });
          apiCalls++;
          if (replayResponse.status === 404) {
            await replayResponse.arrayBuffer().catch(() => new ArrayBuffer(0));
            await waitForApiBudget();
            replayResponse = await fetch("https://osu.ppy.sh/api/v2/scores/" + mode + "/" + encodeURIComponent(scoreId) + "/download", { headers: replayHeaders });
            apiCalls++;
          }
          if (!replayResponse.ok) {
            if (replayResponse.status === 404) { skipped.unavailable++; continue; }
            return apiJson({ error: "osu_replay_download_failed", upstream_status: replayResponse.status, uploaded: uploaded.length, daily_uploaded: dailyUploaded }, replayResponse.status === 401 ? 401 : 502);
          }
          const raw = await replayResponse.arrayBuffer();
          let clean;
          try { clean = anonymizeOsr(raw, participantId, mode); }
          catch { return apiJson({ error: "replay_anonymization_failed", uploaded: uploaded.length, daily_uploaded: dailyUploaded }, 422); }
          const fileName = filePrefix + String(nextReplayNumber).padStart(6, "0") + ".osr";
          const path = "replays/" + prefix + "/" + fileName;
          let result;
          try { result = await uploadAnonymizedReplay(env, path, clean); }
          catch (error) { return apiJson({ error: error.message || "dataset_upload_failed", uploaded: uploaded.length, daily_uploaded: dailyUploaded }, 502); }
          const fileRecord = { path: result.path, sha: result.sha, hash: scoreId, kv_key: uploadedKey };
          consent.files = Array.isArray(consent.files) ? consent.files : [];
          consent.files.push(fileRecord);
          await env.OAUTH_KV.put(uploadedKey, JSON.stringify({ path: result.path, sha: result.sha, uploaded_at: new Date().toISOString() }));
          await env.OAUTH_KV.put(consentKey, JSON.stringify(consent));
          uploaded.push({ mode, file: fileName });
          nextReplayNumber++;
          modeUploads++;
          dailyUploaded++;
          await env.OAUTH_KV.put(dailyKey, String(dailyUploaded));
        }
      }
      return apiJson({ ok: true, uploaded: uploaded.length, files: uploaded, skipped, api_calls: apiCalls, daily_uploaded: dailyUploaded, daily_limit: 100, batch_limit: 10, next_sync_at: nextDay.toISOString() });
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
