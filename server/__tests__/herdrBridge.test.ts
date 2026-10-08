import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { HerdrBridge, sessionIdOf } from '../src/herdr/herdrBridge.js';
import { createHerdrRequest, type HerdrRequest } from '../src/herdr/herdrClient.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 0,
    sessionId: 'sess-a',
    isExternal: true,
    projectDir: '/work/a',
    jsonlFile: '/claude/projects/-work-a/sess-a.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

interface FakeHerdr {
  request: HerdrRequest;
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
  agents: Array<Record<string, unknown>>;
  workspaces: Array<Record<string, unknown>>;
  fail: boolean;
}

function fakeHerdr(): FakeHerdr {
  const fake: FakeHerdr = {
    calls: [],
    agents: [],
    workspaces: [{ workspace_id: 'w1', label: 'alpha' }],
    fail: false,
    request: async (method, params) => {
      fake.calls.push({ method, params });
      if (fake.fail) throw new Error('socket gone');
      if (method === 'agent.list') return { type: 'agent_list', agents: fake.agents };
      if (method === 'workspace.list')
        return { type: 'workspace_list', workspaces: fake.workspaces };
      if (method === 'agent.focus') return { type: 'ok' };
      throw new Error(`unexpected ${method}`);
    },
  };
  return fake;
}

function herdrAgent(sessionId: string, paneId: string, extra: Record<string, unknown> = {}) {
  return {
    pane_id: paneId,
    workspace_id: 'w1',
    agent: 'claude',
    agent_status: 'working',
    agent_session: { kind: 'id', value: sessionId },
    terminal_title_stripped: 'Refactor parser',
    ...extra,
  };
}

function setup() {
  const store = new AgentStateStore();
  const broadcasts: Array<Record<string, unknown>> = [];
  store.on('broadcast', (msg: Record<string, unknown>) => broadcasts.push(msg));
  const herdr = fakeHerdr();
  const bridge = new HerdrBridge({ store, request: herdr.request, log: () => {} });
  return { store, broadcasts, herdr, bridge };
}

describe('HerdrBridge', () => {
  it('joins agents to herdr panes by Claude session id and broadcasts once per change', async () => {
    const { store, broadcasts, herdr, bridge } = setup();
    store.set(1, createTestAgent({ id: 1 }));
    herdr.agents = [herdrAgent('sess-a', 'w1:p3')];

    await bridge.refresh();
    expect(broadcasts).toEqual([
      {
        type: 'agentHerdrInfo',
        id: 1,
        paneId: 'w1:p3',
        workspaceLabel: 'alpha',
        title: 'Refactor parser',
        status: 'working',
      },
    ]);
    expect(store.get(1)?.folderName).toBe('alpha');

    await bridge.refresh();
    expect(broadcasts).toHaveLength(1);

    herdr.agents = [herdrAgent('sess-a', 'w1:p3', { agent_status: 'blocked' })];
    await bridge.refresh();
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1].status).toBe('blocked');
  });

  it('ignores herdr agents that belong to no tracked session', async () => {
    const { store, broadcasts, herdr, bridge } = setup();
    store.set(1, createTestAgent({ id: 1 }));
    herdr.agents = [herdrAgent('someone-else', 'w1:p9'), { pane_id: 'w1:p8', workspace_id: 'w1' }];
    await bridge.refresh();
    expect(broadcasts).toEqual([]);
  });

  it('uses the hook-forwarded pane until agent.list knows the session, then prefers agent.list', async () => {
    const { store, broadcasts, herdr, bridge } = setup();
    store.set(1, createTestAgent({ id: 1 }));
    bridge.noteHookEvent({
      session_id: 'sess-a',
      herdr: { pane_id: 'w1:p1', workspace_id: 'w1' },
    });
    await bridge.refresh();
    expect(broadcasts.at(-1)).toMatchObject({ paneId: 'w1:p1', workspaceLabel: 'alpha' });
    expect(bridge.workspaceLabelFor({ sessionId: 'sess-a' })).toBe('alpha');

    // The pane moved to another workspace: herdr reissues the pane id.
    herdr.workspaces.push({ workspace_id: 'w2', label: 'beta' });
    herdr.agents = [herdrAgent('sess-a', 'w2:p1', { workspace_id: 'w2' })];
    await bridge.refresh();
    expect(broadcasts.at(-1)).toMatchObject({ paneId: 'w2:p1', workspaceLabel: 'beta' });
  });

  it('focuses the current pane on click, re-reading agent.list first', async () => {
    const { store, herdr, bridge } = setup();
    store.set(1, createTestAgent({ id: 1 }));
    herdr.agents = [herdrAgent('sess-a', 'w1:p3')];
    await bridge.refresh();
    herdr.agents = [herdrAgent('sess-a', 'w1:p7')];

    await expect(bridge.focusAgent(1)).resolves.toBe(true);
    expect(herdr.calls.at(-1)).toEqual({ method: 'agent.focus', params: { target: 'w1:p7' } });
  });

  it('never focuses anything for an agent herdr does not know', async () => {
    const { store, herdr, bridge } = setup();
    store.set(1, createTestAgent({ id: 1 }));
    await expect(bridge.focusAgent(1)).resolves.toBe(false);
    await expect(bridge.focusAgent(42)).resolves.toBe(false);
    expect(herdr.calls.some((c) => c.method === 'agent.focus')).toBe(false);
  });

  it('only ever calls read methods while polling', async () => {
    const { store, herdr, bridge } = setup();
    store.set(1, createTestAgent({ id: 1 }));
    herdr.agents = [herdrAgent('sess-a', 'w1:p3')];
    await bridge.refresh();
    await bridge.refresh();
    expect(new Set(herdr.calls.map((c) => c.method))).toEqual(
      new Set(['agent.list', 'workspace.list']),
    );
  });

  it('survives herdr being unreachable and keeps the last known links', async () => {
    const { store, broadcasts, herdr, bridge } = setup();
    store.set(1, createTestAgent({ id: 1 }));
    herdr.agents = [herdrAgent('sess-a', 'w1:p3')];
    await bridge.refresh();
    herdr.fail = true;
    await expect(bridge.refresh()).resolves.toBeUndefined();
    expect(bridge.isConnected).toBe(false);
    expect(broadcasts).toHaveLength(1);
  });

  it('replays every linked agent to a new client', async () => {
    const { store, herdr, bridge } = setup();
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2, sessionId: '', jsonlFile: '/p/sess-b.jsonl' }));
    herdr.agents = [herdrAgent('sess-a', 'w1:p3'), herdrAgent('sess-b', 'w1:p4')];
    await bridge.refresh();
    const sent: Array<Record<string, unknown>> = [];
    bridge.resend((m) => sent.push(m));
    expect(sent.map((m) => m.paneId)).toEqual(['w1:p3', 'w1:p4']);
  });

  it('derives the session id from the transcript name when the hook id is absent', () => {
    expect(sessionIdOf(createTestAgent({ sessionId: '', jsonlFile: '/x/abc-123.jsonl' }))).toBe(
      'abc-123',
    );
  });
});

describe('focusAgent client message', () => {
  it('is honored only for privileged (tokened) clients', () => {
    const store = new AgentStateStore();
    const focused: number[] = [];
    const ctx = { store, cache: null, onFocusAgent: (id: number) => focused.push(id) };
    handleClientMessage({ type: 'focusAgent', id: 3 }, () => {}, { ...ctx, privileged: false });
    handleClientMessage({ type: 'focusAgent', id: 'x' }, () => {}, { ...ctx, privileged: true });
    handleClientMessage({ type: 'focusAgent', id: 4 }, () => {}, { ...ctx, privileged: true });
    expect(focused).toEqual([4]);
  });
});

describe('createHerdrRequest', () => {
  let server: net.Server | null = null;
  let dir: string | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function listen(onLine: (line: string, socket: net.Socket) => void): Promise<string> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-test-'));
    const socketPath = path.join(dir, 'herdr.sock');
    server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf-8');
      socket.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl >= 0) onLine(buf.slice(0, nl), socket);
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    return socketPath;
  }

  it('sends one JSON line and resolves with the matching result', async () => {
    const socketPath = await listen((line, socket) => {
      const req = JSON.parse(line);
      expect(req).toMatchObject({ method: 'agent.list', params: {} });
      socket.end(JSON.stringify({ id: req.id, result: { type: 'agent_list', agents: [] } }) + '\n');
    });
    const request = createHerdrRequest(socketPath, 1000);
    await expect(request('agent.list')).resolves.toEqual({ type: 'agent_list', agents: [] });
  });

  it('rejects with herdr error codes', async () => {
    const socketPath = await listen((line, socket) => {
      const req = JSON.parse(line);
      socket.end(
        JSON.stringify({ id: req.id, error: { code: 'not_found', message: 'no pane' } }) + '\n',
      );
    });
    const request = createHerdrRequest(socketPath, 1000);
    await expect(request('agent.focus', { target: 'w9:p9' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('times out when herdr never answers', async () => {
    const socketPath = await listen(() => {});
    const request = createHerdrRequest(socketPath, 50);
    await expect(request('agent.list')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects when the socket does not exist', async () => {
    const request = createHerdrRequest('/nonexistent/herdr.sock', 1000);
    await expect(request('agent.list')).rejects.toBeInstanceOf(Error);
  });
});
