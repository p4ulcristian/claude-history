// Claude History: indexes every Claude Code session under ~/.claude/projects
// into SQLite full-text search and serves a local browser UI for it.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const HOME = homedir();
const PROJECTS = join(HOME, ".claude/projects");
const DATA = join(process.env.XDG_DATA_HOME || join(HOME, ".local/share"), "claude-history");
const PORT = Number(process.env.PORT || 4470);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `claude-history.localhost:${PORT}`]);
// Bump to rebuild the index after a change to the schema or to what gets indexed.
const SCHEMA = "3";
const MAX_TEXT = 100_000;

mkdirSync(DATA, { recursive: true });
const db = new Database(join(DATA, "index.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
if (db.query("SELECT v FROM meta WHERE k = 'schema'").get()?.v !== SCHEMA) {
  db.exec("DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS fts;");
  db.query("INSERT OR REPLACE INTO meta VALUES ('schema', ?)").run(SCHEMA);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, path TEXT, mtime REAL, size INTEGER,
    cwd TEXT, grp TEXT, branch TEXT, title TEXT, first_prompt TEXT,
    started INTEGER, ended INTEGER, users INTEGER, msgs INTEGER, auto INTEGER);
  CREATE INDEX IF NOT EXISTS sessions_ended ON sessions (ended);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, uuid TEXT, role TEXT);
  CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5 (text, tokenize = 'unicode61 remove_diacritics 2');
`);

// ---------------------------------------------------------------- parsing

type Item = { k: "u" | "a" | "t" | "n"; u: string; ts: number; text: string; name?: string };

async function* lines(path: string) {
  const dec = new TextDecoder();
  let parts: string[] = [];
  for await (const chunk of Bun.file(path).stream()) {
    const s = dec.decode(chunk, { stream: true });
    let start = 0;
    let nl: number;
    while ((nl = s.indexOf("\n", start)) !== -1) {
      const seg = s.slice(start, nl);
      if (parts.length) {
        parts.push(seg);
        yield parts.join("");
        parts = [];
      } else yield seg;
      start = nl + 1;
    }
    if (start < s.length) parts.push(s.slice(start));
  }
  if (parts.length) yield parts.join("");
}

function cleanUser(s: string) {
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  if (/^\s*<local-command-(stdout|stderr|caveat)>/.test(s)) return "";
  const cmd = s.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) s = `${cmd[1]} ${s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? ""}`;
  s = s.trim();
  return s.startsWith("[Request interrupted") ? "" : s;
}

function toolBrief(input: any) {
  const v = input?.description ?? input?.command ?? input?.file_path ?? input?.pattern ?? input?.query ?? input?.skill ?? input?.prompt ?? input?.url ?? "";
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 200) : "";
}

// Folders that are one worktree per task collapse into their parent in the folder filter.
function group(cwd: string) {
  const parts = cwd.split("/");
  const i = parts.findIndex((p) => /worktrees$/.test(p));
  return i > 0 && i < parts.length - 1 ? parts.slice(0, i + 1).join("/") : cwd;
}

// Claude Code names a project folder after the launch directory, with every other character turned into "-".
const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

async function parseSession(path: string) {
  const dir = basename(dirname(path));
  let anyCwd = "";
  const items: Item[] = [];
  const m = { cwd: "", branch: "", title: "", firstPrompt: "", started: 0, ended: 0, users: 0, auto: 0 };
  let custom = "", ai = "", agent = "", summary = "";
  for await (const line of lines(path)) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    // A session can cd elsewhere (a scratchpad, a worktree); its folder is the one it was launched in.
    if (!m.cwd && typeof d.cwd === "string") {
      anyCwd ||= d.cwd;
      if (encode(d.cwd) === dir) m.cwd = d.cwd;
    }
    // Sessions started through the SDK (Iris, Otto, CI agents) rather than typed into a terminal.
    if (typeof d.entrypoint === "string" && d.entrypoint.startsWith("sdk")) m.auto = 1;
    const t = d.type;
    if (t === "ai-title") ai = d.aiTitle || ai;
    else if (t === "custom-title") custom = d.customTitle || d.title || custom;
    else if (t === "agent-name") agent = d.agentName || agent;
    else if (t === "summary") summary ||= d.summary || "";
    if ((t !== "user" && t !== "assistant") || d.isSidechain) continue;
    if (d.gitBranch && d.gitBranch !== "HEAD") m.branch = d.gitBranch;
    const ts = Date.parse(d.timestamp) || 0;
    const c = d.message?.content;
    const before = items.length;
    if (t === "user") {
      if (d.isMeta || d.origin?.kind === "task-notification") continue;
      const raw = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
      const text = cleanUser(raw).slice(0, MAX_TEXT);
      if (!text) continue;
      if (d.isCompactSummary) items.push({ k: "n", u: d.uuid, ts, text });
      else {
        items.push({ k: "u", u: d.uuid, ts, text });
        m.users++;
        if ((!m.firstPrompt || m.firstPrompt.startsWith("/")) && !(m.firstPrompt && text.startsWith("/"))) m.firstPrompt = text.slice(0, 400);
      }
    } else if (Array.isArray(c) && d.message?.model !== "<synthetic>") {
      for (const b of c) {
        if (b.type === "text" && b.text?.trim()) items.push({ k: "a", u: d.uuid, ts, text: b.text.slice(0, MAX_TEXT) });
        else if (b.type === "tool_use") items.push({ k: "t", u: d.uuid, ts, text: toolBrief(b.input), name: b.name });
      }
    }
    if (items.length > before && ts) {
      m.started ||= ts;
      m.ended = Math.max(m.ended, ts);
    }
  }
  m.cwd ||= anyCwd;
  m.title = custom || ai || agent || summary || m.firstPrompt.split("\n")[0].slice(0, 80);
  return { meta: m, items };
}

// ---------------------------------------------------------------- indexing

const q = {
  known: db.query("SELECT id, mtime, size FROM sessions"),
  delFts: db.query("DELETE FROM fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)"),
  delMsg: db.query("DELETE FROM messages WHERE session_id = ?"),
  delSession: db.query("DELETE FROM sessions WHERE id = ?"),
  putSession: db.query("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"),
  putMsg: db.query("INSERT INTO messages (session_id, uuid, role) VALUES (?,?,?)"),
  putFts: db.query("INSERT INTO fts (rowid, text) VALUES (?,?)"),
};

const store = db.transaction((id: string, f: { path: string; mtime: number; size: number; dir: string }, parsed: Awaited<ReturnType<typeof parseSession>>) => {
  const { meta: m, items } = parsed;
  q.delFts.run(id);
  q.delMsg.run(id);
  const cwd = m.cwd || f.dir.replace(/-/g, "/");
  const indexed = items.filter((i) => i.k === "u" || i.k === "a");
  q.putSession.run(id, f.path, f.mtime, f.size, cwd, group(cwd), m.branch, m.title, m.firstPrompt, m.started, m.ended, m.users, indexed.length, m.auto);
  if (!m.users) return;
  for (const i of indexed) q.putFts.run(q.putMsg.run(id, i.u, i.k).lastInsertRowid, i.text);
  // The title and folder are searchable too; inserted last so a real message wins as "first hit".
  q.putFts.run(q.putMsg.run(id, "", "title").lastInsertRowid, `${m.title}\n${cwd}`);
});

const remove = db.transaction((id: string) => {
  q.delFts.run(id);
  q.delMsg.run(id);
  q.delSession.run(id);
});

const status = { indexing: false, done: 0, total: 0, lastScan: 0 };
let scanPromise: Promise<void> | null = null;

function scan() {
  return (scanPromise ??= doScan().finally(() => {
    scanPromise = null;
    status.indexing = false;
    status.lastScan = Date.now();
  }));
}

async function doScan() {
  const known = new Map<string, { mtime: number; size: number }>();
  for (const r of q.known.all() as any[]) known.set(r.id, r);
  const todo: { id: string; path: string; mtime: number; size: number; dir: string }[] = [];
  for (const dir of existsSync(PROJECTS) ? readdirSync(PROJECTS) : []) {
    let names: string[];
    try {
      names = readdirSync(join(PROJECTS, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(PROJECTS, dir, name);
      const id = name.slice(0, -6);
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      const k = known.get(id);
      known.delete(id);
      if (!k || k.mtime !== st.mtimeMs || k.size !== st.size) todo.push({ id, path, mtime: st.mtimeMs, size: st.size, dir });
    }
  }
  for (const id of known.keys()) remove(id);
  if (!todo.length) return;
  // A handful of changed sessions is quick enough to wait for; a bulk build reports progress instead.
  Object.assign(status, { indexing: todo.length > 20, done: 0, total: todo.length });
  for (const f of todo) {
    try {
      store(f.id, f, await parseSession(f.path));
    } catch (e) {
      console.error("index failed", f.path, e);
    }
    status.done++;
  }
}

// Picks up new and changed sessions when the UI asks; never blocks on the first big build.
async function fresh() {
  if (!scanPromise && Date.now() - status.lastScan <= 3000) return;
  const p = scan();
  if (!status.indexing) await p;
}

// ---------------------------------------------------------------- queries

const COLS = "s.id, s.title, s.cwd, s.grp, s.branch, s.first_prompt, s.started, s.ended, s.users, s.msgs, s.auto";

// src: "mine" (typed in a terminal, the default), "agents" (started through the SDK) or "all".
function source(p: URLSearchParams) {
  const src = p.get("src");
  return `s.users > 0${src === "all" ? "" : src === "agents" ? " AND s.auto = 1" : " AND s.auto = 0"}`;
}

function listSessions(p: URLSearchParams) {
  const tokens = (p.get("q") ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
  const match = tokens.map((t) => `"${t}"*`).join(" ");
  const where = [source(p)];
  const args: any[] = [];
  if (p.get("grp")) where.push("s.grp = ?"), args.push(p.get("grp"));
  if (p.get("from")) where.push("s.ended >= ?"), args.push(Number(p.get("from")));
  if (p.get("to")) where.push("s.started <= ?"), args.push(Number(p.get("to")));
  const limit = Math.min(Number(p.get("limit")) || 100, 500);
  const offset = Number(p.get("offset")) || 0;
  const w = where.join(" AND ");
  if (!match) {
    return {
      total: (db.query(`SELECT count(*) n FROM sessions s WHERE ${w}`).get(...args) as any).n,
      rows: db.query(`SELECT ${COLS} FROM sessions s WHERE ${w} ORDER BY s.ended DESC LIMIT ? OFFSET ?`).all(...args, limit, offset),
    };
  }
  const hits = `SELECT m.session_id sid, count(*) hits, min(m.id) first FROM fts JOIN messages m ON m.id = fts.rowid WHERE fts MATCH ? GROUP BY m.session_id`;
  const total = (db.query(`SELECT count(*) n FROM (${hits}) h JOIN sessions s ON s.id = h.sid WHERE ${w}`).get(match, ...args) as any).n;
  const rows = db.query(`SELECT ${COLS}, h.hits, h.first FROM (${hits}) h JOIN sessions s ON s.id = h.sid WHERE ${w} ORDER BY s.ended DESC LIMIT ? OFFSET ?`).all(match, ...args, limit, offset) as any[];
  const snip = db.query("SELECT snippet(fts, 0, char(1), char(2), '…', 28) s FROM fts WHERE fts MATCH ? AND rowid = ?");
  const msg = db.query("SELECT uuid, role FROM messages WHERE id = ?");
  for (const r of rows) {
    const mm = msg.get(r.first) as any;
    r.hit = mm?.uuid ?? "";
    r.hitRole = mm?.role ?? "";
    r.snippet = (snip.get(match, r.first) as any)?.s ?? "";
    delete r.first;
  }
  return { total, rows };
}

function resume(id: string) {
  const s = db.query("SELECT cwd FROM sessions WHERE id = ?").get(id) as any;
  if (!s) return { error: "Unknown session" };
  if (!existsSync(s.cwd)) return { error: `Folder no longer exists: ${s.cwd}` };
  const claude = Bun.which("claude");
  if (!claude) return { error: "claude not found on PATH" };
  // Same flags as the SUPER+RETURN binding in ~/.config/hypr/bindings.lua.
  Bun.spawn(["setsid", "-f", "uwsm-app", "--", "xdg-terminal-exec", `--dir=${s.cwd}`, claude, "--dangerously-skip-permissions", "--resume", id], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { ok: true };
}

// ---------------------------------------------------------------- http

const json = (v: unknown, status = 200) => Response.json(v, { status });

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    // Local only: reject other sites reaching in through DNS rebinding or cross-site posts.
    if (!HOSTS.has(req.headers.get("host") ?? "")) return new Response("forbidden", { status: 403 });
    const origin = req.headers.get("origin");
    if (origin && !HOSTS.has(origin.replace(/^https?:\/\//, ""))) return new Response("forbidden", { status: 403 });

    if (url.pathname === "/") return new Response(Bun.file(join(import.meta.dir, "public/index.html")), { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/api/status") return json({ ...status, home: HOME });
    if (url.pathname === "/api/sessions") {
      await fresh();
      try {
        return json(listSessions(url.searchParams));
      } catch (e) {
        return json({ total: 0, rows: [], error: String(e) });
      }
    }
    if (url.pathname === "/api/folders") {
      return json(db.query(`SELECT grp, count(*) n, max(ended) last FROM sessions s WHERE ${source(url.searchParams)} GROUP BY grp ORDER BY last DESC`).all());
    }
    const one = url.pathname.match(/^\/api\/session\/([0-9a-zA-Z-]+)$/);
    if (one) {
      const s = db.query(`SELECT ${COLS}, s.path FROM sessions s WHERE s.id = ?`).get(one[1]) as any;
      if (!s || !existsSync(s.path)) return json({ error: "Session not found" }, 404);
      const { items } = await parseSession(s.path);
      delete s.path;
      return json({ session: s, items });
    }
    const res = url.pathname.match(/^\/api\/resume\/([0-9a-zA-Z-]+)$/);
    if (res && req.method === "POST") return json(resume(res[1]));
    return new Response("not found", { status: 404 });
  },
});

console.log(`claude-history on http://127.0.0.1:${PORT}`);
const t0 = Date.now();
scan().then(() => console.log(`index ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`));
