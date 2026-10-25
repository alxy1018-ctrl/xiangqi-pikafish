# 中国象棋 · 皮卡鱼 Pikafish 对弈

中文 | [English](README.en.md)

> **Chinese chess against Pikafish, running locally.** A single-page board with a live analysis panel (evaluation, depth, candidate moves) and a 7-step strength slider. You pick either side (default: engine Red, you Black), and Red always moves first; engine and NNUE weights are bundled, so a clone plus `start.cmd` is all it takes. Full English documentation: **[README.en.md](README.en.md)**.
> The interface itself is in Chinese, and the English document quotes its strings as-is.

一个本地跑的中国象棋对弈页面：**Pikafish 引擎和你任选一边执子**（默认你执黑、引擎执红），
**AI 永远在棋盘下方、你在上方，换边时整盘翻转 180°**。带实时分析面板（评估分、搜索深度、候选着法）和棋力难度滑块。红方永远先行。

界面参考了象棋 AI 在线分析网站的布局：左侧棋盘、右侧分析面板。

**仓库**：<https://github.com/alxy1018-ctrl/xiangqi-pikafish>

**引擎与权重已随仓库附带**，克隆下来双击 `start.cmd` 就能下，不需要另外配置。

```bash
git clone https://github.com/alxy1018-ctrl/xiangqi-pikafish.git
```

> 仓库约 56 MB，其中 55 MB 是引擎与神经网络权重。只想要源码的话：
> `git clone --filter=blob:none --sparse ...` 之后再按需检出，
> 然后设 `XQ_ENGINE` 指向你自己的 Pikafish。

---

## 怎么开始

**双击 `start.cmd`**。它会：

1. 找到 DSH 自带的那份 node（这台机器的 PATH 上没有 node）
2. 定位 Microsoft Edge
3. 启动服务，**等服务真正开始监听端口后，自动用 Edge 打开棋盘页**

窗口保持开着就是服务在运行；关掉窗口或按 `Ctrl+C` 即停止。

> 为什么浏览器由**服务端**打开、而不是批处理等几秒再开：
> 固定 sleep 在端口被占用（例如已经跑着一个实例）时会弹出一个打不开的死页面。
> 服务端在自己 `listen` 成功之后才拉浏览器，就不会有这个问题。
> 端口冲突时它会直接告诉你"端口已被占用"，而不是抛一堆堆栈。

### 改端口

```cmd
set XQ_PORT=19391
start.cmd
```

### 批处理的两个坑（改动 start.cmd 前务必读）

这台机器上踩过两次，都属于"看着没问题、一跑就崩"：

1. **`REM` 注释里也会做变量展开。** 注释中写 `%ProgramFiles(x86)%`，展开出来的路径带括号，
   会打破语句结构；把报错文本本身写进注释，那段文本会被当成命令执行。
   **注释里不要出现 `%` 和括号。**
2. **不要在 `if ... ( ... )` 括号块里 echo 含括号的路径。**
   `C:\Program Files (x86)\...` 里的右括号会**提前闭合那个块**，剩下的路径变成一条命令，
   报错正是 `\Microsoft\Edge\Application\msedge.exe was unexpected at this time`。
   本脚本因此改用 `goto` 标签分支。

另外，脚本必须保持**纯 ASCII + CRLF**（cmd.exe 会误解析 UTF-8 与裸 LF）。

### 开局怎么走

中国象棋规则是**红方先行**。开局时页面会提示你选一种：

| 按钮 | 效果 |
| --- | --- |
| **换边** | 在「你执红 / 你执黑」之间切换。切到执红时棋盘**翻转 180°**（你执红在上、引擎执黑在下），你可以直接走红方第一步；切回执黑时棋盘翻回、红方仍归引擎，点「让引擎先走」开局 |
| **让引擎先走** | 你执黑时，引擎执红先落子，然后轮到你 |

两个按钮都**只在开局可用**（走过任意一步后禁用）。**「重新开始」保留你当前的执子选择。**

> 「换边」只是选边，不会替你把棋走起来：切到执黑后仍要点「让引擎先走」；
> 切到执红时红方先行，直接走你的红棋即可。
>
> 换边只翻转**显示**：内部坐标、棋谱、候选着法都不变，棋子文字和「楚河汉界」始终正立；
> 引擎永远在下方，你永远在上方。

---

## 界面说明

| 区域 | 内容 |
| --- | --- |
| 棋盘 | 点击自己的棋子选中，蓝色圆点/圆圈标出可落点，再点目标格完成走子。AI 始终在下方、你始终在上方，换边时整盘翻转 180° |
| 引擎分析 | 红方视角的评估分、搜索深度、节点数、速度、胜率（WDL） |
| 候选着法 | 引擎给出的前 3 个选择及各自评分，中文记谱 |
| 棋谱 | 逐步记录，格式如 `1 炮二平五 卒3进1`，同名同线棋子用「前/后」区分 |
| 难度滑块 | 7 档，从「入门」到「满血」，改完立即生效 |

**按钮**：换边 / 让引擎先走 / 重新开始 / 悔棋 / 分析当前局面
**快捷键**：`u` 悔棋、`n` 新局、`a` 分析、`b` 换边、`r` 让引擎先走

---

## 难度档位

| 档 | 名称 | UCI_Elo | Skill | 思考时间 |
| --- | --- | --- | --- | --- |
| 1 | 入门 | 1280 | 0 | 200 ms |
| 2 | 初级 | 1500 | 3 | 300 ms |
| 3 | 中级 | 1800 | 7 | 500 ms（默认） |
| 4 | 较强 | 2100 | 11 | 800 ms |
| 5 | 高手 | 2400 | 15 | 1200 ms |
| 6 | 大师 | 2700 | 18 | 1800 ms |
| 7 | 满血 | 不限制 | 20 | 2500 ms |

「满血」会关掉 `UCI_LimitStrength`，用满线程和满 Skill——**基本走不到 20 回合**。

> 说明：Elo 档位是按引擎支持的 1280–3133 区间**分段映射**的，不是逐点校准过的。
> 如果觉得某档名不副实，改 `lib/engine.js` 里的 `LEVELS` 即可。

---

## 项目结构

```
中国象棋/                    （D:\Code\中国象棋）
├── start.cmd              双击启动（ASCII + CRLF，别改成 UTF-8）
├── server.js              HTTP 服务 + 对局推进 + 分析汇总
├── lib/
│   ├── board.js           规则核心：走法生成/校验、将军、将死困毙、中文记谱、坐标转换
│   └── engine.js          Pikafish UCI 封装（常驻子进程、串行命令、超时与关闭）
├── public/
│   └── index.html         单页前端（SVG 棋盘 + 分析面板），无外部依赖
└── test/
    ├── board.test.mjs           84 项：perft、四类特殊规则、将死、坐标回归
    ├── engine.test.mjs          24 项：握手、搜索、超时、关闭、与规则引擎交叉验证
    ├── api.test.mjs             99 项：端到端流程、换边、非法着法、悔棋、难度
    ├── frontend.test.mjs        56 项：把前端/集成 bug 的根因固化成断言
    ├── perft-crosscheck.test.mjs 用 Pikafish 做独立裁判比对 perft（19 项）
    ├── leak-probe.mjs           内存累积探测（连续分析，看是否泄漏）
    ├── orphan-probe.mjs         异常退出是否留下孤儿引擎
    ├── fen-probe.mjs            验证引擎对 FEN 的支持（含黑先的合成局面）
    └── drill.test.mjs           对局演练脚本（人工观察用）
```

### 测试怎么跑

```powershell
$node = 'C:\Users\LXY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 规则引擎（不需要服务）
& $node D:\Code\中国象棋\test\board.test.mjs

# 引擎封装（会真的拉起 Pikafish）
& $node D:\Code\中国象棋\test\engine.test.mjs

# 前端回归（读源码做断言，不需要服务）
& $node D:\Code\中国象棋\test\frontend.test.mjs

# 端到端（**需要服务在跑**）
& $node D:\Code\中国象棋\test\api.test.mjs

# 独立裁判：我的规则引擎 vs Pikafish 的 perft（需要服务不必，但会跑满 CPU）
& $node D:\Code\中国象棋\test\perft-crosscheck.test.mjs
```

### 验证强度

- **换边翻转实测**：真实浏览器里，换边前内部红车（idx 81）显示 cy=534（下方）、黑车（idx 0）cy=30（上方）；
  点「换边」后红车 cy=30、黑车 cy=534，红方合法落点落在上半盘；点上半盘落点走子成功，
  引擎黑方应手，上一步标记落在下半盘；再点「换边」后红车 cy=534、黑车 cy=30，翻回默认方向。
- **263 项断言全部通过**（84 + 24 + 99 + 56，数字由 2026-10-25 重跑四套测试实测）。
- **perft 交叉验证 19/19 一致**：我的 JS 规则引擎与 Pikafish（独立 C++ 实现）在 6 个
  不同局面上给出完全相同的节点数，包括开局 `depth 4 = 3,290,240`
  （这个数另用 Pikafish 自带的 `go perft 4` 直接核过）。
  这条是**唯一脱离自身实现的独立证据**，用来排除"生成器与校验器共享同一偏差"的风险。
- **真实对局走通**：`炮二平五 卒3进1 炮五进四 卒7进1 炮八平五 马2进2 前炮退二`，
  每步都复核了引擎着法合法性与局面一致性。
- **浏览器端逐类验证**：黑方 7 种棋子的合法落点数全部符合规则
  （马 2、炮 12、车 2、象 2、士 1、卒 1、将 1），其中炮的落点含 `b9(吃)`，
  证明「隔子吃 + 吃子标记」链路正确。

---

## 三个必须知道的实现约定

### 1. 坐标系统：rank 方向相反（踩过坑）

| | rank 0 | rank 9 |
| --- | --- | --- |
| **内部表示**（渲染、XQ FEN） | 黑方底线（顶部） | 红方底线（底部） |
| **UCI / Pikafish** | 红方底线（底部） | 黑方底线（顶部） |

file（a–i）两套一致，**只有 rank 需要 `9 - rank` 翻转**。

实测依据：标准开局下 Pikafish 给出的最佳着法是 `h2e2`（炮二平五），
即它认为 **rank 2** 上是红炮；而内部表示里红炮在 rank 7。

**铁律**：`toEngineSquare` / `fromEngineSquare` 是**唯一**允许做这个转换的地方。
任何其它位置直接拼 rank 数字都是 bug——早期版本漏了一处，表现为候选着法里的棋子名显示成 `?`。

### 2. 局面唯一事实来源是 `moves` 数组，**轮走方也由它推导**

引擎侧局面**永远**由 `moves` 重建，本地不维护第二份局面。

红方永远先行，合法的走子序列严格交替，所以轮走方直接由步数奇偶决定：
奇数步后轮到黑方，偶数步后轮到红方。`currentPosition()` 只做重建，不再按模式手工修正 ——
换边只改变"用户执哪一方"，不改变棋局本身。

### 3. 下发局面一律用 FEN，不用走子序列

`position startpos moves ...` 隐含**红先**，而且要求从开局严格交替下发；这里已经有完整局面，
直接发 FEN 把轮走方显式带上，少一套"什么时候能用 startpos"的判断。FEN 也是引擎直接支持的形式。

**铁律**：任何调用 `engine.search()` 的地方都必须经过 `engineRequest()`。

---

## 运行时会产生什么垃圾（实测）

结论：**基本不产生**。逐项实测数据：

| 检查项 | 实测结果 |
| --- | --- |
| 项目目录内生成的文件 | **零**。没有日志、临时文件、缓存 |
| node 内存（连续 12 轮分析） | heapUsed 在 9.2–10.5 MB 之间上下波动，**无累积趋势**；rss 基本不变 |
| 引擎内存 | 约 480 MB（NNUE 权重 + 哈希表），**恒定不增长** |
| 进程 | node + Pikafish 各一个，父子关系正确 |
| **强杀 node 后** | 引擎**自行退出**，不留孤儿 —— 它从 stdin 管道读到 EOF 就自己结束了 |
| 浏览器 | 由服务端 spawn，`detached` 且不持有句柄，关掉不影响服务 |

`/api/state` 里带 `memory` / `searchCount` / `analysisCount` 字段，怀疑有累积时直接读它对照。

### 修掉过的一处真实泄漏

`lib/engine.js` 的 `_pendingLines`：握手阶段缓存引擎输出行是必要的
（`waitLine` 要回看"命令发出前就到了"的 token），但原条件写成了
`!this._lineHandlers?.length` —— 握手结束后这个数组恰好是**空**，于是每轮搜索的
几十行 `info` 全都被塞进去，**长时间运行就是一条稳定泄漏**。
现在只在握手期间缓存，握手完成即清空（见 `_onStdout` 的 `handshakeActive`）。

### 唯一需要你留意的

**别让 node 变成孤儿。** 实测发现一个真实场景：如果启动它的父进程（cmd 控制台）先消失、
而 node 还活着，会出现两个后果：

1. 它**仍然正常服务**（页面照常打开），但**没有任何窗口能让你停下它**
2. 它**继承着父进程的管道句柄**——实测中它攥着 `start-out.log` / `start-err.log`，
   导致这两个文件删不掉（`Remove-Item` 报"正被另一个进程使用"）

正常双击 `start.cmd` 使用不会遇到这个：关窗就全结束了。
只有用脚本间接拉起、又把脚本所在的 shell 提前结束才会这样。
真遇到了就按端口找进程结束它：

```powershell
$pid = (Get-NetTCPConnection -State Listen -LocalPort 19390).OwningProcess
Stop-Process -Id $pid -Force
Get-Process -Name 'Pikafish*' -ErrorAction SilentlyContinue | Stop-Process -Force
```

### 顺带一提：`.dsh-tmp` 里堆了 111 个文件

那是**我历次排查留下的临时脚本**（编码探测、会话日志解析、模型连通性测试之类），
不是这个项目产生的。要清理可以直接删，里面只有少数几个 README 笔记值得留。

---

## 已知限制

- **不支持联网对战**。Pikafish 的 NNUE 权重协议明确禁止用于作弊场景；本地自己玩没问题。
- **没有开局库**。Pikafish 本身不带书，同一个开局它可能反复走同样的着法。
- **长将／自然限着判负未实现**。引擎内部按亚洲规则处理重复局面，但页面层不做裁决；
  真出现循环需要你手动「重新开始」。
- **悔棋只退回到你该走的时刻**，不会退成"半个回合"。
- 引擎是**单实例长连接**，分析与对弈共用它，所以分析期间不能同时走子。
- **不能替对方走子**。引擎固定执你对面的一方：你执黑时红方归引擎，你执红时黑方归引擎。
- **换边只在对局开始前可用**；对局中不能更换执子。「重新开始」保留你当前的执子选择。

---

## 引擎信息

**引擎已随仓库附带，clone 下来即可运行，不需要另外配置。**

- 位置：`engine/` 目录
- 程序：`engine/Pikafish-Windows-x86-64-universal.exe`（7.2 MB）
- 权重：`engine/pikafish.nnue`（49.5 MB）—— **必须与 exe 同目录**，引擎启动时从工作目录找它
- 版本：Pikafish 2026-09-25
- 另附 `engine/NNUE-License.txt`（授权原文）与 `engine/README-Pikafish.txt`（官方说明）
- 来源：官方 [pikafish.com](https://pikafish.com) / [GitHub Releases](https://github.com/official-pikafish/Pikafish/releases)

代码里的路径是**相对本文件**定位的（`join(__dirname, 'engine', ...)`），
所以仓库 clone 到哪、目录改成什么名字都能跑。

### 想用别处的引擎

设环境变量即可，不用改代码：

```powershell
$env:XQ_ENGINE = "D:\别的路径\pikafish.exe"   # 注意同目录要有 pikafish.nnue
$env:XQ_PORT   = 19391
```

### 关于授权（重要）

`pikafish.nnue` 的使用协议见 `engine/NNUE-License.txt`，两条限制：

1. **仅限用于合法用途** —— 协议点名"如作弊"的后果自负。
   **不要拿它去联网对战平台**，那正是被禁止的场景。本地自己下、看它对局，完全在范围内。
2. **未经允许不得用于商业用途。**

本仓库对引擎与权重的再分发**仅用于非商业目的**，未作任何修改。
需要商用授权请走官方渠道（协议里附了已获授权列表的链接）。
引擎会随官方版本更新，想用最新版请到上面的官方地址下载。
