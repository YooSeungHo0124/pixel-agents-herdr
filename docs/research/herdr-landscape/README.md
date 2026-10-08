# herdr × 픽셀 오피스 생태계 조사 — pixel-agents-herdr 설계 근거

> 조사일: 2026-10-08 · 대상: herdr 0.8.2 (protocol 20) 환경 · 방법: 각 저장소를 `--depth 1` clone 후 **소스 직접 정독**(설치·빌드·실행 없음) + 로컬 herdr 소켓 read-only 실측
>
> 상세 보고서: [A. TUI 플러그인](A-tui-plugins.md) · [B. 웹 오피스](B-web-offices.md) · [C. 3D/데스크톱](C-3d-desktop.md) · [D. herdr API·인접 프로젝트·접점 매핑](D-herdr-api-and-adjacent.md)

## 1. 왜 조사했나

pixel-agents는 Claude Code hook + JSONL로 **"무엇을 하고 있는지"를 정확히** 안다. 하지만 herdr 안에서 돌릴 때 **"그게 어느 pane인지"를 모르고**, 캐릭터를 클릭해도 아무 일도 일어나지 않는다(standalone `focusAgent` 미구현). 반대로 herdr 생태계 프로젝트들은 pane은 알지만 활동은 화면 스크래핑으로 추정한다. 같은 고민을 먼저 한 사람들의 공통점·차이점에서 설계 방향을 뽑는 것이 목적이다.

## 2. 조사 대상 한눈 비교

| 프로젝트                             | 형태                                  | herdr 데이터                                           | 활동(tool) 정보 출처                            | Claude 세션 ↔ pane       | 클릭→pane           | 성숙도 / 라이선스                |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------ | ----------------------------------------------- | ------------------------ | ------------------- | -------------------------------- |
| devangchhajed/**herdr-pixel-office** | herdr plugin TUI pane                 | `agent.list` 1s poll + `agent.read` 250ms round-robin  | **화면 스크래핑** (`⏺ Tool(`, `Context ███ N%`) | pane 그 자체             | ✅ `agent.focus`    | 커밋 4 / MIT                     |
| vandemaelefelix/**herdr-herd**       | plugin TUI (양)                       | `session.snapshot` + 이벤트=재조회 트리거, 2.5s 안전망 | 없음 (status만)                                 | `terminal_id` 키         | ✅                  | 커밋 ~185, 테스트 437, ADR / MIT |
| andrewromewo/**herdr-lil-office**    | plugin TUI (타워)                     | 비-Claude만 `agent.list`                               | JSONL tail (hook 없음)                          | cwd 휴리스틱             | ❌ (Claude)         | 커밋 1 / 없음                    |
| montagao/**herdr-story**             | 웹 (아이소)                           | snapshot + `state_change_seq`                          | `agent_session` → JSONL + 화면 검증             | ✅ `agent_session.value` | ✅                  | 테스트 44 / (에셋 저작권 문제)   |
| unrealandychan/**herdr-office**      | 웹 (pixel-agents 영감, 신규 작성)     | CLI 1.5s poll                                          | 화면 + pi JSONL                                 | ❌                       | ✅ + prompt/spawn   | 초기 / **보안 위험**             |
| BlazzzPlay/**herdr-office**          | 웹, read-only                         | `ping` → snapshot, 이벤트=힌트                         | 없음                                            | ❌                       | ❌                  | MVP, 실제 갱신 안 됨             |
| andrebrov/**herdr-viz**              | 웹 대시보드                           | 5s poll                                                | 없음                                            | ❌                       | ❌                  | 초기                             |
| screenagers-io/**bullpen**           | 3D voxel 웹                           | snapshot                                               | `agent_session` → JSONL tail 256KB              | ✅                       | ✅ (+더블클릭 read) | 소규모 / MIT                     |
| luiscleto/**weherd**                 | Three.js 플레이어블                   | snapshot + `terminal session observe`                  | 라이브 터미널(xterm.js)                         | identity hash            | ✅ + 입력           | 라이선스 없음                    |
| HEM42/**agent-view**                 | Electrobun 데스크톱                   | poll + 2연속 확인 스무딩                               | 없음                                            | ❌                       | ✅                  | 라이선스 없음                    |
| Luckystrike561/**terrarium**         | **pixel-agents v1.4.1 포크** (PixiJS) | `HerdrBridge` → 가짜 hook 이벤트                       | omp JSONL                                       | 부분                     | ✅                  | 활발 / MIT                       |
| hhdebb/**herdr-radar**               | sidebar 토큰                          | 이벤트 wake + `agent.list` resync                      | JSONL 마지막 timestamp                          | ✅                       | (herdr 자체)        | v1.4 / —                         |
| caioniehues/**herdmates**            | 팀 shim                               | `agent.list`                                           | team 파일                                       | teammate=pane            | —                   | v3.2 / —                         |
| IvanWng97/**pixtuoid**               | Rust TUI (개념적 파생)                | 없음                                                   | hook shim + JSONL                               | ❌                       | OS 창 단위만        | 활발                             |

## 3. 공통점 — 여러 팀이 독립적으로 수렴한 결론

1. **"snapshot이 정본, 이벤트는 힌트."** herd, radar, BlazzzPlay, terrarium 모두 이벤트를 상태로 믿지 않고 *재조회 트리거*로만 쓴다. 이유는 herdr 쪽 사실에 있다:
   - `pane.agent_status_changed`는 **pane_id 필수** 구독 → 전역 status 스트림이 소켓에 없다(실측: pane_id 없이 구독하면 요청 전체가 `invalid_request`).
   - 구독 직후 최근 512개 이벤트를 replay, envelope 이름이 snake_case/dotted 두 종류, 구독당 ~10 ev/s throttle.
   - 결과적으로 **모두 1~2.5초 폴링 + 이벤트 debounce resync**로 수렴.
2. **위치(공간)가 상태를 말한다.** 일하는/막힌 에이전트는 책상, 쉬는 에이전트는 휴게실·소파·침대(pixel-office, agent-view, herdr-viz). 상태 전환 = 걸어서 이동.
3. **blocked는 가장 시끄럽게, 첫 동기화는 조용히.** 소리는 *실제 전환*에서만, 초기 snapshot은 무음, 같은 tick 다중 전환은 1회(herd, herdr-story).
4. **클릭 → `agent.focus`** 는 거의 모든 성숙한 프로젝트의 기본기. pixtuoid처럼 OS 창 포커스로는 멀티플렉서 안의 pane까지 못 간다 → **pane 단위 점프가 herdr 연동의 핵심 가치**.
5. **Claude 경로 하드코딩 버그가 흔하다.** radar, herdmates, lil-office 모두 `~/.claude` 고정 → `CLAUDE_CONFIG_DIR` 환경에서 조용히 실패. (우리 포크는 이미 수정.)
6. **pixel-agents의 아이디어가 원류.** unrealandychan은 "inspired by pixel-agents", terrarium은 실제 v1.4.1 포크. 하지만 **pixel-agents의 hook 정밀도와 herdr pane 연결을 둘 다 가진 프로젝트는 없다.**

## 4. 차이점 — 설계 축별 선택지

| 축                   | 선택지 A                                     | 선택지 B                                                                                         | 관찰                                                                                                                                                           |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **활동 정보 출처**   | 화면 스크래핑 (pixel-office, unrealandychan) | JSONL/hook (herdr-story, bullpen, terrarium, pixel-agents)                                       | 스크래핑은 Claude TUI 포맷 변경에 취약하고 **pane 텍스트를 읽는 프라이버시 부담**. JSONL/hook이 정확하고 저렴                                                  |
| **세션↔pane 조인**   | cwd 휴리스틱 (lil-office)                    | `agent_session.value` (herdr-story, bullpen)                                                     | 같은 cwd에 pane 여러 개면 cwd는 틀림. `agent_session.value`가 정답                                                                                             |
| **에이전트 식별 키** | `pane_id`                                    | `terminal_id` (herd)                                                                             | pane을 다른 workspace로 옮기면 pane_id가 바뀜. 장수명 키는 terminal_id / session_id                                                                            |
| **형태**             | herdr 안 TUI pane                            | 브라우저 웹                                                                                      | TUI는 설치 간편·herdr 일체감, 웹은 표현력(애니메이션, 레이아웃 에디터)                                                                                         |
| **쓰기 범위**        | read-only (BlazzzPlay, radar)                | prompt/spawn까지 (unrealandychan, bullpen, weherd)                                               | 쓰기를 넣은 곳 중 unrealandychan은 0.0.0.0 + CORS * 로 **임의 웹페이지가 에이전트 조종 가능**. herdr-story의 loopback + Host/Origin/Sec-Fetch-Site 검사가 모범 |
| **상태 스무딩**      | 그대로 표시                                  | 2연속 확인, blocked만 즉시 (agent-view) / `state_change_seq`로 폴링 사이 전환 감지 (herdr-story) | 깜빡임과 놓침을 동시에 줄이는 조합이 좋다                                                                                                                      |
| **idle 세분화**      | idle 하나                                    | fresh ≤15분 / idle / stale ≥2h (radar), done은 볼 때까지 유지                                    | "방금 끝남"과 "방치됨"을 구분하는 것이 실사용에서 유용                                                                                                         |

## 5. 우리가 확인한 herdr 사실 (구현 전제)

- 소켓: `$HERDR_SOCKET_PATH`, 줄 단위 JSON `{id, method, params}` → `{id, result}` / `{id, error}`. **요청마다 연결이 닫힌다**(구독 연결만 유지). 0.8.2 = protocol 20.
- `agent.list[].agent_session.value` **== Claude Code `session_id`** — 로컬 15/15 pane에서 검증. herdr 공식 Claude integration이 SessionStart hook에서 보고한다.
- Claude hook 프로세스는 `HERDR_PANE_ID / HERDR_WORKSPACE_ID / HERDR_TAB_ID / HERDR_SOCKET_PATH`를 상속한다.
- `terminal_title_stripped` = Claude가 붙인 **세션 요약 제목** → 이름표로 최적.
- `workspace.list[].label` = 사용자가 지은 워크스페이스 이름 → 오피스 구역(Area) 이름으로 최적.
- `done` = "idle인데 사용자가 아직 안 봄". **CLI/API 읽기는 seen 처리 안 함** → 폴링해도 herdr 배지를 망가뜨리지 않는다. `agent.focus`는 seen 처리한다.
- 플러그인: `herdr-plugin.toml`의 `[[startup]]`, `[[actions]]`, `[[events]]`, `[[panes]]`. `command`는 argv 배열(셸 확장 없음).

## 6. 피해야 할 함정 체크리스트

- [ ] `pane.agent_status_changed`를 pane_id 없이 구독하지 말 것 (요청 전체 거부).
- [ ] `pane.updated` 구독 금지 — 자기 metadata write의 echo로 서버 응답 지연.
- [ ] 이벤트 replay(512)를 실제 전환으로 착각해 소리/애니메이션을 내지 말 것.
- [ ] `pane_id`를 영구 키로 쓰지 말 것 (pane move 시 변경) — focus 직전 `agent.list`로 재해석.
- [ ] 에이전트가 종료된 셸 pane이 idle 에이전트처럼 보일 수 있음 (terrarium: `user@host:` title 필터).
- [ ] 마지막 pane을 닫으면 workspace가 닫힘 — **우리는 pane을 닫거나 만들지 않는다**.
- [ ] transcript **mtime은 믿지 말 것** (재attach 시 timestamp 없는 줄 append) — 마지막 `timestamp` 필드 사용.
- [ ] 쓰기 API(focus 포함)는 token 있는 클라이언트만 — 아무 웹페이지가 포커스를 훔치지 못하게.
- [ ] 비-MIT/무라이선스 저장소(weherd, agent-view)와 herdr-story의 게임 에셋은 **아이디어만** 참고.

## 7. pixel-agents-herdr 설계 방향

**차별점 한 줄:** _pixel-agents의 hook 기반 정밀 활동 + herdr의 pane 단위 위치·포커스._ 스크래핑 없이, herdr를 절대 조작하지 않는 선에서.

### 아키텍처

```
Claude hook ──(+HERDR_PANE_ID 등 env 힌트)──► POST /api/hooks/claude ─► AgentRuntime (기존 그대로)
                                                                         │ sessionId
herdr socket ── agent.list / workspace.list (1.5s poll) ─► HerdrBridge ──┤ sessionId → {pane, workspace label, title, status}
                                                                         ▼
                                                     folderName = workspace label (→ Area 자동 배치)
                                                     agentHerdrInfo { paneId, workspaceLabel, title, status }
webview 클릭 ─ focusAgent ─► HerdrBridge.focus(sessionId) ─► agent.list 재해석 → agent.focus(pane_id)
```

- **조인:** 권위 = `agent.list`의 `agent_session.value`(pane move에도 최신 pane id). 보조 = hook에 실어 보낸 `HERDR_PANE_ID`(SessionStart 직후 즉시 사용).
- **안전:** herdr에는 `agent.list`, `workspace.list`, `agent.focus`(사용자가 클릭했을 때만) 외에 아무것도 호출하지 않는다. 소켓이 없으면 bridge는 no-op → 원본 pixel-agents와 동일하게 동작.

### 로드맵

| 단계        | 내용                                                                                                                                                                                          | 근거                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **1 (MVP)** | HerdrBridge(폴링) · 캐릭터 클릭→herdr pane 점프 · 이름표 = workspace · 세션 제목 · folderName = workspace label(Area 자동) · hook에 herdr env 힌트 · `CLAUDE_CONFIG_DIR` 지원 · 실행 스크립트 | 공통점 1·4·6, 표 #1~#6  |
| 2           | herdr `blocked`/`done`을 말풍선 보강(done은 볼 때까지 유지) · idle fresh/stale 연출 · herdr에서 pane 포커스 시 오피스 하이라이트(양방향)                                                      | radar, agent-view, herd |
| 3           | 비-Claude 에이전트(codex 등)를 status 전용 캐릭터로 · herdr sidebar에 `$tool`/`$ctx` 토큰 역보고 · herdr plugin 패키징(`[[startup]]`으로 서버 자동 기동)                                      | D 보고서 #10·#11·#17    |
| 4           | 다중 머신(SSH) · `pane.graphics`로 herdr pane 안 직접 렌더                                                                                                                                    | terrarium #18, D 1.4    |
