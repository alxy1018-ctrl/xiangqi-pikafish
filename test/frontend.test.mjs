/**
 * 前端回归测试。
 *
 * 为什么有这些"读源码做断言"的测试：项目里 6 个真 bug 是**前端/集成层**的
 * （render 没被调用、SVG 层级颠倒、解析路径没挂上、坐标漏翻转……），
 * 它们不会被规则测试或 API 测试发现，且修完之后很容易在重构中复发。
 * 这里把每个 bug 的**根因特征**固化成断言。
 *
 * 这里是"防止重构退回旧样子"；浏览器端的实地行为验证步骤记录在 README 的「验证强度」一节。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 相对本测试文件定位，不写绝对路径 —— 项目目录改名或搬到别处都不用改这里
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = join(ROOT, 'public', 'index.html');
const SERVER = join(ROOT, 'server.js');
const ENGINE = join(ROOT, 'lib', 'engine.js');
const BOARD = join(ROOT, 'lib', 'board.js');

const html = readFileSync(HTML, 'utf8');
const server = readFileSync(SERVER, 'utf8');
const engine = readFileSync(ENGINE, 'utf8');
const board = readFileSync(BOARD, 'utf8');

const pass = [], fail = [];
const ok = (n, c, x) => (c ? pass.push(n) : fail.push(n + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')));

// ---------------------------------------------------------------- bug 1：render() 未被 applyState 调用
{
  // 症状：棋子层永远为空，DOM 里一个 .piece 都没有
  const i = html.indexOf('function applyState(s)');
  const body = i >= 0 ? html.slice(i, html.indexOf('\n}', i) + 2) : '';
  ok('applyState 里调用了 render()（否则棋盘永远不更新）', /\brender\(\)/.test(body), body.slice(0, 120));
  ok('applyState 里也调用了 renderAnalysis', /renderAnalysis\(/.test(body));
  ok('applyState 里也调用了 renderMoves', /renderMoves\(/.test(body));
}

// ---------------------------------------------------------------- bug 2：SVG 层级顺序
{
  // 症状：木纹背景矩形压在棋子层之上，棋子存在但看不见
  const layers = html.match(/svg\.append\(layerBase, layerMarks, layerPieces\)/);
  ok('SVG 分层按 base → marks → pieces 顺序追加', Boolean(layers));
  const li = html.indexOf('const layerBase = el');
  const liMarks = html.indexOf('const layerMarks = el');
  const liPieces = html.indexOf('const layerPieces = el');
  ok('三层都先建好再追加（保证 z-order 可控）', li >= 0 && liMarks > li && liPieces > liMarks);
  // drawBoardBase 必须往 layerBase 里画，不能再直接 svg.append（那会破坏层级）
  const db = html.indexOf('function drawBoardBase()');
  const dbBody = db >= 0 ? html.slice(db, html.indexOf('\n}', html.indexOf('layerBase.append(river)', db)) + 2) : '';
  ok('drawBoardBase 不再直接 svg.append 背景', !/svg\.append\(/.test(dbBody), dbBody.match(/svg\.append\([^)]*\)/)?.[0]);
}

// ---------------------------------------------------------------- bug 3：lastMove 漏坐标翻转
{
  // 症状：上一步标记画在棋盘上下镜像的位置。
  // 定位那段真正画标记的代码：它以 `if (last)` 开头（不是注释里的"上一步标记"）。
  const i = html.indexOf('if (last) {');
  const body = i >= 0 ? html.slice(i, i + 700) : '';
  ok('找到了 lastMove 渲染代码块', i >= 0, i);
  ok('lastMove 渲染做了 rank 翻转（9 - rank）',
    /9\s*-\s*Number\(engineSq\[1\]\)/.test(body), body.slice(0, 220));
  ok('lastMove 变量名标明是引擎坐标', /engineSq/.test(body));
  ok('lastMove 渲染有越界保护', /continue/.test(body));
}

// ---------------------------------------------------------------- bug 4：候选着法漏翻转（显示成 ?）
{
  const i = html.indexOf('function uciToCn');
  const body = html.slice(i, i + 1100);
  ok('uciToCn 做了 rank 翻转', /9\s*-\s*eFromRank/.test(body), body.slice(0, 220));
  ok('uciToCn 对终点也做了翻转', /9\s*-\s*eToRank/.test(body));
  // 光有翻转还不够：分析之后局面常又走了一步，起点棋子会移走。
  // 必须用分析时的棋盘快照，否则仍然显示成 "?"。
  ok('uciToCn 接受棋盘快照参数', /function uciToCn\(uci,\s*boardAtAnalysis\)/.test(body));
  ok('uciaToCn 优先用快照而不是当前棋盘', /boardAtAnalysis\s*\?\?\s*state\?\.board/.test(body));
  ok('渲染候选时传入分析快照 a.board', /uciToCn\(c\.uci,\s*a\.board\)/.test(html));
}

// ---------------------------------------------------------------- 分析视角标注
{
  ok('分析结果带 sideToMove', /sideToMove/.test(server));
  ok('分析结果带棋盘快照', /board:\s*boardAtAnalysis/.test(server));
  ok('标签标注是哪一方的候选着法', /黑方候选|红方候选/.test(html));
}

// ---------------------------------------------------------------- bug 5：引擎应手后前端不刷新
{
  ok('存在后台轮询刷新机制', /setInterval\(/.test(html) && /refreshing/.test(html));
  // 轮询条件**不能**用 state.turn 判断：黑方回合（turn === 'black'）恰恰最需要刷新
  // （引擎刚应手、或外部改了状态），用 turn 会让页面长期停在旧局面上。
  ok('轮询条件基于 canUserMove 而不是 turn',
    /state\.thinking\s*\|\|\s*!state\.canUserMove/.test(html), '应为 state.thinking || !state.canUserMove');
  ok('轮询条件里没有裸的 turn 判断', !/shouldPoll[^;]*state\.turn/.test(html));
  // 用状态指纹比较，否则"重新开始"（步数不变）与"分析更新"会被漏掉
  ok('存在状态指纹函数 stateSignature', /function stateSignature/.test(html));
  ok('指纹包含分析深度（否则分析更新不重画）', /s\.analysis\s*\?\s*s\.analysis\.depth/.test(html));
  ok('指纹包含 blackFirst（否则切换模式不重画）', /s\.blackFirst/.test(html));
  ok('用户选子时暂停轮询（不打断选中态）', /if\s*\(selected\s*!==\s*null\)\s*return/.test(html));
}

// ---------------------------------------------------------------- bug 6：分析结果没重画面板
{
  // 症状：点了"分析当前局面"，面板数字是旧的
  const i = html.indexOf("getElementById('btn-analyze').onclick");
  const body = html.slice(i, i + 200);
  ok('分析按钮走 post()（会自动 applyState 重画）', /post\('\/api\/analyze'/.test(body), body.trim());
}

// ---------------------------------------------------------------- 黑方先走模式（用户要求的语义）
{
  // 需求：按一下按钮切到"黑方先走"；引擎的红方**原地不动**；等用户走完黑方第一步，引擎才接管。
  const bf = html.indexOf("getElementById('btn-black-first').onclick");
  ok('存在「切换到黑方先走」按钮处理', bf >= 0);
  ok('该按钮调用 /api/engine-first', /post\('\/api\/engine-first'/.test(html.slice(bf, bf + 200)));
  const rf = html.indexOf("getElementById('btn-red-first').onclick");
  ok('存在「让引擎先走」按钮处理', rf >= 0);
  ok('该按钮调用 /api/red-first', /post\('\/api\/red-first'/.test(html.slice(rf, rf + 200)));

  // 关键：点击棋子时**不能**用 state.turn 判断谁能走 ——
  // 黑方先走模式下局面记的是红方回合，但这时该用户走黑棋。
  const ci = html.indexOf("svg.addEventListener('click'");
  const cbody = html.slice(ci, ci + 900);
  ok('走子被 canUserMove 门控（而不是只看回合）', /state\.canUserMove\s*===\s*false/.test(cbody), cbody.slice(0, 160));
  ok('只允许选中黑棋（用户执黑）', /isRedPiece\(p\)/.test(cbody));

  // 状态文字在"红方回合但该用户走"时也要显示成轮到你走
  ok('状态文字优先按 canUserMove 显示', /else if \(s\.canUserMove\)/.test(html));
  ok('开局未切换时有引导文案', /切换到黑方先走/.test(html) && /让引擎先走/.test(html));
}

// ---------------------------------------------------------------- 坐标转换的单一出口
{
  ok('board.js 已删除未翻转的 uciSquare', !/export const uciSquare/.test(board));
  ok('board.js 已删除未翻转的 squareFromUci', !/export const squareFromUci/.test(board));
  ok('存在带翻转的 toEngineSquare', /export const toEngineSquare/.test(board));
  ok('存在带翻转的 fromEngineSquare', /export const fromEngineSquare/.test(board));
  ok('server.js 不再 import 已删除的函数', !/uciSquare|squareFromUci/.test(server));
  // 前端不应自己拼 rank，必须翻转
  ok('前端 lastMove 有越界保护', /f\s*<\s*0\s*\|\|\s*f\s*>\s*8/.test(html));
}

// ---------------------------------------------------------------- 引擎层：单一 stdout 解析路径
{
  // 症状：握手与搜索各写一条路径，搜索那条没挂上 → 引擎回了 bestmove 没人接 → 必然超时
  ok('engine.js 只有一条 stdout 解析入口', /_onStdout\(chunk\)/.test(engine));
  ok('不再存在死代码 attachParser', !/attachParser\s*\(/.test(engine), 'attachParser 若只是定义未调用就是死代码');
  const onDataCount = (engine.match(/this\.proc\.stdout\.on\('data'/g) ?? []).length;
  ok('stdout 上只挂了一个 data 监听器', onDataCount === 1, onDataCount);
}

// ---------------------------------------------------------------- 引擎层：超时不丢着法
{
  // 症状：超时直接 reject，同时到达的 bestmove 被静默丢弃
  ok('超时先发 stop 让引擎收手', /stdin\.write\('stop\\n'\)/.test(engine));
  ok('存在硬超时兜底', /hardTimer/.test(engine));
  ok('bestmove 到达时做幂等判断', /if\s*\(p\s*&&\s*!p\.settled\)/.test(engine));
}

// ---------------------------------------------------------------- 引擎层：退出要带走子进程
{
  ok('stop() 是异步并等待退出', /async stop\(/.test(engine));
  ok('server.js 关闭时 await 引擎 stop', /await engine\?\.stop\(\)/.test(server));
  ok('server.js 注册了 SIGINT/SIGTERM 清理', /process\.on\('SIGINT'/.test(server) && /process\.on\('SIGTERM'/.test(server));
}

console.log('\n========================================');
console.log(`  通过 ${pass.length}   失败 ${fail.length}`);
if (fail.length) {
  console.log('\n失败项：');
  fail.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('  ✅ 全部通过');
}
