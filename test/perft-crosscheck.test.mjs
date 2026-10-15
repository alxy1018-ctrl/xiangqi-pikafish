/**
 * 用 Pikafish 的 UCI `go perft` 做**独立裁判**，验证我的规则引擎。
 *
 * 为什么这条最有价值：Pikafish 是与我完全独立的实现（C++、Stockfish 系）。
 * 它与我的规则引擎在相同局面上给出相同的节点数，才算真正排除了
 * "生成器与校验器共享同一个偏差"的同源风险。
 *
 * 注意：两套的 UCI 坐标 rank 方向相反，比对时必须转换。
 */
import { spawn } from 'node:child_process';
import {
  Position, RED, BLACK, moveToUci, moveFromUci, positionFromMoves, idx,
} from '../lib/board.js';
import { EXE, CWD } from './engine-path.mjs';

/** 让引擎跑 go perft N，返回总节点数 */
function enginePerft(moves, depth) {
  return new Promise((resolve, reject) => {
    const proc = spawn(EXE, [], { cwd: CWD, windowsHide: true });
    let buf = '';
    let total = null;
    let stage = 'uci';                 // uci → ready → go
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`超时（已收到 ${total ?? 0} 节点信息，stage=${stage}）`));
    }, 600000);

    const writePos = () => {
      const seq = moves.length ? ' moves ' + moves.join(' ') : '';
      proc.stdin.write(`position startpos${seq}\n`);
      proc.stdin.write(`go perft ${depth}\n`);
      stage = 'go';
    };

    proc.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '').trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('Nodes searched:')) {
          total = Number(line.split(':')[1].trim());
          clearTimeout(timer);
          try { proc.stdin.write('quit\n'); } catch { /* 已退出 */ }
          proc.kill();
          resolve(total);
          return;
        }
        if (line === 'uciok' && stage === 'uci') {
          // 关键：先 isready 同步，再下发局面 —— 长序列后直接 go 会没反应
          stage = 'ready';
          proc.stdin.write('isready\n');
        } else if (line === 'readyok' && stage === 'ready') {
          writePos();
        }
      }
    });
    proc.on('error', reject);
    proc.stdin.write('uci\n');
  });
}

/** 我的规则引擎跑同样的 perft */
function myPerft(moves, depth) {
  const pos = positionFromMoves(moves);
  const rec = (depth) => {
    if (depth === 0) return 1;
    let n = 0;
    for (const mv of pos.generateLegalMoves(pos.turn)) {
      const cap = pos.makeMove(mv);
      n += rec(depth - 1);
      pos.undoMove(mv, cap);
    }
    return n;
  };
  return rec(depth);
}

const results = [];
console.log('=== 用 Pikafish 做独立裁判，比对 perft 节点数 ===\n');

// 测试局面：开局 + 几个典型中局（含吃子、过河、被将军等）
const SCENARIOS = [
  { name: '标准开局', moves: [], depths: [1, 2, 3, 4] },
  { name: '炮二平五后', moves: ['h2e2'], depths: [1, 2, 3] },
  { name: '中炮开局 2 回合', moves: ['h2e2', 'h9g7', 'h0g2', 'i9h9'], depths: [1, 2, 3] },
  { name: '兑炮后（含吃子）', moves: ['h2e2', 'b9c7', 'b0c2', 'a9b9'], depths: [1, 2, 3] },
  // 双方各进一兵。注意坐标是**引擎坐标**：
  //   红兵内部在 rank 6 → 引擎 rank 3，所以红兵前进是 c3c4；
  //   黑卒内部在 rank 3 → 引擎 rank 6，所以黑卒前进是 c6c5。
  //   （写反过一次，引擎直接判非法 —— 这类笔误由下面的自校验拦住。）
  { name: '双方各进一兵', moves: ['c3c4', 'c6c5', 'g3g4', 'g6g5'], depths: [1, 2, 3] },
  // 红兵过河后可以横走：引擎坐标下红兵从 rank 3 一路推进到 rank 0（内部 rank 9？不，
  // 引擎 rank 0 是红方底线，所以"前进"是 rank 减小；过河线在 rank 4/5 之间）
  { name: '红兵推进三步', moves: ['c3c4', 'a6a5', 'c4c5', 'a5a4', 'c5c6'], depths: [1, 2, 3] },
];

let allMatch = true;

/**
 * 发引擎之前先用规则引擎自查一遍走子序列。
 * 加这一步是因为写测试时把引擎坐标和内部坐标搞混过，结果引擎判非法、
 * 表现为"超时"这种难以定位的现象。自查能把这类笔误变成一行明确的报错。
 */
function validateSequence(moves) {
  for (let i = 0; i < moves.length; i++) {
    const pos = positionFromMoves(moves.slice(0, i));
    const mv = moveFromUci(moves[i]);
    const legal = pos.generateLegalMoves(pos.turn).some((m) => m.from === mv.from && m.to === mv.to);
    if (!legal) {
      const side = pos.turn === RED ? '红' : '黑';
      return `第 ${i + 1} 步 ${moves[i]} 非法（轮到${side}方，起点棋子="${pos.board[mv.from]}"）`;
    }
  }
  return null;
}

for (const sc of SCENARIOS) {
  console.log(`【${sc.name}】走子序列: ${sc.moves.join(' ') || '(无)'}`);
  const bad = validateSequence(sc.moves);
  if (bad) {
    console.log(`  ❌ 序列自校验失败：${bad}`);
    console.log('     （这是测试数据写错，不是引擎问题；已跳过该局面）\n');
    allMatch = false;
    continue;
  }
  for (const d of sc.depths) {
    let mine, theirs;
    try {
      mine = myPerft(sc.moves, d);
      theirs = await enginePerft(sc.moves, d);
    } catch (e) {
      console.log(`  depth ${d}: ⚠️ 出错 — ${e.message}`);
      allMatch = false;
      continue;
    }
    const match = mine === theirs;
    if (!match) allMatch = false;
    console.log(`  depth ${d}:  我的=${String(mine).padStart(9)}   Pikafish=${String(theirs).padStart(9)}   ${match ? '✅ 一致' : '❌ 不一致'}`);
    results.push({ scenario: sc.name, depth: d, mine, theirs, match });
  }
  console.log('');
}

const matched = results.filter((r) => r.match).length;
console.log('========================================');
console.log(`  比对项: ${matched} / ${results.length} 一致`);
console.log(allMatch
  ? '  ✅ 两套独立实现（我的 JS 规则引擎 vs Pikafish C++）在全部测试局面上完全一致'
  : '  ❌ 存在不一致 —— 至少一方有 bug，需逐个排查');
process.exit(allMatch ? 0 : 1);
