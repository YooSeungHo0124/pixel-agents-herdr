import * as path from 'path';

import type { AgentStateStore } from '../agentStateStore.js';
import { HERDR_POLL_INTERVAL_MS } from '../constants.js';
import type { AgentState } from '../types.js';
import type { HerdrRequest } from './herdrClient.js';

/**
 * Ties pixel-agents characters to the herdr panes their Claude sessions run in.
 *
 * Read-only by design: the bridge only ever calls `agent.list` and
 * `workspace.list`, plus `agent.focus` when the user clicks a character. It
 * never creates, closes, moves or types into anything in the user's herdr
 * session.
 *
 * Join key: herdr's `agent_session.value` IS the Claude Code session_id (herdr's
 * own Claude integration reports it from SessionStart). Hook payloads also carry
 * the pane's HERDR_* env as a hint, which covers the gap before herdr's next
 * agent.list includes a brand-new session. agent.list wins whenever both exist:
 * a pane moved to another workspace gets a new pane id, and only herdr knows it.
 */

/** One herdr agent as returned by `agent.list` (only the fields we read). */
interface HerdrAgent {
  pane_id: string;
  workspace_id: string;
  tab_id?: string;
  terminal_id?: string;
  agent?: string;
  agent_status?: string;
  agent_session?: { kind?: string; value?: string };
  terminal_title_stripped?: string;
  title?: string;
}

interface HerdrWorkspace {
  workspace_id: string;
  label?: string;
}

/** What we know about one session's herdr location. */
export interface HerdrSessionInfo {
  paneId: string;
  workspaceId: string;
  workspaceLabel?: string;
  title?: string;
  status?: string;
}

interface PaneHint {
  paneId: string;
  workspaceId?: string;
}

export interface HerdrBridgeOptions {
  store: AgentStateStore;
  request: HerdrRequest;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

/** Bound on remembered hook hints (one per session id ever seen). */
const MAX_HINTS = 500;

/** The Claude session id an agent belongs to: its hook session id, else its transcript's basename. */
export function sessionIdOf(agent: AgentState): string | undefined {
  if (agent.sessionId) return agent.sessionId;
  if (agent.jsonlFile) return path.basename(agent.jsonlFile, '.jsonl');
  return undefined;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export class HerdrBridge {
  private readonly store: AgentStateStore;
  private readonly request: HerdrRequest;
  private readonly pollIntervalMs: number;
  private readonly log: (msg: string) => void;

  private bySession = new Map<string, HerdrSessionInfo>();
  private workspaceLabels = new Map<string, string>();
  private hints = new Map<string, PaneHint>();
  /** Last agentHerdrInfo payload sent per agent id, to broadcast only on change. */
  private lastSent = new Map<number, string>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private connected: boolean | null = null;

  constructor(opts: HerdrBridgeOptions) {
    this.store = opts.store;
    this.request = opts.request;
    this.pollIntervalMs = opts.pollIntervalMs ?? HERDR_POLL_INTERVAL_MS;
    this.log = opts.log ?? ((msg) => console.log(msg));
  }

  /** Begin polling herdr. Safe to call once; the first poll runs immediately. */
  start(): void {
    const tick = async (): Promise<void> => {
      await this.refresh();
      if (!this.disposed) this.timer = setTimeout(() => void tick(), this.pollIntervalMs);
    };
    void tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Whether the last poll reached herdr. */
  get isConnected(): boolean {
    return this.connected === true;
  }

  /** Record the HERDR_* env a Claude hook forwarded (see claude-hook.ts). */
  noteHookEvent(event: Record<string, unknown>): void {
    const sessionId = event.session_id;
    const herdr = event.herdr as Record<string, unknown> | undefined;
    if (!isNonEmptyString(sessionId) || !herdr || !isNonEmptyString(herdr.pane_id)) return;
    const hint: PaneHint = {
      paneId: herdr.pane_id,
      workspaceId: isNonEmptyString(herdr.workspace_id) ? herdr.workspace_id : undefined,
    };
    const prev = this.hints.get(sessionId);
    if (prev?.paneId === hint.paneId && prev.workspaceId === hint.workspaceId) return;
    this.hints.delete(sessionId);
    this.hints.set(sessionId, hint);
    if (this.hints.size > MAX_HINTS) {
      const oldest = this.hints.keys().next().value;
      if (oldest !== undefined) this.hints.delete(oldest);
    }
  }

  /** Best current knowledge for a session: herdr's agent.list first, then the hook hint. */
  infoForSession(sessionId: string | undefined): HerdrSessionInfo | undefined {
    if (!sessionId) return undefined;
    const listed = this.bySession.get(sessionId);
    if (listed) return listed;
    const hint = this.hints.get(sessionId);
    if (!hint) return undefined;
    return {
      paneId: hint.paneId,
      workspaceId: hint.workspaceId ?? '',
      workspaceLabel: hint.workspaceId ? this.workspaceLabels.get(hint.workspaceId) : undefined,
    };
  }

  /**
   * folderName for a new agent: its herdr workspace label, so the Areas UI
   * groups characters by herdr workspace. Undefined lets the caller fall back
   * to the cwd basename.
   */
  workspaceLabelFor(ctx: {
    sessionId?: string;
    cwd?: string;
    projectDir?: string;
  }): string | undefined {
    return this.infoForSession(ctx.sessionId)?.workspaceLabel;
  }

  /**
   * Bring the agent's herdr pane to the front. Re-reads agent.list first so a
   * pane that moved since the last poll is still found. Resolves false when
   * the agent is not in herdr or herdr refused.
   */
  async focusAgent(agentId: number): Promise<boolean> {
    const agent = this.store.get(agentId);
    const sessionId = agent ? sessionIdOf(agent) : undefined;
    if (!sessionId) return false;
    await this.refresh();
    const info = this.infoForSession(sessionId);
    if (!info) return false;
    try {
      await this.request('agent.focus', { target: info.paneId });
      return true;
    } catch (err) {
      this.log(
        `[Pixel Agents] herdr: focus ${info.paneId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Replay every agent's herdr info to one newly connected client. */
  resend(send: (msg: Record<string, unknown>) => void): void {
    for (const [id, agent] of this.store) {
      const msg = this.messageFor(id, agent);
      if (msg) send(msg);
    }
  }

  /** Poll herdr once and broadcast what changed. Never throws. */
  async refresh(): Promise<void> {
    let agents: HerdrAgent[];
    let workspaces: HerdrWorkspace[];
    try {
      const [agentRes, wsRes] = await Promise.all([
        this.request('agent.list'),
        this.request('workspace.list'),
      ]);
      agents = ((agentRes as { agents?: HerdrAgent[] })?.agents ?? []).filter(
        (a) => a && isNonEmptyString(a.pane_id),
      );
      workspaces = (wsRes as { workspaces?: HerdrWorkspace[] })?.workspaces ?? [];
    } catch (err) {
      if (this.connected !== false) {
        this.log(
          `[Pixel Agents] herdr: not reachable (${err instanceof Error ? err.message : String(err)}) — office keeps working without pane links`,
        );
      }
      this.connected = false;
      return;
    }
    if (this.connected !== true) {
      this.log(`[Pixel Agents] herdr: connected (${agents.length} agents)`);
    }
    this.connected = true;

    this.workspaceLabels = new Map(
      workspaces
        .filter((w) => isNonEmptyString(w.workspace_id))
        .map((w) => [w.workspace_id, isNonEmptyString(w.label) ? w.label : w.workspace_id]),
    );
    const bySession = new Map<string, HerdrSessionInfo>();
    for (const a of agents) {
      const sessionId = a.agent_session?.value;
      if (!isNonEmptyString(sessionId)) continue;
      bySession.set(sessionId, {
        paneId: a.pane_id,
        workspaceId: a.workspace_id,
        workspaceLabel: this.workspaceLabels.get(a.workspace_id),
        title: a.terminal_title_stripped || a.title || undefined,
        status: a.agent_status,
      });
    }
    this.bySession = bySession;
    this.broadcastChanges();
  }

  private messageFor(id: number, agent: AgentState): Record<string, unknown> | undefined {
    const info = this.infoForSession(sessionIdOf(agent));
    if (!info) return undefined;
    return {
      type: 'agentHerdrInfo',
      id,
      paneId: info.paneId,
      workspaceLabel: info.workspaceLabel,
      title: info.title,
      status: info.status,
    };
  }

  private broadcastChanges(): void {
    let folderChanged = false;
    for (const [id, agent] of this.store) {
      const msg = this.messageFor(id, agent);
      if (!msg) continue;
      // Persist the workspace label as folderName so a restart restores the
      // character into its workspace's Area.
      const label = msg.workspaceLabel as string | undefined;
      if (label && agent.folderName !== label) {
        agent.folderName = label;
        folderChanged = true;
      }
      const key = JSON.stringify(msg);
      if (this.lastSent.get(id) === key) continue;
      this.lastSent.set(id, key);
      this.store.broadcast(msg);
    }
    for (const id of this.lastSent.keys()) {
      if (!this.store.has(id)) this.lastSent.delete(id);
    }
    if (folderChanged) this.store.persist();
  }
}
