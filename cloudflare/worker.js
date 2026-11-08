const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, max-age=0", ...cors }
  });
}

function publicJson(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=20, s-maxage=20", ...cors }
  });
}

async function cachedPublicJson(request, loader) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = publicJson(await loader());
  await cache.put(key, response.clone());
  return response;
}

// D1 schema checks/migrations run once per Worker isolate instead of on every
// telemetry event and dashboard poll. A failed initialization can be retried.
// One Worker isolate serves one deployment environment and its D1 binding.
// Cache each schema initializer by name for the lifetime of the isolate.
const schemaInitialization = new Map();
function ensureOnce(key, initialize) {
  if (!schemaInitialization.has(key)) {
    const pending = Promise.resolve().then(initialize).catch(error => {
      schemaInitialization.delete(key);
      throw error;
    });
    schemaInitialization.set(key, pending);
  }
  return schemaInitialization.get(key);
}

async function ensureSchema(db) {
  return ensureOnce("training-telemetry", async () => {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS training_runs (
        run_id TEXT NOT NULL, run_attempt INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        started_at TEXT, updated_at TEXT NOT NULL, run_url TEXT, cycle INTEGER, trial INTEGER,
        epoch INTEGER NOT NULL DEFAULT 0, total_epochs INTEGER, best_epoch INTEGER, train_loss REAL,
        validation_loss REAL, replay_count INTEGER, segment_count INTEGER, warm_started INTEGER,
        player_disjoint INTEGER, payload TEXT, PRIMARY KEY (run_id, run_attempt)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS training_epochs (
        run_id TEXT NOT NULL, run_attempt INTEGER NOT NULL, trial INTEGER NOT NULL, epoch INTEGER NOT NULL,
        train_loss REAL, validation_loss REAL, created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, run_attempt, trial, epoch)
      )`)
    ]);
  });
}
async function readTelemetry(db) {
  await ensureSchema(db);
  const current = await db.prepare(
    "SELECT * FROM training_runs ORDER BY updated_at DESC LIMIT 1"
  ).first();
  if (!current) {
    return { schema_version: 1, status: "idle", generated_at: new Date().toISOString(),
      training_cycles: 0, comparison_due_at: 7, latest: null, history: [],
      note: "Live telemetry endpoint is ready. Waiting for the next training run." };
  }

  const epochs = await db.prepare(`
    SELECT e.run_id, e.trial, e.epoch, e.train_loss, e.validation_loss, r.cycle
    FROM training_epochs e
    LEFT JOIN training_runs r ON r.run_id = e.run_id AND r.run_attempt = e.run_attempt
    WHERE e.run_id IN (
      SELECT run_id FROM training_runs ORDER BY updated_at DESC LIMIT 5
    )
    AND e.trial = COALESCE(r.trial, 1)
    ORDER BY r.cycle ASC, e.epoch ASC
  `).all();

  const historyResult = await db.prepare(
    "SELECT run_id, run_attempt, status, started_at, updated_at, cycle, replay_count, segment_count, warm_started, validation_loss FROM training_runs ORDER BY updated_at DESC LIMIT 50"
  ).all();

  const payload = current.payload ? JSON.parse(current.payload) : {};
  const latest = {
    ...payload,
    run_id: current.run_id,
    run_attempt: current.run_attempt,
    run_url: current.run_url,
    started_at: current.started_at,
    finished_at: payload.finished_at || (current.status === "trained" ? current.updated_at : null),
    cycle: current.cycle,
    epoch: current.epoch,
    total_epochs: current.total_epochs,
    best_epoch: current.best_epoch,
    train_loss: current.train_loss,
    validation_loss: current.validation_loss,
    replay_count: current.replay_count,
    segment_count: current.segment_count,
    warm_started: current.warm_started === null ? null : Boolean(current.warm_started),
    player_disjoint: current.player_disjoint === null ? null : Boolean(current.player_disjoint),
    epoch_history: (epochs.results || []).map(row => ({
      run_id: row.run_id, cycle: row.cycle, trial: row.trial,
      epoch: row.epoch, train_loss: row.train_loss, validation_loss: row.validation_loss
    })),
    status: current.status
  };

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    status: current.status,
    training_cycles: current.cycle || 0,
    comparison_due_at: 7,
    latest,
    history: (historyResult.results || []).map(row => ({
      run_id: row.run_id, run_attempt: row.run_attempt, cycle: row.cycle,
      started_at: row.started_at, finished_at: row.updated_at,
      replay_count: row.replay_count, segment_count: row.segment_count,
      warm_started: row.warm_started === null ? null : Boolean(row.warm_started),
      validation_loss: row.validation_loss, status: row.status
    })),
    note: "Live epoch telemetry from the replay training workflow. No replay files, player identifiers, or model weights are stored."
  };
}

async function readWorkflowSnapshot(db) {
  await ensureOnce("workflow-snapshot", () => db.prepare(`CREATE TABLE IF NOT EXISTS workflow_snapshots (
    run_id TEXT NOT NULL, run_attempt INTEGER NOT NULL, status TEXT NOT NULL,
    conclusion TEXT, run_url TEXT, run_number INTEGER, updated_at TEXT NOT NULL,
    jobs_json TEXT NOT NULL, PRIMARY KEY (run_id, run_attempt)
  )`).run());
  const row = await db.prepare("SELECT * FROM workflow_snapshots ORDER BY updated_at DESC LIMIT 1").first();
  if (!row) return { status: "unknown", latest: null, generated_at: new Date().toISOString() };
  let jobs = [];
  try { jobs = JSON.parse(row.jobs_json || "[]"); } catch {}
  return { status: row.status, latest: { run_id: row.run_id, run_attempt: row.run_attempt,
    conclusion: row.conclusion, run_url: row.run_url, run_number: row.run_number,
    updated_at: row.updated_at, jobs }, generated_at: new Date().toISOString() };
}
async function ingestWorkflowSnapshot(request, env) {
  if (!env.INGEST_TOKEN) return json({ error: "INGEST_TOKEN secret is not configured." }, 503);
  if ((request.headers.get("Authorization") || "") !== `Bearer ${env.INGEST_TOKEN}`)
    return json({ error: "Unauthorized" }, 401);
  if (!env.DB) return json({ error: "D1 binding DB is not configured." }, 503);
  const data = await request.json();
  const runId = String(data.run_id || "");
  const attempt = Number(data.run_attempt || 1);
  if (!runId || !Number.isInteger(attempt) || attempt < 1 || !Array.isArray(data.jobs))
    return json({ error: "Invalid workflow snapshot." }, 400);
  if (data.jobs.length > 100) return json({ error: "Too many jobs." }, 400);
  const jobs = data.jobs.map(job => ({
    name: String(job.name || "Unnamed job").slice(0, 180),
    status: String(job.status || "unknown").slice(0, 32),
    conclusion: job.conclusion ? String(job.conclusion).slice(0, 32) : null,
    steps: Array.isArray(job.steps) ? job.steps.slice(0, 200).map(step => ({
      name: String(step.name || "Unnamed step").slice(0, 220),
      status: String(step.status || "unknown").slice(0, 32),
      conclusion: step.conclusion ? String(step.conclusion).slice(0, 32) : null
    })) : []
  }));
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workflow_snapshots (
    run_id TEXT NOT NULL, run_attempt INTEGER NOT NULL, status TEXT NOT NULL,
    conclusion TEXT, run_url TEXT, run_number INTEGER, updated_at TEXT NOT NULL,
    jobs_json TEXT NOT NULL, PRIMARY KEY (run_id, run_attempt)
  )`).run();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO workflow_snapshots
    (run_id, run_attempt, status, conclusion, run_url, run_number, updated_at, jobs_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, run_attempt) DO UPDATE SET status=excluded.status,
    conclusion=excluded.conclusion, run_url=excluded.run_url, run_number=excluded.run_number,
    updated_at=excluded.updated_at, jobs_json=excluded.jobs_json`)
    .bind(runId, attempt, String(data.status || "completed"), data.conclusion || null,
      data.run_url || null, Number(data.run_number || 0), now, JSON.stringify(jobs)).run();
  return json({ ok: true, run_id: runId, jobs: jobs.length });
}

async function ingest(request, env, trustedDevice = false) {
  if (!trustedDevice) {
    if (!env.INGEST_TOKEN) return json({ error: "INGEST_TOKEN secret is not configured." }, 503);
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${env.INGEST_TOKEN}`) return json({ error: "Unauthorized" }, 401);
  }

  let data;
  try { data = await request.json(); }
  catch { return json({ error: "Request body must be valid JSON." }, 400); }

  const runId = String(data.run_id || "");
  const attempt = Number(data.run_attempt || 1);
  const event = String(data.event || "");
  if (!runId || !Number.isInteger(attempt) || attempt < 1 ||
      !["started", "epoch", "completed", "failed"].includes(event)) {
    return json({ error: "Invalid run_id, run_attempt, or event." }, 400);
  }

  if (!env.DB) return json({ error: "D1 binding DB is not configured." }, 503);

  await ensureSchema(env.DB);
  const previous = await env.DB.prepare(
    "SELECT * FROM training_runs WHERE run_id = ? AND run_attempt = ?"
  ).bind(runId, attempt).first();

  const now = data.timestamp || new Date().toISOString();
  const status = event === "started" ? "in_progress" :
    event === "completed" ? "trained" : event === "failed" ? "failure" : "in_progress";
  const trial = Number(data.trial || previous?.trial || 1);
  const epoch = Number(data.epoch || previous?.epoch || 0);
  const payload = { ...(previous?.payload ? JSON.parse(previous.payload) : {}), ...data };
  const boolInt = value => value === undefined || value === null ? null : (value ? 1 : 0);

  await env.DB.prepare(`INSERT INTO training_runs
    (run_id, run_attempt, status, started_at, updated_at, run_url, cycle, trial, epoch,
     total_epochs, best_epoch, train_loss, validation_loss, replay_count, segment_count,
     warm_started, player_disjoint, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, run_attempt) DO UPDATE SET
      status=excluded.status, started_at=COALESCE(excluded.started_at, training_runs.started_at),
      updated_at=excluded.updated_at,
      run_url=COALESCE(excluded.run_url, training_runs.run_url),
      cycle=COALESCE(excluded.cycle, training_runs.cycle),
      trial=excluded.trial, epoch=MAX(training_runs.epoch, excluded.epoch),
      total_epochs=COALESCE(excluded.total_epochs, training_runs.total_epochs),
      best_epoch=COALESCE(excluded.best_epoch, training_runs.best_epoch),
      train_loss=COALESCE(excluded.train_loss, training_runs.train_loss),
      validation_loss=COALESCE(excluded.validation_loss, training_runs.validation_loss),
      replay_count=COALESCE(excluded.replay_count, training_runs.replay_count),
      segment_count=COALESCE(excluded.segment_count, training_runs.segment_count),
      warm_started=COALESCE(excluded.warm_started, training_runs.warm_started),
      player_disjoint=COALESCE(excluded.player_disjoint, training_runs.player_disjoint),
      payload=excluded.payload`)
    .bind(runId, attempt, status, data.started_at || previous?.started_at || now, now,
      data.run_url || previous?.run_url || null, data.cycle ?? previous?.cycle ?? null,
      trial, epoch, data.total_epochs ?? previous?.total_epochs ?? null,
      data.best_epoch ?? previous?.best_epoch ?? null, data.train_loss ?? previous?.train_loss ?? null,
      data.validation_loss ?? previous?.validation_loss ?? null,
      data.replay_count ?? previous?.replay_count ?? null,
      data.segment_count ?? previous?.segment_count ?? null,
      boolInt(data.warm_started) ?? previous?.warm_started ?? null,
      boolInt(data.player_disjoint) ?? previous?.player_disjoint ?? null,
      JSON.stringify(payload)).run();

  if (event === "epoch" && Number.isInteger(Number(data.epoch)) &&
      Number.isFinite(Number(data.train_loss)) && Number.isFinite(Number(data.validation_loss))) {
    await env.DB.prepare(`INSERT INTO training_epochs
      (run_id, run_attempt, trial, epoch, train_loss, validation_loss, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, run_attempt, trial, epoch) DO UPDATE SET
        train_loss=excluded.train_loss, validation_loss=excluded.validation_loss,
        created_at=excluded.created_at`)
      .bind(runId, attempt, trial, Number(data.epoch), Number(data.train_loss),
        Number(data.validation_loss), now).run();
  }

  // Backfill epoch rows from the aggregate payload published after training.
  if (Array.isArray(data.epoch_history)) {
    const statements = data.epoch_history.filter(row => Number.isInteger(Number(row.epoch)) &&
      Number.isFinite(Number(row.train_loss)) && Number.isFinite(Number(row.validation_loss))).slice(0, 1000)
      .map(row => env.DB.prepare(`INSERT INTO training_epochs
        (run_id, run_attempt, trial, epoch, train_loss, validation_loss, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, run_attempt, trial, epoch) DO UPDATE SET
          train_loss=excluded.train_loss, validation_loss=excluded.validation_loss,
          created_at=excluded.created_at`)
        .bind(runId, attempt, Number(data.trial || 1), Number(row.epoch),
          Number(row.train_loss), Number(row.validation_loss), now));
    if (statements.length) await env.DB.batch(statements);
  }
  return json({ ok: true, event, run_id: runId, run_attempt: attempt });
}


const APP_ORIGIN = "https://anton4ik837-eng.github.io";
const TRACKER_URL = APP_ORIGIN + "/Osu-Daliy-Tracker/training.html";
const OWNER = "anton4ik837-eng";
const DATA_REPO = "anton4ik837-eng/Osu-Daliy-Tracker";
const TRAINING_REPO = "anton4ik837-eng/Osu-Daliy-Tracker";
const TRAINING_WORKFLOW = "replay-model-training.yml";
const COLLECTOR_WORKFLOW = "server-replay-collector.yml";

function b64url(bytes) {
  let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
async function issueSession(login, secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({login, exp:Math.floor(Date.now()/1000)+3600})));
  const sig = b64url(await hmac(secret, payload));
  return payload + "." + sig;
}
async function readSession(request, secret) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = await hmac(secret, parts[0]);
  const actual = fromB64url(parts[1]);
  if (expected.length !== actual.length || !crypto.subtle) return null;
  let ok = false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["verify"]);
  ok = await crypto.subtle.verify("HMAC", key, actual, new TextEncoder().encode(parts[0]));
  if (!ok) return null;
  try { const p=JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))); return p.exp > Date.now()/1000 ? p : null; } catch { return null; }
}
async function oauthStart(env) {
  if (!env.GITHUB_CLIENT_ID) return json({error:"GITHUB_CLIENT_ID is not configured"},503);
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", "https://osu-ai-training-telemetry.anton4ik837.workers.dev/auth/github/callback");
  url.searchParams.set("state", state);
  const headers = new Headers({Location:url.toString(),"Cache-Control":"no-store"});
  headers.append("Set-Cookie", "osu_oauth_state="+state+"; HttpOnly; Secure; SameSite=Lax; Path=/auth/github/callback; Max-Age=600");
  return new Response(null,{status:302,headers});
}
async function oauthCallback(request, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.DB) return new Response("GitHub OAuth is not configured.",{status:503});
  const url=new URL(request.url), state=url.searchParams.get("state")||"", code=url.searchParams.get("code")||"";
  const cookie=(request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("osu_oauth_state="))?.slice(16)||"";
  const clear="osu_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/auth/github/callback; Max-Age=0";
  if (!state || state!==cookie || !code) return new Response("OAuth state validation failed.",{status:400,headers:{"Set-Cookie":clear}});
  const exchange=await fetch("https://github.com/login/oauth/access_token",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code})});
  const tokenData=await exchange.json();
  if (!exchange.ok || !tokenData.access_token) return new Response("GitHub OAuth exchange failed.",{status:502,headers:{"Set-Cookie":clear}});
  const profileResponse=await fetch("https://api.github.com/user",{headers:{Authorization:"Bearer "+tokenData.access_token,Accept:"application/vnd.github+json","User-Agent":"Osu-AI-Training-Panel"}});
  const profile=await profileResponse.json();
  if (!profileResponse.ok || !profile.login) return new Response("Could not verify GitHub identity.",{status:502,headers:{"Set-Cookie":clear}});
  const ticket=b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash=b64url(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(ticket)));
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS oauth_tickets (ticket_hash TEXT PRIMARY KEY, login TEXT NOT NULL, expires_at INTEGER NOT NULL)").run();
  await env.DB.prepare("INSERT INTO oauth_tickets(ticket_hash,login,expires_at) VALUES(?,?,?)").bind(hash,profile.login,Math.floor(Date.now()/1000)+180).run();
  return new Response(null,{status:302,headers:{"Location":TRACKER_URL+"?auth_ticket="+encodeURIComponent(ticket),"Cache-Control":"no-store","Set-Cookie":clear}});
}
async function exchangeTicket(request, env) {
  if (!env.DB || !env.SESSION_SECRET) return json({error:"Authentication storage is not configured."},503);
  let body; try {body=await request.json()} catch {return json({error:"Invalid JSON"},400)}
  const ticket=String(body.ticket||"");
  if (ticket.length<30 || ticket.length>200) return json({error:"Invalid ticket"},400);
  const hash=b64url(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(ticket)));
  const row=await env.DB.prepare("SELECT login,expires_at FROM oauth_tickets WHERE ticket_hash=?").bind(hash).first();
  await env.DB.prepare("DELETE FROM oauth_tickets WHERE ticket_hash=?").bind(hash).run();
  if (!row || row.expires_at<Math.floor(Date.now()/1000)) return json({error:"Login ticket expired"},401);
  const session=await issueSession(row.login,env.SESSION_SECRET);
  return json({login:row.login,is_admin:row.login.toLowerCase()===OWNER,session,expires_in:3600});
}
async function authMe(request,env) {
  if (!env.SESSION_SECRET) return json({authenticated:false},200);
  const s=await readSession(request,env.SESSION_SECRET);
  return json(s?{authenticated:true,login:s.login,is_admin:s.login.toLowerCase()===OWNER}:{authenticated:false},s?200:401);
}
async function requireAdmin(request, env) {
  if (!env.SESSION_SECRET) return { error: json({error:"SESSION_SECRET is not configured"},503) };
  const session = await readSession(request, env.SESSION_SECRET);
  if (!session || session.login.toLowerCase() !== OWNER)
    return { error: json({error:"Admin access required"},403) };
  return { session };
}
async function dispatchCoachVideoAnalysis(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  if (!env.GITHUB_ACTIONS_TOKEN)
    return json({ error: "GITHUB_ACTIONS_TOKEN is not configured." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const videoUrl = String(body.video_url || "").trim();
  if (body.usage_permission_confirmed !== true)
    return json({ error: "Подтверди, что видео принадлежит тебе или автор явно разрешил использовать его для ML-обучения." }, 400);
  let parsed;
  try { parsed = new URL(videoUrl); } catch { return json({ error: "Укажи корректную ссылку YouTube." }, 400); }
  const host = (parsed.hostname || "").toLowerCase();
  const allowed = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"];
  const parts = parsed.pathname.split("/").filter(Boolean);
  const videoId = host.endsWith("youtu.be") ? parts[0] :
    parsed.pathname === "/watch" ? parsed.searchParams.get("v") :
    ["shorts", "embed", "live"].includes(parts[0]) ? parts[1] : null;
  if (parsed.protocol !== "https:" || !allowed.includes(host) || !/^[A-Za-z0-9_-]{11}$/.test(videoId || ""))
    return json({ error: "Поддерживаются только публичные YouTube-ссылки." }, 400);
  const videoWorkflowRepo = "anton4ik837-eng/Osu-Daliy-Tracker";
  const response = await fetch("https://api.github.com/repos/" + videoWorkflowRepo +
    "/actions/workflows/coach-video-knowledge.yml/dispatches", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.GITHUB_ACTIONS_TOKEN,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "Osu-AI-Coach-Video-Analyzer"
      },
      body: JSON.stringify({ ref: "main", inputs: { video_url: videoUrl, usage_permission_confirmed: "true" } })
    });
  if (response.status !== 204) {
    const detail = (await response.text()).slice(0, 300);
    return json({ error: "Не удалось поставить анализ в очередь.", detail }, 502);
  }
  return json({ ok: true, status: "queued", video_id: videoId,
    message: "Видео отправлено в бесплатный GitHub Actions runner публичного репозитория. Предложение будет сохранено в приватный датасет после анализа." }, 202);
}

async function ensureNightSchedule(db) {
  return ensureOnce("night-training-schedule", async () => {
    await db.prepare(`CREATE TABLE IF NOT EXISTS night_training_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0,
      start_time TEXT NOT NULL DEFAULT '23:00', end_time TEXT NOT NULL DEFAULT '07:00',
      timezone TEXT NOT NULL DEFAULT 'Asia/Almaty', night_epochs INTEGER NOT NULL DEFAULT 400,
      night_patience INTEGER NOT NULL DEFAULT 40, night_trials INTEGER NOT NULL DEFAULT 3,
      night_learning_rate REAL NOT NULL DEFAULT 0.00025, night_hidden_units INTEGER NOT NULL DEFAULT 64,
      last_window_date TEXT, last_dispatch_at TEXT, last_run_id TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    )`).run();
    for (const sql of [
      "ALTER TABLE night_training_schedule ADD COLUMN night_epochs INTEGER NOT NULL DEFAULT 400",
      "ALTER TABLE night_training_schedule ADD COLUMN night_patience INTEGER NOT NULL DEFAULT 40",
      "ALTER TABLE night_training_schedule ADD COLUMN night_trials INTEGER NOT NULL DEFAULT 3",
      "ALTER TABLE night_training_schedule ADD COLUMN night_learning_rate REAL NOT NULL DEFAULT 0.00025",
      "ALTER TABLE night_training_schedule ADD COLUMN night_hidden_units INTEGER NOT NULL DEFAULT 32"
    ]) {
      try { await db.prepare(sql).run(); }
      catch (error) { if (!String(error).toLowerCase().includes("duplicate column")) throw error; }
    }
    await db.prepare(`INSERT OR IGNORE INTO night_training_schedule
      (id, enabled, start_time, end_time, timezone, night_epochs, night_patience, night_trials, night_learning_rate, night_hidden_units, updated_at)
      VALUES (1,0,'23:00','07:00','Asia/Almaty',400,40,3,0.00025,64,?)`)
      .bind(new Date().toISOString()).run();
  });
}
async function getNightSchedule(db) {
  await ensureNightSchedule(db);
  const row = await db.prepare("SELECT enabled,start_time,end_time,timezone,night_epochs,night_patience,night_trials,night_learning_rate,night_hidden_units,last_window_date,last_dispatch_at,last_run_id,updated_at FROM night_training_schedule WHERE id=1").first();
  return {...row, enabled:Boolean(row.enabled)};
}
function validClock(value) { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
async function adminNightSchedule(request, env, save=false) {
  const auth = await requireAdmin(request,env);
  if (auth.error) return auth.error;
  if (!env.DB) return json({error:"D1 binding DB is not configured"},503);
  await ensureNightSchedule(env.DB);
  if (!save) return json({ok:true,schedule:await getNightSchedule(env.DB)});
  let body; try { body=await request.json(); } catch { return json({error:"Invalid JSON"},400); }
  const enabled=body.enabled===true;
  const start=String(body.start_time||""), end=String(body.end_time||"");
  const epochs=Number(body.night_epochs), patience=Number(body.night_patience), trials=Number(body.night_trials), learningRate=Number(body.night_learning_rate), hiddenUnits=Number(body.night_hidden_units);
  if (!validClock(start)||!validClock(end)||start===end)
    return json({error:"Укажи корректное время начала и окончания; они не должны совпадать."},400);
  if (!Number.isInteger(epochs)||epochs<50||epochs>400||
      !Number.isInteger(patience)||patience<0||patience>50||
      !Number.isInteger(trials)||trials<1||trials>5||
      !Number.isFinite(learningRate)||learningRate<0.00001||learningRate>0.005||(!Number.isInteger(hiddenUnits)||hiddenUnits<16||hiddenUnits>512))
    return json({error:"Параметры ночного обучения: эпохи 50–400, patience 0–50 (0 = отключён), trials 1–5, LR 0.00001–0.005."},400);
  await env.DB.prepare(`UPDATE night_training_schedule SET enabled=?,start_time=?,end_time=?,
    night_epochs=?,night_patience=?,night_trials=?,night_learning_rate=?,night_hidden_units=?,timezone='Asia/Almaty',updated_at=? WHERE id=1`)
    .bind(enabled?1:0,start,end,epochs,patience,trials,learningRate,hiddenUnits,new Date().toISOString()).run();
  return json({ok:true,schedule:await getNightSchedule(env.DB)});
}
async function ensureCollectorSchedule(db) {
  return ensureOnce("collector-schedule", async () => {
    await db.prepare(`CREATE TABLE IF NOT EXISTS replay_collector_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1), last_slot TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0, last_dispatch_at TEXT, updated_at TEXT NOT NULL
    )`).run();
    await db.prepare("INSERT OR IGNORE INTO replay_collector_schedule (id,updated_at) VALUES (1,?)")
      .bind(new Date().toISOString()).run();
  });
}
async function githubCollectorWorkflowRuns(env) {
  const response=await fetch("https://api.github.com/repos/"+DATA_REPO+"/actions/workflows/"+COLLECTOR_WORKFLOW+"/runs?per_page=20",{
    headers:{Authorization:"Bearer "+env.GITHUB_ACTIONS_TOKEN,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"Osu-Replay-Collector-Scheduler"}
  });
  if(!response.ok) throw new Error("GitHub collector status query failed: HTTP "+response.status);
  const data=await response.json();
  return data.workflow_runs||[];
}
async function dispatchReplayCollector(env) {
  const response=await fetch("https://api.github.com/repos/"+DATA_REPO+"/actions/workflows/"+COLLECTOR_WORKFLOW+"/dispatches",{
    method:"POST",headers:{Authorization:"Bearer "+env.GITHUB_ACTIONS_TOKEN,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json","User-Agent":"Osu-Replay-Collector-Scheduler"},
    body:JSON.stringify({ref:"main",inputs:{dry_run:"false"}})
  });
  if(response.status!==204) throw new Error("Replay collector dispatch failed: HTTP "+response.status+" "+(await response.text()).slice(0,300));
}
// Automatic collector schedule: six-hour UTC windows.
async function runReplayCollectorScheduler(env) {
  if (!env.DB || !env.GITHUB_ACTIONS_TOKEN) return;
  await ensureCollectorSchedule(env.DB);
  const now=Date.now(), iso=new Date(now).toISOString();
  const lock=await env.DB.prepare("UPDATE replay_collector_schedule SET lease_until=? WHERE id=1 AND lease_until<?")
    .bind(now+50000,now).run();
  if (!lock.meta?.changes) return;
  try {
    // One collection window every six hours (UTC): 00:00, 06:00, 12:00, 18:00.
    // The first scheduled tick after deployment may start the current window.
    const d=new Date(now);
    d.setUTCHours(Math.floor(d.getUTCHours()/6)*6,0,0,0);
    const slot=d.toISOString().slice(0,16);
    const state=await env.DB.prepare("SELECT last_slot FROM replay_collector_schedule WHERE id=1").first();
    if (state?.last_slot===slot) return;
    const runs=await githubCollectorWorkflowRuns(env);
    const active=runs.find(run=>run.status==="queued"||run.status==="in_progress");
    if (active) return;
    await dispatchReplayCollector(env);
    await env.DB.prepare("UPDATE replay_collector_schedule SET last_slot=?,last_dispatch_at=?,updated_at=? WHERE id=1")
      .bind(slot,iso,iso).run();
  } finally {
    await env.DB.prepare("UPDATE replay_collector_schedule SET lease_until=0 WHERE id=1").run();
  }
}
function localClockParts(date, timezone) {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return {date:p.year+"-"+p.month+"-"+p.day,clock:p.hour+":"+p.minute};
}
function inWindow(clock,start,end) {
  return start<end ? clock>=start&&clock<end : clock>=start||clock<end;
}

async function ensureLocalTrainingTables(db) {
  return ensureOnce("local-training-tables", async () => {
    await db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS local_training_devices (device_id TEXT PRIMARY KEY, login TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS local_training_jobs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, config_json TEXT NOT NULL, device_id TEXT, stop_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL, finished_at TEXT, last_error TEXT)")
    ]);
  });
}
async function issueDeviceToken(login, deviceId, secret) {
  const payload=b64url(new TextEncoder().encode(JSON.stringify({
    scope:"local-training-device",login,device_id:deviceId,
    exp:Math.floor(Date.now()/1000)+30*24*60*60
  })));
  return payload+"."+b64url(await hmac(secret,payload));
}
async function readDeviceToken(request,env) {
  if(!env.SESSION_SECRET) return null;
  const token=(request.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  const parts=token.split(".");
  if(parts.length!==2) return null;
  try {
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.SESSION_SECRET),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    const valid=await crypto.subtle.verify("HMAC",key,fromB64url(parts[1]),new TextEncoder().encode(parts[0]));
    if(!valid) return null;
    const p=JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    return p.scope==="local-training-device" && p.login?.toLowerCase()===OWNER &&
      p.exp>Date.now()/1000 && typeof p.device_id==="string" ? p : null;
  } catch { return null; }
}
async function deviceLocalTrainingPair(request,env) {
  if(!env.DB||!env.SESSION_SECRET) return json({error:"Device pairing storage is not configured."},503);
  const ghToken=(request.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  if(ghToken.length<20||ghToken.length>500) return json({error:"GitHub CLI authentication is required."},401);
  const profileResponse=await fetch("https://api.github.com/user",{
    headers:{Authorization:"Bearer "+ghToken,Accept:"application/vnd.github+json","User-Agent":"Osu-AI-Local-Trainer"}
  });
  if(!profileResponse.ok) return json({error:"GitHub identity verification failed."},401);
  const profile=await profileResponse.json();
  if(String(profile.login||"").toLowerCase()!==OWNER) return json({error:"Only the repository owner can pair a training device."},403);
  let body={};try{body=await request.json()}catch{}
  const deviceId=crypto.randomUUID(),label=String(body.label||"Termux tablet").slice(0,80);
  const now=new Date().toISOString();
  await ensureLocalTrainingTables(env.DB);
  await env.DB.prepare("INSERT INTO local_training_devices(device_id,login,label,created_at,last_seen) VALUES(?,?,?,?,?)")
    .bind(deviceId,profile.login,label,now,now).run();
  const token=await issueDeviceToken(profile.login,deviceId,env.SESSION_SECRET);
  return json({ok:true,device_id:deviceId,device_token:token,expires_in:30*24*60*60});
}
async function queueLocalTrainingJob(db,config,source="manual") {
  const runId="local-"+crypto.randomUUID();
  const now=new Date().toISOString();
  const payload={...config,source};
  await db.prepare("INSERT INTO local_training_jobs (run_id,status,config_json,stop_requested,created_at,updated_at) VALUES(?, 'queued', ?, 0, ?, ?)")
    .bind(runId,JSON.stringify(payload),now,now).run();
  return runId;
}
async function adminLocalTraining(request,env,action="status") {
  const auth=await requireAdmin(request,env);
  if(auth.error) return auth.error;
  if(!env.DB) return json({error:"D1 binding DB is not configured."},503);
  await ensureLocalTrainingTables(env.DB);
  const now=Date.now();
  if(action==="status") {
    const device=await env.DB.prepare("SELECT device_id,label,last_seen FROM local_training_devices ORDER BY last_seen DESC LIMIT 1").first();
    let job=await env.DB.prepare("SELECT run_id,status,config_json,device_id,created_at,started_at,updated_at,finished_at,last_error,stop_requested FROM local_training_jobs ORDER BY created_at DESC LIMIT 1").first();
    // A powered-off tablet cannot send a final event. Expire only a running job
    // whose own device has stopped heartbeating; queued jobs remain available.
    if(job?.status==="running") {
      const heartbeat=job.device_id
        ? await env.DB.prepare("SELECT last_seen FROM local_training_devices WHERE device_id=?").bind(job.device_id).first()
        : null;
      const heartbeatAt=Date.parse(heartbeat?.last_seen || job.updated_at || job.started_at || "");
      if(Number.isFinite(heartbeatAt) && now-heartbeatAt>90000) {
        const finished=new Date(now).toISOString();
        const reason="Потеряна связь с локальным агентом: heartbeat отсутствует более 90 секунд. Обучение помечено как прерванное; результаты candidate не подтверждены.";
        await env.DB.prepare("UPDATE local_training_jobs SET status='failed',finished_at=?,updated_at=?,last_error=? WHERE run_id=? AND status='running'")
          .bind(finished,finished,reason,job.run_id).run();
        job={...job,status:"failed",finished_at:finished,updated_at:finished,last_error:reason};
      }
    }
    let config=null;try{config=job?JSON.parse(job.config_json):null}catch{}
    return json({ok:true,device:device?{...device,online:now-new Date(device.last_seen).getTime()<45000}:null,
      job:job?{...job,config,stop_requested:Boolean(job.stop_requested)}:null,
      active:Boolean(job&&["queued","running"].includes(job.status))});
  }
  if(action==="queue") {
    let body;try{body=await request.json()}catch{return json({error:"Invalid JSON."},400)}
    const mode=String(body.training_mode||"continue"),epochs=Number(body.epochs),patience=Number(body.patience),trials=Number(body.trials),learningRate=Number(body.learning_rate),hiddenUnits=Number(body.hidden_units);
    if(!["continue","fresh"].includes(mode)||!Number.isInteger(epochs)||epochs<50||epochs>400||
      !Number.isInteger(patience)||patience<0||patience>50||!Number.isInteger(trials)||trials<1||trials>5||
      !Number.isFinite(learningRate)||learningRate<0.00001||learningRate>0.005||!Number.isInteger(hiddenUnits)||hiddenUnits<16||hiddenUnits>512)
      return json({error:"Invalid training settings. hidden_units must be an integer from 16 to 512; learning rate must be 0.00001–0.005."},400);
    const device=await env.DB.prepare("SELECT device_id,last_seen FROM local_training_devices ORDER BY last_seen DESC LIMIT 1").first();
    if(!device||now-new Date(device.last_seen).getTime()>=45000)
      return json({error:"Планшет не подключён. Запусти локальный агент обучения в Termux."},409);
    const active=await env.DB.prepare("SELECT run_id,status FROM local_training_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").first();
    if(active) return json({error:"Обучение уже запущено или ожидает планшет.",run_id:active.run_id,status:active.status},409);
    const runId=await queueLocalTrainingJob(env.DB,{training_mode:mode,epochs,patience,trials,learning_rate:learningRate,hidden_units:hiddenUnits},"manual");
    return json({ok:true,run_id:runId,status:"queued",executor:"local-tablet"});
  }
  if(action==="stop") {
    const job=await env.DB.prepare("SELECT run_id,status FROM local_training_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").first();
    if(!job) return json({ok:false,error:"Нет активного локального обучения."},404);
    if(job.status==="queued") {
      await env.DB.prepare("UPDATE local_training_jobs SET status='stopped',finished_at=?,updated_at=? WHERE run_id=? AND status='queued'")
        .bind(new Date().toISOString(),new Date().toISOString(),job.run_id).run();
    } else {
      await env.DB.prepare("UPDATE local_training_jobs SET stop_requested=1,updated_at=? WHERE run_id=?")
        .bind(new Date().toISOString(),job.run_id).run();
    }
    return json({ok:true,run_id:job.run_id,status:job.status==="queued"?"stopped":"stop_requested"});
  }
  return json({error:"Unknown local training action."},404);
}
async function deviceLocalTrainingNext(request,env) {
  const device=await readDeviceToken(request,env);
  if(!device) return json({error:"Invalid or expired device token."},401);
  if(!env.DB) return json({error:"D1 binding DB is not configured."},503);
  await ensureLocalTrainingTables(env.DB);
  const now=new Date().toISOString();
  await env.DB.prepare("UPDATE local_training_devices SET last_seen=? WHERE device_id=?").bind(now,device.device_id).run();
  const job=await env.DB.prepare("SELECT run_id,config_json FROM local_training_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").first();
  if(!job) return json({ok:true,job:null});
  const claimed=await env.DB.prepare("UPDATE local_training_jobs SET status='running',device_id=?,started_at=?,updated_at=? WHERE run_id=? AND status='queued'")
    .bind(device.device_id,now,now,job.run_id).run();
  if(!claimed.meta?.changes) return json({ok:true,job:null});
  let config={};try{config=JSON.parse(job.config_json)}catch{}
  return json({ok:true,job:{run_id:job.run_id,config}});
}
async function deviceLocalTrainingStop(request,env) {
  const device=await readDeviceToken(request,env);
  if(!device) return json({error:"Invalid or expired device token."},401);
  if(!env.DB) return json({error:"D1 binding DB is not configured."},503);
  const url=new URL(request.url),runId=String(url.searchParams.get("run_id")||"");
  await env.DB.prepare("UPDATE local_training_devices SET last_seen=? WHERE device_id=?")
    .bind(new Date().toISOString(),device.device_id).run();
  const row=await env.DB.prepare("SELECT stop_requested,status FROM local_training_jobs WHERE run_id=? AND device_id=?")
    .bind(runId,device.device_id).first();
  return json({ok:true,stop_requested:Boolean(row?.stop_requested)||row?.status==="stopped"});
}
async function deviceLocalTrainingEvent(request,env) {
  const device=await readDeviceToken(request,env);
  if(!device) return json({error:"Invalid or expired device token."},401);
  if(!env.DB) return json({error:"D1 binding DB is not configured."},503);
  let data;try{data=await request.json()}catch{return json({error:"Invalid JSON."},400)}
  const runId=String(data.run_id||"");
  if (runId.startsWith("local-")) data.run_url=null;
  const job=await env.DB.prepare("SELECT status FROM local_training_jobs WHERE run_id=? AND device_id=?")
    .bind(runId,device.device_id).first();
  if(!job) return json({error:"Training job not found for this device."},404);
  const event=String(data.event||"");
  if(!["started","epoch","completed","failed"].includes(event)) return json({error:"Invalid telemetry event."},400);
  const trustedRequest=new Request(request.url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  const ingested=await ingest(trustedRequest,env,true);
  if(!ingested.ok) return ingested;
  const jobStatus=data.job_status==="stopped"?"stopped":
    event==="completed"?"completed":event==="failed"?"failed":"running";
  const finished=["completed","failed","stopped"].includes(jobStatus)?new Date().toISOString():null;
  await env.DB.prepare("UPDATE local_training_jobs SET status=?,updated_at=?,finished_at=COALESCE(?,finished_at),last_error=COALESCE(?,last_error) WHERE run_id=? AND device_id=?")
    .bind(jobStatus,new Date().toISOString(),finished,data.error?String(data.error).slice(0,1000):null,runId,device.device_id).run();
  await env.DB.prepare("UPDATE local_training_devices SET last_seen=? WHERE device_id=?")
    .bind(new Date().toISOString(),device.device_id).run();
  return json({ok:true,event,job_status:jobStatus});
}


async function githubTrainingWorkflowRuns(env) {
  if (!env.GITHUB_ACTIONS_TOKEN) throw new Error("GITHUB_ACTIONS_TOKEN is not configured.");
  const response = await fetch("https://api.github.com/repos/" + TRAINING_REPO + "/actions/workflows/" + TRAINING_WORKFLOW + "/runs?per_page=20", {
    headers: { Authorization: "Bearer " + env.GITHUB_ACTIONS_TOKEN, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Osu-AI-Training-Control" }
  });
  if (!response.ok) throw new Error("GitHub training status query failed: HTTP " + response.status);
  return (await response.json()).workflow_runs || [];
}
async function dispatchGithubTrainingWorkflow(env, config) {
  const response = await fetch("https://api.github.com/repos/" + TRAINING_REPO + "/actions/workflows/" + TRAINING_WORKFLOW + "/dispatches", {
    method: "POST", headers: { Authorization: "Bearer " + env.GITHUB_ACTIONS_TOKEN, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "Osu-AI-Training-Control" },
    body: JSON.stringify({ ref: "main", inputs: {
      training_mode: String(config.training_mode || "continue"), epochs: String(config.epochs || 300),
      patience: String(config.patience == null ? 0 : config.patience), trials: String(config.trials || 2),
      learning_rate: String(config.learning_rate || 0.00025), hidden_units: String(config.hidden_units || 256)
    }})
  });
  if (response.status !== 204) throw new Error("GitHub dispatch failed: HTTP " + response.status + " " + (await response.text()).slice(0, 300));
}
async function adminGithubTrainingStatus(request, env) {
  const auth = await requireAdmin(request, env); if (auth.error) return auth.error;
  try {
    const runs = await githubTrainingWorkflowRuns(env);
    const active = runs.find(run => run.status === "queued" || run.status === "in_progress") || null;
    return json({ ok: true, active: Boolean(active), active_run: active, latest_run: runs[0] || null, workflow: TRAINING_WORKFLOW });
  } catch (error) { return json({ error: "Не удалось получить состояние GitHub Actions.", detail: String(error) }, 502); }
}
async function adminDispatchGithubTraining(request, env) {
  const auth = await requireAdmin(request, env); if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const mode = String(body.training_mode || "continue"), epochs = Number(body.epochs), patience = Number(body.patience);
  const trials = Number(body.trials), lr = Number(body.learning_rate), hidden = Number(body.hidden_units);
  if (!["continue", "fresh"].includes(mode) || !Number.isInteger(epochs) || epochs < 50 || epochs > 400 ||
      !Number.isInteger(patience) || patience < 0 || patience > 50 || !Number.isInteger(trials) || trials < 1 || trials > 5 ||
      !Number.isFinite(lr) || lr < 0.00001 || lr > 0.005 || ![32, 64, 128, 256, 512].includes(hidden))
    return json({ error: "Параметры обучения вне допустимого диапазона." }, 400);
  try {
    const runs = await githubTrainingWorkflowRuns(env);
    const active = runs.find(run => run.status === "queued" || run.status === "in_progress");
    if (active) return json({ error: "Обучение уже запущено или ожидает GitHub runner.", run_id: active.id, status: active.status }, 409);
    await dispatchGithubTrainingWorkflow(env, { training_mode: mode, epochs, patience, trials, learning_rate: lr, hidden_units: hidden });
    return json({ ok: true, status: "queued", executor: "github-actions", workflow: TRAINING_WORKFLOW }, 202);
  } catch (error) { return json({ error: "Не удалось запустить обучение.", detail: String(error) }, 502); }
}
async function adminCancelGithubTraining(request, env) {
  const auth = await requireAdmin(request, env); if (auth.error) return auth.error;
  try {
    const runs = await githubTrainingWorkflowRuns(env);
    const active = runs.find(run => run.status === "in_progress" || run.status === "queued");
    if (!active) return json({ error: "Нет активного запуска обучения." }, 404);
    const response = await fetch("https://api.github.com/repos/" + TRAINING_REPO + "/actions/runs/" + active.id + "/cancel", {
      method: "POST", headers: { Authorization: "Bearer " + env.GITHUB_ACTIONS_TOKEN, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Osu-AI-Training-Control" }
    });
    if (response.status !== 202) return json({ error: "GitHub не принял команду остановки.", detail: "HTTP " + response.status }, 502);
    return json({ ok: true, run_id: active.id, status: "cancel_requested" });
  } catch (error) { return json({ error: "Не удалось остановить обучение.", detail: String(error) }, 502); }
}

async function runNightScheduler(env) {
  if (!env.DB || !env.GITHUB_ACTIONS_TOKEN) return;
  await ensureNightSchedule(env.DB);
  const now = Date.now(), iso = new Date(now).toISOString();
  const lock = await env.DB.prepare("UPDATE night_training_schedule SET lease_until=? WHERE id=1 AND lease_until<?")
    .bind(now + 50000, now).run();
  if (!lock.meta?.changes) return;
  try {
    const cfg = await getNightSchedule(env.DB);
    if (!cfg.enabled) return;
    const local = localClockParts(new Date(now), cfg.timezone);
    if (!inWindow(local.clock, cfg.start_time, cfg.end_time)) return;
    const windowDate = cfg.start_time < cfg.end_time || local.clock >= cfg.start_time ? local.date :
      localClockParts(new Date(now - 86400000), cfg.timezone).date;
    if (cfg.last_window_date === windowDate) return;
    const runs = await githubTrainingWorkflowRuns(env);
    if (runs.some(run => run.status === "queued" || run.status === "in_progress")) return;
    await dispatchGithubTrainingWorkflow(env, {
      training_mode: "continue", epochs: cfg.night_epochs, patience: cfg.night_patience,
      trials: cfg.night_trials, learning_rate: cfg.night_learning_rate,
      hidden_units: cfg.night_hidden_units || 256
    });
    await env.DB.prepare("UPDATE night_training_schedule SET last_window_date=?,last_dispatch_at=?,last_run_id=NULL,updated_at=? WHERE id=1")
      .bind(windowDate, iso, iso).run();
  } finally {
    await env.DB.prepare("UPDATE night_training_schedule SET lease_until=0 WHERE id=1").run();
  }
}


export default {
  async scheduled(controller, env, ctx) { ctx.waitUntil((async()=>{ await runReplayCollectorScheduler(env); await runNightScheduler(env); })()); },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/auth/github/start") return oauthStart(env);
    if (request.method === "GET" && url.pathname === "/auth/github/callback") {
      try { return await oauthCallback(request,env); } catch(e) { return new Response("OAuth callback failed: "+String(e),{status:500}); }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/exchange") {
      try { return await exchangeTicket(request,env); } catch(e) { return json({error:"Ticket exchange failed"},500); }
    }
    if (request.method === "GET" && url.pathname === "/api/auth/me") return authMe(request,env);
    if (request.method === "GET" && url.pathname === "/api/admin/night-training") {
      try { return await adminNightSchedule(request,env,false); } catch(e) { return json({error:"Schedule read failed",detail:String(e)},500); }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/night-training") {
      try { return await adminNightSchedule(request,env,true); } catch(e) { return json({error:"Schedule save failed",detail:String(e)},500); }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/local-training")
      return adminLocalTraining(request,env,"status");
    if (request.method === "POST" && url.pathname === "/api/admin/local-training")
      return adminLocalTraining(request,env,"queue");
    if (request.method === "POST" && url.pathname === "/api/admin/local-training/stop")
      return adminLocalTraining(request,env,"stop");
    if (request.method === "POST" && url.pathname === "/api/admin/coach-video")
      return dispatchCoachVideoAnalysis(request,env);
    if (request.method === "POST" && url.pathname === "/api/device/local-training/pair")
      return deviceLocalTrainingPair(request,env);
    if (request.method === "GET" && url.pathname === "/api/device/local-training/next")
      return deviceLocalTrainingNext(request,env);
    if (request.method === "GET" && url.pathname === "/api/device/local-training/stop")
      return deviceLocalTrainingStop(request,env);
    if (request.method === "POST" && url.pathname === "/api/device/local-training/event")
      return deviceLocalTrainingEvent(request,env);
    if (request.method === "GET" && url.pathname === "/api/admin/training/status")
      return adminGithubTrainingStatus(request,env);
    if (request.method === "POST" && url.pathname === "/api/admin/training/dispatch")
      return adminDispatchGithubTraining(request,env);
    if (request.method === "POST" && url.pathname === "/api/admin/training/cancel")
      return adminCancelGithubTraining(request,env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "osu-ai-training-telemetry", database_bound: Boolean(env.DB),
        ingest_secret_configured: Boolean(env.INGEST_TOKEN) });
    }
    if (request.method === "GET" && url.pathname === "/api/workflow") {
      if (!env.DB) return json({ error: "D1 binding DB is not configured." }, 503);
      try { return await cachedPublicJson(request, () => readWorkflowSnapshot(env.DB)); }
      catch (error) { return json({ error: "Workflow snapshot read failed.", detail: String(error) }, 500); }
    }
    if (request.method === "POST" && url.pathname === "/api/workflow") {
      try {
        // This route is also used for live training events because the legacy
        // /api/telemetry path is blocked by the edge before reaching the Worker.
        const probe = await request.clone().json();
        if (["started", "epoch", "completed", "failed"].includes(String(probe.event || "")))
          return await ingest(request, env);
        return await ingestWorkflowSnapshot(request, env);
      } catch (error) {
        return json({ error: "Workflow/telemetry ingest failed.", detail: String(error) }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/telemetry") {
      if (!env.DB) return json({ error: "D1 binding DB is not configured." }, 503);
      try { return await cachedPublicJson(request, () => readTelemetry(env.DB)); }
      catch (error) { return json({ error: "Telemetry read failed.", detail: String(error) }, 500); }
    }
    if (request.method === "POST" && url.pathname === "/api/telemetry") {
      try { return await ingest(request, env); }
      catch (error) { return json({ error: "Telemetry ingest failed.", detail: String(error) }, 500); }
    }
    return json({ error: "Not found" }, 404);
  }
};
