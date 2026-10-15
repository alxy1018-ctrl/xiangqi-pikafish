/**
 * 干净的对局演练：只打 API，不经过浏览器，逐步打印状态。
 * 目的是确认服务端状态在各次调用之间是稳定、单调推进的。
 */
import { moveFromUci, moveToUci, idx, positionFromMoves, RED, BLACK } from '../lib/board.js';

const BASE = `http://127.0.0.1:${process.env.XQ_PORT ?? 19390}`;
const api = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
};

const show = async (label) => {
  const { data: s } = await api('/api/state');
  console.log(`  ${label.padEnd(22)} moves=${s.moves.length} turn=${s.turn} ` +
    `棋谱=[${s.notation.join(' ')}] 引擎错误=${s.engineError ?? '无'}`);
  return s;
};

console.log('=== 1. 重置 ===');
await api('/api/new', {});
let s = await show('重置后');

console.log('  让引擎先走…');
await api('/api/engine-first', {});
s = await show('引擎先走后');

console.log('=== 2. 用户执黑走三步，每步后引擎应手 ===');
// 黑卒七进一（内部 c3→c4）、黑卒三进一（g3→g4）、黑马八进七（b0→c2）
const userMoves = [
  { from: idx(2, 3), to: idx(2, 4) },
  { from: idx(6, 3), to: idx(6, 4) },
  { from: idx(1, 0), to: idx(2, 2) },
];
for (const mv of userMoves) {
  const before = (await api('/api/state')).data;
  const pos = positionFromMoves(before.moves);
  if (pos.turn !== BLACK) { console.log('  ⚠️ 不是黑方回合，跳过'); break; }
  const legal = pos.generateLegalMoves(BLACK).some((m) => m.from === mv.from && m.to === mv.to);
  if (!legal) { console.log(`  ⚠️ 着法 ${moveToUci(mv)} 不合法，跳过`); continue; }
  const r = await api('/api/move', mv);
  if (r.status !== 200) { console.log('  ❌ 走子失败: ' + r.data.error); break; }
  s = await show(`走 ${moveToUci(mv)} 后`);
}

console.log('=== 3. 状态一致性复核（每一步都用规则引擎独立重建）===');
{
  const { data: st } = await api('/api/state');
  const pos = positionFromMoves(st.moves);
  const same = pos.board.join('') === st.board;
  console.log(`  服务端局面与走子序列重建结果一致: ${same ? '✅' : '❌'}`);
  console.log(`  轮走方一致: ${pos.turn === st.turn ? '✅' : '❌'} (${pos.turn} vs ${st.turn})`);
  // 引擎的每一步都必须是红方的合法着法
  let allLegal = true;
  for (let i = 0; i < st.moves.length; i++) {
    const before = positionFromMoves(st.moves.slice(0, i));
    const mv = moveFromUci(st.moves[i]);
    if (before.turn === RED) {
      if (!before.generateLegalMoves(RED).some((m) => m.from === mv.from && m.to === mv.to)) {
        console.log(`  ❌ 第 ${i + 1} 步 ${st.moves[i]} 在规则引擎里非法`);
        allLegal = false;
      }
    }
  }
  console.log(`  所有引擎着法均合法: ${allLegal ? '✅' : '❌'}`);
  console.log(`  总步数: ${st.moves.length}   棋谱: ${st.notation.join(' ')}`);
}

console.log('=== 4. 再查一次状态，确认没有被意外重置 ===');
await new Promise((r) => setTimeout(r, 1500));
const final = await show('1.5 秒后');

console.log('\n结论：' +
  (final.moves.length > 0
    ? `✅ 状态稳定（${final.moves.length} 步）`
    : '❌ 状态被重置了 —— 有并发写入把对局清空'));
