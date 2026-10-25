/**
 * 验证 Pikafish 对 FEN 的支持：格式、轮走方字段、以及"黑先"合成局面的搜索。
 * 这个探针构造的是不经过正常对局流程的合成局面（黑方先动过一步），
 * 用于确认引擎读 FEN 的轮走方；应用里的正式对局始终红先。
 */
import { spawn } from 'node:child_process';
import { Position, idx, positionFromMoves, moveFromUci, moveToUci, RED, BLACK } from '../lib/board.js';
import { EXE, CWD } from './engine-path.mjs';

function runUci(commands, waitFor = 'bestmove', timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(EXE, [], { cwd: CWD, windowsHide: true });
    let buf = '';
    const out = [];
    const timer = setTimeout(() => { proc.kill(); reject(new Error('超时；已收到：\n' + out.join('\n'))); }, timeoutMs);
    proc.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '').trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        out.push(line);
        if (line === 'uciok') proc.stdin.write('isready\n');
        else if (line === 'readyok') commands.forEach((c) => proc.stdin.write(c + '\n'));
        else if (waitFor && line.startsWith(waitFor)) {
          clearTimeout(timer);
          proc.stdin.write('quit\n'); proc.kill();
          resolve(out);
        }
      }
    });
    proc.on('error', reject);
    proc.stdin.write('uci\n');
  });
}

// 合成局面：先走一步黑棋（黑卒 c3→c4，内部），随后该红方走
const blackFirstPos = positionFromMoves(['c6c5']);   // 引擎坐标 c6c5 = 内部 c3→c4
console.log('局面推导：');
console.log('  内部棋盘 c4 格 = "' + blackFirstPos.board[idx(2, 4)] + '"  (期望 p 黑卒已到)');
console.log('  toFen() = ' + blackFirstPos.toFen());
console.log('  （注意 toFen 的 turn 字段来自 pos.turn，这里需要手工确保是 w=红方走）\n');

const fen = blackFirstPos.toFen();
console.log('=== 测试 1：标准开局 FEN + go depth 8 ===');
try {
  const out = await runUci(['position fen rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    'go depth 8']);
  const best = out.find((l) => l.startsWith('bestmove'));
  console.log('  bestmove: ' + best + '   （期望 h2e2 之类的红方着法）');
} catch (e) { console.log('  ❌ ' + e.message); }

console.log('\n=== 测试 2：黑先合成局面的 FEN（轮红方）+ go depth 8 ===');
try {
  // 强制 turn 为红方：合成局面里黑方已经动过一步，接下来轮到红方
  blackFirstPos.turn = RED;
  const fen2 = blackFirstPos.toFen();
  console.log('  下发的 FEN: ' + fen2);
  const out = await runUci([`position fen ${fen2}`, 'go depth 8']);
  const best = out.find((l) => l.startsWith('bestmove'));
  console.log('  bestmove: ' + best);
  // 校验引擎给的着法在规则引擎里合法（红方视角）
  if (best) {
    const uci = best.split(/\s+/)[1];
    if (uci && uci !== '(none)') {
      const mv = moveFromUci(uci);
      const legal = blackFirstPos.generateLegalMoves(RED).some((m) => m.from === mv.from && m.to === mv.to);
      console.log('  该着法在规则引擎里合法: ' + (legal ? '✅' : '❌'));
      console.log('  内部坐标: ' + mv.from + '→' + mv.to + '  走的是 "' + blackFirstPos.board[mv.from] + '"');
    }
  }
} catch (e) { console.log('  ❌ ' + e.message); }

console.log('\n=== 测试 3：对照 —— 用 startpos moves 下发黑先合成局面（预期崩溃或异常）===');
try {
  const out = await runUci(['position startpos moves c6c5', 'go depth 8'], 'bestmove', 12000);
  console.log('  意外地成功了：' + out.filter((l) => l.startsWith('bestmove')).join(' '));
} catch (e) {
  console.log('  ⚠️ 复现了问题：' + e.message.split('\n')[0]);
}
