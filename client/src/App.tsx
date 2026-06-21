import { useState, useEffect, useRef } from 'react';
import type { Envelope, ChatMessage } from 'shared';

interface FileEntry {
  name: string;
  type: 'file' | 'dir';
}

interface TermLine {
  type: 'stdout' | 'stderr' | 'exit' | 'cmd';
  text: string;
  code?: number;
  duration?: number;
}

// ponytail: one component, no router, no state library
export default function App() {
  const [token, setToken] = useState('');
  const [authed, setAuthed] = useState(false);
  const [messages, setMessages] = useState<Envelope[]>([]);
  const [input, setInput] = useState('');
  const [dark, setDark] = useState(true);
  const [project] = useState('iphone-opencode');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // file browser state
  const [view, setView] = useState<'chat' | 'files' | 'file-view' | 'terminal'>('chat');
  const [filePath, setFilePath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [fileViewPath, setFileViewPath] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileError, setFileError] = useState('');

  // terminal state
  const [termOutput, setTermOutput] = useState<TermLine[]>([]);
  const [termHistory, setTermHistory] = useState<string[]>([]);
  const [termRunning, setTermRunning] = useState(false);
  const [termInput, setTermInput] = useState('');
  const [termHistIdx, setTermHistIdx] = useState(-1);
  const [showCommitForm, setShowCommitForm] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const termBottomRef = useRef<HTMLDivElement>(null);
  const historyFetchedRef = useRef(false);

  // ponytail: fetch dev token from server on mount
  useEffect(() => {
    fetch('http://localhost:3001/api/v1/dev-token')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.token) setToken(d.token); })
      .catch(() => {}); // server might not be up yet
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView(); }, [messages]);
  useEffect(() => { termBottomRef.current?.scrollIntoView(); }, [termOutput]);

  const getRetryDelay = (count: number) =>
    Math.min(1000 * Math.pow(2, count), 16000);

  const scheduleRetry = () => {
    const delay = getRetryDelay(retryCountRef.current);
    retryCountRef.current += 1;
    retryTimeoutRef.current = setTimeout(() => connect(), delay);
  };

  // ponytail: exponential backoff 1s→2s→4s→8s→16s max
  const connect = async (manual = false) => {
    if (manual) {
      retryCountRef.current = 0;
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    }
    setConnecting(true);
    try {
      const res = await fetch('http://localhost:3001/api/v1/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error('auth failed');

      wsRef.current?.close();
      const socket = new WebSocket(`ws://localhost:3001?token=${token}`);
      socket.onopen = () => {
        setAuthed(true);
        setConnected(true);
        setConnecting(false);
        retryCountRef.current = 0;
      };
      socket.onclose = () => {
        setConnected(false);
        scheduleRetry();
      };
      socket.onmessage = (e) => {
        const env = JSON.parse(e.data) as Envelope;
        if (env.type === 'stdout' || env.type === 'stderr') {
          setTermOutput(p => [...p, { type: env.type, text: env.payload as string } as TermLine]);
        } else if (env.type === 'exit') {
          const p = env.payload as { code: number; duration: number };
          setTermOutput(prev => [...prev, { type: 'exit', text: `→ exited ${p.code} (${p.duration}ms)`, code: p.code, duration: p.duration }]);
          setTermRunning(false);
        } else if (env.type === 'history') {
          setTermHistory(env.payload as string[]);
        } else {
          setMessages(m => [...m, env]);
        }
      };
      wsRef.current = socket;
    } catch {
      setConnecting(false);
      if (!manual) scheduleRetry();
    }
  };

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      wsRef.current?.close();
    };
  }, []);

  const send = () => {
    if (!input.trim() || !wsRef.current) return;
    const msg: Envelope<ChatMessage> = { type: 'prompt', payload: { text: input, project } };
    wsRef.current.send(JSON.stringify(msg));
    setMessages((m) => [...m, { type: 'sent', payload: { text: input } } as Envelope]);
    setInput('');
  };

  const sendExec = (cmd: string) => {
    if (!cmd.trim() || !wsRef.current) return;
    setTermRunning(true);
    setTermOutput(p => [...p, { type: 'cmd', text: cmd }]);
    wsRef.current.send(JSON.stringify({ type: 'exec', payload: { command: cmd } }));
    setTermHistory(prev => prev.includes(cmd) ? prev : [...prev, cmd]);
    setTermInput('');
    setTermHistIdx(-1);
  };

  const killCommand = () => {
    wsRef.current?.send(JSON.stringify({ type: 'kill' }));
  };

  const fetchHistory = () => {
    wsRef.current?.send(JSON.stringify({ type: 'history' }));
  };

  // file browser functions

  const authHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  });

  const fetchDir = async (path: string) => {
    setLoading(true);
    setFileError('');
    try {
      const res = await fetch(
        `http://localhost:3001/api/v1/files/list?path=${encodeURIComponent(path)}`,
        { headers: authHeaders() },
      );
      if (!res.ok) { const t = await res.text(); throw new Error(t || 'Failed to list directory'); }
      const data: FileEntry[] = await res.json();
      setEntries(data);
    } catch (e) {
      setFileError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const openFile = async (name: string) => {
    const path = filePath ? `${filePath}/${name}` : name;
    setFileViewPath(path);
    setLoading(true);
    setFileError('');
    try {
      const res = await fetch(
        `http://localhost:3001/api/v1/files/read?path=${encodeURIComponent(path)}`,
        { headers: authHeaders() },
      );
      if (!res.ok) { const t = await res.text(); throw new Error(t || 'Failed to read file'); }
      const data = await res.json();
      setFileContent(data.content);
      setEditContent(data.content);
      setEditing(false);
      setView('file-view');
    } catch (e) {
      setFileError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveFile = async () => {
    setLoading(true);
    setFileError('');
    try {
      const res = await fetch(
        `http://localhost:3001/api/v1/files/write?path=${encodeURIComponent(fileViewPath)}`,
        {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({ content: editContent }),
        },
      );
      if (!res.ok) { const t = await res.text(); throw new Error(t || 'Failed to save file'); }
      setFileContent(editContent);
      setEditing(false);
    } catch (e) {
      setFileError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const navigateDir = (name: string) => {
    const path = filePath ? `${filePath}/${name}` : name;
    setFilePath(path);
    fetchDir(path);
  };

  const navigateBreadcrumb = (index: number) => {
    const segments = filePath.split('/').filter(Boolean);
    const path = segments.slice(0, index + 1).join('/');
    setFilePath(path);
    fetchDir(path);
  };

  const goBackToListing = () => {
    setView('files');
    setFileViewPath('');
    setFileContent('');
    setEditing(false);
  };

  const switchToFiles = () => {
    setView('files');
    if (entries.length === 0) fetchDir(filePath);
  };

  // ponytail: simple extension-based icon mapping
  const fileIcon = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️',
      json: '📋', md: '📝', css: '🎨', html: '🌐',
      sql: '🗄️', yml: '⚙️', yaml: '⚙️',
    };
    return map[ext || ''] || '📄';
  };

  // ponytail: dirs first, then alphabetical
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const breadcrumbSegments = filePath ? filePath.split('/').filter(Boolean) : [];

  return (
    <div className={`app${dark ? ' dark' : ''}`} data-theme={dark ? 'dark' : 'light'}>
      <header>
        <h1>◉ OpenCode</h1>
        <button className="theme-btn" onClick={() => setDark((d) => !d)} aria-label="Toggle theme">
          {dark ? '☀︎' : '☽'}
        </button>
      </header>

      {!authed ? (
        <div className="login">
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="API Token" />
          <button onClick={() => connect()} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <span className="project">{project}</span>
            <span className={`status${connected ? ' connected' : ''}`}>
              {connecting ? (
                <span className="loading-dots"><span /><span /><span /></span>
              ) : (
                connected ? 'connected' : 'disconnected'
              )}
            </span>
          </div>

          <nav className="tab-bar">
            <button className={`tab${view === 'chat' ? ' active' : ''}`} onClick={() => setView('chat')}>Chat</button>
            <button className={`tab${view === 'files' || view === 'file-view' ? ' active' : ''}`} onClick={switchToFiles}>Files</button>
            <button className={`tab${view === 'terminal' ? ' active' : ''}`} onClick={() => { setView('terminal'); if (!historyFetchedRef.current) { historyFetchedRef.current = true; fetchHistory(); } }}>Terminal</button>
          </nav>

          {view === 'chat' && (
            <>
              <div className="messages">
                {!connected && (
                  <div className="disconnected-banner">
                    <span>Connection lost — reconnecting…</span>
                    <button onClick={() => connect(true)}>Reconnect</button>
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`msg msg-${m.type}`}>
                    {typeof m.payload === 'object' && m.payload !== null
                      ? (m.payload as Record<string, unknown>).text as string ?? JSON.stringify(m.payload)
                      : String(m.payload)}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              <div className="input-bar">
                <input value={input} onChange={(e) => setInput(e.target.value)}
                       onKeyDown={(e) => e.key === 'Enter' && send()}
                       placeholder="Send a prompt…" disabled={!connected} />
                <button onClick={send} disabled={!connected || !input.trim()}>Send</button>
              </div>
            </>
          )}

          {view === 'files' && (
            <div className="file-browser">
              <div className="breadcrumb">
                <button className="crumb-btn" onClick={() => { setFilePath(''); fetchDir(''); }}>
                  Root
                </button>
                {breadcrumbSegments.map((seg, i) => (
                  <span key={i} className="crumb-part">
                    <span className="crumb-sep">/</span>
                    <button className="crumb-btn" onClick={() => navigateBreadcrumb(i)}>{seg}</button>
                  </span>
                ))}
              </div>

              {fileError && <div className="file-error">{fileError}</div>}

              {loading ? (
                <div className="file-loading">Loading…</div>
              ) : sortedEntries.length === 0 && !fileError ? (
                <div className="file-empty">Empty directory</div>
              ) : (
                <div className="file-list">
                  {sortedEntries.map((entry) => (
                    <div key={entry.name} className="file-entry" onClick={() => {
                      if (entry.type === 'dir') navigateDir(entry.name);
                      else openFile(entry.name);
                    }}>
                      <span className="file-entry-icon">
                        {entry.type === 'dir' ? '📁' : fileIcon(entry.name)}
                      </span>
                      <span className="file-entry-name">{entry.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {view === 'file-view' && (
            <>
              <div className="file-viewer">
                <div className="file-viewer-header">
                  <button className="back-btn" onClick={goBackToListing}>← Back</button>
                  <span className="file-viewer-path">{fileViewPath}</span>
                  <button className="edit-btn" onClick={() => setEditing((e) => !e)}>
                    {editing ? 'Cancel' : 'Edit'}
                  </button>
                  {editing && (
                    <button className="save-btn" onClick={saveFile} disabled={loading}>Save</button>
                  )}
                </div>

                {fileError && <div className="file-error">{fileError}</div>}

                {loading && !editing ? (
                  <div className="file-loading">Loading…</div>
                ) : editing ? (
                  <textarea
                    className="edit-area"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    spellCheck={false}
                  />
                ) : (
                  <pre className="file-content">{fileContent}</pre>
                )}
              </div>

              {editing && (
                <div className="input-bar">
                  <span className="file-context">{fileViewPath}</span>
                  <button onClick={saveFile} disabled={loading || editContent === fileContent}>
                    {loading ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </>
          )}

          {view === 'terminal' && (
            <>
              <div className="term-git-bar">
                <button onClick={() => sendExec('git status')}>status</button>
                <button onClick={() => sendExec('git diff')}>diff</button>
                <button onClick={() => sendExec('git log --oneline -10')}>log</button>
                <button onClick={() => sendExec('git pull')}>pull</button>
                <button onClick={() => sendExec('git push')}>push</button>
                <button onClick={() => setShowCommitForm(true)}>commit</button>
                <button onClick={() => sendExec('git branch')}>branch</button>
              </div>

              {showCommitForm && (
                <div className="term-commit-form">
                  <input
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && commitMsg.trim()) {
                        sendExec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
                        setShowCommitForm(false);
                        setCommitMsg('');
                      }
                      if (e.key === 'Escape') { setShowCommitForm(false); setCommitMsg(''); }
                    }}
                    placeholder="Commit message"
                    autoFocus
                  />
                  <button onClick={() => { setShowCommitForm(false); setCommitMsg(''); }}>Cancel</button>
                </div>
              )}

              <div className="term-output">
                {(() => {
                  const MAX = 500;
                  const total = termOutput.length;
                  let items: { line: TermLine; idx: number }[];
                  let hidden = 0;

                  if (total <= MAX * 2) {
                    items = termOutput.map((l, i) => ({ line: l, idx: i }));
                  } else {
                    hidden = total - MAX * 2;
                    const first = termOutput.slice(0, MAX);
                    const last = termOutput.slice(total - MAX);
                    items = [
                      ...first.map((l, i) => ({ line: l, idx: i })),
                      ...last.map((l, i) => ({ line: l, idx: total - MAX + i })),
                    ];
                  }

                  return items.map(({ line, idx }, i) => {
                    const nodes: React.ReactNode[] = [];
                    if (line.type === 'cmd') {
                      if (idx > 0) {
                        nodes.push(<hr key={`hr-${idx}`} className="term-sep" />);
                      }
                      nodes.push(
                        <div key={idx} className="line-cmd">
                          <span className="term-prompt">$</span> {line.text}
                        </div>
                      );
                    } else if (line.type === 'exit') {
                      nodes.push(
                        <div key={idx} className={`line-exit line-exit-${line.code === 0 ? 'ok' : 'err'}`}>
                          {line.text}
                        </div>
                      );
                    } else {
                      nodes.push(
                        <div key={idx} className={`line-${line.type}`}>{line.text}</div>
                      );
                    }
                    // ponytail: snippet before hidden indicator
                    if (hidden > 0 && i === MAX - 1) {
                      nodes.push(
                        <div key="hidden" className="term-hidden">… {hidden} lines hidden …</div>
                      );
                    }
                    return nodes;
                  });
                })()}
                <div ref={termBottomRef} />
              </div>

              <div className="term-status">
                {termRunning && <span className="term-running-indicator">running…</span>}
              </div>

              <div className="term-input-bar">
                <span className="term-prompt">$</span>
                <input
                  value={termInput}
                  onChange={(e) => setTermInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      sendExec(termInput);
                    } else if (e.key === 'ArrowUp') {
                      if (termHistory.length === 0) return;
                      const newIdx = termHistIdx === -1 ? termHistory.length - 1 : Math.max(0, termHistIdx - 1);
                      setTermHistIdx(newIdx);
                      setTermInput(termHistory[newIdx]);
                    } else if (e.key === 'ArrowDown') {
                      if (termHistIdx === -1) return;
                      const newIdx = termHistIdx + 1;
                      if (newIdx >= termHistory.length) {
                        setTermHistIdx(-1);
                        setTermInput('');
                      } else {
                        setTermHistIdx(newIdx);
                        setTermInput(termHistory[newIdx]);
                      }
                    }
                  }}
                  placeholder="Run a command…"
                  disabled={termRunning}
                />
                {termRunning && (
                  <button className="term-kill-btn" onClick={killCommand} aria-label="Kill command">✕</button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
