/**
 * herdr as the office's only data source. Read-only apart from `agent.focus`
 * and `workspace.focus` when the user clicks: nothing here creates, closes,
 * moves or types into anything in the user's herdr session.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export type AgentStatus = 'working' | 'blocked' | 'done' | 'idle' | 'unknown';

export interface AgentInfo {
  paneId: string;
  workspaceId: string;
  tabId: string;
  /** Agent kind as herdr detected it: claude, codex, gemini, ... */
  kind: string;
  status: AgentStatus;
  title: string;
  cwd: string;
  focused: boolean;
}

export interface WorkspaceInfo {
  id: string;
  label: string;
  number: number;
  focused: boolean;
}

export interface Snapshot {
  workspaces: WorkspaceInfo[];
  agents: AgentInfo[];
}

export interface Source {
  poll(): Promise<Snapshot>;
  focusAgent(paneId: string): Promise<void>;
  focusWorkspace(workspaceId: string): Promise<void>;
}

const STATUSES = new Set<AgentStatus>(['working', 'blocked', 'done', 'idle', 'unknown']);

export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.HERDR_SOCKET_PATH?.trim();
  if (fromEnv) return fromEnv;
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  const fallback = path.join(configHome, 'herdr', 'herdr.sock');
  return fs.existsSync(fallback) ? fallback : undefined;
}

let nextId = 1;

/** One newline-delimited JSON request per connection, as herdr's socket API expects. */
export function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 3000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `herdr-office-${nextId++}`;
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`herdr ${method} timed out`)), timeoutMs);
    socket.setEncoding('utf-8');
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: string; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue;
        if (msg.error) finish(new Error(msg.error.message ?? `herdr ${method} failed`));
        else finish(null, msg.result);
        return;
      }
    });
    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(new Error(`herdr closed the connection during ${method}`)));
  });
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Turn raw `agent.list` + `workspace.list` results into a Snapshot. */
export function toSnapshot(agentRes: unknown, wsRes: unknown): Snapshot {
  const rawWs = ((wsRes as { workspaces?: unknown[] })?.workspaces ?? []) as Record<
    string,
    unknown
  >[];
  const rawAgents = ((agentRes as { agents?: unknown[] })?.agents ?? []) as Record<
    string,
    unknown
  >[];
  const workspaces = rawWs
    .filter((w) => str(w.workspace_id))
    .map((w, i) => ({
      id: str(w.workspace_id),
      label: str(w.label) || str(w.workspace_id),
      number: typeof w.number === 'number' ? w.number : i + 1,
      focused: w.focused === true,
    }))
    .sort((a, b) => a.number - b.number);
  const agents = rawAgents
    .filter((a) => str(a.pane_id) && str(a.workspace_id))
    .map((a) => {
      const status = str(a.agent_status) as AgentStatus;
      return {
        paneId: str(a.pane_id),
        workspaceId: str(a.workspace_id),
        tabId: str(a.tab_id),
        kind: str(a.agent, 'agent'),
        status: STATUSES.has(status) ? status : 'unknown',
        title: str(a.terminal_title_stripped) || str(a.terminal_title) || str(a.pane_id),
        cwd: str(a.cwd),
        focused: a.focused === true,
      };
    });
  return { workspaces, agents };
}

export class HerdrSource implements Source {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async poll(): Promise<Snapshot> {
    const [agents, workspaces] = await Promise.all([
      request(this.socketPath, 'agent.list'),
      request(this.socketPath, 'workspace.list'),
    ]);
    return toSnapshot(agents, workspaces);
  }

  async focusAgent(paneId: string): Promise<void> {
    await request(this.socketPath, 'agent.focus', { target: paneId });
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await request(this.socketPath, 'workspace.focus', { workspace_id: workspaceId });
  }
}

/** Fake herdr with agents cycling through every status, for trying the office out. */
export class DemoSource implements Source {
  private readonly start = Date.now();

  async poll(): Promise<Snapshot> {
    const t = Math.floor((Date.now() - this.start) / 1000);
    const cycle: AgentStatus[] = ['working', 'working', 'done', 'idle', 'idle', 'blocked'];
    const at = (offset: number, every: number): AgentStatus =>
      cycle[Math.floor((t + offset) / every) % cycle.length];
    const ws = [
      { id: 'w1', label: 'puzzle', number: 1, focused: true },
      { id: 'w2', label: 'pixel-agents', number: 2, focused: false },
      { id: 'w3', label: 'wiki', number: 3, focused: false },
    ];
    const titles = [
      'API 리팩터링',
      '테스트 작성',
      'UI 버그 수정',
      '문서 정리',
      '배포 확인',
      '리서치',
    ];
    const agents: AgentInfo[] = [];
    const mk = (w: string, n: number, status: AgentStatus): void => {
      agents.push({
        paneId: `${w}:p${n}`,
        workspaceId: w,
        tabId: `${w}:t${n}`,
        kind: 'claude',
        status,
        title: titles[(n + w.length) % titles.length],
        cwd: '/tmp',
        focused: w === 'w1' && n === 1,
      });
    };
    mk('w1', 1, at(0, 7));
    mk('w1', 2, at(3, 9));
    mk('w1', 3, at(5, 11));
    mk('w1', 4, 'idle');
    mk('w2', 1, at(1, 8));
    mk('w2', 2, 'blocked');
    mk('w3', 1, at(2, 10));
    return { workspaces: ws, agents };
  }

  async focusAgent(): Promise<void> {}

  async focusWorkspace(): Promise<void> {}
}
