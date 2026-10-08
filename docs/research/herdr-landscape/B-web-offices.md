# B. herdr 웹 오피스 계열 4개 레포 분석 (pixel-agents-herdr 설계용)

조사일: 2026-10-08 · 대상: `unrealandychan/herdr-office`, `BlazzzPlay/herdr-office`, `montagao/herdr-story`, `andrebrov/herdr-viz`
방법: `git clone --depth 1`로 받은 뒤 소스만 읽었다(실행·설치는 하지 않음). 메타데이터는 `gh`로 확인했다. 아래 file:line은 각 레포 루트 기준이다.
클론 위치: `scratchpad/research/repos/<owner>-<name>`

---

## 0. 한눈에 비교

|                        | unrealandychan/herdr-office                                  | BlazzzPlay/herdr-office                                                    | montagao/herdr-story                                                                           | andrebrov/herdr-viz                                    |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| ★ / 생성 / 마지막 push | 0 / 2026-09-27 / 09-28                                       | 0 / 2026-08-11 / 08-11                                                     | 1 / 2026-09-05 / 10-06                                                                         | 0 / 2026-10-06 / 10-07                                 |
| 커밋 수(대략)          | 16                                                           | 11                                                                         | 7 (히스토리 squash된 것으로 보임)                                                              | 2                                                      |
| 라이선스               | README에는 MIT라고 적혀 있으나 LICENSE 파일 없음             | MIT                                                                        | ISC (단, Kairosoft 아트 포함)                                                                  | MIT                                                    |
| 스택                   | Node+ws 서버 / React19+Vite+Canvas2D(아이소메트릭)           | Node(vite-node) / React19, **CSS/DOM 렌더**                                | **Bun** 서버 + SQLite / Vite + **Phaser 4**                                                    | 의존성 0개, Node 서버 1파일 + 단일 index.html Canvas2D |
| herdr 접근             | **CLI** `herdr agent list` 등 execFile                       | **Unix socket** JSON-line (`ping`, `session.snapshot`, `events.subscribe`) | **Unix socket** (Bun.connect, 요청 1건당 연결 1개)                                             | **CLI** `herdr agent list`, `workspace list`           |
| 갱신                   | 적응형 폴링 1.5s(클라이언트 접속 중) / 10s(미접속) → WS diff | 이벤트 기반 refresh(폴링 없음), 프론트는 **최초 1회 fetch만**              | 1s 폴링, 5s마다 `session.snapshot` → WS (+delta 협상)                                          | 서버 캐시 5s, 브라우저 `setInterval` 5s fetch          |
| 트랜스크립트 결합      | pi 세션 JSONL tail(`agent_session.value`=경로)               | 없음                                                                       | **Claude `~/.claude/projects/**/<uuid>.jsonl` + Codex rollouts** (`agent_session.kind==='id'`) | 없음                                                   |
| 제어(쓰기)             | prompt/interrupt/spawn/broadcast/에이전트 간 메시지          | 없음(읽기 전용이 원칙)                                                     | prompt/queue/interrupt/hire/close/model 변경 (loopback일 때 기본 활성)                         | 없음                                                   |
| 보안                   | **매우 취약**: 0.0.0.0 bind, CORS `*`, WS Origin 검사 없음   | loopback 전용, GET만 허용, 경로 정제                                       | loopback, Host+Origin+Sec-Fetch-Site 검사, 쓰기 RPC allowlist                                  | 127.0.0.1, GET만 허용                                  |
| 성숙도                 | 데모 수준, 테스트 10개                                       | 설계 문서는 많지만 UI는 미완성                                             | **가장 성숙**: 테스트 파일 44개, smoke 스크립트 50여 개                                        | 작은 단일 목적 도구                                    |

---

## 1. unrealandychan/herdr-office: "pixel-agents에서 영감을 받은" Herdr 오피스

### 1.1 메타

- "Pixel office GUI orchestrator for Herdr agents". 2026-09-27에 만들어져 이틀 동안 집중 개발됐다. 이슈 #1–#23로 트랙(Art/Backend/Engine/UI/Native Rust)을 나눴고, #14–#19 "Native Rust" 이슈들은 아직 열려 있다(Rust 데스크톱 포팅 계획).
- 테스트: `server/test/*.ts` 2개 파일에 10개 남짓. `test-e2e.ts`는 실제 herdr 세션이 있어야 돌아간다.
- README에는 MIT라고 되어 있지만 LICENSE 파일이 없다.

### 1.2 폼팩터와 실행 방법

- npm workspaces 모노레포(`client`, `server`). `npm run dev`는 `concurrently`로 서버(:4000, ws)와 Vite(:5173)를 함께 띄운다. 빌드 후에는 서버가 `client/dist`를 정적으로 서빙한다(`server/src/index.ts:132-147`).
- VS Code 확장이 아니라 **독립 웹앱**이다.

### 1.3 데이터 소스 (ARCHITECTURE.md 주장 vs 실제 코드)

- 문서는 "herdr.sock JSON-RPC 또는 CLI 폴백, 기본 500ms"라고 하지만, **실제 코드는 CLI만 쓴다.** socket과 events는 쓰지 않는다.
- `herdr agent list`를 execFile로 호출(timeout 2s)하고 JSON(`result.agents[]`)을 파싱한다 — `herdrConnector.ts:354-361`.
- **적응형 폴링**: WS 클라이언트가 1명 이상이면 1500ms(`HERDR_POLL_INTERVAL_MS`), 0명이면 10000ms(`HERDR_IDLE_POLL_INTERVAL_MS`)다. 클라이언트가 0명에서 1명이 되면 즉시 poll한다 — `herdrConnector.ts:280-318, 779-790`. `inFlightPoll`로 중복 poll을 막는다(`342-352`).
- 세부 활동은 두 경로로 얻는다.
  1. `raw.agent_session.value`를 **파일 경로**로 보고 JSONL tail 64KB를 읽는다. 마지막 user 메시지를 prompt로, 마지막 assistant의 `toolCall`/`thinking`/`text`를 task로 삼고, 결과를 mtime으로 캐시한다 — `herdrConnector.ts:144-235, 374-398`. 이 포맷(`type:'message'`, `toolCall`)은 **pi 하네스의 세션 포맷**이고 Claude Code JSONL(`type:'assistant'`, `tool_use`)과는 맞지 않는다. Claude 에이전트라면 사실상 동작하지 않는다.
  2. 위에서 task를 못 얻고 상태가 working/blocked면 `herdr agent read <pane> --lines 20`으로 화면을 읽고(8초 캐시) 정규식 휴리스틱(`extractTerminalDetails`, `21-120`)으로 currentTask와 blockedReason을 뽑는다.
- 에이전트 식별 키는 `pane_id`다. 추가·변경·삭제를 diff해서 `agent_added`/`agent_updated`/`agent_removed`를 emit한다(`440-468`). status, focused, title, task, prompt 중 하나라도 바뀌면 update로 친다.

### 1.4 상태 모델 → 비주얼

- herdr의 5개 상태(`idle|working|blocked|done|unknown`)를 그대로 쓴다(`normalizeStatus`, `792-802`).
- 스프라이트 시트의 row로 매핑한다(`officeCanvas.ts:1540-1600`): working은 row5 타이핑(8fps), blocked는 row6 당황(4fps), done은 row7 승리 포즈, idle은 row0, 걷기는 se/ne/sw 방향별 row2–4, 드래그 중에는 row8(공중에서 다리를 버둥거림).
- **캐릭터 변형을 에이전트 종류별로** 둔다. manifest의 `variants`에 `pi/claude/codex/gemini`가 있다(`client/public/assets/manifest.json:209-215`).
- working이면 `{ } ; λ ⚡` 같은 코드 문자 파티클이 머리 위로 올라간다(`officeCanvas.ts` update의 "Coding Sparks"). blocked는 빨간 `!` 말풍선, done은 초록 체크 말풍선이다.

### 1.5 비주얼과 인터랙션

- **2.5D 아이소메트릭**(64×32 iso 타일, `officeLayout.ts:gridToIso`)이다. pixel-agents의 탑다운 16px 그리드와 다르다.
- 데스크 8개(팀 pod 2개)에 회의실 좌석 8개, POI(커피·정수기·라운지·화이트보드)가 있다. idle 상태로 앉아 있는 에이전트는 24–50초마다 35% 확률로 POI에 갔다가 4.5초 뒤 돌아온다(`officeCanvas.ts:400-445`). POI 슬롯 점유를 확인해 서로 겹치지 않게 한다.
- 비착석 엔티티끼리는 **분리력**(MIN_DIST 0.85)을 적용해 겹침을 막는다.
- **에이전트 간 대화 연출**: 메시지를 보내면 송신자가 수신자 책상까지 걸어가 말풍선을 띄우고, 수신자가 답을 말한 뒤 송신자가 복귀한다. walking_to → speaking_from → speaking_reply → returning 순서의 상태 머신이다(`officeCanvas.ts:234-265`, update §3). 이와 함께 서버는 `herdr agent prompt <to> "[From @x]: ..."`로 **실제 메시지를 전달**한다(`herdrConnector.ts:621-680`).
- **Standup**: 전원이 회의 테이블로 모인다. **Broadcast**: 모든 에이전트에 `[Workspace Goal Update]: ...`를 프롬프트로 보낸다(`682-753`).
- **AgentDrawer**: 클릭한 에이전트의 터미널 60줄 보기(`agent read`, 실패하면 `pane read`), prompt 입력(Ctrl+Enter), Ctrl+C 인터럽트. **SpawnAgentModal**: `tab create --no-focus`, `agent start --kind`, 초기 prompt 순으로 실행한다(`547-601`).
- 드래그 앤 드롭으로 캐릭터를 집어 옮길 수 있고, 클릭 리플, 에스프레소 증기와 정수기 거품 파티클, 분위기 조명도 있다.
- focus: WS로 `focus_pane`을 보내면 `herdr pane focus --pane <id>`가 실행된다(`493-502`).
- 아트는 `scripts/generate-art.ts`가 pngjs로 **절차적으로 생성**한 PNG 타일셋과 캐릭터 시트다. 외부 에셋 라이선스 문제를 피하려는 선택으로 보인다.

### 1.6 pixel-agents 대비 변경점과 이유 (추정 포함)

| pixel-agents                                        | unrealandychan                                        | 이유와 의도                                                       |
| --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| VS Code 확장 webview                                | 독립 Node 서버 + 브라우저                             | herdr는 터미널 멀티플렉서라 IDE에 종속되지 않는다                 |
| Claude Code hooks + JSONL로 상태 추론               | `herdr agent list`의 `agent_status`가 정본            | 하네스(pi/claude/codex/gemini)와 무관하게 동작                    |
| 탑다운 16px 타일 + 레이아웃 에디터                  | 2.5D 아이소메트릭, 고정 레이아웃(에디터는 Roadmap M6) | "Theme Hospital/SimCity" 풍 비주얼(`generate-art.ts` 팔레트 주석) |
| 외부 타일셋 에셋                                    | pngjs 절차적 생성 아트                                | "100% custom pixel art"(README)                                   |
| 관찰 전용                                           | **오케스트레이터**(prompt/spawn/broadcast/메시지)     | "GUI orchestrator"라는 포지셔닝                                   |
| 툴 이름 기반 애니메이션(Read는 읽기, Edit는 타이핑) | 상태 5종 기반. 툴 정보는 말풍선 텍스트로만 표시       | herdr가 툴 단위 이벤트를 주지 않기 때문                           |

### 1.7 가져올 만한 아이디어

- **클라이언트 수에 따른 적응형 폴링** + inFlight 합치기(`herdrConnector.ts:280-352`). 보는 사람이 없으면 10초로 늦춘다.
- **화면 읽기는 working/blocked일 때만, 8초 캐시**(`400-422`). 비용이 큰 `agent read`를 필요한 때만 한다.
- **세션 파일 tail은 64KB만 읽고, prompt가 없으면 head 32KB를 읽는다**(`144-235`). mtime 캐시와 캐시 최대 50개 제한도 있다.
- `agent prompt`가 실패하면 `pane send-text`로 폴백(`504-529`). 다만 이 폴백은 위험하다(1.8 참고).
- 메시지 전송을 걸어가서 대화하는 연출로 시각화하는 점, idle일 때 커피를 마시러 가는 자율 행동, done 승리 포즈(pixel-agents에는 done 상태가 없다).

### 1.8 한계와 함정

- **보안이 심각하게 약하다**: `httpServer.listen(port)`에 host가 없어 모든 인터페이스에 bind된다(`index.ts:367`). `Access-Control-Allow-Origin: *`(`index.ts:58`)이고, WS는 Origin을 검사하지 않는다(`index.ts:177, 246`). 따라서 **사용자가 방문한 아무 웹사이트나 `ws://localhost:4000`에 붙어 `spawn_agent`/`prompt_agent`를 보낼 수 있다**. 원격 코드 실행과 같은 수준의 위험이다. 정적 서빙도 `path.join(clientDistPath, urlPath)`로 경로를 정제하지 않는다(`index.ts:132-138`).
- **좌석 배정이 인덱스 기반**이다: `getStationForIndex(i)`(`officeCanvas.ts:317-368`, `officeLayout.ts`). 에이전트 하나가 빠지면 뒤쪽 전원의 자리가 한 칸씩 밀린다.
- 세션 JSONL 파서가 pi 전용이어서 Claude Code 트랜스크립트는 해석하지 못한다.
- `extractTerminalDetails`의 정규식(`?\s*$`가 있으면 blocked, "error"가 있으면 blocker 등)은 오탐이 잦다.
- `pane send-text` 폴백은 TUI 상태와 무관하게 텍스트와 `\n`을 밀어 넣는다. Claude가 권한 프롬프트를 띄운 상태라면 의도하지 않은 선택이 될 수 있다.
- 문서에는 "socket/500ms"라고 적혀 있지만 실제로는 CLI/1.5s다. 문서를 믿으면 안 된다.

---

## 2. BlazzzPlay/herdr-office: Collie와 Claude Office를 결합하려 한 "읽기 전용" 오피스

### 2.1 메타

- 2026-08-11 하루 동안 진행됐다(커밋 약 11개). OpenSpec(SDD) 문서가 매우 많다(`openspec/changes/archive/2026-08-11-herdr-office-mvp-feasibility/*`). MIT 라이선스.
- 테스트는 vitest로 약 22개다(bridge 정규화, 재연결, 이벤트 hint, HTTP 라우팅, 렌더). live 테스트는 `HERDR_SOCKET`이 없으면 skip되고, verify-report에도 **실제 프로토콜 호환성은 검증되지 않았다**고 명시돼 있다(`verify-report.md:37,84`).
- `UPSTREAM.md`: Collie(`AltanS/collie@f6153629`)와 Claude Office(`W17ant/Claude-Office@291e7608`)는 기준선으로만 기록했고 **"아직 어떤 코드도 복사하거나 개조하지 않았다"**고 적혀 있다. 이름과 달리 실제로 결합한 상태는 아니다.

### 2.2 폼팩터와 실행 방법

- `npm start`(vite-node `bridge/index.ts`)는 기본 `127.0.0.1:3000`에서 뜬다. `OFFICE_STATIC_DIR`로 빌드된 프론트를 서빙한다.
- 렌더링은 **Canvas가 아니라 CSS/DOM**이다(`DESIGN.md`: "semantic HTML remains testable, accessible"). 스프라이트는 `<div class="sprite"><i/><b/></div>` 수준이다(`frontend/src/components/Office.tsx:31-34`).

### 2.3 데이터 소스

- **Unix socket JSON-lines 프로토콜**(`bridge/herdr-client.ts`)
  - 요청은 `{"id","method","params"}\n`, 응답은 `id`로 매칭한다. `id`가 없고 `event`가 있는 메시지는 이벤트로 처리한다(`14-59`).
  - `readSnapshot()`: 먼저 `ping`을 보내 `{type:'pong', version:string, protocol:19}`인지 **엄격히 확인**한 뒤, **새 연결로** `session.snapshot`을 보내고 `{type:'session_snapshot', snapshot}`을 받는다(`66-77, 108-120`). 지원하는 프로토콜은 **19 하나뿐**이다.
  - `subscribe()`: ping 후 `events.subscribe {subscriptions:[{type:'pane.agent_status_changed'}]}`를 보낸다. 3회 재시도(25/100/250ms)하고, close되면 자동으로 재구독한다(`79-101`).
- **스냅샷이 정본이고 이벤트는 힌트일 뿐**이다(ARCHITECTURE 불변식 1–2). 이벤트가 오면 `EventPoker`가 키(`event:sequence` 또는 data JSON)로 50ms 동안 중복을 제거한 뒤 `refresh()`, 즉 전체 snapshot 재조회를 트리거한다(`event-poker.ts`, `state-engine.ts:15-30`). 이벤트 payload로 상태를 직접 바꾸지 않는다.
- 실패하면 disconnected snapshot(에이전트 0명)으로 바꾸고 100/250/500ms 백오프로 재시도한다(`state-engine.ts:21-30`).
- **멀티 세션**: `HERDR_SESSIONS='[{"name","socketPath","version":1,"primary"?}]'`. 하나만 쓸 때는 `HERDR_SOCKET`으로 폴백한다. `HERDR_SOCKET_ROOT`(기본값 `/run/herdr` 또는 HERDR_SOCKET의 dirname) 밖의 경로는 거부하고, 이름은 `^[\w.-]+$`만 허용한다(`registry.ts:21-39`, `index.ts:21-29`). HTTP는 세션 ID를 카탈로그에서만 조회하므로 경로를 주입할 수 없다.
- 정규화: `snapshot.agents ?? snapshot.panes`에서 `{id: id??pane_id, name: name??agent??terminal_title_stripped, status: status??agent_status, focused}`만 화이트리스트로 노출한다(`normalize.ts:17-25`). cwd와 경로는 일부러 빼서 **민감 정보 누출을 막는다**.

### 2.4 상태 모델과 비주얼

- 5개 상태에 텍스트 마커(`! ~ + · ?`)와 색을 함께 쓴다. **색만으로 상태를 구분하지 않는 접근성 원칙**과 `prefers-reduced-motion` 존중(DESIGN.md)이 있다.
- 모니터 글리프(`! ~ + _ ?`), 에이전트 이름, 상태 텍스트, "/ focused" 표시. 세분화된 활동 정보는 없다.

### 2.5 인터랙션과 보안

- 세션 선택 드롭다운만 있다. 클릭해서 포커스하거나 프롬프트를 보내는 기능은 없다("UI가 제어를 암시해서는 안 된다").
- HTTP는 `GET /api/snapshot`, `/api/sessions`, `/api/sessions/:id/snapshot`만 있고, 나머지 `/api/*`는 404/405로 닫힌다. 정적 파일은 `relative()`로 경로 이탈을 막는다(`server.ts:19-56`). loopback이 기본이다.

### 2.6 가져올 만한 아이디어

- **"snapshot이 정본, event는 힌트"** 패턴(`state-engine.ts`, `event-poker.ts`). 이벤트가 유실·중복되거나 순서가 바뀌어도 정합성이 깨지지 않는다. 재연결 시에도 snapshot만 다시 받으면 된다.
- **ping으로 프로토콜 버전을 핸드셰이크**하고, 지원하지 않는 버전은 명시적으로 실패시키기(`herdr-client.ts:108-114`).
- 와이어 타입과 공개 DTO의 분리, 소켓 경로 화이트리스트, 세션 런타임 격리(한 세션이 실패해도 다른 세션은 영향 없음).
- 접근성 원칙(텍스트+색+마커 병기, 모션 감소 옵션).

### 2.7 한계와 함정

- **프론트엔드가 실시간으로 갱신되지 않는다**: `App.tsx:12-17`에서 마운트할 때 한 번 fetch하고 끝이다. 폴링도 SSE도 WS도 없다.
- **서버도 주기적으로 폴링하지 않는다**: `refresh()`는 초기 1회, 이벤트, 실패 재시도 때만 불린다. 이벤트 구독이 조용히 실패하면(catch로 무시, `state-engine.ts:19`) 상태가 영원히 갱신되지 않는다. 문서에 쓴 "polling fallback"이 구현되지 않았다.
- 요청마다 새 소켓을 연다(ping 1회, snapshot 1회). 재시도 백오프 상한이 500ms라서 herdr가 꺼져 있으면 초당 2회씩 무한 재시도한다.
- `protocol === 19`만 허용하므로 herdr가 업그레이드되면 바로 끊긴다.
- 실제 herdr 위에서 검증된 적이 없다(live 테스트 skip).

---

## 3. montagao/herdr-story: Game Dev Story 풍 "스튜디오 시뮬레이션"

### 3.1 메타

- "A pixel-art office for Herdr agents, project progress, and revenue." ★1. 2026-09-05에 생성됐고 10-06에 push됐다. ISC 라이선스. CI 배지가 있다.
- 코드 약 2만 줄(TS). 테스트 파일 44개(`bun test`)와 Playwright smoke 스크립트 50개 이상이 있다. 넷 중 **가장 성숙하다**.
- 스택: **Bun** 브리지(`bridge/server.ts` 1715줄, SQLite 저널) + Vite + **Phaser 4** 프론트.
- **주의**: 오피스 아트는 **Kairosoft "Game Dev Story" 에셋을 추출한 것**이다(`src/seats.ts` 주석에 "IL2CPP extraction of Game Dev Story 2.6.9"라고 적혀 있다). README는 "this private repository"라고 하지만 GitHub상으로는 **PUBLIC**이다. 라이선스 리스크가 있으므로 에셋을 참고해서는 안 된다.

### 3.2 폼팩터와 실행 방법

- `npm run dev`(`scripts/dev.sh`): 브리지는 `127.0.0.1:7788`, 웹은 5173에서 뜬다. `dev:mock`(herdr 없이 모의 백엔드), `dev:read-only`(`HERDR_STORY_WRITE=0`), `dev:tailscale`(Tailscale Serve용 origin 자동 설정), `?demo=1`(가상 데모), `?debug`(이벤트 테스트 트레이)가 있다.
- 아트가 없을 때는 **roster-only 뷰**(프로젝트별로 묶은 에이전트 목록, 모바일 지원)로 대체된다.

### 3.3 데이터 소스

- **소켓 탐색**(`server.ts:478-488`): ① `HERDR_SOCKET_PATH` → ② `herdr status` 출력에서 `socket: <path>` 파싱 → ③ `HERDR_SESSION`이면 `~/.config/herdr/sessions/<name>/herdr.sock` → ④ `~/.config/herdr/herdr.sock`.
- **클라이언트**(`bridge/herdr-client.ts`): Bun.connect로 **요청 1건마다 연결 1개**를 연다. `id` 매칭, timeout 10s(`agent.start`는 90s). `invalid_request` 에러는 `notSent:true`로 표시해 "확실히 전송되지 않았음"을 구분한다(`:32-33`).
- **폴링**: `POLL_MS=1000`(`HERDR_STORY_POLL_MS`, `server.ts:45`), `setInterval(poll)`(`:1477`). `events.subscribe`는 **쓰지 않는다**.
  - `listedAgents()`(`:457-476`): 5초마다 `session.snapshot`(agents와 workspaces를 원자적으로 함께 받아 workspace label을 얻는다), 그 사이에는 가벼운 `agent.list`를 호출한다.
- 사용하는 herdr 메서드: `session.snapshot`, `agent.list`, `agent.get`, `agent.read{source:'visible'}`, `agent.prompt{wait:{until:[...], timeout_ms}}`, `agent.queue`, `agent.send_keys`, `agent.focus`, `agent.start{name,kind,pane_id,args,timeout_ms}`, `agent.settings.update`, `workspace.create/close`, `pane.split/close`.
- **변경 감지 키**: `state_change_seq`(herdr가 주는 단조 증가 카운터)와 `sessionKey = [pane_id, agent, agent_session.kind, agent_session.value, cwd]`(`:1327`). status가 같아도 seq가 바뀌면 변경으로 본다.
- **Claude Code / Codex 트랜스크립트 결합(핵심)**
  - `agent_session = {kind:'id', value:<uuid>}`를 이용한다. `~/.claude/projects/**/*.jsonl`과 `~/.codex/sessions/**/*.jsonl`을 60초마다 glob 스캔해 `uuid → 파일경로` 인덱스를 만든다(`server.ts:290-329`).
  - 모델명: tail 512KB를 역방향으로 읽어 `assistant.message.model` 또는 `turn_context.payload.model`을 찾는다. 15초 캐시와 크기 캐시를 쓴다(`:331-389`).
  - 대화 파싱(`bridge/transcript.ts:24-62`): Claude는 `type:'user'`(isMeta와 tool_result 제외)와 `type:'assistant'` text, `ai-title`을 본다. Codex는 `response_item`, `event_msg.task_complete`를 본다. 파일 크기와 inode 기준으로 증분 파싱해서 idle 에이전트는 stat 한 번만 하면 된다(`:105-`).
  - **"화면이 이긴다"**: herdr의 session id가 낡을 수 있다(같은 pane에서 새 대화를 시작한 경우). 그래서 화면에서 읽은 prompt와 트랜스크립트의 prompt 앞 40자가 다르면 화면을 믿는다(`transcript.ts:85-92`, `server.ts:442-445`).
- **화면 기반 활동 추출**(`withCurrent`, `server.ts:431-452`)
  - 폴링 1회당 **최대 6개 pane만** `agent.read(visible)` 한다(budget). 재조회 조건은 상태나 seq가 바뀌었을 때, working이면 5초, 그 외에는 2분이다.
  - `extractCurrent`(`outcome.ts:52-65`): `❯` 프롬프트 줄로 last_prompt, `⏺` 마크 줄로 activity, Claude 스피너 줄(`✻ Thinking… (12s)`)로 현재 단계를 뽑는다.
  - `extractWaitNotice`(`agent-wait.ts`): "Retrying in…", "rate limit", "You've hit your limit"을 감지해 `wait_notice {kind:'rate_limit'|'retry'}`를 만든다. **herdr의 상태와 별개인 오버레이 상태**다.
- **읽기 스케줄러**(`agent-output.ts:15-80`): 모든 `agent.read`를 하나의 허브로 모은다. 동시 실행은 2개까지, background 작업은 1개까지라서 interactive 요청이 우선된다. visible 캐시 180ms, 기록 캐시 1.5s, 같은 키의 중복 요청 합치기, AbortSignal 취소, 캐시 상한 64개·2MB를 둔다.

### 3.4 상태 모델 → 비주얼 (`src/scenes/OfficeScene.ts:397-450`)

- working: 타이핑 포즈, 모니터 애니메이션, 불꽃 아이콘, 팝업 이펙트. debug 직군이면 버그 이펙트를 추가한다.
- blocked: 서서 두리번거리고, `!` 말풍선이 bob 트윈으로 위아래로 움직인다.
- done: cheer 포즈로 점프한다. idle: 앉아서 fidget(1.5–6초마다 둘러보기, 깜빡임, 스트레칭). unknown: 회색 tint.
- `wait_notice`가 있으면 타이핑 포즈로 고정하고 이름표에 "Rate limited · …"를 표시한다.
- **실제 전이(transition)일 때만 소리와 말풍선**을 낸다. 첫 동기화 때는 조용히 착석시킨다(`animateTransition`).
- **컷신**(README 표): working 상태가 25분 이상 이어지다 done/idle이 되면 책상에 엎드린다(`CRUNCH_MS`, `OfficeScene.ts:1458`). blocked 전이 직후 snippet에 error/panic 같은 단어가 있으면 폭발 이펙트(`:1456`). 그 밖에 Ship party, Awards night 등이 있다.
- **좌석**: 프로젝트(cwd 기반 `projectKey`)마다 클러스터 하나를 두고, 4인 뱅크를 대각선으로 늘린다(`src/seats.ts`).
- **영속 정체성**(`bridge/studio.ts:231-256`): identity(session 기반)를 employee UUID에 매핑하고, 이름·얼굴(`hash(pane_id)%36`)·몸·레벨·커리어 통계를 SQLite에 저장한다. session id가 한 폴링 늦게 도착하는 경우를 고려해 **provisional identity를 한 번만 승격**하는 로직도 있다.

### 3.5 인터랙션, 오케스트레이션, 보안

- 대화 창: 트랜스크립트를 산문으로 보여주고, 원시 pane 출력은 클릭 한 번으로 볼 수 있다. 갱신 중에는 stale veil을 씌운다.
- prompt/이미지 전송, **Claude가 바쁠 때는 큐에 넣었다가 idle이 되면 자동 전송**(`claude-queue.ts`, 원자적 파일 저장), model/effort 변경, 인터럽트, 마지막 prompt 복구, 신규 고용(workspace/pane 생성 + agent.start), 해고(pane.close)를 지원한다.
- **프롬프트 전달 검증**(`prompt-delivery.ts`)
  - 먼저 `agent.get`으로 `interactive_ready`/`launch_pending`을 확인하며 최대 20초 기다린다.
  - `agent.prompt`에 `wait:{until:[working,idle,done,blocked], timeout_ms:6000}`을 붙여 보낸다.
  - 타임아웃이 나면 15초 동안 ① `state_change_seq` 증가나 working 전이, ② 입력 박스(`❯` 줄, 두 개의 가로 rule 사이)가 비어 있고 메시지가 echo됐는지로 성공 여부를 확인한다. 박스에 텍스트가 그대로 남아 있으면 "재전송하지 말 것"이라는 uncertain 에러를 낸다. **절대 재전송하거나 추가로 Enter를 보내지 않는다.**
- 보안(`SECURITY.md`, `browser-access.ts`)
  - loopback이 기본이다. 쓰기는 `HERDR_STORY_WRITE` 미지정 시 loopback일 때만 활성화된다(`server.ts:43-44`). 쓰기 메서드는 allowlist로 관리한다(`:48`).
  - **Host와 Origin을 모두 검사해 DNS rebinding을 막는다**. Origin이 없는 요청은 `Sec-Fetch-Site`가 cross-site/same-site면 거부한다. WS upgrade에도 같은 검사를 적용한다.
  - 원격 접근은 Tailscale Serve와 `HERDR_STORY_ALLOWED_ORIGINS` 정확 일치로만 허용한다.
  - "read-only도 터미널 출력은 노출한다"는 점을 명시한다.
- WS 프로토콜: 클라이언트가 `hello{deltas:true}`로 delta 지원을 협상한다(지원하지 않으면 100ms 뒤 전체 snapshot). `output.subscribe`로 특정 pane의 화면을 스트리밍하고, `call{id,method,params}`로 RPC를 프록시하며, 진행 단계는 `launch` 메시지로 알린다(`server.ts:1671-1712`).

### 3.6 가져올 만한 아이디어 (pixel-agents-herdr에 바로 적용 가능)

1. **`agent_session.value`(uuid)로 `~/.claude/projects/**/<uuid>.jsonl`을 찾는 조인** — pixel-agents의 JSONL 파서를 herdr pane에 붙이는 가장 깔끔한 방법이다(`server.ts:312-329`). 단, session id가 낡을 수 있으니 화면과 교차 검증한다(`transcript.ts:85`).
2. **`state_change_seq`를 변경 감지 키로 사용** — idle→working→idle이 폴링 간격 사이에 일어나 status가 같아 보여도 놓치지 않는다.
3. **화면 read 예산(폴링당 6개)과 상태별 TTL(working 5초 / 그 외 2분)**, 그리고 **우선순위 read 큐**(`agent-output.ts`).
4. **`wait_notice`(rate limit/retry)를 herdr 상태와 독립된 오버레이로 다루기** — herdr는 rate limit을 working으로 보고하기 때문이다.
5. **첫 동기화는 조용히, 실제 전이에만 소리와 연출**, 장시간 working 이후 "crunch" 연출, done 축하.
6. `prompt-delivery.ts`의 **"재전송 금지, 상태나 화면으로 제출 확인"** 원칙.
7. Host+Origin+Sec-Fetch-Site 검사(`browser-access.ts`) — 26줄짜리라 그대로 이식할 만하다.
8. provisional identity 승격을 포함한 **영속 캐릭터 정체성**(같은 Claude 세션이면 같은 캐릭터).
9. 5초마다 `session.snapshot`, 그 사이에는 `agent.list`로 비용과 정보량의 균형 맞추기.

### 3.7 한계와 함정

- Kairosoft 에셋 문제(앞의 3.1).
- 이벤트 구독 없이 1초 폴링만 한다. 짧은 blocked도 seq로 감지는 하지만 표시가 최대 1초 늦는다.
- 범위가 지나치게 넓다(결제, Stripe/RevenueCat, Boss AI, 저널). `server.ts` 한 파일이 1715줄이다.
- Boss 기능은 "permission bypass"로 Claude를 실행한다(SECURITY.md에 명시).
- 요청마다 소켓 연결 1개를 연다(herdr의 "one-response socket"에 맞춘 것이라 주석에 설명돼 있다).

---

## 4. andrebrov/herdr-viz: RTS(스타크래프트) 풍 작전 지도

### 4.1 메타

- 2026-10-06에 생성, 커밋 2개, MIT. 의존성과 빌드 단계가 없다. `server.mjs`(299줄) + `index.html`(991줄) + `verify-render.mjs`(파서 단위 테스트와 vm 기반 렌더 검사).

### 4.2 폼팩터와 실행 방법

- `node server.mjs`로 실행하면 `http://127.0.0.1:4777`에서 뜬다. herdr는 `HERDR_BIN`, PATH, `~/.local/bin/herdr` 순으로 찾고, herdr 환경변수(소켓 경로)는 상속한다.

### 4.3 데이터 소스

- CLI `herdr agent list`와 `herdr workspace list`를 병렬로 호출한다(timeout 5s, maxBuffer 8MB). 서버는 5초 동안 결과를 캐시하고 `pending`으로 동시 요청을 합친다. 실패하면 **마지막 정상값을 유지하면서 `stale:true`**로 응답한다(`server.mjs:84-115`).
- 브라우저는 `setInterval(poll, 5000)`로 `/api/status`를 가져온다(`index.html:984`).
- **Callsign**: workspace label이 `"Sulu · claude-pm"`이고 `" · <agent name>"`으로 끝나면 앞부분을 콜사인으로 쓴다. 없으면 `~/.config/herdr/callsigns.tsv`를 본다(`server.mjs:61-74`).
- 선택 기능: beans 작업 큐(`beans list --json`), 좌석·소유자 파일, standup/retro Markdown 리더. 모두 읽기 전용이다.
- 정체성 키: `name + pane + occurrence`(`index.html:176-211`).

### 4.4 상태 모델 → 비주얼 (`index.html:303-361`)

- 상태별 **이동 메타포**:
  - working: 자기 기지와 중앙 "크리스탈 필드"를 왕복하며 자원을 나른다. 3사이클마다 다른 working 유닛을 방문하거나 bridge로 간다. 진행 막대도 표시한다.
  - done: 중앙 bridge에 황금각(2.39996rad) 나선 배치로 모인다.
  - idle: 집으로 복귀하고 위아래로 bob한다. blocked: 그 자리에 멈춘다.
  - unknown은 `missing`으로 보고 회색으로 그린다.
- README가 "이 이동은 비주얼 메타포일 뿐, 실제 협업을 주장하지 않는다"고 **정직하게 밝히는** 점이 좋다. 선택한 유닛 패널에는 현재 route와 실제 terminal title을 함께 보여준다.
- **하네스별 실루엣**: fillRect만으로 claude(뿔), codex(바이저), cursor(안테나), grok, opencode 등을 그리고 종족 색을 입힌다(`index.html:449-500`). 이미지 에셋 없이 절차적으로 그린다.
- 미니맵, 카메라 드래그 팬, 상태 카운트 HUD, 인스펙터 스크롤.

### 4.5 가져올 만한 아이디어

- **workspace label 규약 `"<콜사인> · <agent name>"`을 캐릭터 이름으로 쓰는 방식** — herdr 사용자가 이미 쓰고 있는 메타데이터를 재활용한다.
- **last-good + stale 플래그**로 일시적인 CLI 실패를 견딘다.
- 상태를 이동 패턴으로 인코딩하는 방식(working은 왕복, done은 집결, blocked는 정지). blocked가 "멈춤"으로 직관적으로 보인다.
- 이미지 없이 kind별 실루엣을 그리는 방식(pixel-agents의 캐릭터 팔레트를 하네스 종류에 매핑하는 데 참고할 수 있다).

### 4.6 한계와 함정

- `records.filter(record => record && record.name)`(`server.mjs:61`): **`name`이 없는 에이전트(직접 실행해 herdr가 자동 감지한 claude 등)는 아예 표시되지 않는다.**
- 5초 주기라 짧은 blocked나 done을 놓친다(`state_change_seq`를 쓰지 않는다).
- 레이아웃이 이름순 정렬 기반이라 에이전트가 추가되거나 빠지면 기지 위치가 재배열된다(`index.html:100-126`).
- 클릭해서 포커스하거나 제어하는 기능이 없다(의도된 읽기 전용).

---

## 5. pixel-agents-herdr 설계 제언 (4개 레포 종합)

### 5.1 데이터 계층

1. **socket 직접 사용, snapshot을 정본으로**: 시작할 때 `ping`으로 protocol 버전을 확인한다(BlazzzPlay). 실패를 명시적으로 처리하되 버전 범위는 관대하게 둔다. 이후 `session.snapshot`(workspace label 포함)으로 전체 상태를 동기화한다.
2. **`events.subscribe(pane.agent_status_changed)`는 refresh 힌트로만** 쓰고, **주기적 폴링 안전망(예: 2–5s)을 반드시 함께 둔다**. BlazzzPlay는 이 안전망을 빠뜨렸다.
3. 변경 감지는 `(status, state_change_seq, sessionKey)`로 한다(herdr-story).
4. **Claude 세분 활동**: `agent_session.kind==='id'`이면 uuid로 `~/.claude/projects/**/<uuid>.jsonl`을 찾아 **pixel-agents의 기존 JSONL/툴 파서를 재사용**한다. 그러면 Read/Edit/Bash 같은 툴 애니메이션을 유지할 수 있다. `kind==='path'`(pi 등)는 경로를 그대로 쓴다(unrealandychan). 트랜스크립트와 화면이 어긋나면 화면을 우선한다.
5. 화면 read는 **예산과 TTL을 둔 우선순위 큐**로 관리한다(herdr-story `agent-output.ts`). working/blocked 상태에서만 읽는다(unrealandychan).
6. rate limit과 retry는 herdr 상태와 별도인 `wait_notice` 오버레이로 다룬다.
7. 실패해도 last-good 상태를 유지하고 "stale" 배지를 띄운다(herdr-viz).

### 5.2 정체성과 좌석

- 좌석은 **인덱스가 아니라 안정적인 키(pane_id, 가능하면 session uuid)에 고정 배정**하고 해시로 외형을 정한다. unrealandychan과 herdr-viz는 인덱스나 정렬 순서에 의존해서 자리가 재배치되는 문제가 있다.
- 이름 우선순위: `agent.name` → workspace label 콜사인 → `terminal_title_stripped` → kind. 이름이 없는 에이전트도 반드시 표시한다(herdr-viz의 버그를 피한다).
- 프로젝트(cwd/workspace)별 클러스터 배치를 고려한다(herdr-story).

### 5.3 비주얼 매핑 (pixel-agents 위에 추가)

- herdr의 `done` 상태를 축하 포즈와 체크 말풍선으로 표현한다(pixel-agents에는 없음). `blocked`는 `!` 말풍선 bob과 정지 또는 두리번거림, `unknown`은 회색 tint.
- 첫 동기화는 무음, 실제 전이에서만 효과음. 장시간 working은 crunch 연출, idle은 커피나 산책 같은 자율 행동.
- 하네스 kind(claude/codex/pi/gemini/opencode)마다 캐릭터 팔레트나 실루엣을 다르게 한다.

### 5.4 인터랙션과 보안

- **클릭하면 `pane.focus`/`agent.focus`**(pixel-agents의 "클릭하면 터미널 포커스" 경험을 계승).
- 프롬프트 전송 같은 쓰기 기능을 넣는다면 다음을 지킨다.
  - 기본은 loopback 전용이고, 쓰기는 opt-in이며, 메서드는 allowlist로 제한한다.
  - **Host+Origin(+Sec-Fetch-Site) 검사**를 적용한다(herdr-story `browser-access.ts`).
  - **unrealandychan의 CORS `*` / 0.0.0.0 / Origin 검사 없음 구성은 절대 따라 하지 않는다.**
  - `pane send-text`로 폴백하지 말고, `agent.prompt` + `wait` + 상태·화면으로 제출을 확인한다. 재전송은 하지 않는다.
- 멀티 세션: 소켓 경로는 서버 설정에서만 받고 HTTP 입력에서는 받지 않는다. 세션별 런타임을 격리한다(BlazzzPlay).

### 5.5 피해야 할 것

- 문서에만 있고 구현되지 않은 기능(unrealandychan의 socket/500ms 문서, BlazzzPlay의 polling fallback). 반드시 실제 herdr에서 검증해야 한다.
- 출처가 불분명하거나 상용인 에셋(herdr-story의 Kairosoft 추출 아트).
- 터미널 출력에 대한 공격적인 정규식 휴리스틱으로 blocked 원인을 단정하는 것(오탐이 잦다). herdr의 `agent_status`를 정본으로 삼는다.
