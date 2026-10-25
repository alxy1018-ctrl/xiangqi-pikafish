/**
 * 中国象棋对弈服务：静态页 + API + Pikafish 引擎桥接。
 *
 * 核心设计：**局面唯一事实来源是 moves 数组**。
 * 引擎侧局面永远从该数组重建，并以 FEN 下发，
 * 本地不维护第二份局面 —— 这样悔棋、重开都不会出现两侧不同步。
 *
 * 执子约定：**用户可以选边**（game.userColor，默认执黑），引擎固定执另一方。
 * 红方永远先行：用户执红就直接走红方第一步；用户执黑就等「让引擎先走」。
 * 换边只在对局开始前（moves 为空）可用，见 /api/swap-sides。
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
   * 用户执哪一方（RED / BLACK），默认执黑。
   *
   * 引擎固定执另一方；红方永远先行：
   *   - 用户执红：用户直接走红方第一步，引擎执黑应手；
   *   - 用户执黑：引擎执红，开局等「让引擎先走」。
   *
   * 只在对局开始前（moves 为空）可以通过 /api/swap-sides 切换；
   * 「重新开始」保留这个选择，不回到默认执黑。
   */
  userColor: BLACK,
  /** 引擎搜索次数（含应手与分析），用于观察是否有随次数累积的东西 */
  searchCount: 0,
  /** 分析次数（面板分析，不含应手） */
  analysisCount: 0,
};

/** 现在是否允许用户走子：只有轮到用户执的那一方时才允许。 */
function userMayMoveNow(pos) {
  return pos.turn === game.userColor;
}

let engine = null;
let engineError = null;

/**
 * 由 moves 推导当前局面。
 *
 * 红方永远先行，合法的走子序列严格交替，`makeMove` 自己会翻轮走方；
 * 因此不需要再按某种模式手工修正奇偶。moves 依旧是唯一事实来源。
 */
const currentPosition = () => positionFromMoves(game.moves);

const sideName = (color) => (color === RED ? '红方' : '黑方');
const playerName = (color) => (color === game.userColor ? '你' : 'Pikafish');
/** 结果文案：红方（你）/ 黑方（Pikafish）/ …，按实际执子显示 */
const winnerName = (color) => `${sideName(color)}（${playerName(color)}）`;

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
 * 为什么不用 `position startpos moves ...`：那个形式隐含"红先"，
 * 而且要求从开局严格交替下发。这里已经有完整局面（moves 重建），
 * 直接发 FEN 把轮走方显式带上 —— 少一套"什么时候能用 startpos"的判断。
 * FEN 也是引擎直接支持的形式，正常局面用起来完全等价。
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
 * 推进对局：只要轮到引擎执的那一方且引擎可用，就让引擎走一步，
 * 直到轮到用户或对局结束。
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
        winnerName: winnerName(st.winner),
        reason: st.reason === 'checkmate' ? '将死' : '困毙',
      };
      break;
    }

    // 轮到用户执子 → 交还给用户，退出循环
    if (pos.turn === game.userColor) break;
    // 轮到引擎但引擎不可用/不允许 → 也退出
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
    const legal = pos.generateLegalMoves(pos.turn).some((m) => m.from === mv.from && m.to === mv.to);
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
      winnerName: winnerName(st.winner),
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
    /** 用户执哪一方（red / black） */
    userColor: game.userColor,
    /** 现在能不能点棋子走子（前端据此决定是否允许交互与怎么显示状态） */
    canUserMove: userMayMoveNow(pos) && !game.thinking && !st.over,
    /** 开局还没走子（用于决定「换边」「让引擎先走」是否可用） */
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
        return send(res, 400, {
          error: game.moves.length === 0
            ? '开局红方先行：请点「让引擎先走」，或点「换边」改执红'
            : `现在轮到${sideName(pos.turn)}（引擎），请稍候`,
          state: statePayload(),
        });
      }

      const side = pos.turn;
      const legal = pos.generateLegalMoves(side).find((m) => m.from === from && m.to === to);
      if (!legal) return send(res, 400, { error: '非法着法', state: statePayload() });

      game.notation.push(toChineseNotation(pos, legal));
      game.moves.push(moveToUci(legal));
      // 轮走方由 moves 重建；用户走完这一方后，advance() 会接着走引擎那一方。

      const engineMoves = await advance({ allowEngine: true });
      return send(res, 200, { ok: true, engineMoves, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/undo') {
      if (game.thinking) return send(res, 409, { error: '引擎正在思考，请稍候' });
      if (!game.moves.length) return send(res, 200, { ok: true, state: statePayload() });
      // 悔棋退回到"轮到用户执子"的时刻：执黑、执红都适用，不会退成半个回合。
      let guard = 0;
      do {
        game.moves.pop();
        game.notation.pop();
      } while (game.moves.length && currentPosition().turn !== game.userColor && ++guard < 4);
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
      // 新一局保留用户已选的执子（换边是选边，不是临时状态）。
      // 红方先行且引擎不会自动走：用户执黑时等「让引擎先走」；用户执红时用户直接走。
      // 开局局面轮到红方。
      return send(res, 200, { ok: true, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/swap-sides') {
      // 「换边」：只在对局开始前切换用户执红/执黑。引擎固定执另一方，红方永远先行。
      if (game.thinking) return send(res, 409, { error: '引擎正在思考，请稍候' });
      if (game.moves.length) {
        return send(res, 400, { error: '只能在对局开始前换边（已经走过棋了）', state: statePayload() });
      }
      game.userColor = other(game.userColor);
      game.analysis = null;   // 换边后"轮到谁/谁在分析"的语义变了，旧候选面板不再对应当前执子
      return send(res, 200, { ok: true, state: statePayload() });
    }

    if (req.method === 'POST' && path === '/api/red-first') {
      // 「让引擎先走」：引擎执红、红方先手时立刻走一步（用户执黑时的正常开局）
      if (game.thinking) return send(res, 409, { error: '引擎正在思考，请稍候' });
      if (game.moves.length) return send(res, 400, { error: '只能在开局时使用', state: statePayload() });
      if (game.userColor !== BLACK) {
        return send(res, 400, { error: '你已选择执红，红方先行，直接走棋即可', state: statePayload() });
      }
      if (!engine?.ready) return send(res, 503, { error: '引擎未就绪', state: statePayload() });
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
      // 用户能走时用用户执子；否则（例如陈旧/越权请求）用局面轮走方。
      const side = userMayMoveNow(pos) ? game.userColor : pos.turn;
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
