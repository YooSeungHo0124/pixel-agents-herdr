# herdr-office

A pixel office that lives in a [herdr](https://github.com/herdrdev/herdr) pane.
Every herdr workspace is a room; every agent herdr detects (claude, codex,
gemini, …) is a character acting out its herdr status:

| herdr status    | in the office                                                           |
| --------------- | ----------------------------------------------------------------------- |
| `working`       | sits at its desk typing                                                 |
| `blocked`       | stands in front of its desk hopping, red `!` bubble, room border blinks |
| `done` (unseen) | stands in front of its desk with a green check                          |
| `idle`          | wanders the lounge, sometimes sits down to read                         |
| `unknown`       | stands faded with a `?`                                                 |

No browser, no Claude hooks: the only data source is herdr's socket API
(`agent.list`, `workspace.list`), and the only writes are `agent.focus` /
`workspace.focus` when you click. Images go through herdr's own
`pane.graphics` layers (one per room), labels are real terminal text.

## Run

Node ≥ 23.6 runs the TypeScript directly — no build step.

```bash
node herdr-office/src/main.ts          # inside a herdr pane
node herdr-office/src/main.ts --demo   # fake agents cycling through every status
node herdr-office/src/main.ts --help
```

Click a character (or Tab/arrows + Enter) to jump to its pane, click a room's
name plate to jump to the workspace. Wheel / PgUp / PgDn scroll, `+` `-` `0`
change the size, `q` quits.

## Characters

Sheets are read from `~/.herdr-office/characters/*.png` (falls back to the
stock pixel-agents cast in `webview-ui/public/assets/characters`). A sheet is
7 columns — walk1, walk2, walk3, type1, type2, read1, read2 — by 3 rows
(down, up, right; left = mirrored right) or 4 rows (… , left). Any size works
as long as the frames split evenly; frames are normalised to 128 px tall, so
a 16×32 sheet is upscaled 4× and a 128×128-frame sheet is used as is.

Optional `cast.json` next to the sheets picks a sheet per agent kind or pane:

```json
{ "claude": "jjanggu", "codex": "cheolsu", "w4:p4": "yuri", "default": "jjanggu" }
```

Without it every agent gets a stable pick from the available sheets.

## Tests

```bash
node --test herdr-office/test/*.test.ts
```
