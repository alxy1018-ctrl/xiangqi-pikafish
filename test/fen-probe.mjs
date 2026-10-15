/**
 * 验证 Pikafish 对 FEN 的支持：格式、能否接受"红方轮走"的自定义局面。
 * 黑方先走模式下必须走 FEN 路线 —— 因为 startpos + 走子序列隐含红先，
 * 第一步下黑棋会让引擎崩掉（已实测 exit code 1）。
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

// 黑方先走一着的局面：黑卒 c3→c4（内部），随后该红方走
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

console.log('\n=== 测试 2：黑方先走一着后的 FEN（轮红方）+ go depth 8 ===');
try {
  // 强制 turn 为红方：黑方先走模式下，轮到的是红方
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

console.log('\n=== 测试 3：对照 —— 用 startpos moves 下发黑方先走（预期崩溃或异常）===');
try {
  const out = await runUci(['position startpos moves c6c5', 'go depth 8'], 'bestmove', 12000);
  console.log('  意外地成功了：' + out.filter((l) => l.startsWith('bestmove')).join(' '));
} catch (e) {
  console.log('  ⚠️ 复现了问题：' + e.message.split('\n')[0]);
}
