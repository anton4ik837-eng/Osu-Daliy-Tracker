import { invokeReferee } from "./referee-hub.js";

async function botToken(env) {
  const raw = await env.OAUTH_KV.get("coop:bot-session");
  if (!raw) return "";
  let session;
  try { session = JSON.parse(raw); } catch { return ""; }
  if (session?.accessToken && (!session.expiresAt || session.expiresAt > Date.now() + 30000)) return session.accessToken;
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
  await env.OAUTH_KV.put("coop:bot-session", JSON.stringify({ ...session, accessToken: token, refreshToken: tokens.refresh_token || session.refreshToken, expiresAt: Date.now() + Number(tokens.expires_in || 0) * 1000 }));
  return token;
}

export async function pollCoopRooms(env) {
  if (!env.OAUTH_KV) return;
  const token = await botToken(env);
  if (!token) return;
  const raw = await env.OAUTH_KV.get("coop:rooms");
  let rooms = [];
  try { rooms = raw ? JSON.parse(raw) : []; } catch {}
  for (const room of rooms.slice(0, 50)) {
    const roomId = Number(room?.id || 0), channelId = Number(room?.chatChannelId || 0);
    if (!roomId) continue;
    try {
      const info = await invokeReferee(token, "JoinRoom", [roomId]);
      const players = Array.isArray(info?.players) ? info.players : [];
      const allReady = players.length > 0 && players.every(player => String(player?.status || "").toLowerCase() === "ready");
      const alreadyStarted = await env.OAUTH_KV.get("coop:started:" + roomId);
      if (allReady && !alreadyStarted) {
        await invokeReferee(token, "StartMatch", [roomId, { countdown: 10 }]);
        await env.OAUTH_KV.put("coop:started:" + roomId, "1", { expirationTtl: 3600 });
      }
    } catch { /* room may be closed */ }
    if (!channelId) continue;
    try {
      await invokeReferee(token, "JoinRoom", [roomId]);
    } catch {}
    try {
      const response = await fetch("https://osu.ppy.sh/api/v2/chat/channels/" + channelId + "/messages?limit=10", { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
      if (!response.ok) continue;
      const payload = await response.json();
      const messages = Array.isArray(payload) ? payload : (payload.messages || []);
      const lastRaw = await env.OAUTH_KV.get("coop:chat-last:" + roomId);
      let lastId = Number(lastRaw || 0) || 0;
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
        let replyStatus = 0;
        if (reply) {
          // osu! forbids API posts into multiplayer channels, so answer in a PM.
          try {
            const pm = await fetch("https://osu.ppy.sh/api/v2/chat/channels", {
              method: "POST",
              headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ target_id: Number(message?.sender_id || message?.user_id || 0) }),
            });
            const pmData = await pm.json().catch(() => ({}));
            const pmChannel = Number(pmData?.channel_id || 0);
            if (pmChannel) {
              const sent = await fetch("https://osu.ppy.sh/api/v2/chat/channels/" + pmChannel + "/messages", {
                method: "POST",
                headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ message: reply }),
              });
              replyStatus = sent.status;
            }
          } catch {}
        }
        try { await env.OAUTH_KV.put("coop:chat-log:" + roomId, JSON.stringify({ command, reply, replyStatus, at: Date.now() }), { expirationTtl: 3600 }); } catch {}
      }
      await env.OAUTH_KV.put("coop:chat-last:" + roomId, String(lastId), { expirationTtl: 86400 });
    } catch { /* keep going */ }
  }
}

export class CoopBot {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
    return new Response("ok");
  }

  async alarm() {
    try { await pollCoopRooms(this.env); } catch {}
    try { await this.env.OAUTH_KV.put("coop:bot-heartbeat", String(Date.now()), { expirationTtl: 300 }); } catch {}
    try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
  }
}
