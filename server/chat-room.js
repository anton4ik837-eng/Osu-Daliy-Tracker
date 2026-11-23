// One Durable Object per chat room. Uses the SQLite + WebSocket Hibernation API so
// idle rooms cost nothing on the Workers Free plan.
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        sender TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        created_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS members (
        sub TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        avatar TEXT,
        joined_at INTEGER NOT NULL
      )`);
    });
  }

  get sql() { return this.state.storage.sql; }

  async fetch(request) {
    const url = new URL(request.url);
    const sub = String(request.headers.get("x-chat-sub") || url.searchParams.get("sub") || "").trim();
    const roomId = String(request.headers.get("x-chat-room") || url.searchParams.get("room") || "").trim();

    if (request.headers.get("Upgrade") === "websocket") {
      if (!sub) return new Response("unauthorized", { status: 401 });
      const authorized = await this.isMember(sub, roomId);
      if (!authorized) return new Response("forbidden", { status: 403 });
      const pair = new WebSocketPair();
      pair[1].serializeAttachment({ sub });
      this.state.acceptWebSocket(pair[1], [sub]);
      this.broadcast({ type: "presence", sub, online: true }, pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/members" && request.method === "POST") {
      let payload;
      try { payload = await request.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
      const members = Array.isArray(payload?.members) ? payload.members.slice(0, 100) : [];
      for (const member of members) {
        const memberSub = String(member?.sub || "").trim();
        if (!memberSub) continue;
        this.sql.exec(
          `INSERT INTO members (sub, name, avatar, joined_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(sub) DO UPDATE SET name=excluded.name, avatar=excluded.avatar`,
          memberSub, String(member?.name || "").slice(0, 80), member?.avatar || null, Date.now()
        );
      }
      return Response.json({ ok: true, members: this.listMembers() });
    }

    if (url.pathname === "/history" && request.method === "GET") {
      if (!sub || !(await this.isMember(sub, roomId))) return Response.json({ error: "forbidden" }, { status: 403 });
      const before = Number(url.searchParams.get("before") || 0) || 0;
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 40) || 40));
      const rows = before
        ? [...this.sql.exec(`SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?`, before, limit)]
        : [...this.sql.exec(`SELECT * FROM messages ORDER BY seq DESC LIMIT ?`, limit)];
      return Response.json({ messages: rows.reverse(), members: this.listMembers() });
    }

    if (url.pathname === "/info" && request.method === "GET") {
      return Response.json({ roomId, members: this.listMembers() });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async isMember(sub, roomId) {
    const row = this.sql.exec(`SELECT sub FROM members WHERE sub = ?`, sub).toArray()[0];
    if (row) return true;
    // Legacy/self-healing path for DM rooms: the room id itself encodes both subs.
    if (String(roomId).startsWith("dm:") && String(roomId).includes(sub)) return true;
    return false;
  }

  listMembers() {
    return [...this.sql.exec(`SELECT sub, name, avatar FROM members`)];
  }

  broadcast(message, except) {
    const payload = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(payload); } catch { /* dead socket, hibernation will clean it up */ }
    }
  }

  async webSocketMessage(ws, raw) {
    let data;
    try { data = JSON.parse(String(raw)); } catch { return; }
    const sub = ws.deserializeAttachment()?.sub || "";
    if (!sub) return;

    if (data?.type === "typing") {
      this.broadcast({ type: "typing", sub, name: this.memberName(sub) }, ws);
      return;
    }
    if (data?.type !== "message") return;
    const body = String(data.body || "").replace(/\u0000/g, "").slice(0, 4000);
    if (!body.trim()) return;
    const now = Date.now();
    const id = crypto.randomUUID();
    const name = this.memberName(sub);
    const avatar = this.memberAvatar(sub);
    let seq = 0;
    try {
      this.sql.exec(
        `INSERT INTO messages (id, sender, name, avatar, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, sub, name, avatar, body, "text", now
      );
      seq = Number(this.sql.exec(`SELECT seq FROM messages WHERE id = ?`, id).toArray()[0]?.seq || 0);
    } catch { return; }
    const message = { type: "message", id, seq, sender: sub, name, avatar, body, kind: "text", createdAt: now };
    this.broadcast(message);
    this.touchRoomIndex(sub, message);
  }

  webSocketClose(ws) {
    const sub = ws.deserializeAttachment()?.sub || "";
    if (sub) this.broadcast({ type: "presence", sub, online: false }, ws);
  }

  webSocketError(_ws) { /* nothing to do; hibernation handles cleanup */ }

  memberName(sub) {
    return String(this.sql.exec(`SELECT name FROM members WHERE sub = ?`, sub).toArray()[0]?.name || "Игрок");
  }

  memberAvatar(sub) {
    return this.sql.exec(`SELECT avatar FROM members WHERE sub = ?`, sub).toArray()[0]?.avatar || null;
  }

  // Keep the per-user room list fresh so the chat list can show last messages
  // without querying every Durable Object on every page load.
  touchRoomIndex(senderSub, message) {
    try {
      const members = this.listMembers().map(row => row.sub);
      if (!members.includes(senderSub)) members.push(senderSub);
      for (const sub of members) {
        const raw = this.env.OAUTH_KV.get("chat:rooms:" + sub);
        Promise.resolve(raw).then(value => {
          let rooms = [];
          try { rooms = value ? JSON.parse(value) : []; } catch { rooms = []; }
          const roomId = String(this.state.id?.toString?.() || "");
          let found = false;
          for (const room of rooms) {
            if (room.id !== roomId) continue;
            found = true;
            room.last = { body: message.body.slice(0, 120), name: message.name, createdAt: message.createdAt };
            room.updatedAt = message.createdAt;
            break;
          }
          if (found) this.env.OAUTH_KV.put("chat:rooms:" + sub, JSON.stringify(rooms));
        }).catch(() => {});
      }
    } catch { /* KV indexes are an optimisation, never critical */ }
  }
}
