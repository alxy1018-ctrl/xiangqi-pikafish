# Chinese Chess · Pikafish

English | [中文](README.md)

A local Chinese chess (xiangqi) board: **you pick either side against the Pikafish engine** (by default the engine plays Red, you play Black), with a live analysis panel (evaluation, search depth, candidate moves) and a strength slider. The AI always sits at the bottom and you at the top; switching sides flips the board 180°. Red always moves first.

The layout follows the online xiangqi analysis sites: board on the left, analysis panel on the right.

**Repository**: <https://github.com/alxy1018-ctrl/xiangqi-pikafish>

**The engine and its weights ship with the repository**, so a clone plus a double-click on `start.cmd` is enough to play. Nothing else to configure.

```bash
git clone https://github.com/alxy1018-ctrl/xiangqi-pikafish.git
```

> The repository is about 56 MB, 55 MB of which is the engine and the neural-network weights. If you only want the source:
> `git clone --filter=blob:none --sparse ...` and check out what you need, then point `XQ_ENGINE` at your own Pikafish.

> **A note on language.** The user interface is in Chinese, so the strings this document quotes are the Chinese ones; where it helps, the English meaning is given in brackets. Difficulty levels, buttons, hotkeys, move notation and error messages are written exactly as they appear on screen.

---

## Getting started

**Double-click `start.cmd`.** It will:

1. find the node that ships with DSH (this machine has no node on `PATH`)
2. locate Microsoft Edge
3. start the server and, **only once the port is really being listened on**, open the board in Edge

Leave the window open: that is the server running. Close it or press `Ctrl+C` to stop.

> Why the **server** opens the browser instead of the batch file sleeping for a few seconds first:
> a fixed sleep opens a dead page when the port is already taken (for instance when an instance is
> already running). The server only launches the browser after its own `listen` succeeds, so that
> cannot happen. On a port conflict it tells you "the port is already in use" instead of dumping a stack trace.

### Changing the port

```cmd
set XQ_PORT=19391
start.cmd
```

### Two traps in the batch file (read before touching start.cmd)

Both have bitten on this machine, and both look fine until they run:

1. **Variable expansion happens inside `REM` comments too.** Writing `%ProgramFiles(x86)%` in a comment expands to a path containing parentheses, which breaks the statement structure; and error text written into a comment gets executed as a command. **Never put `%` or parentheses in a comment.**
2. **Do not echo a path containing parentheses inside an `if ... ( ... )` block.** The closing parenthesis in `C:\Program Files (x86)\...` **closes the block early**, the rest of the path becomes a command, and the error is exactly `\Microsoft\Edge\Application\msedge.exe was unexpected at this time`. This script therefore branches with `goto` labels.

The script must also stay **pure ASCII with CRLF** (cmd.exe misparses UTF-8 and bare LF).

### Choosing your side

Chinese chess is **Red first**. At the start of a game the page offers a choice:

| Button | Effect |
| --- | --- |
| **换边** ("switch sides") | Toggles between "you are Red" and "you are Black". Switching to Red **flips the board 180°** (you are Red on top, the engine is Black at the bottom) and you move first; switching back to Black restores the board, Red still belongs to the engine, so press 让引擎先走 to open |
| **让引擎先走** ("let the engine move first") | Only for Black: the engine opens as Red, then it is your turn |

Both buttons **work only at the opening** (they are disabled after the first move). **重新开始** ("restart") **keeps the side you chose**.

> 换边 only selects a side; it does not start the game for you. After switching to Black you still press
> 让引擎先走; as Red you simply make the first move yourself.
>
> Switching sides flips the **display** only: internal coordinates, the move list and candidate notation are
> unchanged, and the piece characters plus 楚河汉界 stay upright. The engine is always at the bottom, you at the top.

---

## The interface

| Area | Contents |
| --- | --- |
| Board | Click one of your pieces to select it; blue dots/circles mark legal destinations; click one to move. The AI is always at the bottom and you at the top; switching sides flips the whole board 180° |
| Engine analysis | Evaluation from Red's point of view, search depth, node count, speed, win/draw/loss (WDL) |
| Candidate moves | The engine's top 3 choices with their scores, in Chinese notation |
| Move list | Move by move, e.g. `1 炮二平五 卒3进1`; two pieces on the same file are told apart by 前/后 (front/rear) |
| Difficulty slider | 7 steps, from 入门 (beginner) to 满血 (full strength); takes effect immediately |

**Buttons**: 换边 (switch sides) / 让引擎先走 / 重新开始 / 悔棋 (undo) / 分析当前局面 (analyse current position)
**Hotkeys**: `u` undo, `n` new game, `a` analyse, `b` switch sides, `r` engine moves first

---

## Difficulty levels

| Level | Name | UCI_Elo | Skill | Think time |
| --- | --- | --- | --- | --- |
| 1 | 入门 (beginner) | 1280 | 0 | 200 ms |
| 2 | 初级 (novice) | 1500 | 3 | 300 ms |
| 3 | 中级 (intermediate) | 1800 | 7 | 500 ms (default) |
| 4 | 较强 (strong) | 2100 | 11 | 800 ms |
| 5 | 高手 (expert) | 2400 | 15 | 1200 ms |
| 6 | 大师 (master) | 2700 | 18 | 1800 ms |
| 7 | 满血 (full strength) | unlimited | 20 | 2500 ms |

"Full strength" turns `UCI_LimitStrength` off and uses every thread and the maximum Skill — **you will rarely last 20 moves**.

> The Elo steps are a **piecewise mapping** across the 1280–3133 range the engine supports, not point-by-point calibration. If a level feels misnamed, edit `LEVELS` in `lib/engine.js`.

---

## Project layout

```
中国象棋/                    (repo root; D:\Code\中国象棋 on the author's machine)
├── start.cmd              double-click launcher (ASCII + CRLF — do not convert to UTF-8)
├── server.js              HTTP server + game progression + analysis aggregation
├── lib/
│   ├── board.js           rules core: move generation/validation, check, checkmate and stalemate, Chinese notation, coordinate conversion
│   └── engine.js          Pikafish UCI wrapper (long-lived child process, serialized commands, timeouts, shutdown)
├── public/
│   └── index.html         single-page front end (SVG board + analysis panel), no external dependencies
└── test/
    ├── board.test.mjs           84 items: perft, the four special rules, checkmate, coordinate regression
    ├── engine.test.mjs          24 items: handshake, search, timeout, shutdown, cross-validation against the rules engine
    ├── api.test.mjs             99 items: end-to-end flow, side switching, illegal moves, undo, difficulty
    ├── frontend.test.mjs        56 items: root causes of past front-end/integration bugs, frozen as assertions
    ├── perft-crosscheck.test.mjs perft cross-check with Pikafish as an independent judge (19 items)
    ├── leak-probe.mjs           memory-growth probe (continuous analysis, looking for leaks)
    ├── orphan-probe.mjs         does an abnormal exit leave an orphaned engine behind
    ├── fen-probe.mjs            verifies the engine's FEN support (including a synthetic Black-to-move position)
    └── drill.test.mjs           game drill script (for human observation)
```

### Running the tests

```powershell
$node = 'C:\Users\LXY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# rules engine (no server needed)
& $node <repo>\test\board.test.mjs

# engine wrapper (actually launches Pikafish)
& $node <repo>\test\engine.test.mjs

# front-end regression (asserts against the source; no server needed)
& $node <repo>\test\frontend.test.mjs

# end-to-end (**needs the server running**)
& $node <repo>\test\api.test.mjs

# independent judge: my rules engine vs Pikafish's perft (no server, but saturates the CPU)
& $node <repo>\test\perft-crosscheck.test.mjs
```

### How strong the verification is

- **Board flip measured in a real browser**: before switching, internal Red rook (idx 81) renders at cy=534 (bottom) and Black rook (idx 0) at cy=30 (top); after 换边 the Red rook is at cy=30 and the Black rook at cy=534, the Red legal-destination hints land in the top half, moving from one of them works, the engine answers as Black, and the last-move markers land in the bottom half; pressing 换边 again puts the Red rook back at cy=534 and the Black rook at cy=30 (default orientation).
- **263 assertions pass** (84 + 24 + 99 + 56), counted by rerunning all four suites on 2026-10-25.
- **perft cross-check 19/19 identical**: my JS rules engine and Pikafish (an independent C++ implementation) agree on the node count for every test position, including the opening at `depth 4 = 3,290,240` — that figure was confirmed directly from Pikafish's own `go perft 4`.
  This is the **only independent evidence that does not come from my own implementation**, and it exists to rule out the risk that the generator and the checker share the same bias.
- **A real game played through**: `炮二平五 卒3进1 炮五进四 卒7进1 炮八平五 马2进2 前炮退二`, with every move re-checked for engine move legality and position consistency.
- **Browser side checked piece by piece**: the legal-destination count for all seven Black pieces matches the rules (horse 2, cannon 12, rook 2, elephant 2, advisor 1, pawn 1, king 1); the cannon's destinations include `b9 (capture)`, which proves the "screen capture + capture marker" path is correct.

> Note: the numbers above come from running the suites, not from memory. If you change the tests, rerun them and update both READMEs.

---

## Three implementation conventions you must know

### 1. Coordinates: the rank direction is inverted (a trap we fell into)

| | rank 0 | rank 9 |
| --- | --- | --- |
| **Internal representation** (rendering, XQ FEN) | Black's back rank (top) | Red's back rank (bottom) |
| **UCI / Pikafish** | Red's back rank (bottom) | Black's back rank (top) |

The file (a–i) agrees between the two; **only the rank needs `9 - rank`**.

The evidence: from the standard opening Pikafish's best move is `h2e2` (炮二平五), i.e. it believes the Red cannon is on **rank 2**, while in the internal representation that cannon is on rank 7.

**Iron rule**: `toEngineSquare` / `fromEngineSquare` are the **only** places allowed to do this conversion. Assembling a rank number anywhere else is a bug — an early version missed one spot, and the symptom was piece names showing up as `?` in the candidate list.

### 2. The `moves` array is the single source of truth for the position — **including the side to move**

The engine's position is **always** rebuilt from `moves`; no second copy of the position is kept locally.

Red always moves first and a legal move sequence strictly alternates, so the side to move follows directly from the move count: after an odd number of moves it is Black's turn, after an even number it is Red's. `currentPosition()` only rebuilds the position and no longer patches parity for a mode — switching sides only changes which side the user owns, not the game itself.

### 3. Positions are always sent as FEN, never as a move sequence

`position startpos moves ...` implies **Red to move** and requires a strictly alternating sequence from the opening. We already have the complete position (rebuilt from `moves`), so sending a FEN carries the side to move explicitly and removes one "when is startpos valid" branch. FEN is also a form the engine supports directly.

**Iron rule**: every call to `engine.search()` must go through `engineRequest()`.

---

## What runtime garbage does it leave behind (measured)

Conclusion: **essentially none**. Item by item:

| Check | Measured result |
| --- | --- |
| Files created inside the project directory | **Zero**. No logs, temp files or caches |
| node memory (12 consecutive analyses) | heapUsed oscillates between 9.2 and 10.5 MB with **no upward trend**; rss essentially constant |
| Engine memory | about 480 MB (NNUE weights + hash table), **constant, not growing** |
| Processes | one node and one Pikafish, parent/child correct |
| **After force-killing node** | the engine **exits on its own**, leaving no orphan — it sees EOF on the stdin pipe and ends |
| Browser | spawned by the server, `detached` and no handle held; closing it does not affect the server |

`/api/state` exposes `memory` / `searchCount` / `analysisCount`, so if you suspect growth, read it and compare.

### One real leak that was fixed

`_pendingLines` in `lib/engine.js`: caching engine output lines during the handshake is necessary (`waitLine` has to look back at tokens that arrived before the command was sent), but the condition was written as `!this._lineHandlers?.length` — and right after the handshake that array is exactly **empty**, so the dozens of `info` lines from every search got appended, **a steady leak under long runs**.
It now caches only while the handshake is active and clears as soon as the handshake completes (see `handshakeActive` in `_onStdout`).

### The one thing to watch for

**Do not let node become an orphan.** A real scenario was observed: if the parent process (the cmd console) disappears first while node keeps running, two things follow:

1. it **still serves normally** (the page opens as usual), but **no window is left to stop it**
2. it **inherits the parent's pipe handles** — in the observed case it held `start-out.log` / `start-err.log`, so those two files could not be deleted (`Remove-Item` reported "being used by another process")

The normal double-click path never hits this: closing the window ends everything.
It only happens when a script starts it indirectly and the shell running that script exits early.
If you do hit it, find the process by port and kill it:

```powershell
$pid = (Get-NetTCPConnection -State Listen -LocalPort 19390).OwningProcess
Stop-Process -Id $pid -Force
Get-Process -Name 'Pikafish*' -ErrorAction SilentlyContinue | Stop-Process -Force
```

## Known limitations

- **No online play.** The Pikafish NNUE licence explicitly forbids cheating scenarios; playing locally for yourself is fine.
- **No opening book.** Pikafish ships without one, so it may repeat the same moves in the same opening.
- **Perpetual check / the natural-move limit are not adjudicated.** The engine handles repetition internally under Asian rules, but the page does not rule on it; if a cycle appears you have to press 重新开始 yourself.
- **Undo only goes back to your own turn**, never to "half a move".
- The engine is **a single long-lived instance** shared by analysis and play, so you cannot move while an analysis is running.
- **You cannot move the opponent's side.** The engine always owns the side opposite yours: Red belongs to the engine when you play Black, Black when you play Red.
- **换边 is only available before the first move**; you cannot change sides mid-game. **重新开始** keeps your chosen side.

## Engine information

**The engine ships with the repository — clone and run, nothing to configure.**

- Location: the `engine/` directory
- Binary: `engine/Pikafish-Windows-x86-64-universal.exe` (7.2 MB)
- Weights: `engine/pikafish.nnue` (49.5 MB) — **must sit next to the exe**; the engine looks for it in the working directory at startup
- Version: Pikafish 2026-09-25
- Also included: `engine/NNUE-License.txt` (the licence) and `engine/README-Pikafish.txt` (upstream notes)
- Source: the official [pikafish.com](https://pikafish.com) / [GitHub Releases](https://github.com/official-pikafish/Pikafish/releases)

Paths in the code are resolved **relative to this file** (`join(__dirname, 'engine', ...)`), so it runs wherever the repository is cloned and whatever the directory is named.

### Using an engine from elsewhere

Set an environment variable; no code changes:

```powershell
$env:XQ_ENGINE = "D:\other\path\pikafish.exe"   # pikafish.nnue must be in the same directory
$env:XQ_PORT   = 19391
```

### About the licence (important)

The terms for `pikafish.nnue` are in `engine/NNUE-License.txt`. Two restrictions:

1. **Legal use only** — the licence names "e.g. cheating" as the user's own responsibility.
   **Do not take it to online playing sites**; that is precisely the forbidden scenario. Playing locally and watching it play is entirely within scope.
2. **No commercial use without permission.**

This repository redistributes the engine and weights for **non-commercial purposes only**, unmodified.
For commercial licensing go through the official channel (the licence links to the list of existing licensees).
The engine tracks official releases; for the newest version use the address above.
