# C. 3D / 데스크톱 계열 herdr 시각화 프로젝트 분석

대상: `screenagers-io/bullpen`, `luiscleto/weherd`, `HEM42/agent-view`, `Luckystrike561/terrarium`
조사일: 2026-10-08. 모두 `--depth 1` clone 후 소스를 읽기만 했고, 설치·빌드·실행은 하지 않았다. 코드 위치(file:line)는 각 clone 기준이다.
clone 위치: `scratchpad/research/repos/<owner>-<name>`. terrarium PR #20 파일 일부는 `scratchpad/research/pr20/`에 있다.

---

## 0. 한눈에 비교

|                    | bullpen                                                               | weherd                                                     | agent-view                              | terrarium                                                                         |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| Stars / forks      | 0 / 0                                                                 | 3 / 0                                                      | 0 / 0                                   | 1 / 1                                                                             |
| 생성 → 마지막 push | 2026-09-04 → 09-05                                                    | 09-05 → 09-05                                              | 09-28 → 09-28 (커밋 날짜는 06-11~12)    | 09-30 → 10-07 (활발)                                                              |
| 커밋 수            | 7                                                                     | 2                                                          | 3                                       | 10 (+ open PR #20)                                                                |
| License            | MIT (GitHub에는 "Other"로 표시)                                       | 없음                                                       | 없음                                    | MIT                                                                               |
| Stack              | Node(의존성 0) + vanilla three.js(vendored), 단일 `index.html` 1882줄 | Node + `ws` 브리지, Vite + TS + three + xterm.js           | Electrobun(Bun) + Canvas 2D 384×216     | **pixel-agents v1.4.1 fork**, Fastify + React 19 + PixiJS(isometric)              |
| 형태               | 로컬 웹서버 + 브라우저(3D 복셀 오피스)                                | 로컬 웹서버 + 브라우저(WASD로 플레이)                      | macOS 프레임리스 데스크톱 위젯          | standalone 웹서버(+ VS Code 확장도 빌드됨)                                        |
| herdr 접근         | CLI `herdr api snapshot`, 1s 폴링                                     | Unix socket NDJSON `session.snapshot`, 1.8s(브라우저 주도) | CLI `herdr agent list`, 1Hz             | socket JSON-RPC `agent.list`+`workspace.list`+`tab.list` 2.5s, `events.subscribe` |
| 세부 활동          | **Claude JSONL**(herdr가 준 session id로 찾음)                        | 없음                                                       | 없음                                    | **omp** JSONL만 (`agent_session.value` 경로)                                      |
| 제어               | focus, prompt, read, rename, start/close agent, workspace 생성·닫기   | 실제 interactive terminal(xterm), 닫기("샷건")             | focus만                                 | 없음(읽기 전용)                                                                   |
| 성숙도             | 기능은 가장 풍부, 1인 1~2일 작업                                      | 범위 작음, 보안·identity가 꼼꼼함                          | 범위 작음, 상태 debounce와 FSM이 단단함 | 아키텍처가 가장 성숙(테스트, e2e, AsyncAPI), herdr 지원은 아직 부분적             |

네 개 모두 AI가 생성한 코드다(weherd README에 "Vibe-coded"라고 명시). 셋은 사실상 1회성 작업이다. 유지보수가 진행 중인 것은 terrarium 하나다.

---

## 1. screenagers-io/bullpen — 3D 복셀 오피스

### Meta

- `README.md` 1행에서 "in the spirit of pixel-agents"라고 밝힌다. fork는 아니다. three.js r(vendored), 빌드 단계와 npm dependency가 없다. Node ≥18.17.
- 설치: `curl …/install.sh | sh`(herdr, private Node, bullpen을 모두 설치), `npm i -g git+…`, macOS `.app` 런처.
- 실행: `bullpen` → `http://127.0.0.1:4877` 서버를 띄우고 브라우저를 연다. 서버가 이미 떠 있으면 페이지만 연다(`bin/bullpen.mjs`). `--demo`, `--poll <ms>`, `--herdr <path>`, `--host`를 지원한다.

### Data source (`server.mjs`)

- **herdr CLI exec**: `herdr(args)`(108–125). `execFile`로 실행하고 stdout JSON을 받아 `parsed.error`를 확인한 뒤 `parsed.result`를 꺼낸다. 바이너리는 PATH 외에 `~/.local/bin`, Homebrew, Nix, mise 같은 installer 폴더에서도 찾는다(GUI 런처는 PATH가 짧기 때문). ENOENT가 나면 캐시를 리셋한다(118).
- **폴링**: `buildState()`(458–525). 1초마다 `herdr api snapshot` 한 번. 결과의 `snapshot.workspaces/tabs/panes/agents`와 `focused_*_id`를 workspace→tab→pane 트리로 재구성한다.
- **Claude transcript 결합** (가장 중요한 부분):
  - herdr snapshot의 pane에는 `agent_session: { kind: 'id', value: <claude session uuid> }`가 들어 있다. bullpen은 `kind === 'id'`일 때만 사용한다(470–471).
  - `findTranscript(sessionId, cwd)`(136–155)는 먼저 `~/.claude/projects/<cwd를 [^a-zA-Z0-9]→'-'로 치환>/<id>.jsonl`을 보고, 없으면 `projects/*` 전체를 훑는다. 결과는 sessionId별로 캐시한다.
  - `readActivity`(251–272)는 파일 **끝 256KB만** 읽고, `(size, mtime)`가 같으면 캐시를 쓴다.
  - `parseActivity`(186–249)는 `isSidechain`을 제외하고 `tool_use`/`tool_result`를 짝지어 `toolInFlight`, `pendingAgents`(아직 결과가 없는 Agent/Task 호출 수 = 진행 중인 subagent 수), `lastTool{name, category, detail}`, `lastUserPrompt`, `lastTs`, `toolTimes`(최근 400개)를 만든다.
  - tool 분류는 read/write/run/agent/ask/mcp/other(157–171), 요약은 `summarize`(173–184: file basename, bash 첫 줄, pattern, url host…).
- **Agent kind 목록**: herdr state의 `agent-detection/status.toml`에서 `[agents.<kind>]`를 정규식으로 추출한다(395–415). 시작할 수 있는 kind 목록은 `herdr completion zsh` 출력의 `KIND:(...)`를 파싱하고, 각 CLI 바이너리가 login-shell PATH에 있는지 확인한다(417–454). 공식 API가 없어서 쓴 우회 방식이라 깨지기 쉽다.
- **브라우저 전송**: SSE `/events`(620–628). payload가 바뀌었거나 10초가 지났을 때만 broadcast한다(541–560). 새 클라이언트에는 `latestState`를 즉시 보낸다.
- **mutation 이후 즉시 재폴링**: 모든 POST가 끝나면 `setTimeout(poll, 150~300)`을 건다. 체감 지연을 줄이는 간단한 방법이다.
- 다중 머신: 없음. `--host 0.0.0.0`로 LAN에서 보기만 할 수 있고 인증은 없다.

### 제어 API (`server.mjs` 616–838)

| endpoint             | herdr 명령                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/focus`         | `herdr agent focus <pane>`, 실패하면 `herdr tab focus <tab>`(셸 pane일 때)                                                                                                                           |
| `/api/prompt`        | `herdr agent prompt <pane> <text>`                                                                                                                                                                   |
| `/api/read`          | `herdr pane read <pane> --lines N --format text`                                                                                                                                                     |
| `/api/explain`       | `herdr agent explain <pane>`                                                                                                                                                                         |
| `/api/rename`        | `herdr agent rename <pane> <name>` / `--clear`                                                                                                                                                       |
| `/api/agent/new`     | `herdr tab create --workspace … --cwd … --label … --no-focus` 또는 `herdr pane split --pane … --direction right --no-focus`, 그다음 `herdr agent start <name> --kind <k> --pane <p> --timeout 90000` |
| `/api/agent/close`   | `herdr pane close` (마지막 pane이면 `tab close`). `confirm=yes` 필수                                                                                                                                 |
| `/api/workspace/new  | rename                                                                                                                                                                                               | close` | `herdr workspace create --cwd --label --no-focus` / `rename` / `close` |
| `/api/herdr/start`   | `herdr server`를 detached로 띄우고 `api snapshot`이 성공할 때까지 최대 15초 대기(305–316)                                                                                                            |
| `/api/open-terminal` | herdr TUI 프로세스를 `ps`로 찾아(`isTuiCommandLine`) macOS에서는 부모 `.app`을 거슬러 올라가 `open -a`로 앞에 띄운다. 없으면 터미널 에뮬레이터로 `herdr`를 실행한다(318–391)                         |

- CSRF와 DNS rebinding 방어: `allowedHost` + Origin/`Sec-Fetch-Site` 검사(590–614). pixel-agents-herdr도 localhost 서버에서 herdr를 제어한다면 그대로 가져올 만하다.

### State model / 활동 도출 (`public/index.html`)

- 기본 상태는 herdr의 `agent_status`(working/idle/blocked/done/unknown)를 그대로 쓴다.
- **STATE_DWELL = 1.2s**(219, 1295): pendingState가 1.2초 동안 유지돼야 반영한다(flap 억제).
- `desiredPlace()`(1239–1244):
  - blocked → help desk **queue**(도착 순서대로 줄을 서고 맨 앞은 wave, 나머지는 fidget, 1249)
  - done → meeting table(축하 hop, ✓)
  - idle → transcript `lastTs` 기준 1분 미만이면 desk에서 휴식, 이후 lounge(커피), **30분 이상이면 bed(💤)**. idle 타이머를 herdr 상태 전이 시각이 아니라 transcript의 마지막 활동 시각에서 계산한다(1267–1268). "방금 턴을 끝낸 에이전트가 곧장 커피를 마시러 가지 않게" 하려는 설계다.
  - working → desk에서 typing.
- tool 이벤트(1274–1280): 새 `lastTool.id`가 오면 말풍선(📖✏️⚙️👥💬)을 띄운다. write면 desk에 종이를 쌓고 run이면 모니터를 깜빡인다. 첫 관찰은 무시한다(재접속 시 과거를 replay하지 않도록).
- 새 user prompt는 따옴표 말풍선(1272)으로, terminal title 변경도 말풍선(1281)으로 보여준다.
- **subagent**: `pendingAgents` 수(최대 3)만큼 helper가 문으로 들어와 desk 주변에 모이고, 끝나면 나간다(1282–1291).
- 색과 캐릭터: `KIND_CAST`(437)로 claude→Luma, codex→Rivet처럼 kind별 캐릭터를 고정하고, agent마다 hue shift를 준다. 사용자 아바타 override는 localStorage에 저장한다(443).

### 시각·상호작용

- 클릭하면 herdr에서 focus, 더블클릭하면 terminal 읽기(popup), 우클릭하면 메뉴. `b` 키는 다음 blocked 에이전트로 카메라를 옮긴다. Follow 모드도 있다.
- 실제 데이터를 반영하는 소품: easel(focused pane 출력을 2.5초마다 갱신), 갤러리 벽(workspace별 최근 30분 tool calls/min 차트, 1087), 마스코트 선반(kind별, working이면 bounce), 식물(활동량에 따라 자람), 칸반 보드(agent 포스트잇이 Idle/Doing/Needs You/Done 열에 붙음, 1152), LED 띠(blocked 있으면 주황, working이면 초록, 1149), 실제 시계와 시간대별 조명.
- 레이아웃: **workspace당 desk bank 하나, pane당 desk 하나**. herdr 토폴로지를 공간 구조로 그대로 옮겼다.

### 훔칠 만한 아이디어

1. **herdr `agent_session`(kind:'id') → Claude JSONL 경로 매핑** (`server.mjs:132–155, 470–474`). pixel-agents의 기존 JSONL 파서를 herdr pane에 붙이는 가장 직접적인 연결 고리다. hooks 없이도 Claude pane의 tool 수준 세부 정보를 얻을 수 있다.
2. tail 256KB + (size, mtime) 캐시로 매 폴링마다 상태를 다시 계산하는 stateless 파서(251–272). incremental offset 방식보다 단순하고 재시작에 강하다. 대신 비용이 든다.
3. 상태별 장소 매핑(blocked=queue, done=meeting, 장기 idle=bed)과 **idle 경과 시간을 transcript 기준으로 계산**하는 방식.
4. herdr가 없을 때 `herdr server`를 headless로 띄워주는 버튼.
5. "Blocked (n)" 버튼과 `b` 단축키로 다음 blocked 에이전트로 점프.
6. workspace→desk bank 매핑. 칸반 보드나 LED 같은 "앰비언트 집계 표시".

### 한계·함정

- 매초 `herdr` 프로세스를 spawn한다(exec 오버헤드). socket이나 events를 쓰지 않는다.
- tool 세부 정보는 Claude에만 있다. 다른 kind는 herdr 상태만 보여준다.
- `status.toml`이나 `completion zsh` 파싱은 herdr 내부 형식에 의존한다.
- 프론트가 단일 1882줄 HTML이라 구조를 재사용하기 어렵다.
- `--host 0.0.0.0`이면 인증 없이 원격에서 에이전트를 제어할 수 있다(README에 경고가 있다).
- Windows 경로는 실제로 검증되지 않았다(README에 명시).

---

## 2. luiscleto/weherd — 걸어다니는 Three.js 오피스 + 실시간 터미널

### Meta

- 2커밋, 하루 작업. license 없음. Codex가 생성했다(README에 명시). Node ≥22, Vite + TS + three 0.183 + `@xterm/xterm` 6 + `ws`.
- 실행: `npm run dev`로 bridge(4317)와 vite(5173)를 함께 띄우거나, `npm run build && npm start`. Herdr 0.8.2 / protocol 20에서 검증했다.

### Data source (`server/herdr.mjs`, `server/index.mjs`, `server/PROTOCOL.md`)

- **Unix socket NDJSON 직접 호출**: `HerdrClient.request(method, params)`(herdr.mjs:96–124). 요청마다 새 연결을 열고 `{id, method, params}\n`을 보낸 뒤 첫 줄 응답을 받으면 연결을 끊는다. 응답 id 일치 여부와 8MB 상한을 검사한다.
- socket 경로 해석(`defaultSocketPath`, 12–21): `HERDR_SOCKET_PATH`, 그다음 `HERDR_CONFIG_PATH` dir, 그다음 `HERDR_SESSION` → `…/sessions/<name>/herdr.sock`, 마지막으로 `~/.config/herdr/herdr.sock`. herdr 자신의 해석 순서를 따르므로 이름 있는 세션도 지원한다(terrarium #18이 지적한 누락을 이미 해결했다).
- 사용 메서드: `session.snapshot`(상태), `tab.create`(대체 셸), `pane.close`, `workspace.close`.
- **protocol 버전 gate**: `[19, 20].includes(snapshot.protocol)`가 아니면 거부(35). 버전이 바뀌면 바로 disconnected가 된다.
- 폴링: **브라우저가 1.8초마다 `/api/state`를 호출**하고(main.ts:258), 그때마다 서버가 socket snapshot을 1회 수행한다. push나 events는 없다.
- Claude hooks, transcript, usage: 없음. 다중 머신: 없음.

### 실시간 터미널 (이 레포의 핵심)

- `TerminalSession`(herdr.mjs:138–194): `herdr terminal session control <terminal_id> --cols --rows`를 `shell:false`, argv 배열, `HERDR_SOCKET_PATH`를 명시해 spawn한다. 이 CLI가 herdr의 binary terminal transport를 NDJSON으로 바꿔준다.
  - 수신 frame: `{type:'terminal.frame', encoding:'ansi', full, seq, width, height, bytes(base64)}`. seq 단조 증가, 첫 frame은 full, 이후에는 seq+1 연속인지 엄격히 검증한다(166).
  - 송신: `{type:'terminal.input', text}`, `{type:'terminal.resize', cols, rows}`. 종료할 때는 `{type:'terminal.release'}` 후 SIGTERM을 보낸다. PTY와 에이전트는 계속 살아 있다.
  - `observe` 모드 옵션도 있다(141). 읽기 전용으로 붙을 수 있다.
- 브라우저 쪽: WS `/api/terminal?paneId&identity`를 xterm.js에 연결한다(main.ts:197–233). 입력은 16ms 배치로 모으고, **보낼 때마다 snapshot을 다시 떠서 identity를 재검증**한다(index.mjs:152–162). 1.5초마다 재검증하고 15초마다 ping/pong을 한다.
- Esc는 터미널로 전달하고, Shift+Esc로 패널을 닫는다(main.ts:231).

### Identity 모델

- `agentIdentity` = sha256(`pane_id, workspace_id, terminal_id, agent, name, agent_session`)의 앞 32 hex(27–32). 클라이언트는 이 값을 들고 다니며, close나 input을 보낼 때 서버가 fresh snapshot과 비교한다(`selectAgent`, 63–69). 같은 pane에 다른 에이전트가 들어온 경우를 409로 막는다.
- `normalizeSnapshot`(34–61): `agent || display_agent || launch_pending`만 에이전트로 본다. `launch_pending`은 working으로 처리한다. 이름은 `name → terminal_title_stripped → title → "<kind> · <pane>"` 순으로 정한다. cwd는 `foreground_cwd → cwd → pane.cwd` 순이다.

### State / 시각

- 상태는 herdr의 5개 그대로다. working은 desk에서 laptop, blocked는 빨간 몸에 머리를 감싸 쥐는 모션, idle/done은 커피 테이블, unknown은 "STANDING BY"(office.ts:297–309, 427–441).
- **라벨 밀도 휴리스틱**(office.ts:439): 선택됐거나 인원이 8명 이하일 때 라벨을 보인다. blocked는 22명 미만일 때까지 보인다.
- 게임 요소: WASD 이동, E로 가까운 에이전트의 터미널 열기, Q로 샷건을 들고 쏘면 해당 에이전트를 닫는다. 기본값은 idle/done만 닫을 수 있고 working/blocked는 보호된다.

### 훔칠 만한 아이디어

1. **`herdr terminal session control|observe` NDJSON 어댑터 + xterm.js**: 월드 안에서 실제 터미널을 여는 방법이다. 서버 쪽 약 60줄(herdr.mjs:138–194). pixel-agents-herdr에서 캐릭터를 클릭했을 때 열리는 "터미널 보기" 패널을 만들 때 그대로 참고할 수 있다.
2. **identity fingerprint + 액션 직전 재검증**: herdr에는 atomic compare-and-act가 없으므로 race를 최소화하는 패턴이다.
3. socket 경로 해석 순서(`HERDR_SOCKET_PATH`/`HERDR_SESSION`/config dir).
4. herdr는 마지막 pane을 닫으면 workspace도 함께 없앤다. 이를 피하려고 **대체 셸 tab을 먼저 만들고 확인한 다음에 닫는 패턴**(index.mjs:53–72). 실전에서 겪은 함정이다.
5. linked worktree 그룹(`worktree.repo_key`, `is_linked_worktree`)을 닫을 때 cascade를 거부한다(herdr.mjs:80–85). snapshot에 worktree 메타가 있다는 근거이기도 하다.
6. 라벨 밀도 휴리스틱. "blocked만 우선 표시"하는 규칙은 사람이 많은 사무실에서 유용하다.

### 한계·함정

- 상태가 herdr 5단계뿐이라 tool 세부 정보가 없다.
- 폴링이 클라이언트 주도라서 탭을 여러 개 열면 herdr 호출도 그만큼 늘어난다.
- protocol 19/20 하드 gate. herdr protocol 22(terrarium이 확인)에서는 바로 끊긴다.
- 이미 control lease가 있는 터미널은 가로채지 않는다. 사용자가 herdr TUI로 같은 pane을 보고 있으면 충돌할 수 있다(PROTOCOL.md).
- license가 없어 코드를 그대로 복사하기는 어렵다. 아이디어만 참고해야 한다.

---

## 3. HEM42/agent-view — Electrobun 사이버펑크 픽셀 오피스

### Meta

- 3커밋(2026-06-11~12에 작성, 09-28에 push). license 없음. Bun + Electrobun(Electron이 아니라 시스템 WKWebView), Canvas 2D. macOS arm64 Homebrew cask로 배포한다.
- 형태: 1172×682 프레임리스 투명 창 위젯. 드래그 이동, `◎` always-on-top, `×` 종료(`src/bun/index.ts:44–53`).

### Data source (`src/bun/herdr.ts`)

- **CLI `herdr agent list`**를 1Hz로 호출한다. 오프라인일 때는 2초, 미설치일 때는 5초로 back-off한다(212–217). exec 타임아웃 3초에 SIGKILL(89, 137–138).
- 파싱(51–82): herdr는 실패해도 JSON `{"error":…}`를 내고 exit 1로 끝나므로 error 키를 명시적으로 확인한다. `result.agents[]`에서 `terminal_id, agent, agent_status, cwd, focused`만 꺼낸다.
- **Identity는 `terminal_id`**다(types.ts:7). 정렬해서 순서를 안정적으로 유지한다.
- `done`은 idle로 합친다(41). 알 수 없는 상태는 `unknown`으로 처리해 "버전 drift가 방을 오프라인으로 만들지 않게" 한다.
- 제어: `herdr agent focus <id>` 하나뿐이다(더블클릭).
- hooks, transcript, usage, 다중 머신: 없음.
- 바이너리 탐색: Finder에서 실행하면 PATH가 짧으므로 `/opt/homebrew/bin`, `~/.local/bin`, `~/.bun/bin`을 직접 확인한다(97–118). 마지막 커밋이 바로 이 버그 수정이다. 데스크톱이나 런처 형태라면 반드시 필요한 처리다.

### State model (가장 깔끔한 부분)

- **비대칭 debounce**(`debounceStatus`, 273–296): 새 상태는 2회 연속 poll에서 관측돼야 확정한다. 단 **blocked는 즉시 확정**한다("손을 드는 것이 앱의 존재 이유이므로 지연이 flapping보다 나쁘다"). 새 agent의 첫 상태도 즉시 반영한다.
- **오프라인 판단**(221–245): 연속 3회 실패하면 offline. 그 전까지는 마지막 정상 데이터를 다시 보내는 grace window를 둔다. 복구는 정상 poll 1회로 즉시 이뤄진다. 렌더러는 5초 동안 신호가 없으면 link lost로 본다(types.ts:20). 오프라인이면 방을 암전하고 "OFFLINE" 배너를 띄운다. 오래된 데이터를 조용히 보여주지 않는다.
- 렌더 FSM(`characters/fsm.ts`): `ENTERING/WALKING/WORKING/RAISING_HAND/WATCHING_TV/AT_BAR/SLEEPING/IDLE_STANDING/CONFUSED/LEAVING`.
  - working→blocked: 그 자리에서 일어나 desk 옆 standPos에서 손을 들고, 좌석은 유지한다. blocked→working은 걷지 않고 바로 앉는다(118–145).
  - idle 체인: couch 3석(TV 켜짐), ramen bar 4석, loiter, 그리고 5분 후 bunk bed(`IDLE_LONG_MS`, 36). 좌석에서 나올 때는 `exitWaypoints`로 standPos를 거쳐 가구를 통과하지 않는다(43–62).
  - unknown: 그 자리에서 머리를 긁는다(CONFUSED). pane이 닫히면 슬라이딩 도어로 퇴장한다.
  - 한 agent가 desk를 소유하고(최초 관측 시 배정, pane이 닫히면 해제) 항상 같은 자리로 돌아온다(`scene/slots.ts`).
- **고양이 "Daemon"**: blocked가 60초 넘게 방치되면 그 desk로 걸어가 앉아 사용자를 응시한다(`world.ts:173–178`, `cat.ts:42–87`). 방치된 blocked를 알리는 부드러운 escalation이다.
- **색 할당**: agent 색 5개와 project accent 색 5개를 first-come으로 충돌 없이 나눠주고 localStorage에 유지한다(`sprites/palette.ts:37–117`). 같은 project면 같은 accent(목도리, 이름표, 담요 줄무늬, 머그, 그릇)를 쓴다.

### 렌더링 기법

- 384×216 가상 해상도를 정수배로 스케일한다(`image-rendering: pixelated`). 이름표는 별도의 고정 크기 HUD 레이어에 그려 창 크기와 상관없이 선명하다. 3×5 비트맵 폰트(`ui/font3x5.ts`).
- 프레임 루프에서 `ctx.filter`/`shadowBlur`를 쓰지 않는다. glow는 미리 렌더링해 두고 `globalCompositeOperation: "lighter"`로 찍는다(README). Canvas 2D 성능 팁으로 pixel-agents에 바로 적용할 수 있다.
- 모든 sprite가 코드(string rows + palette map)이고 부팅 때 OffscreenCanvas로 bake한다. `tools/preview.ts`로 contact sheet PNG를 만든다.
- `HERDR_FAKE=1` 결정론적 90초 데모와 `chaos` 무작위 soak 모드(`src/bun/fake.ts`). `AGENTVIEW_SHOT`으로 프레임을 덤프한다.

### 훔칠 만한 아이디어

1. **비대칭 debounce(blocked 즉시, 나머지는 2틱)**와 **offline grace(3회)**. pixel-agents-herdr의 provider 레이어에 그대로 넣을 만하다(herdr.ts:173–296).
2. `AgentSource` 인터페이스(list/focus)로 fake와 실제를 갈아끼우는 seam(27–31). fake/chaos 소스로 시각 회귀를 테스트할 수 있다.
3. working에서 blocked로 바뀔 때 "제자리에서 일어나 손 들기"(좌석 유지). blocked에서 working으로 돌아올 때는 이동이 없다. 걷기 애니메이션 낭비를 줄인다.
4. 고양이 escalation(blocked가 60초 이상 지속될 때).
5. project accent 색. 같은 workspace/cwd를 한눈에 묶어 보여준다.
6. `done`→idle 정규화, 알 수 없는 상태→unknown(버전 drift 내성).

### 한계·함정

- `herdr agent list`만 쓰므로 workspace/tab 라벨이나 tool 세부 정보가 없다. 이름은 kind와 cwd basename뿐이다.
- 매초 프로세스를 spawn한다. macOS arm64 전용이다. license가 없다.
- Electrobun은 첫 빌드 때 GitHub에서 바이너리를 다운로드한다(README에 인증서 오류 우회법이 있다).

---

## 4. Luckystrike561/terrarium — pixel-agents fork + herdr provider

### Meta / 정체성

- GitHub description("Full-screen tank where AI agents across my machines live as creatures, with Claude/Ollama usage HUD")은 **`PLAN.md`의 초기 구상**이다. 현재 master 코드는 다르다. README 13행에 따르면 실제로는 **"Pixel Agents v1.4.1의 fork"**이고, 서버, 프로토콜, VS Code 어댑터를 유지하면서 세 가지를 바꿨다: (1) herdr provider, (2) PixiJS 2:1 isometric 오피스(CTO 승인 큐, lounge, kitchen), (3) 상태 배지. GitHub 상의 fork 관계는 없다(`isFork:false`). 코드 이름도 아직 `pixel-agents`이고 `eslint-rules/pixel-agents-rules.mjs` 같은 파일이 남아 있다.
- MIT. 10커밋. 2026-10-07에 herdr provider PR #1이 머지됐다. **open PR #20**(모듈형 provider)이 진행 중이다. 이슈 20개 가운데 대부분이 설계 문서 수준으로 자세하다(#7, #16, #17, #18, #19).
- 실행: `npm install && npm run build && node dist/cli.js --provider herdr`. 랜덤 포트에 `?token=` URL을 준다. devbox를 쓰면 `127.0.0.1:8790`.
- issue #17(Dockerfile 요청)에서 확인한 운영 제약: 기본 host가 127.0.0.1이고 포트는 OS가 랜덤으로 할당한다. herdr socket을 `~/.config/herdr/herdr.sock`에 bind-mount해야 하고(UID 문제가 있다), omp JSONL은 **herdr가 보고한 호스트 절대경로 그대로** 마운트해야 tool 활동이 보인다. `~/.pixel-agents/` 볼륨이 필요하다. token이 `docker logs`에 남는다. Claude provider를 컨테이너에서 쓰면 hook 경로가 어긋나 불가능하다.

### herdr provider 구조 (master: `server/src/providers/hook/herdr/`)

pixel-agents의 **HookProvider 인터페이스에 herdr를 "합성 hook 이벤트 발행자"로 끼워 넣는 방식**이다.

- `herdr.ts`(216줄): `herdrProvider: HookProvider`. `kind:'hook'`, `normalizeHookEvent`가 wire envelope `{session_id, hook_event_name, …}`를 공통 `AgentEvent`로 바꾼다(45–105).
  - `SessionStart`→`sessionStart{cwd, transcriptPath?}`, `PreToolUse`→`toolStart{toolId, toolName, input(+__intent)}`, `PermissionRequest`→`permissionRequest`, `Stop`→`turnEnd`, `Notification`→`turnEnd{awaitingInput:true}`, `SessionInfo`→`sessionInfo{name, task}`(**fork에서 새로 추가한 이벤트**), `SessionEnd`→`sessionEnd`.
  - `formatToolStatus`(121–162): 에이전트 자신의 one-line intent(`__intent`)를 우선한다. 그다음 소문자 tool key(omp는 `read/edit/bash` 소문자, Claude는 대문자)로 "Reading x", "Running: cmd" 등을 만든다.
  - `installHooks/uninstallHooks`는 no-op이고 `areHooksInstalled()`는 true다(170–178). 동의(consent) UI가 뜨지 않게 하려는 처리다.
- `herdrBridge.ts`(505줄): 같은 서버 프로세스 안에서 돈다. 서버 자신의 `POST /api/hooks/herdr`에 Bearer token을 붙여 **loopback HTTP로 이벤트를 다시 넣는다**(491–504). 기존 hook 파이프라인(HookEventHandler, AgentRuntime, store, WS)을 그대로 재사용하기 위해서다.
  - **socket 프로토콜 메모(protocol 22, 22–31행)**: plain request(`agent.list` 등)는 **응답 직후 herdr가 연결을 닫는 one-shot**이다. `events.subscribe` 연결은 계속 열려 있다. 둘을 한 socket에 섞으면 연결이 끊긴다. 그래서 이벤트용 장기 socket 1개를 두고, snapshot은 요청마다 버리는 socket으로 처리한다. JSON-RPC 2.0 envelope(`jsonrpc:'2.0'`)을 쓴다.
  - 구독: `events.subscribe {subscriptions:[{type:'pane.agent_detected'},{type:'pane.exited'}]}`(162–171). **`pane.agent_status_changed`는 `pane_id`가 필요해서 구독하지 않는다.** 상태 전이는 2.5초 snapshot 폴링으로 얻는다. 이벤트가 오면 payload는 믿지 않고 `reconcile()`만 트리거한다(211–222). 동시 호출은 `reconciling/reconcileQueued`로 합친다(276–291).
  - reconcile(293–380): `agent.list`, `workspace.list`, `tab.list`를 병렬로 부른다.
    - **유령 agent 필터**(299–307): herdr는 에이전트 프로세스가 끝난 뒤에도 pane의 `agent`를 유지한다. 셸 프롬프트 제목(`user@host:path`)이면 제외하고, `unknown`도 제외한다.
    - 이름 규칙: workspace label(같은 workspace에 여럿이면 `label #tabLabel`)을 쓴다. task는 `terminal_title_stripped`에서 omp의 `π `와 상태 글리프 접두를 제거한 값이다(90–97).
    - identity: `sessionId = "herdr-" + pane_id`(338).
    - 처음 보는 pane: `SessionStart` → `SessionInfo` → JSONL watch → `applyStatus`.
    - 사라진 pane: `SessionEnd`.
  - **level→transition 변환**(396–405): blocked → `PermissionRequest`, idle/done → `Stop`. **working은 아무것도 보내지 않는다**(JSONL tool 이벤트에 맡긴다).
  - **JSONL tail**(409–487): `agent_session.value`를 파일 경로로 보고 현재 size부터 offset을 tail한다(과거 replay 없음). 1.2초 폴링, 2MB 상한, truncate 감지. omp 레코드 `type:'custom', customType:'tool_execution_start'`만 `PreToolUse`로 보낸다. tool이 시작되면 `agent.status='working'`으로 리셋한다. 그래야 JSONL이 idle snapshot보다 늦게 도착해도 다음 snapshot에서 Stop을 다시 보낸다(481–485, race 보정).
- 연결 지점: `cli.ts:262–283`. `if (provider.id === herdrProvider.id) new HerdrBridge(...)`를 실행하고, `runtime.adoptAllExternalSessions = true`로 둔다(herdr 에이전트는 임의 worktree에 있으므로 "tracked project dir" 필터를 끈다, `agentRuntime.ts:83, 202`).
- e2e: `e2e/helpers/herdr.ts`가 **가짜 herdr Unix socket 서버**를 띄운다(one-shot과 subscribe 의미론까지 흉내 낸다). macOS socket 경로 104바이트 제한을 미리 검사한다. `e2e/tests/standalone/herdr.spec.ts`.

### PR #20 (open): 모듈형 provider. pixel-agents-herdr 설계에 가장 중요한 참고 자료

`core/src/provider.ts`(PR head `903a363`, 사본은 `scratchpad/research/pr20/provider.ts`):

- **`AgentModule`**(CLI 하나당 하나: claude, omp…): vocabulary(`formatToolStatus`, `readingTools`, `subagentToolNames`, `contextWindowForModel`), 선택적 `hooks: HookInstaller`, 선택적 자체 discovery `start(host) → RunningAgentModule`. 그리고 **`followSession(sessionFile)`**: multiplexer가 찾은 세션을 agent 모듈이 넘겨받아 tail한다.
- **`MultiplexerModule`**(herdr): `connect(onSnapshot, log) → {connected: Promise<boolean>, stop}`. `onSnapshot`은 매번 **live agent 전체 목록**을 받고, 목록에서 빠지면 종료로 본다.
- **`MultiplexedAgent`** = `{paneId, agentKind, status: 'working'|'blocked'|'idle', cwd, name, task, sessionFile?}`. herdr의 `done`은 idle로, `unknown`은 에이전트가 아닌 것으로 처리한다(pr20/herdrBridge.ts:69–74).
- 범용 `MultiplexerFeed`가 snapshot을 diff하고, 각 pane을 그 kind의 agent 모듈에 넘긴다(`followSession`). 해당 모듈이 없으면 상태만 보여준다.
- **중복 제거**: 두 모듈이 같은 session file을 보고하면 realpath로 비교해 한 캐릭터로 합친다(`sessionStart.sessionFile`). 이슈 #7에서는 `<host>:<session_file>` / `<host>:herdr:<pane_id>` 규칙을 제안했다.
- `--provider claude,omp,herdr`처럼 부분집합을 고를 수 있고 `~/.pixel-agents/config.json`의 `modules`에 저장된다. 알 수 없는 id는 에러로 처리한다(Claude로 조용히 대체하지 않는다). `adoptAllExternalSessions` 전역 플래그를 없애고, 모듈별로 "세션을 알린 모듈이 adoption을 결정"하게 바꿨다.
- 주의: PR #20 이후로는 `--provider herdr`만 쓰면 omp tool 활동이 보이지 않는다(`herdr,omp`가 필요하다).

### 로드맵 이슈의 인사이트

- **#18 원격 머신**: herdr에는 네트워크 listener가 없다. 원격 접속은 SSH로 해야 한다(`herdr machine add <ssh-target>`, `herdr --machine <id> agent list`). 후보 A는 `ssh -T host herdr api …` 또는 `ssh -L local.sock:remote herdr.sock`, 후보 B는 로컬 `herdr --machine` 위임이다. `events.subscribe`가 `--machine`으로 전달되는지는 미검증이다. session id에 connection id를 붙여야 한다(`herdr-<conn>-<pane>`, pane id `w1:p1`은 서버마다 범위가 다르다). 원격 JSONL은 로컬 fs로 읽을 수 없어서 `agent.read`나 SSH 스트리밍이 필요하다. socat으로 TCP를 노출하는 방법은 인증 없는 제어 API를 여는 셈이라 거부됐다.
- **#19 머신별 층(floor)**: 머신당 isometric 층 하나를 `worldToIso(x,y,z)`의 z 오프셋으로 쌓는다(dollhouse cutaway). 에이전트는 자기 층을 벗어나지 않는다.
- **#16 quota HUD**: Claude 5h/7d `rate_limits`는 **status line stdin에만** 공식 제공된다(hook payload에 있는지는 미검증). 사용자의 기존 `statusLine`을 망가뜨리지 않으려면 chaining(stdin을 사용자 명령으로 전달하고 출력은 그대로 두면서 서버에 POST)하고 consent를 받아야 한다. Ollama Cloud에는 공식 API가 없다(쿠키 스크래핑뿐). 표현은 커피 원두 개수(남은 quota)로 제안됐다. transcript 토큰 수로 quota를 추정하는 방법은 한도를 몰라서 거부됐다.
- PLAN.md의 초기 설계(창이 있는 수조 + 생물): host별 collector가 hub에 WebSocket으로 이벤트를 보내고, ring buffer replay, heartbeat가 끊기면 "돌로 변함", tool별 애니메이션 표(read=두루마리, bash=망치, task=알 부화, 에러=넘어짐), `~/.omp/stats.db` 기반 usage HUD. 원래 계획에서는 `pane.agent_status_changed`를 pane마다 구독하도록 돼 있었다(구현에서는 폴링으로 대체).

### 훔칠 만한 아이디어 (pixel-agents-herdr에 직결)

1. **"herdr = 합성 hook 이벤트 발행자"** (master 방식): 브리지가 herdr level을 transition(PermissionRequest/Stop/SessionStart/SessionEnd/SessionInfo)으로 바꿔 pixel-agents의 기존 hook 파이프라인에 그대로 넣는다. pixel-agents 코어를 거의 건드리지 않고 붙일 수 있는 최소 침습 경로다(`herdrBridge.ts:396–405, 491–504`).
2. **"multiplexer는 누가 살아 있는지, agent 모듈은 무엇을 하는지"** (PR #20 방식): 장기적으로 올바른 분리다. pixel-agents-herdr에서는 herdr를 MultiplexerModule로, 기존 Claude JSONL/hook 로직을 AgentModule로 두고, herdr가 준 `agent_session`으로 `followSession`을 연결하면 된다. Claude의 경우 `agent_session.kind==='id'` + cwd로 경로를 만드는 bullpen 방식을 쓰면 된다.
3. socket 의미론: one-shot request와 장기 subscribe 연결을 분리하고, 이벤트는 "다시 snapshot하라"는 신호로만 쓴다. reconcile을 합친다.
4. 유령 agent 필터(셸 프롬프트 제목 정규식)와 `unknown` 제외.
5. 이름은 workspace label, 같은 workspace에 여럿이면 `#tab`. task는 terminal title에서 글리프를 제거한 값.
6. JSONL은 "현재 끝에서부터" tail해 과거를 replay하지 않는다. tool 시작 시 내부 status를 리셋해 snapshot과 tail 사이의 race를 보정한다.
7. 가짜 herdr socket 서버로 e2e를 돌린다(`e2e/helpers/herdr.ts`).
8. CTO 승인 큐(blocked/입력 대기가 줄을 서고, 대기가 길어지면 의자를 양보). bullpen의 help desk 큐와 같은 발상으로, 두 프로젝트가 독립적으로 같은 결론에 이르렀다.

### 한계·함정 (코드로 확인)

- **master에서 non-omp 에이전트(Claude, Codex 등)의 working이 표시되지 않을 가능성**: `applyStatus`는 working일 때 아무것도 보내지 않고, tool 이벤트는 omp JSONL에서만 나온다. 그래서 herdr 안 Claude pane이 한 번 `Stop`된 뒤 다시 working이 돼도 캐릭터를 깨울 이벤트가 없다(추론, `herdrBridge.ts:396–405, 479`). README도 "Agents in herdr panes other than omp show status only"라고 인정한다. PR #20의 `MultiplexedAgent.status` level 전달 방식이 이 문제를 고친다.
- `Notification`(awaitingInput)은 normalizer에만 있고 브리지는 보내지 않는다. 그래서 herdr의 `done`과 `idle`이 구분되지 않는다.
- 문서 drift: `herdr.ts` 주석은 `~/.herdr/herdr.sock`와 `herdr api snapshot`이라고 하지만, 실제로는 `~/.config/herdr/herdr.sock`와 `agent.list`를 쓴다(#17, #18에서 지적). consent 문구도 실제 동작과 다르다.
- socket 경로가 하드코딩돼 있다. `HERDR_SOCKET_PATH`/`HERDR_SESSION`을 무시한다(#18).
- herdr 하나에 provider 하나라서 Claude hooks와 herdr를 동시에 쓰면 같은 세션이 두 번 나타난다(#7, PR #20에서 해결 중).
- 제어 기능은 없다(PLAN의 non-goal: 유출된 URL로 명령을 실행할 수 없게 하려는 의도).

---

## 5. pixel-agents-herdr 구현을 위한 종합 제언

1. **Provider 레이어는 terrarium PR #20 모델을 채택한다.** `MultiplexerModule(herdr)`은 "누가 살아 있는지와 상태 level"을 맡고, `AgentModule(claude)`은 "무엇을 하는지(JSONL/hooks)"를 맡는다. 연결 고리는 herdr의 `agent_session`이다. Claude는 `{kind:'id', value:<uuid>}`(bullpen에서 확인), omp는 파일 경로(terrarium에서 확인)다. 빠르게 시작하려면 master 방식(합성 hook POST)으로 시작해도 되지만, **working level을 반드시 전달해야** terrarium의 버그를 피할 수 있다.
2. **herdr 접근은 socket 직접 호출**(weherd/terrarium)이 CLI exec(bullpen/agent-view)보다 가볍다. one-shot과 subscribe 연결을 분리하고, `pane.agent_detected`/`pane.exited` 이벤트를 받으면 reconcile하며, 상태는 1~2.5초 폴링으로 얻는다. pane별 `pane.agent_status_changed` 구독은 선택 사항이다. socket 경로는 weherd의 해석 순서를 따른다. protocol 버전은 hard gate로 막지 말고 로그로 경고만 남긴다.
3. **상태 안정화**: agent-view의 비대칭 debounce(blocked 즉시, 나머지 2틱)와 offline grace(3회)에 bullpen의 1.2초 dwell을 더한다. `done`은 별도 상태(축하 후 meeting)로 둘지 idle로 합칠지 결정해야 한다. idle 경과 시간은 transcript `lastTs` 기준으로 계산한다(bullpen).
4. **Identity**: 캐릭터 key는 `herdr:<pane_id>`(다중 머신이면 `<host>:` 접두)로 하고, 세션 파일이나 session id로 Claude hook 이벤트와 dedupe한다. 제어 액션 전에는 weherd식 fingerprint로 재검증한다.
5. **이름과 task**: workspace label(+`#tab`), `terminal_title_stripped`에서 글리프를 제거한 task, 셸 프롬프트 제목이면 유령으로 보고 제외한다.
6. **상호작용 우선순위**: (a) 클릭 → `herdr agent focus`(셸이면 `tab focus` fallback), (b) 더블클릭 → `herdr pane read --format text` 미리보기, (c) 고급 기능으로 `herdr terminal session observe|control` + xterm.js 실시간 터미널, (d) `herdr agent prompt`로 프롬프트 보내기, (e) "다음 blocked로 점프" 버튼.
7. **연출**: blocked 큐(help desk/CTO), 장기 idle 침대, subagent helper 입장(pending Agent tool 수), tool 말풍선, project accent 색, 방치된 blocked를 고양이로 escalation, 오프라인 암전. Canvas 2D에서는 shadowBlur 대신 미리 렌더링한 glow를 `lighter`로 합성한다.
8. **로컬 서버 보안**: bullpen의 Host/Origin/Sec-Fetch-Site guard와 terrarium의 `?token=`(특권 동작에 필요)을 함께 쓴다.
9. **나중 단계**: SSH 기반 원격 herdr(#18)와 머신별 층(#19), status line chaining으로 Claude `rate_limits` HUD(#16), 가짜 herdr socket을 이용한 e2e.
