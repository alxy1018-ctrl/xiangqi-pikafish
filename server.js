/**
 * 中国象棋对弈服务：静态页 + API + Pikafish 引擎桥接。
 *
 * 核心设计：**局面唯一事实来源是 moves 数组**。
 * 引擎侧局面永远用 `position startpos moves ...` 从该数组推导，
 * 本地不维护第二份局面 —— 这样悔棋、重开都不会出现两侧不同步。
 *
 * 执子约定：**引擎恒执红方（下方）**，用户执黑方（上方）。
 * 但允许用户在红方轮走时替红方走一步（"代走"），
 * 走完后引擎会在轮到红方时正常接管。见 advance() 的注释。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Position, RED, BLACK, other, moveToUci, moveFromUci,
  fileOf, rankOf, idx, PIECE_NAMES, isRed, positionFromMoves,
} from './lib/board.js';
import { UciEngine, LEVELS } from './lib/engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

// 引擎默认放在项目内的 engine/ 目录，随仓库一起分发。
// 用"相对本文件"定位而不是写绝对路径 —— 这样仓库被 clone 到任何地方、改成任何目录名都能跑。
// 想用别处的引擎就设环境变量 XQ_ENGINE。
const ENGINE_DIR = join(__dirname, 'engine');
const DEFAULT_ENGINE_EXE = process.platform === 'win32'
  ? join(ENGINE_DIR, 'Pikafish-Windows-x86-64-universal.exe')
  : join(ENGINE_DIR, 'Pikafish-Linux-x86-64-universal');

const CONFIG = {
  port: Number(process.env.XQ_PORT ?? 19390),
  host: '127.0.0.1',
  engine: {
    exePath: process.env.XQ_ENGINE ?? DEFAULT_ENGINE_EXE,
    threads: 4,
    hash: 256,
  },
  defaultLevel: 3,
};

// ---------------------------------------------------------------------------
// 对局状态
// ---------------------------------------------------------------------------

const game = {
  /** 完整走子序列（UCI 串）。**唯一事实来源。** */
  moves: [],
  level: CONFIG.defaultLevel,
  /** 每一步的中文记谱，与 moves 一一对应 */
  notation: [],
  /** 引擎是否正在思考（防止并发请求重入） */
  thinking: false,
  /** 最近一次引擎分析（面板用） */
  analysis: null,
  /** 对局结果：null 表示进行中 */
  result: null,
  /**
   * 黑方先走模式。
   *
   * 中国象棋规则是红先，但用户执黑时希望能自己先走一步。
   * 打开这个开关后：**引擎（红方）原地不动**，轮到用户在红方回合替黑方走第一步；
   * 这一步走完，引擎就接管红方正常应手，此后黑白交替。
   *
   * 语义上等价于"把黑方这一步提到红方之前"，所以引擎侧的局面序列依旧是合法的
   * （引擎看到的仍然是"红方该走"的局面，只是此时黑方已经动过一步）。
   */
  blackFirst: false,
  /** 引擎搜索次数（含应手与分析），用于观察是否有随次数累积的东西 */
  searchCount: 0,
  /** 分析次数（面板分析，不含应手） */
  analysisCount: 0,
};

/**
 * 现在是否允许用户走子。
 * 常规情况只有轮到自己（黑方）时能走；黑方先走模式下，
 * 红方回合且未走子时也允许用户动黑棋。
 */
function userMayMoveNow(pos) {
  if (pos.turn === BLACK) return true;
  return game.blackFirst && game.moves.length === 0 && pos.turn === RED;
}

let engine = null;
let engineError = null;

/**
 * 由 moves 推导当前局面。
 *
 * 轮走方不能简单地"走一步翻一次"——黑方先走模式下，用户那步黑棋是**抢在红方之前**走的
 * （见 game.blackFirst）。所以两种模式的奇偶关系不同：
 *
 *   常规模式（红先）  : 奇数步 = 刚走完红棋 → 该黑方走；偶数步 → 该红方走
 *   黑方先走模式      : 第 1 步是黑棋（抢走），所以奇数步 → 该红方走；偶数步 → 该黑方走
 *
 * 这样 moves 数组依旧能唯一确定局面，不必额外维护轮走方状态。
 */
const currentPosition = () => {
  const pos = positionFromMoves(game.moves);
  const odd = game.moves.length % 2 === 1;
  const blackFirstActive = game.blackFirst && game.moves.length > 0;
  pos.turn = blackFirstActive
    ? (odd ? RED : BLACK)      // 黑方抢走一步后，轮到红方（引擎）
    : (odd ? BLACK : RED);     // 红先：红棋走完轮黑方
  return pos;
};

// ---------------------------------------------------------------------------
// 中文记谱（"炮二平五"这种），仅用于显示棋谱
// ---------------------------------------------------------------------------

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

/**
 * 把一个着法转成中文记谱。
 * 规则：红方用汉字纵线号（从右往左数），黑方用阿拉伯数字（从左往右数）。
 * 同一纵线有两个同名子时用「前/后」区分。
 */
export function toChineseNotation(before, move) {
  const piece = before.pieceAt(move.from);
  if (!piece || piece === '.') return moveToUci(move);
  const red = isRed(piece);
  const name = PIECE_NAMES[piece];
  const fromFile = fileOf(move.from), fromRank = rankOf(move.from);
  const toFile = fileOf(move.to), toRank = rankOf(move.to);

  // 纵线号：红方从右往左（file 8 是"一"），黑方从左往右（file 0 是"1"）
  const fileNum = (f) => (red ? 9 - f : f + 1);
  const numStr = (n) => (red ? CN_NUM[n - 1] : String(n));

  // 同一纵线上是否有同种同色棋子
  const sameFile = [];
  for (let r = 0; r < 10; r++) {
    if (before.pieceAt(idx(fromFile, r)) === piece) sameFile.push(r);
  }

  let subject;
  if (sameFile.length > 1) {
    // 红方 rank 小的是"前"（更靠近对方），黑方相反
    const sorted = [...sameFile].sort((a, b) => (red ? a - b : b - a));
    const posInLine = sorted.indexOf(fromRank);
    subject = (posInLine === 0 ? '前' : posInLine === sorted.length - 1 ? '后' : '中') + name;
  } else {
    subject = name + numStr(fileNum(fromFile));
  }

  if (fromRank === toRank) return `${subject}平${numStr(fileNum(toFile))}`;
  // 红方向 rank 减小方向前进；黑方相反
  const forward = red ? toRank < fromRank : toRank > fromRank;
  return `${subject}${forward ? '进' : '退'}${numStr(red ? Math.abs(toRank - fromRank) : Math.abs(toRank - fromRank))}`;
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

async function initEngine() {
  engine = new UciEngine(CONFIG.engine);
  try {
    await engine.start();
    await engine.setLevel(game.level);
    engineError = null;
  } catch (e) {
    engineError = e.message;
    console.error('[引擎] 启动失败：' + e.message);
  }
}

/**
 * 组装一次引擎搜索所需的下发方式。
 *
 * **一律用 FEN 下发当前局面**，并把轮走方如实写进去。
 *
 * 为什么不用 `position startpos moves ...`：那个形式隐含"红先"。
 * 黑方先走模式的走子序列以**黑棋**开头，直接下发会让 Pikafish 崩掉
 * （实测 exit code 1，或挂死不返回 bestmove）。
 * FEN 没有这个隐含前提，正常局面用起来也完全等价，所以干脆统一走 FEN，
 * 不再为两种模式写两套下发逻辑 —— 少一套分支就少一个踩坑点。
 *
 * @param {Position} pos 当前局面
 * @returns {{moves:string[], fen:string, sideToMove:string}}
 *   sideToMove 是**引擎实际在分析的那一方**，用于把评估分换算到红方视角。
 */
function engineRequest(pos) {
  return { moves: game.moves, fen: pos.toFen(), sideToMove: pos.turn };
}

/**
 * 取当前局面棋盘串的快照，随分析结果一起发给前端。
 *
 * 为什么要存快照：分析之后局面往往又走了一步，而候选着法的起点上原来的棋子
 * 可能已经移走了。前端若拿**当前**棋盘去翻译棋子名，就会显示成"?"。
 */
const snapshotBoard = (pos) => pos.board.join('');

/**
 * 推进对局：只要轮到红方且引擎可用，就让引擎走一步，直到轮到黑方或对局结束。
 *
 * @param {object} [opts] { allowEngine: 是否允许引擎走子 }
 */
async function advance({ allowEngine = true } = {}) {
  const engineMoves = [];

  for (;;) {
    const pos = currentPosition();
    const st = pos.status();
    if (st.over) {
      game.result = {
        winner: st.winner,
        winnerName: st.winner === RED ? '红方（Pikafish）' : '黑方（你）',
        reason: st.reason === 'checkmate' ? '将死' : '困毙',
      };
      break;
    }

    // 黑方走 → 交给用户，退出循环
    if (pos.turn === BLACK) break;
    // 红方轮走但引擎不可用/不允许 → 也退出
    if (!allowEngine || !engine || !engine.ready) break;

    game.thinking = true;
    let uci = null;
    try {
      engine.clearInfo();
      const req = engineRequest(pos);
      game.searchCount += 1;
      uci = await engine.search(req.moves, { level: game.level, fen: req.fen });
      game.analysis = summarizeAnalysis(engine.info, req.sideToMove, snapshotBoard(pos));
    } catch (e) {
      engineError = e.message;
      console.error('[引擎] 搜索失败：' + e.message);
    } finally {
      game.thinking = false;
    }

    if (!uci) break;   // 无着法：status() 已在上面处理过，剩下的情况视为引擎异常

    const mv = moveFromUci(uci);
    const legal = pos.generateLegalMoves(RED).some((m) => m.from === mv.from && m.to === mv.to);
    if (!legal) {
      engineError = `引擎给出非法着法 ${uci}（内部 ${mv.from}→${mv.to}），已忽略`;
      console.error('[引擎] ' + engineError);
      break;
    }

    game.notation.push(toChineseNotation(pos, mv));
    game.moves.push(uci);
    engineMoves.push(uci);
  }

  return engineMoves;
}

/**
 * 把引擎 info 汇总成面板需要的数据。
 * 注意：引擎的 score 是**从轮到走的一方视角**的。调用方需说明当前是谁在走，
 * 这里统一换算成「红方视角」（正数=红方优势），便于面板直接显示。
 */
export function summarizeAnalysis(infoList, sideToMove, boardAtAnalysis = null) {
  if (!infoList?.length) return null;
  const withPv = infoList.filter((i) => i.pv && i.pv.length);
  if (!withPv.length) return null;

  const maxDepth = Math.max(...withPv.map((i) => i.depth ?? 0));
  const atMax = withPv.filter((i) => i.depth === maxDepth);
  const last = atMax[0];
  const flip = sideToMove === BLACK ? -1 : 1;   // 引擎报的是"轮到走的一方"视角

  const byMulti = new Map();
  for (const i of withPv) {
    const prev = byMulti.get(i.multipv);
    if (!prev || (i.depth ?? 0) >= (prev.depth ?? 0)) byMulti.set(i.multipv, i);
  }
  const candidates = [...byMulti.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pv, i], index) => ({
      rank: index + 1,
      multipv: pv,
      depth: i.depth,
      scoreCp: i.scoreCp === null ? null : i.scoreCp * flip,
      scoreMate: i.scoreMate === null ? null : i.scoreMate * flip,
      wdl: i.wdl,
      uci: i.pv[0],
      pvLength: i.pv.length,
      pv: i.pv.slice(0, 8),
    }));

  return {
    /** 分析的是哪一方在走。前端据此说明"这是谁的候选着法" */
    sideToMove,
    /**
     * 分析时刻的棋盘快照。
     * 前端要靠它把候选着法的起点翻译成棋子名 —— 用**当前**棋盘会查错，
     * 因为分析之后往往又走了一步，起点上的棋子已经移走了（表现为显示成"?"）。
     */
    board: boardAtAnalysis,
    depth: last.depth,
    selDepth: last.selDepth,
    nodes: last.nodes,
    nps: last.nps,
    time: last.time,
    scoreCp: last.scoreCp === null ? null : last.scoreCp * flip,
    scoreMate: last.scoreMate === null ? null : last.scoreMate * flip,
    wdl: last.wdl,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 组装给前端的完整状态 */
function statePayload() {
  const pos = currentPosition();
  const st = pos.status();
  if (st.over && !game.result) {
    game.result = {
      winner: st.winner,
      winnerName: st.winner === RED ? '红方（Pikafish）' : '黑方（你）',
      reason: st.reason === 'checkmate' ? '将死' : '困毙',
    };
  }
  return {
    board: pos.board.join(''),
    turn: pos.turn,
    moves: game.moves,
    notation: game.notation,
    level: game.level,
    levels: Object.entries(LEVELS).map(([k, v]) => ({ value: Number(k), name: v.name })),
    analysis: game.analysis,
    result: game.result,
    thinking: game.thinking,
    engineReady: Boolean(engine && engine.ready),
    engineError,
    lastMove: game.moves.length ? game.moves[game.moves.length - 1] : null,
    check: pos.isInCheck(pos.turn),
    /** 黑方先走模式是否已打开 */
    blackFirst: game.blackFirst,
    /** 现在能不能点棋子走子（前端据此决定是否允许交互与怎么显示状态） */
    canUserMove: userMayMoveNow(pos) && !game.thinking && !st.over,
    /** 开局还没走子（用于决定那两个"谁先走"按钮是否可用） */
    atStart: game.moves.length === 0,
    /**
     * 运行期计数与内存占用。用于排查"跑久了会不会越吃越多"，
     * 平时前端不显示，但诊断时能直接从 /api/state 读到。
     */
    memory: {
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
      heapTotal: process.memoryUsage().heapTotal,
      external: process.memoryUsage().external,
    },
    searchCount: game.searchCount,
    analysisCount: game.analysisCount,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // ---- 静态文件 ----
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const file = join(__dirname, 'public', 'index.html');
      const html = await readFile(file, 'utf8');
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && path.startsWith('/public/')) {
      const rel = path.slice('/public/'.length);
      if (rel.includes('..')) return send(res, 400, { error: '非法路径' });
      const file = join(__dirname, 'public', rel);
      if (!existsSync(file)) return send(res, 404, { error: 'not found' });
      const ext = file.slice(file.lastIndexOf('.'));
      const content = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(content);
    }

    // ---- API ----
    if (req.method === 'GET' && path === '/api/state') {
      return send(res, 200, statePayload());
    }

    if (req.method === 'POST' && path === '/api/move') {
      const body = await readBody(req);
      const pos = currentPosition();
      const st0 = pos.status();
      if (st0.over) return send(res, 409, { error: '对局已结束', state: statePayload() });
      if (game.thinking) return send(res, 409, { error: '引擎正在思考，请稍候', state: statePayload() });

      const from = Number(body.from), to = Number(body.to);

      if (!userMayMoveNow(pos)) {
        // 红方回合且不在黑方先走模式 → 用户不能替红方走（引擎自己会走）
        return send(res, 400, {
          error: '现在轮到红方（引擎），请先点「切换到黑方先走」',
          state: statePayload(),
        });
      }

      // 黑方先走模式下第一次走子：允许走黑棋，即使当前局面记的是红方回合
      const isBlackFirstMove = game.blackFirst && game.moves.length === 0 && pos.turn === RED;
      const side = isBlackFirstMove ? BLACK : pos.turn;
      const legal = pos.generateLegalMoves(side).find((m) => m.from === from && m.to === to);
      if (!legal) return send(res, 400, { error: '非法着法', state: statePayload() });

      game.notation.push(toChineseNotation(pos, legal));
      game.moves.push(moveToUci(legal));
      // 轮走方不用在这里手工翻转：currentPosition() 会按 blackFirst + 步数奇偶推导，
      // 黑方先走模式下这一步走完即"轮到红方"，引擎随即接管应手。

      const engineMoves = await advance({ allowEngine: true });
      return send(res, 200, { ok: true, engineMoves, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/undo') {
      if (game.thinking) return send(res, 409, { error: '引擎正在思考，请稍候' });
      // 悔棋退回到"轮到黑方"的状态：撤到黑方该走的那个点
      let guard = 0;
      do {
        game.moves.pop();
        game.notation.pop();
      } while (game.moves.length && currentPosition().turn === RED && ++guard < 4);
      game.result = null;
      game.analysis = null;         // 局面变了，旧分析必须丢掉
      // 重算分析
      const pos = currentPosition();
      if (engine?.ready) {
        try {
          const req = engineRequest(pos);
          await engine.search(req.moves, { level: game.level, movetime: 400, fen: req.fen });
          game.analysis = summarizeAnalysis(engine.info, req.sideToMove, snapshotBoard(pos));
        } catch { /* 分析失败不影响悔棋 */ }
      }
      return send(res, 200, { ok: true, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/new') {
      if (game.thinking) return send(res, 409, { error: '引擎正在思考，请稍候' });
      game.moves = [];
      game.notation = [];
      game.result = null;
      // 必须同时清掉分析：否则棋谱显示"尚未走子"、而分析面板还挂着上一局的评估与候选着法
      game.analysis = null;
      game.blackFirst = false;      // 新一局回到默认：红方先走
      // 开局局面轮到红方，引擎不会自动走 —— 等用户按「引擎先走」或「切换黑方先走」
      return send(res, 200, { ok: true, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/engine-first') {
      // 「切换到黑方先走」：**引擎原地不动**，只是允许用户在红方回合先走一步黑棋。
      // 用户走完这步之后，轮到红方，引擎才接管应手。
      // （接口路径保留 /api/engine-first 是为了兼容既有调用，语义见 game.blackFirst 注释。）
      if (game.thinking) return send(res, 409, { error: '引擎正在思考，请稍候' });
      if (game.moves.length) {
        return send(res, 400, { error: '只能在开局时切换（已经走过棋了）', state: statePayload() });
      }
      game.blackFirst = true;
      // 刻意不调用 advance()：这一步就是"引擎先不动"
      return send(res, 200, { ok: true, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/red-first') {
      // 「让引擎先走」：红方先手，引擎立刻走一步（正常开局）
      if (game.thinking) return send(res, 409, { error: '引擎正在思考，请稍候' });
      if (game.moves.length) return send(res, 400, { error: '只能在开局时使用', state: statePayload() });
      if (!engine?.ready) return send(res, 503, { error: '引擎未就绪', state: statePayload() });
      game.blackFirst = false;
      const engineMoves = await advance({ allowEngine: true });
      return send(res, 200, { ok: true, engineMoves, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/level') {
      const body = await readBody(req);
      const lv = Number(body.level);
      if (!LEVELS[lv]) return send(res, 400, { error: '无效难度' });
      game.level = lv;
      if (engine?.ready) await engine.setLevel(lv);
      return send(res, 200, { ok: true, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/analyze') {
      // 只分析，不落子
      if (!engine?.ready) return send(res, 503, { error: '引擎未就绪', state: statePayload() });
      if (game.thinking) return send(res, 409, { error: '正在分析' });
      const body = await readBody(req);
      const pos = currentPosition();
      game.thinking = true;
      try {
        const req = engineRequest(pos);
        game.searchCount += 1;
        game.analysisCount += 1;
        await engine.search(req.moves, { level: game.level, movetime: Number(body.movetime) || 1200, fen: req.fen });
        game.analysis = summarizeAnalysis(engine.info, req.sideToMove, snapshotBoard(pos));
      } finally {
        game.thinking = false;
      }
      return send(res, 200, { ok: true, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/legal') {
      // 查询某个位置的合法落点（前端高亮用）
      const body = await readBody(req);
      const pos = currentPosition();
      const from = Number(body.from);
      // 默认用局面轮走方；但黑方先走模式下红方回合时用户走的是黑棋，
      // 所以要按"用户此刻实际能走的那一方"来算落点，否则会给出红方的着法。
      const side = userMayMoveNow(pos)
        ? (game.blackFirst && game.moves.length === 0 && pos.turn === RED ? BLACK : pos.turn)
        : pos.turn;
      const targets = pos.generateLegalMoves(side)
        .filter((m) => m.from === from)
        .map((m) => m.to);
      return send(res, 200, { from, targets, side });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[服务] 处理 ' + path + ' 出错：' + e.message);
    return send(res, 500, { error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/**
 * 打开浏览器访问指定 URL。
 *
 * 由 start.cmd 通过环境变量 XQ_OPEN_URL / XQ_OPEN_EXE 触发：
 *   XQ_OPEN_URL  URL（不设则不打开浏览器）
 *   XQ_OPEN_EXE  浏览器可执行文件路径（不设则用系统默认程序打开）
 *
 * 放在**服务器真正开始监听之后**调用，而不是让批处理 sleep 几秒再 open ——
 * 后者在端口被占用（例如已经跑着一个实例）时会打开一个打不开的死页面。
 */
function openBrowser(url) {
  const exe = process.env.XQ_OPEN_EXE;
  try {
    if (exe && existsSync(exe)) {
      spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return `已用指定浏览器打开：${exe}`;
    }
    // 没有指定浏览器就用系统默认程序（Windows 走 start 的 shell 关联）
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return '已用系统默认浏览器打开';
  } catch (e) {
    return `打开浏览器失败（请手动访问）：${e.message}`;
  }
}

async function main() {
  console.log('=== 中国象棋 · Pikafish 对弈 ===');
  console.log('引擎：' + CONFIG.engine.exePath);
  await initEngine();
  if (engineError) {
    console.log('⚠️  引擎启动失败：' + engineError);
    console.log('    页面仍会打开，但引擎不会应手（你可以手动走双方）。');
  } else {
    console.log('✅ 引擎就绪（Pikafish）');
  }

  // 端口被占用时给出人话提示，而不是抛一堆 EADDRINUSE 堆栈
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口 ${CONFIG.port} 已被占用 —— 可能已经有一个实例在跑了。`);
      console.error(`   直接访问 http://${CONFIG.host}:${CONFIG.port}/ 试试；`);
      console.error(`   想开新实例就换端口：set XQ_PORT=19391 后再启动。`);
      process.exit(1);
    }
    console.error('服务出错：' + e.message);
    process.exit(1);
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    const url = `http://${CONFIG.host}:${CONFIG.port}/`;
    console.log(`\n👉 地址：${url}`);
    // 只有真开始监听之后才拉浏览器
    if (process.env.XQ_OPEN_URL) console.log('   ' + openBrowser(process.env.XQ_OPEN_URL));
    console.log('   按 Ctrl+C 停止\n');
  });
}

// 优雅退出：一定要带走引擎子进程，否则会留下孤儿进程
async function shutdown() {
  console.log('\n正在关闭…');
  try { await engine?.stop(); } catch { /* 已退出 */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
