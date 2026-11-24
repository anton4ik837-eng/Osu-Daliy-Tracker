// Minimal SignalR JSON-protocol client for osu!'s referee hub.
// Used to create/manage lazer multiplayer rooms without opening the game client.
const HUB = 'https://spectator.ppy.sh';
const RS = '\u001e'; // SignalR record separator

async function negotiate(accessToken) {
  const response = await fetch(HUB + '/referee/negotiate?negotiateVersion=1', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error('referee_negotiate_http_' + response.status);
  const data = await response.json();
  const token = data.connectionToken || data.connectionId;
  if (!token) throw new Error('referee_negotiate_no_token');
  return token;
}

function waitForMessage(ws, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('referee_timeout')); }, timeoutMs);
    const onMessage = (event) => {
      buffer += String(event.data || '');
      let index;
      while ((index = buffer.indexOf(RS)) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!raw) continue;
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        if (predicate(message)) { cleanup(); resolve(message); return; }
      }
    };
    const onError = () => { cleanup(); reject(new Error('referee_ws_error')); };
    const onClose = () => { cleanup(); reject(new Error('referee_ws_closed')); };
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    }
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}

export async function invokeReferee(accessToken, target, args = []) {
  const connectionToken = await negotiate(accessToken);
  const url = new URL(HUB + '/referee');
  url.searchParams.set('id', connectionToken);
  // Browser-style auth: the official SignalR client passes the token in the query string.
  url.searchParams.set('access_token', accessToken);
  const ws = new WebSocket(url.toString());
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('referee_ws_open_timeout')), 20000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('referee_ws_open_error')); }, { once: true });
    });

    const handshake = waitForMessage(ws, message => !message.type);
    ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
    await handshake;

    const invocationId = '1';
    const completion = waitForMessage(ws, message => message.type === 3 && message.invocationId === invocationId);
    ws.send(JSON.stringify({ type: 1, invocationId, target, arguments: args }) + RS);
    const result = await completion;
    if (result.error) throw new Error(String(result.error).slice(0, 300));
    return result.result;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

export async function makeRoom(accessToken, { name, beatmapId, rulesetId = 3, maxParticipants = 2 }) {
  return invokeReferee(accessToken, 'MakeRoom', [{
    ruleset_id: Number(rulesetId) || 3,
    beatmap_id: Number(beatmapId) || 0,
    name: String(name || 'Coop').slice(0, 80),
    type: 0,          // HeadToHead
    queue_mode: 0,    // HostOnly
    max_participants: Math.max(0, Math.min(50, Number(maxParticipants) || 0)),
  }]);
}

export async function invitePlayer(accessToken, roomId, userId) {
  return invokeReferee(accessToken, 'InvitePlayer', [Number(roomId), Number(userId)]);
}
