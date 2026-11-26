import { invokeReferee } from "./referee-hub.js";

// In-memory state only. KV is read rarely and never written on every tick.
const state = { token: "", expiresAt: 0, lastIds: new Map(), started: new Set() };

async function botToken(env) {
  if (state.token && state.expiresAt > Date.now() + 30000) return state.token;
  const raw = await env.OAUTH_KV.get("coop:bot-session");
  if (!raw) return "";
  let session;
  try { session = JSON.parse(raw); } catch { return ""; }
  if (session?.accessToken && (!session.expiresAt || session.expiresAt > Date.now() + 30000)) {
    state.token = session.accessToken;
    state.expiresAt = Number(session.expiresAt) || 0;
    return state.token;
  }
  const clientId = String(env.OSU_CLIENT_ID || "").trim(), clientSecret = String(env.OSU_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret || !session?.refreshToken) return "";
  const response = await fetch("https://osu.ppy.sh/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: session.refreshToken }),
  });
  if (!response.ok) return "";
  const tokens = await response.json();
  const token = String(tokens.access_token || "");
  if (!token) return "";
  state.token = token;
  state.expiresAt = Date.now() + Number(tokens.expires_in || 0) * 1000;
  await env.OAUTH_KV.put("coop:bot-session", JSON.stringify({ ...session, accessToken: token, refreshToken: tokens.refresh_token || session.refreshToken, expiresAt: state.expiresAt }));
  return token;
}

async function sendPm(token, senderId, text) {
  const target = Number(senderId || 0);
  if (!target || !text) return 0;
  const pm = await fetch("https://osu.ppy.sh/api/v2/chat/channels", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ target_id: target }),
  });
  const data = await pm.json().catch(() => ({}));
  const channel = Number(data?.channel_id || 0);
  if (!channel) return pm.status;
  const sent = await fetch("https://osu.ppy.sh/api/v2/chat/channels/" + channel + "/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message: text }),
  });
  return sent.status;
}

export async function pollCoopRooms(env) {
  if (!env.OAUTH_KV) return;
  const token = await botToken(env);
  if (!token) return;
  const raw = await env.OAUTH_KV.get("coop:rooms");
  let rooms = [];
  try { rooms = raw ? JSON.parse(raw) : []; } catch {}
  for (const room of rooms.slice(0, 10)) {
    const roomId = Number(room?.id || 0), channelId = Number(room?.chatChannelId || 0);
    if (!roomId) continue;
    try {
      const info = await invokeReferee(token, "JoinRoom", [roomId]);
      const players = Array.isArray(info?.players) ? info.players : [];
      const allReady = players.length > 0 && players.every(player => String(player?.status || "").toLowerCase() === "ready");
      if (allReady && !state.started.has(roomId)) {
        await invokeReferee(token, "StartMatch", [roomId, { countdown: 10 }]);
        state.started.add(roomId);
      }
    } catch { /* room may be closed */ }
    if (!channelId) continue;
    try { await invokeReferee(token, "JoinRoom", [roomId]); } catch {}
    try {
      const response = await fetch("https://osu.ppy.sh/api/v2/chat/channels/" + channelId + "/messages?limit=10", { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
      if (!response.ok) continue;
      const payload = await response.json();
      const messages = Array.isArray(payload) ? payload : (payload.messages || []);
      let lastId = state.lastIds.get(roomId) || 0;
      for (const message of messages) {
        const id = Number(message?.message_id || message?.id || 0);
        if (id <= lastId) continue;
        lastId = Math.max(lastId, id);
        const text = String(message?.content || message?.message || "").trim();
        if (!/^@bot\s/i.test(text)) continue;
        const parts = text.replace(/^@bot\s+/i, "").trim().split(/\s+/);
        const command = "!" + parts[0].toLowerCase(), argument = parts[1] || "";
        let reply = "";
        try {
          if (command === "!help") reply = "Команды: @bot start, @bot map <beatmap_id>, @bot dt, @bot ht, @bot close";
          else if (command === "!start") { await invokeReferee(token, "StartMatch", [roomId, {}]); reply = "Матч запущен."; }
          else if (command === "!dt") { await invokeReferee(token, "EditCurrentPlaylistItem", [roomId, { required_mods: [{ acronym: "DT" }], freestyle: true }]); reply = "DT включён."; }
          else if (command === "!ht") { await invokeReferee(token, "EditCurrentPlaylistItem", [roomId, { required_mods: [{ acronym: "HT" }], freestyle: true }]); reply = "HT включён."; }
          else if (command === "!map" && Number(argument)) { await invokeReferee(token, "EditCurrentPlaylistItem", [roomId, { beatmap_id: Number(argument), ruleset_id: Number(room?.rulesetId || 3) }]); reply = "Карта сменена."; }
          else if (command === "!close") { await invokeReferee(token, "CloseRoom", [roomId]); reply = "Комната закрыта."; }
          else reply = "Неизвестная команда. Напиши @bot help";
        } catch (error) { reply = "Ошибка: " + String(error?.message || error).slice(0, 120); }
        await sendPm(token, message?.sender_id || message?.user_id, reply);
      }
      state.lastIds.set(roomId, lastId);
    } catch { /* keep going */ }
  }
}

export class CoopBot {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch() {
    try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
    return new Response("ok");
  }

  async alarm() {
    try { await pollCoopRooms(this.env); } catch {}
    try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
  }
}
