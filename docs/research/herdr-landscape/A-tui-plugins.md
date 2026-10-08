# A. herdr TUI 플러그인 3종 분석 — pixel-agents-herdr 설계 참고용

조사일: 2026-10-08. 세 저장소 모두 `git clone --depth 1`로 받아 소스를 읽기만 했다(설치·빌드·실행은 하지 않음). 파일:라인은 각 저장소 루트 기준이다.

|                    | herdr-pixel-office                                           | herdr-herd                                                              | herdr-lil-office                                                                              |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 저장소             | devangchhajed/herdr-pixel-office                             | vandemaelefelix/herdr-herd                                              | andrewromewo/herdr-lil-office                                                                 |
| Stars / forks      | 7 / 0                                                        | 0 / 1                                                                   | 0 / 0                                                                                         |
| 생성 → 마지막 push | 2026-09-16 → 09-21                                           | 2026-07-23 → 08-27                                                      | 2026-08-08 (단일 push)                                                                        |
| 커밋 수            | 4                                                            | 약 185                                                                  | 1                                                                                             |
| 테스트             | 없음(`tsc` 타입체크만)                                       | 약 437개 `#[test]` + snapshot 테스트                                    | 없음(`--headless`, `--snapshot` PPM으로 수동 검증)                                            |
| 라이선스           | MIT                                                          | MIT                                                                     | Cargo.toml에는 MIT 표기, LICENSE 파일 없음(GitHub상 null)                                     |
| 스택               | TypeScript, Node ≥18, **런타임 dependency 0개**              | Rust(serde), 자체 half-block + kitty graphics 렌더러                    | Rust, ratatui 0.29 + crossterm                                                                |
| 형태               | herdr 플러그인 TUI pane(split)                               | herdr 플러그인. 모든 탭 하단에 자동 주입되는 얇은 strip pane + watchdog | herdr 플러그인 TUI pane(split)                                                                |
| 데이터 소스        | herdr socket(`agent.list` 폴링 + `agent.read` 화면 스크래핑) | herdr socket(`session.snapshot` + `events.subscribe`)                   | **Claude Code JSONL transcript**가 주 소스, herdr `agent.list`는 Claude가 아닌 agent에만 사용 |

---

## 1. devangchhajed/herdr-pixel-office

pixel-agents를 herdr로 옮기려는 목표에 가장 가깝다. README와 소스 주석에 "Mirrors the pixel-agents provider"라는 문구가 여러 번 나온다. pixel-agents의 `formatToolStatus`, 읽기/타이핑 애니메이션, 권한 요청/질문 말풍선을 터미널 TUI에서 다시 만들었다.

### Meta

- 커밋 4개, v0.1.0 첫 릴리스(CHANGELOG). 테스트는 없다. MIT 라이선스.
- `package.json`의 `dependencies`는 비어 있고 devDeps는 typescript와 @types/node뿐이다. README는 이를 프라이버시 근거로 내세운다("zero runtime dependencies that could add some").

### Form factor / 실행

- `herdr-plugin.toml`: `id = "pixel.office"`, `[[panes]] office` → `node dist/main.js`, `[[actions]] open` → `$HERDR_BIN_PATH plugin pane open --plugin pixel.office --entrypoint office --placement split --direction right --focus`.
- 설치 시 `[[build]]`로 `npm install`과 `npm run build`를 실행한다.
- 권장 사용법은 `~/.config/herdr/config.toml`에 `[[keys.command]] key="prefix+o" type="plugin_action" command="pixel.office.open"`을 넣는 것이다(README).
- `--demo` 옵션을 주거나 socket을 찾지 못하면 MockHerdr로 동작한다(`src/main.ts:36-38,79-82`).
- 렌더링: alt screen, SGR mouse(1000/1002/1003/1006), 12fps(`FRAME_MS = 1000/12`, `src/main.ts:6`). 셀마다 **quadrant 블록(2x2 subpixel)**을 쓰고 diff 출력을 한다(`src/render/screen.ts:1-40`). 한 셀에 색이 2개뿐이라 sprite를 "셀당 2색" 예산에 맞춰 그렸고 `measureQuantisation()`으로 검사한다. sextant는 Apple Terminal에서 tofu로 깨져서 쓰지 않았다고 적혀 있다.

### 데이터 소스(검증)

- Socket 탐색 순서(`src/herdr.ts:31-53`): `HERDR_SOCKET_PATH` → `$HERDR_HOME` 또는 `~/.config/herdr/herdr.sock` → `herdr status server --json`의 `{running, socket}`. `fs.statSync().isSocket()`으로 실제 socket인지 확인한다.
- 프로토콜: 요청 하나마다 연결 하나를 열고 newline-delimited JSON `{id, method, params}`를 보낸 뒤 첫 줄만 파싱한다(`src/herdr.ts:67-111`).
- 호출하는 메서드:
  - `agent.list`: **1초 폴링**(`POLL_MS = 1000`, `src/main.ts:7`, `src/herdr.ts:219-247`).
  - `agent.read {target: paneId, source: "visible", lines: 30, strip_ansi: true}` → `result.read.text`(`src/herdr.ts:156-169`). **250ms마다 pane 하나씩 round-robin**으로 읽는다(`ACTIVITY_MS = 250`). 20개 agent 기준 한 agent가 약 5초에 한 번 갱신된다.
  - `agent.focus {target: paneId}`(`src/herdr.ts:120-122`). Enter를 누르거나 이미 선택된 캐릭터를 다시 클릭하면 호출된다.
- events.subscribe를 쓰지 않은 이유가 주석에 있다(`src/herdr.ts:175-179`): "herdr's event subscriptions are per-pane, which would mean re-subscribing every time a pane appears; for a view that only repaints at ~12fps a cheap poll is both simpler and always complete."
- **Claude Code hooks나 transcript는 쓰지 않는다.** 정보는 모두 herdr socket에서 온다.
- Agent 식별은 `pane_id`를 키로 한다(`characters` Map, `src/app.ts:155-185`). 외형은 `lookFor(paneId + agent)` 해시로 정한다(`src/model/character.ts:62`). 라벨 우선순위는 `name` → `terminal_title_stripped` → `title` → `terminal_title`, agent 종류는 `display_agent` → `agent` 순이다(`src/herdr.ts:124-153`). 쓰는 필드: `pane_id, terminal_id, workspace_id, tab_id, agent_status, cwd, focused`.
- 스크래핑 우선순위(`src/app.ts:56-62, 187-205`): working/blocked agent와 아무 agent를 번갈아 고른다("Alternate between 'anyone' and 'someone busy'"). 지금 보고 있는 바쁜 agent의 라벨이 가장 최신으로 유지된다.

### 상태 모델

- `zoneForStatus`(`src/model/character.ts:22`): `working|blocked` → **desk**, 나머지(`idle|done|unknown`) → **lounge(break room)**. 상태가 바뀌면 캐릭터가 BFS 경로(`src/model/navmesh.ts`)를 따라 두 구역 사이를 걸어간다. "Position is status"가 핵심 원칙이다.
- 앉은 자세(`character.ts` `get pose`): working이면 `activity.kind === "reading"`일 때 `read`, 아니면 `type`. blocked → `raise`(손 들기), done → `lean`, 그 외 → `idle`.
- 모니터 밝기(`get screenLit`): working일 때 `0.75 + 0.25*sin(frame/3)`로 깜빡이고 blocked 0.85, done 0.5, idle 0.3, unknown 0.12.
- 말풍선(`character.ts:105-171`): done이면 체크마크를 `DONE_BUBBLE_TICKS = 36`(약 3초) 동안 보여준 뒤 alpha를 서서히 낮춘다. blocked이면 `blockedKind === "input"`일 때 `?`, 아니면 `…`(permission)이고 **해결될 때까지 유지**된다.
- blocked로 바뀌는 순간 `\x07` 벨을 울린다(옵션 `s`, `src/app.ts:163-167`).
- **세부 활동 스크래핑**(`src/activity.ts`, 정규식 그대로 인용):
  - 툴 호출: `/⏺\s+([A-Za-z_][A-Za-z0-9_]*)\(([^\n]*)/g`. 마지막 매치를 쓴다("Last tool call wins").
  - 읽기 툴 집합: `Read, Grep, Glob, WebFetch, WebSearch` → reading. 나머지는 typing.
  - 컨텍스트/사용량 게이지: `/Context\s+[█▓▒░]+\s*(\d+)%/g`, `/Usage\s+[█▓▒░]+\s*(\d+)%/g`. 막대 글리프를 필수로 요구하고 **마지막 매치**를 쓴다. 이유는 agent가 출력 본문에 "Context 12%"라고 쓰면 게이지가 오염되기 때문이다. status line이 pane 맨 아래에 있으니 마지막 매치가 맞다(`activity.ts:62-70`).
  - 진행 중 spinner: `/[✻✽✳✢✶✷✺·*]\s+(\p{L}+)…\s*\(([^)]*)\)/u` → detail(`30s · ↓ 821 tokens`). 완료형: `/[✻✽✳✢✶✷✺·*]\s+(\p{L}+)\s+for\s+([0-9hms\s]+?)\s*$/mu`(`Crunched for 5m 39s`).
  - Sub-agent 수: `/Waiting for (\d+) background agents? to finish/`. herdr의 `background_agents_working` 규칙에서 가져왔고, `Task(` 호출을 세면 이미 끝난 것까지 세어지므로 이 문구를 쓴다고 설명한다. 대안으로 spinner가 돌고 있고 마지막 툴이 `Task|Agent`면 1로 본다.
  - blocked 종류: `"do you want to proceed?"` → permission, `"requests your input"` 또는 `"esc to cancel"` → input. 주석에 "Patterns come from herdr's own detection rules"(`agent.explain`)라고 되어 있다.
  - `formatToolStatus`(`activity.ts:135-171`)는 pixel-agents 것을 그대로 옮겼다: `Reading x.ts`, `Editing`, `Writing`, `Running: <cmd 24자>`, `Searching files/code`, `Subtask: …`, `mcp__a__b` → `Calling b`.

### 시각/상호작용 기능

- 레이아웃: 위쪽 **desk bank**, 아래쪽 **break room**. 빈 책상도 항상 그려서 "격자가 아닌 사무실"로 읽히게 했다.
- **Workspace마다 desk 영역을 행 단위로 나누고 색을 입힌다**(`src/app.ts:243-275`). 영역 라벨은 bare id(`w4`) 대신 멤버 cwd에서 뽑은 프로젝트명을 붙인다(`areaLabel`, `app.ts:354-373`).
- Desk 배정은 sticky다. 같은 workspace 범위 안에서는 자리를 유지한다(`app.ts:284-296`). **이름이 있는 agent(teammate)는 영역 앞쪽 desk**에 앉힌다(`app.ts:298-312`, `isTeammate = name !== null`). 주석: "herdr does not expose which agent is its lead".
- Sub-agent는 부모 옆에 작은 인물로 최대 2명까지 그린다(`src/ui/office.ts:361`).
- Break room의 사회적 행동(`src/model/social.ts`): chat, coffee, cocktail, pingPong, pool, foosball. 순수 장식이고 상태가 바뀌면 즉시 취소된다. 사무실 고양이(`src/model/pet.ts`)와 bartender도 있다.
- 탭 3개: Office / **Roster**(blocked가 위로 오도록 정렬한 표) / Settings(회사 이름 편집).
- 마우스: 클릭하면 선택, 다시 클릭하면 `agent.focus`. **드래그로 desk 재배치**, hover tooltip(status/activity/project/gauges), 휠 스크롤. 화면 밖 인원은 `▴ n ▾ n`으로 표시한다.
- 상태 저장(`src/state.ts`): `$HERDR_PLUGIN_STATE_DIR/office.json`에 desk와 lounge 배정, 표시 설정을 저장한다. 활성 화면은 일부러 저장하지 않는다.
- 물 마시기 리마인더와 벽시계 같은 소소한 기능도 있다.

### 가져갈 만한 아이디어

1. **"Position is status" + break room**(`character.ts:22`, `app.ts:226-`). pixel-agents의 idle 캐릭터를 lounge로 보내면 한눈에 읽힌다.
2. **Round-robin 스크래핑 + 바쁜 agent 우선 교차**(`app.ts:187-205`, `herdr.ts:180-217`). `agent.read` 비용의 상한을 잡는 방식이다.
3. **게이지 정규식 오염 방지**: 막대 글리프 필수 + last match(`activity.ts:62-70`).
4. **blocked를 permission과 input으로 나누는 문자열 규칙**(`activity.ts:126-133`). herdr `agent.explain` 규칙을 근거로 쓴다.
5. **Sub-agent 수를 "Waiting for N background agents" 문구로 판정**(`activity.ts:57`).
6. Workspace별 영역과 cwd 기반 라벨, teammate 앞자리 배치(`app.ts:243-312`, 354-373).
7. Socket 3단계 탐색 + demo 모드 fallback(`herdr.ts:31-53`, `main.ts:36-38`).
8. Roster 뷰(blocked 우선 정렬)를 넣어서 agent가 많을 때의 확장성 문제를 해결한다.

### 한계 / 주의점(README에 명시된 것 포함)

- **프라이버시**: `agent.read`는 pane에 보이는 텍스트(프롬프트, 출력, 경로, 명령)를 반환한다. 30줄만 요청하고 파생 필드만 보관한다고 밝힌다. 네트워크 연결이 없고, spawn하는 프로세스는 `herdr status server --json` 하나뿐이며, 쓰는 파일도 state 파일 하나뿐이라고 명시한다. 세션에 가하는 부작용은 `agent.focus` 하나다.
- 스크래핑을 끄면 라벨, 읽기 자세, 게이지가 사라진다. 상태, 구역, 이동, focus는 `agent.list`만으로 유지된다.
- 스크래핑 정규식은 **Claude Code TUI 출력 형식**(`⏺`, spinner 글리프, status line의 Context/Usage 막대)에 의존한다. Codex 같은 다른 CLI나 Claude UI가 바뀌면 깨진다. Context/Usage 막대는 사용자 statusline 설정에 따라 없을 수도 있다.
- 갱신 지연: agent가 N개일 때 활동 라벨은 최대 약 N×250ms(바쁜 agent는 그 절반 정도) 늦다. 상태는 1초 폴링이다.
- Teammate의 리더 관계는 herdr가 노출하지 않아서 팀 구조를 그릴 수 없다.

---

## 2. vandemaelefelix/herdr-herd

세 저장소 가운데 **엔지니어링 성숙도가 가장 높다**(185커밋, 437개 테스트, `docs/decisions.md` 600줄 이상, issue 51개). 정보량은 일부러 최소로 줄였다(status 4종 + focus). 대신 **herdr API 사용법, event와 polling 설계, 멀티 프로세스 일관성**에서 배울 점이 많다.

### Meta

- Rust, MIT, v0.2.1. 설치 시 `scripts/build.sh`가 플랫폼별 prebuilt 바이너리를 내려받고 실패하면 `cargo build`한다.
- 개발 방식: `GOAL.md`(비목표와 잠금 결정), `docs/superpowers/specs|plans/*`(phase별 설계), `docs/decisions.md`(ADR 형식). Hot reload: controller가 디스크의 바이너리가 바뀐 것을 감지하면 strip을 닫고 자신을 re-exec한다.

### Form factor / 실행

- 바이너리 하나에 두 모드가 있다. `herdr-herd render`는 각 strip pane에서 그리기와 hover/click을 맡고, `herdr-herd control`은 모든 탭에 strip이 있도록 유지하는 watchdog이다. 수동 배치용 `place`도 있다.
- `herdr-plugin.toml`: `[[panes]] herd`(render), `[[actions]] place-herd`, `start-herd-controller`. herdr에 plugin-start hook이 없어서 controller는 세션마다 한 번 수동으로 시작해야 한다(README).
- Strip 주입(`src/control.rs:550-595`): 탭 하단의 full-width pane을 `pane split --direction down`으로 나누고 `pane run <id> "exec '<self>' render"` → `pane rename <id> herdr-herd` 순서로 실행한다. `layout.apply`는 프로세스를 죽이므로 자동 주입에는 쓰지 않고(decisions 2026-07-23 Phase 3) 수동 `place`에서만 쓴다(`src/place.rs:79-85`, `layout.export/apply`).
- 렌더러: 기본은 half-block(`▀▄` + 24bit). 옵션으로 **kitty graphics protocol**을 쓸 수 있다(herdr `[experimental] kitty_graphics = true`와 재접속이 필요).

### 데이터 소스(검증)

- Socket: `HERDR_SOCKET_PATH`만 사용한다(`src/socket.rs`). 없거나 실패하면 `herdr` CLI(`$HERDR_BIN_PATH`)로 fallback한다(`src/herdr.rs`).
- **One-shot RPC**(`socket.rs` `request_line`, `UnixRpcClient`): 호출마다 새 연결을 연다. 주석: "herdr closes a control connection as soon as it has answered a plain request (verified live against 0.8.0: a second request on the same stream gets EPIPE)". subscribe 연결은 event가 섞이므로 요청용으로 재사용할 수 없다.
- `session.snapshot`(`socket.rs:157`, `src/snapshot.rs`): agents, workspaces/tabs 라벨, panes, 탭별 layouts를 **한 번의 호출**로 받는다. CLI 3회(`agent list`, `workspace list`, `tab list`)는 약 203ms·23ms CPU였는데 socket 1회는 약 0.7ms CPU라고 측정해 두었다. 파싱은 관대하게 한다. agent 항목 하나를 해석하지 못하면 그 항목만 건너뛴다(`cwd`가 nullable이라 null 하나 때문에 herd 전체가 사라졌던 issue #71).
- `events.subscribe`(`socket.rs:203`): `pane.created, pane.closed, pane.exited, pane.focused, pane.agent_detected, tab.created, tab.closed, tab.focused, workspace.focused`. 스트림의 event 이름은 underscore 형식(`pane_focused`)이다.
  - **중요**: 주석에 따르면 `pane.agent_status_changed`는 `pane_id` 필터가 필수인 per-pane 구독이라 **전역 status 전환 event가 없다.** 그래서 status 전환은 slow poll(2.5초)로 받는다. 이 판단은 `herdr api schema --json`(0.8.0)으로 확인한 것이다.
  - 연결 직후 herdr가 현재 상태를 replay한다.
- Watcher(`src/watcher.rs`): event 내용은 무시하고 **분류만 해서 debounce한 뒤 snapshot을 다시 가져온다.**
  - `classify_event`: `*_focused` → Focus(100ms), `tab_*`/`workspace_*`/`worktree_*` → Labels(750ms, 라벨 캐시 무효화), 나머지 → Structural(750ms). 해석할 수 없는 줄은 느린 쪽으로 분류한다.
  - `Timings { slow_ms: 2500, debounce_ms: 750, focus_ms: 100 }`. leading과 trailing debounce를 모두 한다. Socket read timeout 400ms로 idle tick을 돌리고, socket이 끊기면 poll-only로 강등한다.
  - 문서화된 성능 이슈(#73): 전역 focus 구독 때문에 pane을 한 번 전환하면 모든 render 프로세스가 깨어난다.
- Click → `herdr agent focus <terminal_id>` CLI(`src/render.rs:829-832`). 실패하면 diag에 기록만 하고 crash하지 않는다.
- Controller는 `pane process-info`로 strip이 살아 있는지 확인한다(`control.rs:461`, RPC `pane.process_info`).
- **Claude hooks와 transcript는 쓰지 않는다.**
- 식별: **`terminal_id`**를 쓴다. 주석: "stable per terminal, survives the pane_id churn that layout.apply causes"(`src/identity.rs:1-5`). `pane_id`는 layout을 재구성하면 바뀐다.

### 상태 모델

- `AgentStatus { Idle, Working, Blocked, Done, #[serde(other)] Unknown }`(`src/agent.rs`). 모르는 문자열은 Unknown으로 받는다.
- **데이터 기반 sprite 파일**(`sprites/sheep.sprite`): 상태별 섹션에 `frame_ms`, `motion`, `overlay`, `color`, `ghost` 속성이 있다.
  - `[idle] frame_ms=520 motion=breathe overlay=bubble:Zz`: 잠든다(stand → sleep → doze로 가라앉는 one-shot 후 유지).
  - `[working] frame_ms=150 motion=walkhop+wander`: 뛰어다닌다.
  - `[done] frame_ms=1400 motion=hop overlay=badge:! color=accent`: 차분한 `!`, "come see".
  - `[blocked] frame_ms=120 motion=bounce overlay=badge:! color=#e62d23`: 빨갛게 변해 뛰며 "I need you now".
  - `[unknown] frame_ms=0 motion=sway overlay=bubble:? ghost=true`.
- 세부 활동(툴 이름 등)은 **일부러 보여주지 않는다**("Glanceable over detailed", 비목표에 "Not a dashboard").
- Agent 종류 아이콘(`agent.rs` `KNOWN_KINDS`): herdr config template에 나열된 18종(claude🤖, codex🦊, gemini🐙, cursor👻 …)을 hover 캡션에 emoji 또는 ascii 2글자로 보여준다.

### 시각/상호작용 기능

- 탭 하단 5행짜리 strip에 agent마다 양/염소가 한 마리씩 있다. 이름 라벨은 없고 **hover하면 `workspace › tab` breadcrumb**(herdr 사이드바와 같은 형식, `snapshot.rs` `resolve_hover_labels`), **클릭하면 focus**된다.
- **Focus hat**(GOAL.md "The focus hat"): 세션 전체에서 단 한 마리만 빨간 모자를 쓴다. focus는 pane 단위다. focus가 agent가 아닌 pane(strip 자신, shell)으로 가면 마지막 agent에 모자가 남는다(sticky). herdr의 per-agent `focused`를 그대로 믿지 않고 `Herd::reconcile`에서 "정확히 하나"를 강제한다.
- 사운드(`src/sound.rs`): **전이(transition)일 때만** 재생한다. 처음 받은 snapshot에서 이미 blocked인 것은 울리지 않는다. 같은 tick에 여러 agent가 같은 상태로 바뀌면 한 번만 울린다. `afplay`/`paplay`/`aplay`를 shell out하고, 소리 파일은 번들하지 않는다.
- `reduced_motion` 옵션. 시간을 0으로 고정하면 되므로 별도 코드 경로가 필요 없다.

### 가져갈 만한 아이디어

1. **`session.snapshot` 한 번으로 전체 상태를 받고, event는 "다시 가져오라는 신호"로만 쓰는 패턴**(`watcher.rs`, `snapshot.rs`). event payload의 스키마 변화에 영향을 덜 받는다.
2. **Event 분류별 debounce(focus 100ms / structural 750ms) + slow poll 2.5초 안전망**(`watcher.rs` `Timings`, `Debouncer`). 전역 status event가 없다는 사실을 문서로 확인해 둔 점도 직접 쓸모가 있다.
3. **식별 키로 `terminal_id`**(`identity.rs`). layout이 바뀌어도 캐릭터의 정체성(외형, 좌석)이 유지된다.
4. **결정적 외형**: `hash(salt, terminal_id)`로 species와 hue를 정하고, 같은 agent는 항상 같은 캐릭터가 된다(`identity.rs` `identity_for`, `unit_hash`).
5. **벽시계 기반 순수 함수 애니메이션** `animate(terminal_id, status, state, now_ms)`(`src/motion.rs`, decisions 2026-07-24). 여러 뷰(여러 탭, 여러 브라우저 탭)가 같은 장면을 보여준다. 위치는 픽셀이 아니라 `x_fraction`이라 화면 폭과 무관하다. status가 바뀔 때 텔레포트하지 않도록 anchor로 약 1초간 ease한다(decisions 2026-07-27).
6. **상태별 sprite 동작을 데이터 파일로 선언**(`sprites/sheep.sprite`). 상태 → (frame_ms, motion, overlay, color) 매핑을 코드 밖으로 뺐다.
7. **"Done = 와서 봐라"(차분), "Blocked = 지금 필요"(빨강, 빠른 bounce)**를 구분했다. done을 idle과 따로 다룬다.
8. **사운드 규칙**: 전이일 때만, 초기 snapshot은 제외, 같은 tick 중복 제거.
9. 관대한 파싱(항목 단위 skip, `serde(other)`). herdr 스키마가 늘어나는 것에 대비한다.

### 한계 / 주의점

- Status 전환은 최대 약 2.5초 늦게 반영된다(전역 이벤트가 없음).
- 전역 focus 구독이 render 프로세스 N개를 모두 깨운다(#73, open).
- 자동 주입은 full-width 하단 pane이 있는 탭에서만 된다. `layout.apply`는 프로세스를 죽인다.
- Kitty: 이미지 id 공간이 터미널 전역이라 프로세스별로 블록을 나눠야 했고(decisions 2026-08-19), 비정상 종료 시 이미지가 화면에 남는다(#79). 렌더러가 죽은 strip은 "corpse"가 되므로 `exec`와 process-info로 회수한다(decisions 2026-08-06).
- 렌더 프로세스와 같은 TTY를 쓰기 때문에 stderr에 출력하면 화면이 깨진다. 진단 메시지를 strip 안에 latch로 표시한다(#84).

---

## 3. andrewromewo/herdr-lil-office

커밋 1개짜리 개인 프로토타입이다. 그래도 **Claude Code transcript로 sub-agent 위임 트리를 추적하는 방식**과 **herdr pane과 Claude 세션을 cwd로 연결하는 heuristic**은 pixel-agents-herdr와 직접 관련이 있다.

### Meta

- Rust 2024, ratatui 0.29 + crossterm 0.28. 커밋 1개(2026-08-08). 테스트 없음. LICENSE 파일 없음.
- `HANDOFF.md`에 작업 방식이 적혀 있다(Claude가 spec을 쓰고 codex가 구현). 디자인 목업은 `design/tower-drafts.html`이다.
- README 로드맵상 chunk 1과 2(데이터 spine, office)만 완료됐고 job 애니메이션, accelerator, multi-orchestrator는 아직이다.

### Form factor / 실행

- `herdr-plugin.toml`: `id = "lil.office"`, split pane, `open` action(pixel-office와 같은 패턴).
- CLI 옵션: `--mock`, `--headless --secs N`(event feed를 텍스트로 출력), `--snapshot out.ppm --at <secs>`(장면을 PPM으로 렌더링해 시각 회귀 확인), `--boss <prefix>`.

### 데이터 소스(검증)

- **주 소스는 `~/.claude/projects/` JSONL**(`src/watcher.rs`). hook이나 설정은 필요 없다.
  - 1초마다 디렉터리를 스캔한다(`SCAN_EVERY`). mtime이 15분 이내인 `*.jsonl`을 orchestrator 세션으로 본다(`ACTIVE_WINDOW`, `watcher.rs:12, 150-203`).
  - Tail: 파일별 byte offset을 저장한다. 처음에는 **마지막 256KB만** 읽고 첫 부분 줄은 버린다. 파일이 줄어들면 offset을 리셋한다. 부분 줄은 `pending`에 두고 4MB 상한을 둔다(`watcher.rs:13-95`).
  - Orchestrator 줄: `cwd`, `type=="assistant"`이면 `message.model`(`<`로 시작하는 값 제외)과 `message.content[].type=="tool_use"` → `OrchestratorTool{tool, detail}`(`watcher.rs:270-327`).
  - **Sub-agent spawn**: `<session>/subagents/agent-<id>.meta.json`이 새로 생기면 그것이 spawn event다. 필드는 `agentType, description, model, spawnDepth`(`watcher.rs:205-268`). 형제 파일 `agent-<id>.jsonl`을 tail해서 tool_use를 얻는다.
  - **Sub-agent 완료**: 부모 transcript의 `toolUseResult.agentId`(+`status`)(`watcher.rs:311-318`).
  - `detail_of`: input에서 `file_path, path, pattern, query, url, command, description, prompt` 순으로 첫 문자열 키를 쓴다(`watcher.rs:358-368`).
- **보조 소스는 herdr `agent.list`**(`src/herdr.rs`). 3초마다 폴링하고 요청마다 연결을 연다. **`agent == "claude"`인 pane과 자기 pane(`HERDR_PANE_ID`)은 제외**한다. Claude는 transcript로 이미 다루기 때문이다. 이전 결과와 diff해서 `PaneAgentSeen`/`PaneAgentGone` event를 만든다.
- Agent 식별: Claude는 session UUID(파일명)와 agentId, 비Claude는 `pane_id`. **Claude 세션과 herdr pane을 연결하지 않는다.** 그래서 click-to-focus가 없다(hover tooltip만 있음, `main.rs:224`).
- 비Claude pane을 orchestrator 층에 붙이는 규칙(`src/office.rs:322-357`): cwd가 정확히 같으면 2점, 조상/자손 경로면 1점, 동점이면 최근 활동 순. 매칭되지 않으면 `pending_panes`에서 다시 시도하고, 한 번 매칭되면 sticky하다.

### 상태 모델

- `WorkerState { Working, Idle, Done }`.
- Transcript 쪽은 시간으로 추정한다(`office.rs:8-10`): 60초 동안 조용하면 Working → Idle, sub-agent가 5분 동안 Idle이면 Done(background agent는 완료 신호가 없을 수 있으므로), Done 3분 후 퇴장, 세션 파일이 15분 동안 그대로면 세션 제거.
- herdr 쪽: `pane_state`는 `"working"`이면 Working, **그 외(blocked 포함)는 모두 Idle**이다(`office.rs:423-425`). blocked와 done을 구분하지 않는다.
- **Job 분류**(`office.rs:74-104`): 초기값은 agentType으로 정한다(`Explore|Plan` → Research, 그 외 Generic). 이후 관찰한 툴로 업그레이드한다. WebSearch/WebFetch → WebResearch(sticky), Edit/Write/NotebookEdit에서 detail에 `.md`가 있으면 MdUpkeep, 아니면 Coding, Grep/Glob/Read는 Generic일 때만 Research로 올린다.
- 모델별 캐릭터 크기(`ModelClass::scale`): fable 1.7, opus 1.3, sonnet 1.0, haiku 0.8. sub-agent의 meta에 model이 없으면 부모 것을 물려받는다.

### 시각/상호작용 기능

- **Tiny Tower 단면도**: 140×104 논리 픽셀을 half-block으로 그린다. 1층은 장식 로비(검은 개 Juniper가 결정적 주기로 걷고 잔다). 그 위로 **활성 orchestrator 세션마다 한 층**(26px)이 처음 본 순서대로 쌓인다. 층마다 매니저 사무실(boss)이 항상 있고, LIBRARY / DEV / WEB / DOCS / BULLPEN 섹션은 **해당 job의 worker가 처음 나타나면 생기고 마지막 worker가 떠나면 사라지며 다시 배치된다**(`Scene::sync_rooms`, `src/scene/mod.rs:208`).
- 엘리베이터로 출입한다. 엘리베이터 칸 위치가 focus된 층을 나타낸다. 비Claude agent는 hard-hat 차림의 "contractor"로 표시한다.
- 키: `o`는 층 focus 순환, ↑↓/kj는 스크롤, TAB은 roster, hover는 tooltip.
- Event spine 원칙(CLAUDE.md): `watcher/mock → Vec<OfficeEvent> → Office::apply`. 장면은 Office 상태만 읽는다. `format_event` 하나로 ticker와 headless 출력을 모두 만든다.

### 가져갈 만한 아이디어

1. **Sub-agent spawn과 완료 신호**: `subagents/agent-<id>.meta.json`(spawn, description, agentType, model, spawnDepth)과 부모의 `toolUseResult.agentId`(완료)(`watcher.rs:205-268, 311-318`). pixel-agents의 sub-agent 캐릭터를 transcript만으로 정확히 만들 수 있다. background agent에는 staleness fallback을 둔다.
2. **Tail 부트스트랩: 마지막 256KB만 읽고 첫 부분 줄 폐기, 파일이 줄면 리셋**(`watcher.rs:40-95`).
3. **Claude 세션 ↔ herdr pane 연결 heuristic**(cwd 정확 일치 > 조상/자손 > 최근 활동, sticky)(`office.rs:322-357`). pixel-agents-herdr에서 hook/transcript 세션과 herdr pane을 묶을 때 fallback으로 쓸 수 있다. 다만 같은 cwd에 세션이 여러 개면 모호하다.
4. **Job → 방/가구 매핑**: 툴 사용 이력으로 "어느 desk에 앉을지"를 정한다. pixel-agents의 좌석 배정에 의미를 더할 수 있다.
5. **모델 등급 → 캐릭터 크기**, sub-agent는 부모 모델을 물려받는다.
6. **세션별 층 / 방이 생기고 사라지는 레이아웃.** 다중 세션을 공간으로 분리하는 아이디어다(pixel-office는 workspace 영역으로 같은 일을 한다).
7. **Headless 텍스트 feed와 `--snapshot PPM --at <t>`로 렌더 결과를 결정적으로 검증.** mock 시나리오의 특정 시점을 이미지로 떠서 리뷰할 수 있다.

### 한계 / 주의점

- Claude 세션과 herdr pane이 연결되지 않아 focus 점프가 없다. 비Claude agent는 blocked를 Idle로 뭉갠다.
- Working/Idle을 transcript 활동 시간(60초)으로 추정하므로 긴 단일 툴 실행이나 권한 대기를 구분하지 못한다. Claude 쪽에는 "blocked" 개념이 없다.
- `~/.claude/projects` 전체를 1초마다 스캔하므로 프로젝트가 많으면 비용이 든다. 15분 창에 따라 오래된 세션은 사라진다.
- HANDOFF에 적힌 버그: 층이 화면 밖으로 스크롤되면 worker가 다른 층 픽셀을 지나 퇴장한다. .md와 코드 편집을 번갈아 하면 방이 flip된다. background sub-agent는 완료 신호가 없다.
- 커밋 1개, 테스트 없음, LICENSE 파일 없음이라 코드를 재사용하기에는 법적으로 불명확하다(아이디어 참고만 권장).

---

## 종합: pixel-agents-herdr에 대한 시사점

1. **데이터 소스 하이브리드가 정답에 가깝다.**
   - herdr: 상태의 기준은 `session.snapshot`이나 `agent.list`, event는 재조회 트리거로만 쓴다(herd). 다만 status 전환에는 전역 event가 없으므로 1~2.5초 폴링이 필요하다. per-pane `pane.agent_status_changed`를 pane마다 구독할 수도 있지만 pane이 생기고 사라질 때마다 재구독을 관리해야 한다(pixel-office와 herd 모두 이 비용 때문에 폴링을 택했다).
   - 세부 활동: pixel-office는 `agent.read`로 화면을 스크래핑했고(형식 의존적, 프라이버시 부담), lil-office는 transcript를 tail했다(정확하지만 Claude 전용이고 pane 연결이 필요하다). **pixel-agents는 이미 hooks와 JSONL을 갖고 있으니, Claude는 hooks/JSONL로 정확히 처리하고 다른 CLI는 herdr status(필요하면 스크래핑)로 처리하는 계층 구조**가 자연스럽다.
2. **식별/연결 키**: 캐릭터 정체성은 `terminal_id`(pane_id는 layout을 바꾸면 변함). Claude 세션과 pane의 연결은 가능하면 hook 페이로드나 env(예: `HERDR_PANE_ID`를 hook에서 기록)로 하고, 불가능하면 cwd + 시간 heuristic(lil-office)으로 한다. 주의: 이 env 방식은 세 저장소 모두 쓰지 않은 추측성 제안이므로 검증이 필요하다.
3. **시각 언어**:
   - 위치가 곧 상태다(desk와 break room, pixel-office).
   - blocked는 permission(`…`)과 question(`?`)으로 나누고 해결될 때까지 유지한다. 손 들기와 amber 모니터로 표현한다.
   - done(차분한 `!` 또는 사라지는 체크)과 blocked(빨강, 빠른 bounce, 벨)의 긴급도를 구분한다(herd).
   - 툴 라벨(`Reading x.ts`)과 읽기/타이핑 자세는 pixel-agents의 `formatToolStatus`를 재사용한다.
   - Context/Usage 게이지(pixel-office).
4. **멀티 세션**: workspace별 desk 영역에 cwd 기반 라벨(pixel-office), 세션별 층(lil-office), 세션 전체에서 단 하나의 focus 마커(herd 모자).
5. **상호작용**: 클릭으로 선택, 재클릭이나 Enter로 `agent.focus`. hover하면 `workspace › tab` breadcrumb. blocked 우선 Roster로 확장성을 확보한다.
6. **견고성**: 관대한 파싱(nullable cwd, 모르는 status는 unknown), 요청마다 socket 연결(herdr가 응답 후 연결을 닫음), socket 탐색 fallback 체인, demo/mock 모드, 결정적 애니메이션(여러 뷰를 열어도 일관됨), 사운드는 전이일 때만.
