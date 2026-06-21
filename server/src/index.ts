import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import type { Envelope, AuthResponse } from 'shared';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

interface Session {
  sessionId: string;
  token: string;
  project?: string;
  connectedAt: string;
  lastActivityAt: string;
  disconnectedAt?: string;
}

// ponytail: in-memory session store, no SQLite until we need persistence
const sessions = new Map<string, Session>();
const tokenToSessionId = new Map<string, string>();

// sessionId -> command history (last 50, deduplicated consecutive)
const commandHistory = new Map<string, string[]>();
const MAX_HISTORY = 50;

// ws -> active child process tracking
const activeProcesses = new Map<WebSocket, { child: import('child_process').ChildProcess; abort: AbortController }>();

// -- Auth --

app.post<{ body: { token?: string; project?: string } }>('/api/v1/auth', (req, res) => {
  const { token, project } = req.body;
  if (!token) {
    res.status(400).json({ error: 'token required' });
    return;
  }

  const existingSessionId = tokenToSessionId.get(token);
  if (existingSessionId && sessions.has(existingSessionId)) {
    const existing = sessions.get(existingSessionId)!;
    existing.lastActivityAt = new Date().toISOString();
    existing.disconnectedAt = undefined;
    existing.project = project ?? existing.project;
    const body: AuthResponse = { sessionId: existingSessionId };
    res.json(body);
    return;
  }

  const sessionId = randomUUID();
  const session: Session = {
    sessionId,
    token,
    project,
    connectedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
  sessions.set(sessionId, session);
  tokenToSessionId.set(token, sessionId);

  const body: AuthResponse = { sessionId };
  res.json(body);
});

// -- Projects --

interface ProjectEntry {
  name: string;
  path: string;
  type: 'opencode' | 'git' | 'node' | 'ai-coded';
}

const PROJECT_INDICATORS: { type: ProjectEntry['type']; files: string[] }[] = [
  { type: 'opencode', files: ['opencode.json', 'opencode.jsonc'] },
  { type: 'git', files: ['.git'] },
  { type: 'node', files: ['package.json'] },
  { type: 'ai-coded', files: ['AGENTS.md', 'CLAUDE.md'] },
];

function detectProjectType(dir: string): ProjectEntry['type'] | null {
  for (const indicator of PROJECT_INDICATORS) {
    for (const file of indicator.files) {
      try {
        if (fs.existsSync(path.join(dir, file))) {
          return indicator.type;
        }
      } catch {
        // permission denied on a specific file check — skip
      }
    }
  }
  return null;
}

function scanDirectories(): ProjectEntry[] {
  const seen = new Map<string, ProjectEntry>();

  const candidates = new Set<string>();

  let current = process.cwd();
  for (let i = 0; i < 3; i++) {
    candidates.add(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const profileDir = path.join(os.homedir(), 'opencode', 'projects');
  candidates.add(profileDir);

  for (const dir of candidates) {
    let type: ProjectEntry['type'] | null = null;
    try {
      if (!fs.existsSync(dir)) continue;
      type = detectProjectType(dir);
    } catch {
      // permission denied — skip
      continue;
    }

    if (type && !seen.has(dir)) {
      seen.set(dir, {
        name: path.basename(dir),
        path: dir,
        type,
      });
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/api/v1/projects', (_req, res) => {
  try {
    const projects = scanDirectories();
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: 'failed to scan projects' });
  }
});

// -- Sessions --

app.post('/api/v1/sessions', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  if (!tokenToSessionId.has(token)) {
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  const activeSessions = Array.from(sessions.values())
    .map(s => ({
      sessionId: s.sessionId,
      project: s.project ?? null,
      connectedAt: s.connectedAt,
      lastActivityAt: s.lastActivityAt,
      disconnectedAt: s.disconnectedAt ?? null,
    }))
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());

  res.json({ sessions: activeSessions });
});

// -- Periodic stale session cleanup --

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - new Date(session.lastActivityAt).getTime() > STALE_THRESHOLD_MS) {
      tokenToSessionId.delete(session.token);
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

// -- File Management --
// ponytail: only the cwd root is used for file ops

const PROJECT_ROOT = process.cwd();

const LANGUAGE_MAP: Record<string, string | undefined> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.sql': 'sql',
  '.sh': 'shell',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.toml': 'toml',
  '.xml': 'xml',
};

function getLanguage(filePath: string): string | undefined {
  return LANGUAGE_MAP[path.extname(filePath).toLowerCase()];
}

// ponytail: simple null-byte check in first 8 KB
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ponytail: path guard duplicated in each handler instead of middleware
function checkPath(raw: string, projectRoot: string): { ok: false; status: number; error: string } | { ok: true; resolved: string } {
  const decoded = decodeURIComponent(raw);
  if (decoded.includes('..')) return { ok: false, status: 403, error: 'path traversal detected' };

  const resolved = path.resolve(projectRoot, decoded);
  if (!resolved.startsWith(projectRoot)) return { ok: false, status: 403, error: 'path traversal detected' };

  return { ok: true, resolved };
}

app.get('/api/v1/files/list', async (req, res) => {
  try {
    const raw = req.query.path as string | undefined;
    if (raw === undefined) { res.status(400).json({ error: 'path query parameter required' }); return; }

    const check = checkPath(raw, PROJECT_ROOT);
    if (!check.ok) { res.status(check.status).json({ error: check.error }); return; }

    let stat: fs.Stats;
    try { stat = await fsp.stat(check.resolved); }
    catch { res.status(404).json({ error: 'path not found' }); return; }

    if (!stat.isDirectory()) { res.status(400).json({ error: 'path is not a directory' }); return; }

    const dirEntries = await fsp.readdir(check.resolved, { withFileTypes: true });
    const entries: { name: string; type: 'file' | 'directory'; size: number | null; mtime: string }[] = [];

    for (const entry of dirEntries) {
      try {
        const full = path.join(check.resolved, entry.name);
        const s = await fsp.stat(full);
        entries.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? s.size : null,
          mtime: s.mtime.toISOString(),
        });
      } catch { /* skip unstatable entries */ }
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: decodeURIComponent(raw), entries });
  } catch (err) {
    console.error('list error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/v1/files/read', async (req, res) => {
  try {
    const raw = req.query.path as string | undefined;
    if (raw === undefined) { res.status(400).json({ error: 'path query parameter required' }); return; }

    const check = checkPath(raw, PROJECT_ROOT);
    if (!check.ok) { res.status(check.status).json({ error: check.error }); return; }

    let stat: fs.Stats;
    try { stat = await fsp.stat(check.resolved); }
    catch { res.status(404).json({ error: 'path not found' }); return; }

    if (!stat.isFile()) { res.status(400).json({ error: 'path is not a file' }); return; }

    const buf = await fsp.readFile(check.resolved);
    if (isBinary(buf)) { res.status(400).json({ error: 'binary file cannot be read as text' }); return; }

    const content = buf.toString('utf-8');
    const language = getLanguage(decodeURIComponent(raw));

    res.json({
      path: decodeURIComponent(raw),
      content,
      size: stat.size,
      ...(language ? { language } : {}),
    });
  } catch (err) {
    console.error('read error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.put('/api/v1/files/write', async (req, res) => {
  try {
    const raw = req.query.path as string | undefined;
    if (raw === undefined) { res.status(400).json({ error: 'path query parameter required' }); return; }

    const check = checkPath(raw, PROJECT_ROOT);
    if (!check.ok) { res.status(check.status).json({ error: check.error }); return; }

    const content = req.body?.content;
    if (typeof content !== 'string') { res.status(400).json({ error: 'content field required (string)' }); return; }

    const dir = path.dirname(check.resolved);
    try { await fsp.mkdir(dir, { recursive: true }); }
    catch { res.status(500).json({ error: 'failed to create parent directories' }); return; }

    await fsp.writeFile(check.resolved, content, 'utf-8');
    const s = await fsp.stat(check.resolved);

    res.json({ path: decodeURIComponent(raw), size: s.size });
  } catch (err) {
    console.error('write error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// -- WebSocket --

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) {
    ws.close(4001, 'unauthorized');
    return;
  }

  const sessionId = tokenToSessionId.get(token);
  if (!sessionId || !sessions.has(sessionId)) {
    ws.close(4001, 'unauthorized');
    return;
  }

  const session = sessions.get(sessionId)!;
  session.lastActivityAt = new Date().toISOString();
  session.disconnectedAt = undefined;

  ws.on('message', (raw) => {
    try {
      const msg: Envelope = JSON.parse(raw.toString());
      session.lastActivityAt = new Date().toISOString();

      if (msg.type === 'exec') {
        const payload = msg.payload as any;
        const command = payload?.command;
        const cwd = payload?.cwd ?? process.cwd();

        if (typeof command !== 'string' || command.trim().length === 0) {
          ws.send(JSON.stringify({ type: 'error', payload: 'command must be a non-empty string' }));
          return;
        }

        // ponytail: no command restrictions yet (Phase 5 will add approval workflow)

        // Push to history with dedup of consecutive identical commands
        const hist = commandHistory.get(sessionId) ?? [];
        if (hist[hist.length - 1] !== command) {
          hist.push(command);
          if (hist.length > MAX_HISTORY) hist.shift();
          commandHistory.set(sessionId, hist);
        }

        const abort = new AbortController();
        const child = exec(command, {
          cwd,
          maxBuffer: 1024 * 1024,
          timeout: 30000,
          signal: abort.signal,
        });

        activeProcesses.set(ws, { child, abort });

        const startTime = Date.now();
        let completed = false;

        child.stdout?.on('data', (chunk: string) => {
          ws.send(JSON.stringify({ type: 'stdout', payload: chunk }));
        });

        child.stderr?.on('data', (chunk: string) => {
          ws.send(JSON.stringify({ type: 'stderr', payload: chunk }));
        });

        child.on('error', (err: Error) => {
          if (completed) return;
          completed = true;
          activeProcesses.delete(ws);
          const elapsed = Date.now() - startTime;
          ws.send(JSON.stringify({ type: 'stderr', payload: err.message + '\n' }));
          ws.send(JSON.stringify({ type: 'exit', payload: { code: -1, duration: elapsed } }));
        });

        child.on('exit', (code) => {
          if (completed) return;
          completed = true;
          activeProcesses.delete(ws);
          const elapsed = Date.now() - startTime;
          ws.send(JSON.stringify({ type: 'exit', payload: { code: code ?? -1, duration: elapsed } }));
        });
      } else if (msg.type === 'history') {
        const hist = commandHistory.get(sessionId) ?? [];
        ws.send(JSON.stringify({ type: 'history', payload: hist }));
      } else if (msg.type === 'kill') {
        const proc = activeProcesses.get(ws);
        if (proc) {
          proc.abort.abort();
          proc.child.kill();
          activeProcesses.delete(ws);
        }
      } else {
        ws.send(JSON.stringify({ type: 'error', payload: `unknown message type: ${msg.type}` }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', payload: 'invalid message' }));
    }
  });

  ws.on('close', () => {
    session.disconnectedAt = new Date().toISOString();
    const proc = activeProcesses.get(ws);
    if (proc) {
      proc.abort.abort();
      proc.child.kill();
      activeProcesses.delete(ws);
    }
  });
});

// -- Dev token (ponytail: ephemeral, printed on startup) --

// ponytail: dev token exposed to client for auto-fill
const DEV_TOKEN = randomUUID();
app.get('/api/v1/dev-token', (_req, res) => {
  res.json({ token: DEV_TOKEN });
});

// -- Start --

const PORT = parseInt(process.env.PORT ?? '3001', 10);
server.listen(PORT, () => {
  console.log(`server :${PORT}`);
  console.log(`dev token: ${DEV_TOKEN}`);
});
