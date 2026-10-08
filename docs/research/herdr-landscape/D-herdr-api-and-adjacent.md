# D. herdr 통합 표면 + 인접 프로젝트 조사 (pixel-agents-herdr)

작성일: 2026-10-08 · 대상: herdr 0.8.2 (protocol 20, 로컬 설치본) · 업스트림 main은 0.9.3 (docs/next 기준 protocol 22)

증거 원본(scratchpad):

- `research/herdr/schema.json`: `herdr api schema --json` 전체 (255 KB)
- `research/herdr/agent_list.json`, `snapshot.json`, `skill.md`
- `research/repos/herdrdev-herdr/docs/versions/0.8.2/website/src/content/docs/{socket-api,plugins,session-state,integrations}.mdx`: 설치 버전과 같은 버전의 공식 문서
- `research/sub_probe.py`: read-only `events.subscribe` 실측 스크립트 (아래 2.4절 결과)

---

## 0. 요약 (TL;DR)

1. **socket protocol**: Unix socket (`$HERDR_SOCKET_PATH` = `~/.config/herdr/herdr.sock`)에 newline-delimited JSON을 보낸다. 요청은 `{"id","method","params"}`, 응답은 `{"id","result":{"type":...}}` 또는 `{"id","error":{"code","message"}}` 형태다. JSON-RPC 2.0이 아니라(`jsonrpc` 필드 없음) 그와 비슷한 자체 포맷이다. 메서드는 96개다.
2. **KEY FACT를 검증했다**: 지금 떠 있는 Claude pane 15개 모두 `agent_list[].agent_session.value`가 Claude Code `session_id`와 같다. 15개 모두 `~/.claude_work/projects/<hash>/<value>.jsonl`로 1:1 매칭됐다. 내 pane(`wS:p1`)의 value `aaaaaaaa-…`도 내 프로세스의 `CLAUDE_CODE_SESSION_ID`와 같다.
3. **join 경로가 2개 있다**: (A) `session_id` ↔ `agent_session.value`, (B) hook 프로세스가 상속받은 `HERDR_PANE_ID`. herdr 자체 Claude integration도 (B)를 쓰고 있다. hook 스크립트가 `$HERDR_PANE_ID`를 읽어 `pane.report_agent_session`을 호출하는데, 15/15에서 정상 동작한다. **(A)를 권위 있는 값으로, (B)를 즉시 쓸 수 있는 힌트로** 쓰는 혼합 전략을 권장한다.
4. **status 이벤트에는 함정이 있다**: `events.subscribe`에서 `pane.agent_status_changed`는 **`pane_id`가 필수**다. type만 주면 구독 전체가 `invalid_request`로 거부된다(실측). 전역 status 스트림은 plugin `[[events]]` hook으로만 받을 수 있다. socket 클라이언트는 agent pane마다 구독하거나, 전역 lifecycle 이벤트를 "wake hint"로 받아 `agent.list`로 resync해야 한다(herdr-radar 패턴).
5. 구독은 연결 직후 **최대 512개의 과거 이벤트를 replay**한다(실측 28줄). `pane.updated`를 구독하면 서버 응답이 느려진다(radar 측정 약 110 ms/write).
6. herdr의 Claude status는 **screen detection**에서 나온다. integration은 session id만 보고한다. 따라서 herdr의 `blocked`(승인 대기)는 pixel-agents의 7초 heuristic permission timer보다 확실한 신호다.
7. 주의: 이 머신은 `CLAUDE_CONFIG_DIR=~/.claude_work`이다(`.claude_personal`도 있다). `~/.claude/projects`를 하드코딩하는 코드는 깨진다. herdr-radar도 이 버그를 갖고 있다.
8. pixel-agents의 standalone `focusAgent`는 미구현이다(`server/src/clientMessageHandler.ts:273-276`). herdr의 `agent.focus`/`pane.focus`가 이 구멍에 정확히 들어맞는다. pixtuoid의 "click to focus"는 OS window 단위라서 multiplexer 안의 pane까지는 가지 못한다. 바로 herdr가 메워 줄 수 있는 차별점이다.

---

## PART 1. herdr 통합 표면

### 1.1 실행한 read-only 명령과 핵심 결과

| 명령                            | 결과 요약                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `herdr --version`               | `herdr 0.8.2`                                                                                                                                                                                    |
| `herdr status server --json`    | `{"status":"running","version":"0.8.2","protocol":20,"capabilities":{"live_handoff":true,"detached_server_daemon":true},"compatible":true,"socket":"~/.config/herdr/herdr.sock","session":null}` |
| `herdr api schema`              | `protocol: 20, schema_version: 1, schemas: error_response, event, request, subscription_event, success_response`                                                                                 |
| `herdr agent list`              | Claude pane 15개, 모두 `agent_session` 보유                                                                                                                                                      |
| `herdr workspace/tab/pane list` | workspace 10개 (`w3`…`wS`), id 형식 `wX`, `wX:tN`, `wX:pN`                                                                                                                                       |
| `herdr plugin list`             | `No plugins installed.`                                                                                                                                                                          |
| `herdr integration status`      | `claude: current (v8) (~/.claude_work/hooks/herdr-agent-state.sh)`. **CLAUDE_CONFIG_DIR 쪽에 설치됨**                                                                                            |
| `herdr --skill`                 | 공식 agent skill 문서 (`research/herdr/skill.md`)                                                                                                                                                |

pane 안에 주입되는 env (현재 pane 기준 실측):

```
HERDR_ENV=1
HERDR_SOCKET_PATH=~/.config/herdr/herdr.sock
HERDR_BIN_PATH=~/.local/bin/herdr
HERDR_WORKSPACE_ID=wS
HERDR_TAB_ID=wS:t1
HERDR_PANE_ID=wS:p1
```

문서상 "Herdr-managed variables are authoritative when they conflict with caller-provided env"(socket-api.mdx)이다. plugin 명령에는 추가로 `HERDR_PLUGIN_ID/ROOT/CONFIG_DIR/STATE_DIR/CONTEXT_JSON`, action에는 `HERDR_PLUGIN_ACTION_ID`, event hook에는 `HERDR_PLUGIN_EVENT` + `HERDR_PLUGIN_EVENT_JSON`, pane에는 `HERDR_PLUGIN_ENTRYPOINT_ID`가 주입된다. **popup placement에서는 `HERDR_PANE_ID`가 주입되지 않는다**.

### 1.2 socket protocol

- Transport: Unix domain socket (Windows는 named pipe). 한 줄에 요청 하나.
  ```json
  {"id":"req_1","method":"ping","params":{}}
  {"id":"req_1","result":{"type":"pong"}}
  {"id":"req_1","error":{"code":"not_found","message":"pane not found"}}
  ```
- 일반 요청은 짧은 connection 하나에 요청 하나를 보내는 식이다(herdr 자체 hook 스크립트도 그렇게 한다: connect, sendall, recv, close, timeout 0.5 s).
- 구독 connection은 ack 뒤에도 열려 있고 이벤트가 push된다. **ack 이후에는 클라이언트가 아무것도 쓰면 안 된다.** 서버는 streaming connection에 들어온 client byte를 disconnect로 취급한다(herdr-radar `lib/subscribe.js` 주석). 구독 집합을 바꾸려면 새 connection을 열어야 한다.
- socket 경로 결정 순서: `--session <name>`, `HERDR_SOCKET_PATH`, `HERDR_SESSION=<name>`, default 순이다. named session은 `~/.config/herdr/sessions/<name>/herdr.sock`을 쓴다.
- 호환성 확인: `ping` 또는 `herdr status server --json`의 `protocol`. 0.8.2는 20, main(0.9.3)은 22다. "Handle unknown fields gracefully."
- CLI 래퍼(`$HERDR_BIN_PATH agent list` 등)도 같은 JSON을 stdout으로 출력한다(`{"id":"cli:agent:list","result":{...}}`). 에러는 stderr로 JSON을 내고 exit 1, CLI 문법 오류는 exit 2다.

### 1.3 메서드 전체 목록 (0.8.2 schema 기준 96개)

| 영역                | 메서드                                                                                                                                                                                                                                                                                                                  | 시각화 관련성                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Server              | `ping`, `server.stop`, `server.live_handoff`, `server.reload_config`, `server.agent_manifests`, `server.reload_agent_manifests`                                                                                                                                                                                         | ping만                                                                    |
| Notification/Client | `notification.show`, `client.window_title.set/clear`                                                                                                                                                                                                                                                                    | 알림 연동                                                                 |
| Session             | **`session.snapshot`**                                                                                                                                                                                                                                                                                                  | 부트스트랩 (agents, panes, tabs, workspaces, layouts, focused_*)          |
| Workspace           | `workspace.create/list/get/focus/rename/move/move_block/report_metadata/close`                                                                                                                                                                                                                                          | list, get, focus, report_metadata                                         |
| Worktree            | `worktree.list/create/open/remove`                                                                                                                                                                                                                                                                                      | (provenance 표시)                                                         |
| Tab                 | `tab.create/list/get/focus/rename/move/close`                                                                                                                                                                                                                                                                           | list, focus                                                               |
| Agent               | **`agent.list`, `agent.get`, `agent.read`, `agent.explain`**, `agent.send_keys`, `agent.rename`, `agent.view.set/clear`, **`agent.focus`**, `agent.start`, `agent.prompt`, `agent.wait`                                                                                                                                 | 핵심                                                                      |
| Pane                | `pane.split/swap/move/zoom/layout/process_info/neighbor/edges/focus_direction/resize/list/current/get/focus/input.set/rename/send_text/send_keys/send_input/read/graphics.set/graphics.clear/graphics.info/report_agent/report_agent_session/report_metadata/clear_agent_authority/release_agent/close/wait_for_output` | list, get, layout, process_info, focus, read, report_metadata, graphics.* |
| Layout              | `layout.export/apply/set_split_ratio`                                                                                                                                                                                                                                                                                   | export (책상 배치 힌트)                                                   |
| Popup               | `popup.close`                                                                                                                                                                                                                                                                                                           |                                                                           |
| Events              | **`events.subscribe`**, `events.wait`                                                                                                                                                                                                                                                                                   | 핵심                                                                      |
| Integration         | `integration.install/uninstall`                                                                                                                                                                                                                                                                                         |                                                                           |
| Plugin              | `plugin.link/list/unlink/enable/disable`, `plugin.action.list/invoke`, `plugin.log.list`, `plugin.pane.open/focus/close`                                                                                                                                                                                                | plugin 배포                                                               |

0.8.2 이후 main에 추가된 메서드: `client_shell.surface.set`, `command.invoke`, `integration.list`, `pane.clear`, `pane.copy_motion`, `pane.copy_search`, `pane.edit_scrollback`, `pane.link.activate/resolve`, `pane.scroll`, `pane.selection.read`, `product_announcement.dismiss`, `release_notes.dismiss`, `server.ssh_agent.register`. 문서에는 `pane.graphics.stream`이 있지만 **0.8.2 schema에는 없다**. 버전 게이트가 필요하다.

### 1.4 시각화에 필요한 메서드 상세

**`agent.list`** (params `{}`). 응답 `result.agents[]: AgentInfo`:

```
required: terminal_id, agent_status, workspace_id, tab_id, pane_id, focused, revision
optional: agent ("claude"), agent_session {source, agent, kind: "id"|"path", value},
          display_agent, name (사용자가 붙인 agent 이름, [a-z][a-z0-9_-]{0,31}),
          cwd, foreground_cwd, title, terminal_title, terminal_title_stripped,
          state_labels {status→text}, tokens {name→value, ≤32},
          state_change_seq (u64, 정렬용), interactive_ready, launch_pending,
          screen_detection_skipped
```

실측 예 (현재 working 중인 pane):

```json
{
  "agent": "claude",
  "agent_session": {
    "agent": "claude",
    "kind": "id",
    "source": "herdr:claude",
    "value": "11111111-2222-3333-4444-555555555555"
  },
  "agent_status": "working",
  "cwd": "/work/project-a",
  "foreground_cwd": "/work/project-a",
  "focused": false,
  "pane_id": "wH:pJ",
  "revision": 4,
  "state_change_seq": 2974,
  "tab_id": "wH:tF",
  "terminal_id": "term_0000000000000",
  "terminal_title": "◑ 작업 제목 예시",
  "terminal_title_stripped": "작업 제목 예시",
  "workspace_id": "wH"
}
```

- `terminal_title_stripped`에는 Claude Code가 OSC title로 설정한 **세션 요약 제목**이 들어 있다(예: "리팩터링 계획 검토"). 캐릭터 이름표나 tooltip에 바로 쓸 수 있다. spinner glyph(✳, ◑)는 제거된 상태다. raw `terminal_title`의 leading glyph(✳ = idle, ◑ = working)도 보조 신호로 쓸 수 있다.
- `AgentStatus` = `idle | working | blocked | done | unknown`. `done`은 "idle이지만 아직 사용자가 보지 않음(unseen)"이다. **CLI/API 읽기는 seen 처리를 하지 않는다.** `agent.focus`/`pane.focus`나 탭 포커스만 seen으로 만든다. 따라서 pixel-agents가 polling해도 `done` 표시는 망가지지 않는다.
- `PaneAgentState`(report용)에는 `done`이 없다(`idle|working|blocked|unknown`). done은 서버가 seen 여부에서 파생하는 값이다.

**`agent.get {target}`**: target은 pane id 또는 고유 agent name이다(terminal id, agent kind는 불가).
**`agent.read {target, source: visible|recent|recent_unwrapped|detection, lines?, format: text|ansi, strip_ansi}`**: 말풍선이나 "마지막 출력 미리보기"에 쓸 수 있다. Claude Code는 alternate screen을 쓰므로 `recent`로는 scrollback이 안 나올 수 있다(skill 문서 경고).
**`agent.focus {target}`**: 해당 pane으로 UI 포커스를 옮기고 seen 처리한다. **focusAgent 구현에 쓸 메서드다.** 대체로 `pane.focus {pane_id}`도 쓸 수 있다. 다른 workspace에 있을 때의 동작(탭과 workspace 전환 여부)은 실측하지 않았다. mutating 금지 규칙 때문에 호출하지 않았고, 구현 단계에서 검증해야 한다.
**`agent.explain {target}`**: detection 근거(매칭 rule, manifest 버전)를 준다. 디버그 패널에 쓸 수 있다.
**`pane.process_info {pane_id}`**: shell pid, foreground 프로세스(pid, argv, cwd)를 준다. hook이 없는 세션의 fallback join(Claude pid와 pane 매칭)에 쓸 수 있다.
**`pane.layout` / `layout.export`**: tab의 BSP split tree와 rect다. "한 tab = 한 방, split 배치 = 책상 배치" 같은 공간 매핑 아이디어에 쓸 수 있다.
**`session.snapshot`**: `{agents, focused_pane_id, focused_tab_id, focused_workspace_id, layouts, panes, protocol, tabs, version, workspaces}`. **재연결할 때마다 이걸로 cache를 다시 만들고**, 그 뒤 이벤트로 갱신하는 것이 공식 권장 패턴이다.
**`workspace.list`**: `WorkspaceInfo {workspace_id, number, label, focused, pane_count, tab_count, active_tab_id, agent_status(rollup), tokens, worktree?}`. `label`(예: "project-b", "pixel-agents")을 office Area 이름으로 쓰기에 적합하다.

**역방향(pixel-agents가 herdr로 쓰기)**: `pane.report_metadata {pane_id, source, title?, display_agent?, state_labels?, tokens{≤16/report, ≤32/pane}, ttl_ms?, seq?, agent?, applies_to_source?}`. display 전용이라 lifecycle state에는 영향이 없다. 예를 들어 pixel-agents가 아는 "현재 tool"이나 context 사용률을 `$tool`, `$ctx` token으로 herdr sidebar에 띄울 수 있다. 값은 80자 상한이다. source당 seq는 단조 증가해야 하고, pane당 sequenced source는 수명 동안 최대 32개다. `workspace.report_metadata`는 `workspace.metadata_updated`를 발생시키지만 plugin hook은 트리거하지 않는다.

**`notification.show {title, body?, position?, sound: none|done|request}`**: herdr 설정(`ui.toast.delivery`, 이 머신은 `"system"`)을 따른다. pixel-agents의 chime과 역할이 겹치므로 둘 중 하나를 선택해야 한다.

**`agent.view.set`**: herdr sidebar의 Agents 목록을 선언적으로 filter/sort한다(source `plugin:<id>`). pixel-agents에서 캐릭터를 선택할 때 sidebar도 같은 agent를 강조하는 연동이 가능하다.

**실험 기능 `pane.graphics.*`**: `[experimental].kitty_graphics = true`일 때만 동작하고 아니면 `feature_disabled`다. PNG/RGBA 프레임을 pane 위에 overlay한다. 이론상 **pixel office를 herdr pane 안에 직접 그릴 수 있다**(headless canvas → PNG → `pane.graphics.set`). 0.8.2에는 stream이 없어서 프레임마다 base64 요청을 보내야 하므로 비용이 크다. 장기 옵션으로 둔다.

### 1.5 이벤트 (events.subscribe / events.wait)

구독 type (`Subscription` oneOf, 0.8.2):

- 전역(type만 지정): `workspace.created/updated/metadata_updated/renamed/moved/reordered/closed/focused`, `worktree.created/opened/removed`, `tab.created/closed/focused/renamed/moved`, `pane.created/closed/updated/focused/moved/exited`, **`pane.agent_detected`**, `layout.updated`
- **pane 지정 필수**: `pane.agent_status_changed {pane_id, agent_status?}`, `pane.output_matched {pane_id, source, match, lines?}`, `pane.scroll_changed {pane_id}`

**실측 결과** (`research/sub_probe.py`, read-only):

```
[{"type":"pane.agent_status_changed"}]
  -> {"id":"","error":{"code":"invalid_request","message":"invalid request: missing field `pane_id` at line 1 column 115"}}
[{"type":"pane.agent_status_changed","pane_id":"wS:p1"}]
  -> {"id":"probe","result":{"type":"subscription_started"}}   (agent_status 필터가 없으면 초기 이벤트 없음)
[{"type":"pane.agent_detected"},{"type":"pane.focused"}]
  -> ack 후 2.5초 동안 28줄. 과거 이벤트 replay 포함:
     {"data":{"agent":"claude","pane_id":"wS:p1","type":"pane_agent_detected","workspace_id":"wS"},"event":"pane_agent_detected"}
     {"data":{"pane_id":"w5:p2","type":"pane_focused","workspace_id":"w5"},"event":"pane_focused"}
```

- **envelope 이름 규칙이 두 가지다.** broadcast 이벤트는 snake_case(`"event":"pane_focused"`, `data.type` 동일)이고, pane 지정 구독 이벤트는 dotted(`"event":"pane.agent_status_changed"`)다. 파서는 둘 다 처리해야 한다.
- `PaneAgentStatusChangedEvent.data`: `{pane_id, workspace_id, agent_status, agent?, title?, display_agent?, state_labels?}`. 상태뿐 아니라 presentation이 바뀔 때도 발생한다(`src/app/api.rs:720` 근처).
- 연결 시 `EventHub` ring buffer(`MAX_EVENTS = 512`, `src/api/event_hub.rs:19`)를 replay한다. 의미 있는 이벤트로 쓰지 말고, 받으면 "resync 해라"라는 신호로만 다루는 편이 안전하다.
- radar 주석에 따르면 구독당 약 10 events/s throttle이 있다. **`pane.updated`/`workspace.metadata_updated`를 구독하면 자기가 쓴 token의 echo를 받게 되고 서버 응답도 느려진다.** report_metadata를 쓸 거라면 이 둘은 구독하지 않는다.
- live handoff나 server reload 때 구독 connection이 끊긴다. backoff로 재연결하고 snapshot을 다시 받아야 한다. socket 파일이 사라지면 서버가 종료된 것이다.
- `events.wait {match_event: EventMatch, timeout_ms?}`: 1회성 대기용이다. 시각화에는 쓰지 않는다.

**전역 status 스트림을 얻는 방법 (택1 또는 조합)**

1. **plugin `[[events]] on = "pane.agent_status_changed"`**: 서버가 모든 pane의 변화마다 명령을 spawn한다(herdr-event-log 방식). 단순하지만 이벤트마다 프로세스가 하나씩 뜬다. radar는 이 비용 때문에 이 방식을 버렸다.
2. **socket 구독 하나 + per-pane 구독 동적 재구성**: 전역 `pane.created/closed/exited/agent_detected/focused`, `workspace.*`, `tab.*`를 받다가 agent pane 집합이 바뀌면 `pane.agent_status_changed{pane_id}` 목록을 담은 새 connection으로 교체한다.
3. **wake-hint + `agent.list` resync (radar 방식, 권장)**: 어떤 이벤트든 오면 debounce(~~100 ms) 후 `agent.list`를 한 번 호출해서 diff한다. replay, throttle, 두 가지 envelope 문제가 모두 무의미해진다. agent 15개 규모에서는 agent.list 비용이 무시할 만하다. 단 per-pane 구독 없이는 status 변화 자체가 wake를 만들지 못한다. 그래서 2와 섞거나 1~~2 s 주기 heartbeat poll을 추가한다.

### 1.6 status의 출처 (authority 모델)

- Claude Code integration v8 (`~/.claude_work/hooks/herdr-agent-state.sh`)은 **`SessionStart` hook에서 `pane.report_agent_session`만** 보낸다. 실제 status(`working/blocked/idle`)는 **herdr의 screen manifest detection**에서 나온다(integrations.mdx: "State still comes from Herdr's screen manifest detection").
- 그 hook 스크립트의 주요 동작:
  - `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` 중 하나라도 없으면 아무것도 하지 않는다.
  - payload에 `agent_id`가 있으면(= subagent) 무시한다. `SubagentStop`도 무시한다.
  - 보내는 params: `{pane_id, source:"herdr:claude", agent:"claude", seq: time_ns, agent_session_id: session_id, agent_session_path: transcript_path, session_start_source: source}`
  - 따라서 `/clear`(source=clear)나 `--resume`으로 session id가 바뀌면 SessionStart가 다시 발생해 갱신된다.
- `agent_session_path`(= transcript_path)도 서버로 보내지만, `agent.list`는 `kind:"id"`인 value 하나만 노출한다. **JSONL 경로는 직접 찾아야 한다** (`$CLAUDE_CONFIG_DIR/projects/*/<id>.jsonl`, 여러 config root를 glob).
- herdr의 native session restore(`claude --resume <id>`)가 이 reference를 사용한다(session-state.mdx). 서버를 재시작해도 pane과 session의 결합은 유지된다. pixel-agents의 persisted agents 복원과 궁합이 좋다.

### 1.7 KEY FACT 검증과 join 전략 평가

**검증 1. agent_session.value = Claude session_id (15/15)**

```
w4:p4 99999999 ~/.claude_work/projects/-home-user-project-b/99999999-….jsonl
…(중략, 15개 전부 매칭)…
wS:p1 aaaaaaaa ~/.claude_work/projects/-work-pixel-agent/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl
```

`wS:p1`(나 자신)의 value는 내 env `CLAUDE_CODE_SESSION_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`와 같다. pixel-agents의 hook payload `session_id`와 같은 값이다(herdr hook이 바로 그 stdin JSON의 `session_id`를 보고한다).
참고: `~/.claude/projects`에서는 0/15가 매칭됐다. 이 머신은 `CLAUDE_CONFIG_DIR=~/.claude_work`이다.

**검증 2. hook 프로세스가 HERDR_PANE_ID를 상속받는다**
herdr 공식 integration이 `HERDR_PANE_ID`를 hook 안에서 읽어 pane에 보고하고, 그 결과로 15개 pane이 모두 `agent_session`을 갖는다. 즉 Claude Code가 hook 자식 프로세스에 부모 env를 그대로 넘긴다는 사실이 실증됐다. pixel-agents hook(`~/.pixel-agents/hooks/claude-hook.js`)도 같은 `~/.claude_work/settings.json`에 이미 등록되어 있으므로 같은 env를 받는다.

| 전략                       | 방식                                                                                                                 | 장점                                                                                                                                                                            | 단점 / 함정                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(A) session_id join**    | 서버가 `agent.list`를 받아 `Map<agent_session.value, pane_id>`를 만든다. pixel-agents agent의 `sessionId`로 조회한다 | herdr가 권위 있게 유지한다. **pane move**(workspace 간 이동 시 pane id가 새로 발급됨)에도 최신 pane id를 준다. hook 수정 없이 동작한다. 서버 재시작이나 restore 후에도 유지된다 | herdr Claude integration이 설치되어 있어야 한다(v6 이상, 현재 v8). SessionStart 이전, 또는 integration이 설치되기 전에 시작된 세션은 매핑이 없다. subagent는 매핑되지 않는다(의도된 동작, 부모 pane을 쓰면 된다). 반영까지 hook 왕복 + polling 지연이 있다                                                                       |
| **(B) HERDR_PANE_ID 주입** | pixel-agents `claude-hook.ts`가 POST body에 `herdr:{pane_id, workspace_id, tab_id, socket_path}`를 덧붙인다          | 모든 hook 이벤트(첫 SessionStart 포함)에서 즉시 사용할 수 있다. herdr integration이 없어도 동작한다. 여러 herdr session(socket)을 구분할 수 있다                                | **stale 위험**: `pane.move`로 workspace가 바뀌면 새 public pane id가 발급되고, 옛 id는 "moved process의 inherited context에서만" resolve된다(skill.md). 즉 pixel-agents 서버가 옛 id로 `agent.focus`를 호출하면 실패할 수 있다. Claude를 herdr 밖에서 띄웠다가 attach한 경우에는 env가 없다. hook payload 스키마를 확장해야 한다 |
| (C) fallback               | `pane.process_info`의 foreground pid/argv/cwd와 Claude 프로세스를 매칭, 또는 `cwd` 매칭                              | 둘 다 실패할 때의 보험                                                                                                                                                          | cwd는 모호하다(같은 cwd에 pane이 여러 개, 예: `wH`에 project-a pane 6개). 비용이 크다                                                                                                                                                                                                                                            |

**권장**: (B)로 즉시 tentative 매핑을 만들고, (A)가 도착하면 덮어쓴다(A가 권위). focus 직전에 `agent.get {target: pane_id}`로 `agent_session.value == sessionId`인지 재확인하고, 불일치하면 (A)로 재조회한다. `agent.list` 응답의 `pane_id`가 늘 최신이므로 focus는 항상 (A) 결과로 한다.

---

### 1.8 Plugin 시스템

**manifest** `herdr-plugin.toml` (plugin root 또는 직접 경로):

```toml
id = "owner.pixel-agents"          # 필수, [A-Za-z0-9.:_-]
name = "Pixel Agents"               # 필수
version = "0.1.0"                   # 필수
min_herdr_version = "0.8.2"         # 필수, 실행 중인 버전보다 높으면 link/install 거부
description = "…"
platforms = ["linux","macos"]       # 생략하면 link는 되지만 warning

[[build]]      command = [...]      # GitHub install 시에만 실행. runtime env 없음. link 시에는 실행 안 함
[[startup]]    command = [...]      # 서버 restore 후 1회 실행(live handoff 때도). one-shot이므로 daemon은 detach 필요
[[actions]]    id, title, command, contexts = ["global"|"workspace"|"tab"|"pane"|"selection"], description?, platforms?
[[events]]     on = "<event name>", command = [...]   # on은 문자열 1개. 여러 개면 블록을 반복
[[panes]]      id, title, command, placement = "overlay"(기본)|"popup"|"split"|"tab"|"zoomed", width?, height?
[[link_handlers]] id, title, pattern(Rust regex), action   # Ctrl+클릭한 URL을 action으로 라우팅
```

- `command`는 **argv 배열이고 shell을 거치지 않는다**(`~`, `$HOME`이 확장되지 않는다. herdmates는 `sh -c`로 우회). cwd는 plugin root다. CLI 호출에는 `$HERDR_BIN_PATH`를 쓰는 것을 권장한다.
- 디렉터리: config는 `herdr plugin config-dir <id>`(`HERDR_PLUGIN_CONFIG_DIR`, `.env` 같은 사용자 설정), state는 `HERDR_PLUGIN_STATE_DIR`. herdmates 소스(`src/paths.rs`)에 따르면 기본값은 `~/.config/herdr/plugins/config/<id>`, `~/.local/state/herdr/plugins/<id>`이다. 레지스트리는 `session.json` 옆의 `plugins.json`이다. Herdr가 관리하는 storage API는 없다.
- 키바인딩: `[[keys.command]] key="prefix+p" type="plugin_action" command="owner.pixel-agents.open"`
- `plugin.pane.open {plugin_id, entrypoint, placement?, target_pane_id?, workspace_id?, direction?, width?, height?, focus, env, cwd}`. popup은 singleton이고 pane id나 lifecycle 이벤트가 없다.
- `HERDR_PLUGIN_CONTEXT_JSON`(PluginInvocationContext)에는 `focused_pane_id/agent/cwd/status`, `workspace_id/label/cwd`, `tab_id/label`, `worktree`, `selected_text`, `clicked_url` 등이 있다. 예를 들어 action "이 pane의 agent를 office에서 보기"를 구현하는 데 쓸 수 있다.
- 배포: GitHub topic `herdr-plugin`을 달면 marketplace에 자동으로 색인된다(30분 주기). 설치는 `herdr plugin install owner/repo[/subdir]`.

**pixel-agents-herdr plugin 형태 제안**

- `[[startup]]`: `node dist/cli.js --port 3100`을 detached로 실행한다(radar처럼 `detached + unref`, pid lock). pixel-agents에 이미 있는 `~/.pixel-agents/servers` 레지스트리 덕분에 중복 기동이 방지된다.
- `[[actions]] open`: `xdg-open http://127.0.0.1:3100/?token=…`. office는 브라우저 canvas라서 terminal pane에 그대로 넣을 수 없다.
- `[[panes]] status`(popup): 서버 URL, 토큰, 연결 상태를 보여 주는 작은 TUI. 선택 사항이다.
- `[[events]] on="pane.agent_detected"`: radar처럼 daemon watchdog 용도로만 쓴다(daemon이 죽었으면 재기동).
- 장기 옵션: `pane.graphics` 기반 in-pane 렌더.

---

## PART 2. 인접 프로젝트 분석

모두 `research/repos/<owner>-<name>`에 `--depth 1`로 clone했다. 읽기만 했고 설치, 빌드, 실행은 하지 않았다.

### 2.1 hhdebb/herdr-radar (Node, v1.4.2, min_herdr 0.9.0, 커밋 1ba8cc4 2026-10-04)

**하는 일**: herdr sidebar의 Agents 목록을 "누가 일하고, 누가 나를 기다리고, 누가 방치됐는지"가 보이게 바꾼다. 자체 UI 없이 `pane.report_metadata` token과 config.toml의 `[ui.sidebar.*]` row style만으로 그린다.

**사용 데이터**

- `agent.list`/`session.snapshot`: status, `terminal_title_stripped`/`title`, `foreground_cwd`, `focused`, `tab_id`, `workspace_id`, `agent_session.value`
- `events.subscribe` 하나를 wake hint로 쓰고 resync한다 (`lib/subscribe.js`, KINDS: `pane.agent_status_changed, pane.created, pane.closed, pane.exited, pane.agent_detected, pane.focused, workspace.created/closed/renamed/focused, tab.renamed`)
- **Claude JSONL tail**: 마지막 `timestamp` 라인으로 "마지막 활동 시각"을 복원한다 (`lib/activity.js:60-90, 159-168`). Codex, Kilo도 지원한다.

**훔칠 만한 UX 아이디어**

- **State 7단계** (`lib/state.js:32`): `working, done, blocked, idle_fresh(≤15분), idle(15~120분), idle_stale(≥120분), unknown`. idle을 "마지막 turn 이후 경과 시간"으로 세 단계로 나눈다(`lib/activity.js:195-203`, config `activity_fresh_minutes=15`, `activity_stale_minutes=120`). pixel-agents에 적용하면: 방금 끝남은 자리에서 대기, 15분 경과는 휴게실로 이동, 2시간 방치는 엎드려 자기/조명 끄기/반투명.
- **"done은 볼 때까지 유지, blocked는 다시 일할 때까지 유지"**: herdr의 done은 seen 개념이 있어 금방 idle로 바뀌므로, 표시를 따로 latch해 둔다(`lib/state.js:312-316`의 "held done"). pixel-agents에서는 체크 말풍선이 캐릭터를 클릭(focus)할 때까지 남아 있는 식이다.
- **workspace 우선순위 rollup** (`lib/state.js:849-858`): `blocked > working > done > idle_fresh > idle > idle_stale > unknown`. 방(Area) 입구 표시등이나 미니맵 색에 쓸 수 있다.
- **그룹 구조**: workspace 헤더, git worktree는 repo 아래 tree, 같은 tab의 split pane은 묶어서 표시, 가장 바쁜 프로젝트가 위. pixel-agents에서는 workspace = 방, worktree = 같은 방의 칸막이, 같은 tab의 pane들 = 붙어 있는 책상으로 옮길 수 있다.
- **"recent" 평면 정렬과 "active" 그룹 정렬 토글** (`bin/agent-view.js`, `agent.view.set` 사용). sidebar 정렬을 pixel-agents와 동기화하는 데 참고할 만하다.
- vendor별 logo와 색(`lib/logos.js`, `assets/marks/*.svg`). 다중 CLI 캐릭터 구분에 쓸 수 있다.

**함정과 교훈**

- `lib/activity.js:163`이 `~/.claude/projects`를 **하드코딩**했다. CLAUDE_CONFIG_DIR 환경(이 머신)에서는 활동 시각 복원이 전부 실패한다.
- 0.8.2에서는 `{type:"pane.agent_status_changed"}`만 주면 구독 전체가 거부된다(위 실측). radar는 min_herdr 0.9.0이지만 main 소스도 여전히 `pane_id`가 필수다(`src/api/schema/events.rs:75-80`). radar는 이 줄 때문에 에러 ack 후 재연결 루프에 빠질 가능성이 있다. 우리는 그대로 따라 하면 안 된다.
- `pane.updated`를 구독하면 자기 token write의 echo 때문에 write 응답이 약 110 ms로 느려진다(`lib/subscribe.js` 주석). report_metadata를 쓰면서 pane.updated를 구독하면 안 된다.
- **mtime은 믿을 수 없다**: 재attach할 때 Claude가 timestamp 없는 `last-prompt` 같은 라인을 append하므로 mtime이 최근으로 바뀐다. 마지막 `timestamp` 필드를 써야 한다(`lib/activity.js:62-67`). pixel-agents의 stale 판정에도 해당되는 교훈이다.
- token 값의 leading whitespace는 trim된다. zero-width space로 우회하는 핵이 있다(`lib/state.js` INDENT). row style이 token "이름"에 묶이므로 상태별로 token 이름을 바꿔 가며 써야 한다.
- startup hook은 one-shot이므로 daemon은 `detached + unref`와 pid lock으로 관리한다. Windows에서는 install 중인 checkout 안에 cwd를 둔 프로세스가 rename을 막는다(manifest 주석 #23).

### 2.2 waynewu411/herdr-event-log (Go, 125줄, min_herdr 0.7.0)

**하는 일**: `[[events]] on="pane.agent_status_changed"`, `command=["./hook"]`. 모든 pane의 status 변화를 `$HERDR_PLUGIN_STATE_DIR/events-<sha256(socket)[:16]>.log`에 JSON line으로 append한다(`main.go`).

**사용 데이터**: `HERDR_PLUGIN_EVENT_JSON`. envelope의 `data` 아래 또는 top-level에 `pane_id, workspace_id, agent_status, agent`가 있다(`main.go:66-72`, 두 형태 모두 방어적으로 처리).

**아이디어**

- **plugin event hook은 전역 status 스트림을 받는 유일한 공식 경로**다. socket 구독은 pane마다 해야 한다. 이 차이를 처음 명확히 보여 준 사례다.
- **durable history**: socket 구독은 연결이 없을 때의 이벤트를 잃는다(512 ring replay는 있다). append-only log와 cursor로 "pixel-agents 서버가 꺼져 있던 동안의 변화"를 재생할 수 있다. 예를 들어 office의 "오늘 타임라인"이나 replay 기능을 만들 수 있다.
- 로그 파일명을 socket path 해시로 정해 herdr session별로 분리한다. 다중 session을 지원할 때 참고할 만하다.
- `scripts/herdr-ewait.sh`: 로그 tail로 hit를 찾은 뒤 `herdr agent get`으로 **live 재검증**한다. 이벤트를 단서로만 쓰고 진실은 get으로 확인하는 원칙이다. radar와 같은 철학이다.

**함정**: 이벤트마다 프로세스를 하나씩 spawn한다. 바이너리를 커밋하지 않으므로 `make build`가 필요하다. 로그 rotation이 없다. **관찰된 0.7.x 문서 사실**: `on`은 단일 문자열이다(`[[events]]`를 반복해야 함).

### 2.3 caioniehues/herdmates (Rust, v3.2.0, min_herdr 0.7.4, linux/macos)

**하는 일**: Claude Code의 **native agent teams**(`teammateMode: tmux`)를 herdr에 연결한다. 가짜 `tmux` 바이너리와 가짜 `TMUX` env(teammux shim, `src/teammux.rs`, `src/tmuxargs.rs`)를 두고, Claude가 호출하는 `split-window`, `respawn-pane`, `kill-pane`, `select-pane -T`, `display-message`, `list-panes`를 `herdr pane split/run/close/rename/get/layout`으로 번역한다. 그래서 **teammate 하나하나가 실제 herdr pane이 된다**. tmux `%N` id와 herdr pane id는 idmap 파일로 매핑한다(`IdMap::allocate`, `src/teammux.rs:320-370`).

**사용 데이터**

- Claude team 파일: `~/.claude/teams/{team}/config.json`(members[].`agentId`, `name`, `tmuxPaneId`), `~/.claude/teams/{team}/inboxes/{agent}.json`, `~/.claude/tasks/{team}/{n}.json`(blockedBy DAG), `~/.claude/projects/*/<sessionId>.jsonl` mtime(`src/gather.rs:76-82, 283, 512, 606`)
- herdr: `agent.list` status, `pane report-metadata` token(`$task`, `$status`, source `herdmates-board`)
- Claude team hooks `TeammateIdle/TaskCreated/TaskCompleted`를 spool하고 recorder JSONL로 만든다(`src/team_hook.rs`, `src/recorder.rs`)

**훔칠 만한 아이디어**

- **Signal engine** (`src/signal_engine.rs:105-170`)의 waiting reason 우선순위: `PermissionPrompt(herdr blocked) > BlockedOnDependency(task blockedBy 미완료) > Stalled{Quiet ≥5분 | Stalled ≥10분, transcript mtime 기준; unread inbox ≥2분이면 가속} > TurnComplete > Waiting(근거 없음)`. **"틀린 이유를 표시하느니 이유 없는 waiting으로 degrade한다"**는 원칙이다. pixel-agents의 말풍선 종류(권한, 의존성 대기, 멈춤, 완료)에 그대로 옮길 수 있다.
- badge는 20자 이내의 telegraphic 문구(`MAX_BADGE_VISIBLE_CHARS`): "permission", "blocked→#3", "stalled 12m".
- **pixel-agents teammate 모드와의 관계**: pixel-agents CLAUDE.md 표의 "Session teammate (teams + tmux): own session, own hooks"가 herdmates 환경에서는 "teammate = 별도 herdr pane + 자기 session_id + 자기 HERDR_PANE_ID"가 된다. **(A)/(B) join이 teammate에게도 그대로 적용된다**. lead와 teammate가 같은 tab의 split pane이므로 "같은 tab = 같은 팀 책상 군집" 배치가 자연스럽다. teammate pane의 tmux id(`%N`)는 config.json `tmuxPaneId`에 남으므로, herdmates idmap을 읽으면 team member를 herdr pane으로 역매핑할 수도 있다.
- ADR-0015: 독자적인 board/focus UI를 삭제하고 native lead에 기능을 몰아줬다. 이유는 "team dir이 session마다 생겨서 standalone surface에서는 어느 팀인지 모호함"이었다(README "Surfaces"). pixel-agents도 team 식별은 session 기반(`leadSessionId`/`session-<8hex>`)으로 해야 한다는 같은 교훈이다.

**함정**

- team 경로를 `~/.claude/...`로 하드코딩했다(CLAUDE_CONFIG_DIR 무시).
- README의 "hard-won facts": 잘못된 sidebar token 이름은 조용히 실패한다(`reload-config`가 "partial"). agent가 없는 pane은 sidebar에 나오지 않는다.
- shim이 claude wrapper(zsh 함수)를 필요로 해서 침습적이다. 사용자 환경에 따라 teammate pane이 나올 수도 있고 in-process로 돌 수도 있다. pixel-agents는 두 경우를 모두 처리해야 한다.

### 2.4 rolandal/pixel-agents-standalone (TS, 커밋 a8c73c0 2026-08-12)

**정체**: 원조 pixel-agents v1 시절(VS Code 전용)을 Express + WS로 standalone화한 초기 fork다. 지금 upstream에는 공식 standalone(`npx pixel-agents`, Fastify)이 있으므로 아키텍처적 가치는 낮다.

**변경점**

- `server/watcher.ts`: chokidar와 1 s poll로 `~/.claude/projects/` 감시. `ACTIVE_THRESHOLD_MS = 600_000`(mtime 10분 이내면 활성, Claude가 5분 넘게 생각할 수 있다는 주석).
- `server/parser.ts`: JSONL만 파싱한다(hook 없음).
- `webview-ui/src/components/AgentLabels.tsx`: 캐릭터 머리 위에 **항상 보이는 이름표 + 상태 점**(waiting = 노랑, active = 파랑 pulse)을 둔다. label 우선순위는 `subagent label > folderName(projectName) > "Agent #id"`. upstream의 `alwaysShowLabels` 설정과 같은 계열이다.
- `scripts/cmux-hook.sh`: **SessionStart hook에서 서버 auto-launch**(health check 후 없으면 기동, pid 파일). 이름에 cmux가 들어간 것을 보면 multiplexer 사용자를 겨냥한 것이다. herdr에서는 `[[startup]]`이 같은 역할을 더 깔끔하게 한다.

**훔칠 만한 것**: 이름표에 herdr의 `terminal_title_stripped`를 쓰면 folderName보다 훨씬 정보가 많다. SessionStart 기반 lazy-launch 패턴도 있다.
**함정**: `~/.claude` 하드코딩, `/tmp` 로그, `kill` stale pid, 10분 mtime heuristic(radar가 지적한 mtime 왜곡에 취약), hook 미지원.

### 2.5 IvanWng97/pixtuoid (Rust TUI, 커밋 21c29b1 2026-10-07, 활발함)

**정체**: pixel-agents 코드의 fork가 아니라 **개념적 파생작**이다. half-block pixel art로 **터미널 안에서** 렌더한다. crate는 `pixtuoid-core`(state/source/reducer), `-scene`(렌더, 452 파일), `-hook`(shim), `-web`(사이트 데모), 메인 TUI로 구성된다. herdr 언급은 전혀 없다(grep 0건).

**사용 데이터**: hook shim(Unix socket에 200 ms fire-and-forget을 보내고 항상 exit 0, `crates/pixtuoid-hook/`)과 JSONL 감시를 합쳐 하나의 channel과 reducer로 처리한다. Claude Code, Codex 등 14종 이상의 CLI를 지원한다. `CLAUDE_CONFIG_DIR`을 처리한다(`crates/pixtuoid-core/src/platform.rs`).

**훔칠 만한 UX** (README Features 표와 해당 소스)

- **cwd 기반 팀 팔레트**: 같은 repo는 같은 셔츠와 바지 색, 머리와 피부는 agent별로 다르다. 방이 조직도처럼 읽힌다. herdr workspace 기반으로 바꾸면 더 정확해진다.
- **도구별 모니터 glow**: Edit = 파랑, Bash = 주황, Read = 청록. 방 전체를 한눈에 읽을 수 있다.
- **token meter** (`crates/pixtuoid-scene/src/token_meter.rs`): 책상 위 종이 더미가 250K/2M/16M 단계로 쌓인다. cache read를 제외한 fresh token 누적값을 쓴다. pixel-agents의 `contextUsage`와는 다른 축(소비량)이다.
- **multi-floor**: 책상이 차면 새 층이 생긴다. herdr workspace를 층에 매핑할 수도 있다.
- **Tab 대시보드** (`crates/pixtuoid/src/tui/widgets/dashboard.rs`): 모든 agent의 접이식 tree, CLI badge, 상태 색, tool 호출 수.
- hover tooltip: session 길이, tool 호출 수, active-time %.
- `?` = 나를 기다림, z's = done/sleep. 상태를 기호로 즉시 보여 준다.
- **click to focus** (`crates/pixtuoid/src/focus/{linux,macos,windows}.rs`, `crates/pixtuoid-hook/src/cli_pid.rs`): hook envelope에 CLI pid(`_pid`)를 찍는다. 끼어 있는 shell(sh/bash/zsh/…)을 건너뛰며 조상을 따라가서 terminal emulator window를 찾고, sway/hyprland IPC나 X11 `_NET_ACTIVE_WINDOW`로 활성화한다.

**함정과 기회**: click to focus는 **OS window 단위**다. herdr, tmux, zellij 안에서는 모든 agent가 같은 terminal window를 공유하므로 window만 올라오고 **pane까지는 가지 못한다**. GNOME Wayland에서는 아예 동작하지 않는다(주석 "silent no-op"). herdr `agent.focus`는 pane 단위로 정확하고 OS 제약도 없다. **pixel-agents-herdr의 핵심 차별점**이 된다.

---

## 3. pixel-agents 아키텍처에 herdr를 붙이는 지점

pixel-agents 로컬 clone 기준(`/data/try/pixel_agent/src/pixel-agents`, v1.4.1). "core는 무의존, server는 core만 의존" 계층 규칙을 지키려면 **herdr 코드는 server/ 안의 새 모듈**(예: `server/src/herdr/`)에 두고, Claude 특화 로직은 `providers/hook/claude/`에 둔다.

### 3.1 새 컴포넌트: `HerdrBridge` (server/src/herdr/)

- `HERDR_SOCKET_PATH`가 있거나 기본 경로에 socket 파일이 있을 때만 활성화한다. 없으면 no-op이므로 기존 동작에 영향이 없다.
- 부팅할 때 `ping`(protocol ≥ 20 확인)과 `session.snapshot`으로 cache를 만든다: `panes`, `agents`, `workspaces`, `tabs`, `layouts`.
- 구독 connection은 1.5절의 전략 3을 따른다. 전역 kinds(`pane.created/closed/exited/agent_detected/focused/moved`, `workspace.created/closed/renamed/focused`, `tab.created/closed/renamed/focused`, `layout.updated`)와 **agent pane별 `pane.agent_status_changed{pane_id}`**를 구독하고, agent 집합이 바뀌면 connection을 교체한다. 이벤트는 debounce 후 `agent.list` resync의 트리거로만 쓰고, 1~2 s heartbeat를 둔다. `pane.updated`와 `workspace.metadata_updated`는 구독하지 않는다.
- 노출 API: `paneForSession(sessionId)`, `sessionForPane(paneId)`, `workspaceLabelFor(sessionId|cwd)`, `statusFor(sessionId)`, `focus(sessionId)`, `reportMetadata(sessionId, tokens)`
- 이벤트 envelope는 두 형태(`pane_focused` / `pane.agent_status_changed`)를 모두 파싱한다. 512 replay는 무시한다(resync 하나로 흡수).

### 3.2 seam별 매핑표

| #   | pixel-agents seam (파일:라인)                                                                                                                                                                                                             | 현재 상태                              | herdr capability                                                                         | 구현 메모                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`server/src/clientMessageHandler.ts:273-276` `default:` 분기**. 주석 "focusAgent, exportLayout, importLayout require IDE-specific handling (not yet implemented for standalone)"                                                        | standalone에서 캐릭터 클릭이 무반응    | `agent.focus {target: pane_id}` (또는 `pane.focus`)                                      | `case 'focusAgent'`를 추가한다. `store.get(id).sessionId`, `bridge.paneForSession`, `agent.focus` 순서로 처리한다. 호출 직전에 `agent.get`으로 session을 재확인한다. **`ctx.privileged` gate를 검토할 것**(untokened WS 클라이언트가 사용자 포커스를 훔칠 수 있다, CLAUDE.md 2-tier 정책). VS Code 쪽 구현은 `adapters/vscode/PixelAgentsViewProvider.ts:444` 참고 |
| 2   | **`server/src/providers/hook/claude/hooks/claude-hook.ts:151-194` `main()`**. stdin JSON을 그대로 `JSON.stringify(data)`해서 POST                                                                                                         | env 정보 없음                          | join (B): `HERDR_PANE_ID/WORKSPACE_ID/TAB_ID/SOCKET_PATH`                                | `data.herdr = {pane_id: process.env.HERDR_PANE_ID, …}`(HERDR_ENV=1일 때만). 비용이 0이고 hook timeout(5 s)에 영향이 없다                                                                                                                                                                                                                                           |
| 3   | `server/src/hookEventHandler.ts:143` `normalizeHookEvent(event)` / `server/src/agentRuntime.ts:291` `handleHookEvent`                                                                                                                     | raw의 `herdr` 필드를 버림              | (B) 힌트 소비                                                                            | `AgentEvent`(core/provider.ts)를 바꾸지 않으려면 handleHookEvent에서 raw.herdr와 session_id를 꺼내 `bridge.hint(sessionId, pane)`로 사이드채널 처리한다. 계층 규칙을 지킬 수 있다                                                                                                                                                                                  |
| 4   | **`server/src/fileWatcher.ts:612-622` `setFolderNameResolver`** (VS Code 전용, standalone은 `path.basename(cwd)` fallback, 사용처 `:1088`, `:1118`, `:1537`)                                                                              | standalone의 folderName = cwd basename | `workspace.list[].label` (사용자가 지은 workspace 이름, 예: "project-b", "pixel-agents") | cli.ts에서 `setFolderNameResolver(({cwd}) => bridge.workspaceLabelFor(cwd))`를 등록한다. **시그니처에 sessionId가 없어서** cwd만으로는 모호하다(같은 cwd의 다른 workspace). resolver ctx에 `sessionId?`를 추가하는 소규모 변경을 권장한다. 동기 함수이므로 bridge cache에서 조회한다                                                                               |
| 5   | **`AgentCreated.folderName` / `ExistingAgents.folderNames`** (`core/asyncapi.yaml:173-192, 222-238`), `server/src/agentStateStore.ts:166`, `server/src/httpServer.ts:176`                                                                 | 문자열 하나                            | workspace label, tab label, pane title                                                   | 프로토콜 변경 없이 folderName에 workspace label을 싣는 것이 최소 변경이다. 확장할 때는 `AgentCreated`에 optional `herdr:{workspaceId, tabId, paneId, title}`을 추가한다. asyncapi를 수정하고 `npm run asyncapi:generate`를 돌린다(CI drift check 대상)                                                                                                             |
| 6   | **Area 매핑**: `clientMessageHandler.ts:256-265` `saveAreaMappings` → `config.standalone.areaMappings`; `webview-ui/src/office/engine/officeState.ts:76-105, 349-368` `findFreeSeat(folderName)`이 `areaMappings[folderName]`로 좌석 선택 | 사용자가 folder와 Area를 수동으로 매핑 | workspace = Area 자동 매핑                                                               | #4로 folderName이 workspace label이 되면 기존 Area UI가 그대로 동작한다. 처음 볼 때 `areaMappings[label] ??= [label]`을 seed해 주는 옵션도 있다. radar의 workspace 우선순위 rollup으로 Area 표시등을 만들 수 있다                                                                                                                                                  |
| 7   | `AgentSelected` 메시지 (asyncapi "An agent's terminal was focused (VS Code only)"), webview `useExtensionMessages.ts:471`                                                                                                                 | standalone에서 미사용                  | 이벤트 `pane.focused`(전역)                                                              | herdr에서 pane을 포커스하면 해당 캐릭터를 하이라이트한다. **양방향 동기화**(office 클릭 → herdr focus, herdr focus → office 하이라이트)                                                                                                                                                                                                                            |
| 8   | `server/src/timerManager.ts` permission timer (7 s heuristic), CLAUDE.md "Sub-agent permission detection (heuristic)"                                                                                                                     | hooks off일 때 추정                    | `agent_status == "blocked"` (screen detection, 확정 신호)                                | hooks-off 모드나 `hookDelivered`가 false인 agent의 permission bubble 근거로 쓴다. hooks-on에서는 PermissionRequest hook이 우선이고 herdr는 교차 검증에만 쓴다                                                                                                                                                                                                      |
| 9   | Turn-end, "Done" vs "Waiting for input" (claude.ts `idle_prompt` → `awaitingInput`)                                                                                                                                                       | hook 기반                              | herdr `done`(unseen) vs `idle`(seen)                                                     | done 체크 말풍선을 사용자가 볼 때까지 유지한다(radar의 held-done). idle을 시간 단계로 나눠 freshness 연출을 한다(radar 15/120분, herdmates 5/10분)                                                                                                                                                                                                                 |
| 10  | `server/src/contextUsage.ts`, tool status (`formatToolStatus`)                                                                                                                                                                            | office에만 표시                        | `pane.report_metadata` tokens (`$tool`, `$ctx`)                                          | 역방향 연동으로 herdr sidebar에서 pixel-agents가 아는 정보를 볼 수 있다. source는 `pixel-agents`로 하고 seq는 단조 증가시킨다. pane.updated를 구독하지 않는 것과 짝을 이룬다                                                                                                                                                                                       |
| 11  | `providers/` (`server/src/providers/index.ts`, HookProvider 계약 `core/src/provider.ts`)                                                                                                                                                  | Claude 하나                            | `agent.list`에 있는 비-Claude agent(codex, pi 등 17종 detection)                         | HookProvider가 아니라 bridge 기반 **"herdr-only agent"**: hook이 없는 CLI도 `agent_detected`, status만으로 캐릭터를 만든다. tool 정보는 없고 working/idle/blocked만 있다. CONTEXT.md의 "Headless agent"/ghost 개념(`ghostHeadlessAgents`, `configPersistence.ts:11`)과 정합을 검토해야 한다                                                                        |
| 12  | `providers/hook/claude/claudeTeamProvider.ts` (`~/.claude/teams/<name>/config.json`), "Session teammate (teams + tmux)" 모드                                                                                                              | 자체 session과 hook으로 라우팅         | teammate = herdr pane (herdmates shim 사용 시)                                           | teammate도 (A)/(B) join이 그대로 적용되므로 teammate 캐릭터 클릭 → teammate pane focus. 같은 `tab_id`이면 같은 책상 군집에 배치. `config.json` `tmuxPaneId`(`%N`)와 herdmates idmap으로 보조 매핑                                                                                                                                                                  |
| 13  | `server/src/providers/hook/claude/claudeConfigDir.ts` `getClaudeConfigDir()` (서버 프로세스의 `CLAUDE_CONFIG_DIR` 하나만 사용)                                                                                                            | config root 하나만 스캔                | `agent_session.value`로 session id를 확보                                                | 다중 계정(`~/.claude_work`, `~/.claude_personal`) 환경에서 file-fallback은 한 root만 본다. herdr가 준 session id로 `~/.claude*/projects/*/<id>.jsonl`을 찾는 resolver를 추가할 수 있다. hook ingress는 root와 무관하게 동작한다                                                                                                                                    |
| 14  | ClientMessage `launchAgent` (standalone 미배선)                                                                                                                                                                                           | —                                      | `pane.split` + `agent.start --kind claude`                                               | **mutating 동작이므로 privileged 전용**이다. 2단계 기능으로 미룬다                                                                                                                                                                                                                                                                                                 |
| 15  | `closeAgent` (`clientMessageHandler.ts:94-106`, office에서 제거만)                                                                                                                                                                        | dismiss                                | (`pane.close`는 쓰지 말 것)                                                              | herdr pane을 닫는 기능은 넣지 않는다. skill 규칙상 "직접 만들지 않은 pane은 닫지 않는다". 현재처럼 office에서만 dismiss한다                                                                                                                                                                                                                                        |
| 16  | 알림 `webview-ui/src/notificationSound.ts`                                                                                                                                                                                                | 브라우저 chime                         | `notification.show {sound:"request"/"done"}`                                             | herdr 사용자는 이미 herdr toast와 sound를 받고 있다(이 머신은 `ui.toast.delivery="system"`, sound enabled). 중복 알림 설정이 필요하다                                                                                                                                                                                                                              |
| 17  | 서버 수명 (`server/src/cli.ts`, `~/.pixel-agents/servers` 레지스트리)                                                                                                                                                                     | 수동 실행                              | plugin `[[startup]]` + `pane.agent_detected` watchdog                                    | radar 패턴: detach/unref, pid lock, startup은 one-shot                                                                                                                                                                                                                                                                                                             |

### 3.3 우선순위 제안

1. **MVP**: HerdrBridge(snapshot, agent.list polling) + #1 focusAgent + #2/#3 env 힌트 + #4 workspace label을 folderName으로. 프로토콜 변경 없이 "클릭하면 herdr pane으로 점프"와 "workspace별 방 배치"가 된다.
2. **상태 보강**: #8 blocked, #9 done-latch와 idle freshness, #7 pane.focused 하이라이트, `terminal_title_stripped`를 이름표로(asyncapi optional 필드 추가).
3. **역방향과 확장**: #10 sidebar token, #11 비-Claude agent, #12 herdmates teammate, plugin 패키징(#17).
4. **실험**: `pane.graphics`로 herdr pane 안에 office 렌더(kitty_graphics 실험 플래그, 0.9.x의 stream 필요).

### 3.4 구현 단계에서 검증해야 할 미확인 사항

- `agent.focus`가 다른 workspace나 tab에 있는 pane을 대상으로 할 때 workspace/tab 전환까지 하는지. 이번 조사에서는 mutating 금지라 미실측이다.
- 클라이언트가 attach되어 있지 않을 때(`no_foreground_client`) focus의 의미.
- `/clear` 직후 새 session_id의 SessionStart 보고와 pixel-agents `/clear` 감지 사이의 race.
- 0.9.x 업그레이드 시 protocol 22 변경점(새 메서드는 1.3절 목록, subscription의 pane_id 필수는 유지).
