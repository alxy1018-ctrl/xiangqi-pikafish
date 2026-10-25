/**
 * 端到端对局测试：直接打 HTTP API，模拟真实操作顺序。
 * 验证的是"用户能不能真的下起来"，而不是单个函数是否正确。
 */
import { moveToUci, positionFromMoves, RED, BLACK, idx } from '../lib/board.js';

const BASE = `http://127.0.0.1:${process.env.XQ_PORT ?? 19390}`;
const pass = [], fail = [];
const ok = (n, c, x) => (c ? pass.push(n) : fail.push(n + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')));
const eq = (n, g, w) => ok(n, g === w, { got: g, want: w });

async function api(path, body) {
  const r = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

// 每一步都独立用规则引擎复核，确认服务返回的局面与走子序列一致
function verifyConsistency(label, state) {
  const pos = positionFromMoves(state.moves);
  eq(`${label}：局面与走子序列一致`, pos.board.join(''), state.board);
  // 红方永远先行，走子序列严格交替：奇数步后轮到黑方，偶数步后轮到红方。
  const expectTurn = state.moves.length % 2 === 1 ? BLACK : RED;
  eq(`${label}：轮走方一致`, state.turn, expectTurn);
  eq(`${label}：棋谱数与走子数一致`, state.notation.length, state.moves.length);
  ok(`${label}：userColor 合法`, state.userColor === RED || state.userColor === BLACK, state.userColor);
}

/** 把服务端的执子切到指定一方（只允许在开局调用；测试用于消除上一条用例的残留状态）。 */
async function ensureUserColor(color) {
  const s = (await api('/api/state')).data;
  if (s.moves.length) throw new Error('ensureUserColor 需要开局局面');
  if (s.userColor === color) return s;
  const r = await api('/api/swap-sides', {});
  if (r.status !== 200) throw new Error('换边失败：' + (r.data.error ?? r.status));
  return r.data.state;
}

async function main() {
  // ---- 重置到干净开局 ----
  await api('/api/new', {});
  let s = await ensureUserColor(BLACK);   // 服务可能是别人用过的，先确保默认执黑
  eq('开局无走子', s.moves.length, 0);
  eq('开局轮到红方', s.turn, RED);
  eq('开局默认用户执黑', s.userColor, BLACK);
  ok('引擎就绪', s.engineReady, s.engineError);
  verifyConsistency('开局', s);

  // ---- 语义验证：开局是红方回合，用户执黑时不能先动黑棋 ----
  const illegalFirst = await api('/api/move', { from: idx(2, 3), to: idx(2, 4) });
  ok('开局替黑方走子被拒绝（还没轮到黑方）', illegalFirst.status === 400, illegalFirst.status);

  // ---- 用户执黑时不能动红方（红方归引擎）----
  const redProxy = { from: idx(0, 9), to: idx(0, 8) };   // 红车九进一（a9→a8）
  let r = await api('/api/move', redProxy);
  ok('① 用户执黑时不能动红方', r.status === 400, r.status);
  s = (await api('/api/state')).data;
  eq('① 被拒后局面未变', s.moves.length, 0, s.moves);
  eq('① 仍是红方回合', s.turn, RED);

  // 换边后的完整验证见文件后半部分。
  await api('/api/new', {});   // 复位，下面按正常流程测

  // ---- 正常流程：让引擎（红方）先走 ----
  r = await api('/api/red-first', {});
  ok('让引擎先走成功', r.status === 200, r.data.error);
  s = r.data.state;
  eq('引擎先走后有 1 步', s.moves.length, 1, s.moves);
  eq('引擎先走后轮到黑方', s.turn, BLACK);
  verifyConsistency('引擎先走后', s);

  // ---- 用户执黑走一手，引擎应以红方应答 ----
  const blackMove = { from: idx(2, 3), to: idx(2, 4) };   // 黑卒 7 进 1
  const blackUci = moveToUci(blackMove);
  eq('黑卒这步的引擎坐标是 c6c5', blackUci, 'c6c5');

  r = await api('/api/move', blackMove);
  ok('黑方走子被接受', r.status === 200, r.data.error);
  s = r.data.state;
  eq('走完后有 3 步（引擎 1 + 用户 1 + 引擎应答 1）', s.moves.length, 3, s.moves);
  eq('第 2 步是用户走的', s.moves[1], 'c6c5');
  ok('第 3 步是引擎应答', /^[a-i][0-9][a-i][0-9]$/.test(s.moves[2]), s.moves[2]);
  eq('引擎应答后轮到黑方（用户）', s.turn, BLACK);
  verifyConsistency('用户走黑后', s);
  ok('棋谱有中文记谱', s.notation[1] && s.notation[1].length >= 3, s.notation);

  // ---- 引擎的着法必须合法：用规则引擎独立复核 ----
  const posAfterBlack = positionFromMoves([s.moves[0], blackUci]);
  const legalRed = posAfterBlack.generateLegalMoves(RED).map(moveToUci);
  ok(`引擎应答 ${s.moves[2]} 合法`, legalRed.includes(s.moves[2]), legalRed.slice(0, 5));

  // ---- 再来一个回合，确认交替稳定 ----
  const blackMove2 = { from: idx(6, 3), to: idx(6, 4) };   // 黑卒 3 进 1
  r = await api('/api/move', blackMove2);
  ok('第二回合走子被接受', r.status === 200, r.data.error);
  s = r.data.state;
  eq('第二回合后有 5 步', s.moves.length, 5, s.moves);
  eq('仍轮到黑方', s.turn, BLACK);
  verifyConsistency('第二回合后', s);

  // ---- 分析面板：必须返回可用的评估与候选着法 ----
  r = await api('/api/analyze', { movetime: 800 });
  ok('分析请求成功', r.status === 200, r.data.error);
  const a = r.data.state.analysis;
  ok('分析返回了结果', Boolean(a), a);
  if (a) {
    ok('有搜索深度', typeof a.depth === 'number' && a.depth > 0, a.depth);
    ok('有评估分或杀棋分', a.scoreCp !== null || a.scoreMate !== null, { cp: a.scoreCp, mate: a.scoreMate });
    ok('有候选着法列表', Array.isArray(a.candidates) && a.candidates.length > 0, a.candidates?.length);
    ok('候选着法是合法格式', /^[a-i][0-9][a-i][0-9]$/.test(a.candidates[0].uci), a.candidates[0].uci);
    ok('候选着法带评分', a.candidates[0].scoreCp !== null || a.candidates[0].scoreMate !== null);
    ok('有节点数', typeof a.nodes === 'number' && a.nodes > 0, a.nodes);
  }

  // ---- 非法着法必须被拒绝 ----
  const pos = positionFromMoves(s.moves);
  // 现在轮到黑方；找一个红方棋子的位置，动它应被拒绝
  const redPieceIdx = pos.board.findIndex((p) => p === 'R');
  const bad = await api('/api/move', { from: redPieceIdx, to: redPieceIdx - 9 });
  ok('轮黑方时动红方的子被拒绝', bad.status === 400, bad.status);
  // 越界索引
  const oob = await api('/api/move', { from: 999, to: 0 });
  ok('越界索引被拒绝', oob.status === 400, oob.status);
  // 空格起点
  const emptyFrom = pos.board.findIndex((p) => p === '.');
  const fromEmpty = await api('/api/move', { from: emptyFrom, to: emptyFrom });
  ok('从空格起手被拒绝', fromEmpty.status === 400, fromEmpty.status);

  // ---- 悔棋：应回到"轮到用户"的状态，且局面与走子序列重新一致 ----
  const beforeUndo = (await api('/api/state')).data;
  const movesBefore = beforeUndo.moves.length;
  r = await api('/api/undo', {});
  ok('悔棋成功', r.status === 200, r.data.error);
  s = r.data.state;
  ok('悔棋后步数减少', s.moves.length < movesBefore, { before: movesBefore, after: s.moves.length });
  eq('悔棋后轮到黑方（用户）', s.turn, BLACK);
  verifyConsistency('悔棋后', s);

  // ---- 难度切换 ----
  r = await api('/api/level', { level: 6 });
  ok('切换难度成功', r.status === 200, r.data.error);
  eq('难度已生效', r.data.state.level, 6);
  const badLv = await api('/api/level', { level: 99 });
  ok('无效难度被拒绝', badLv.status === 400, badLv.status);
  // 高难度下引擎仍能应手（验证 setLevel 真的生效而不是把引擎搞挂）
  const hiMove = { from: idx(0, 3), to: idx(0, 4) };      // 黑卒 9 进 1
  r = await api('/api/move', hiMove);
  ok('满级难度下引擎仍能应手', r.status === 200 && r.data.state.moves.length >= 3, r.data.error ?? r.data.state?.moves?.length);
  await api('/api/level', { level: 3 });

  // ---- 「换边」「让引擎先走」都只在开局可用 ----
  const againSwap = await api('/api/swap-sides', {});
  ok('非开局时换边被拒绝', againSwap.status === 400, againSwap.status);
  const againRed = await api('/api/red-first', {});
  ok('非开局时 让引擎先走 被拒绝', againRed.status === 400, againRed.status);

  // ---- 换边（用户要求：开局可以选执红，红方先行；引擎执黑应手）----
  await api('/api/new', {});
  await ensureUserColor(BLACK);
  r = await api('/api/swap-sides', {});
  ok('① 开局换边成功', r.status === 200, r.data.error);
  s = r.data.state;
  eq('① 换边后用户执红', s.userColor, RED);
  eq('① 换边后仍是 0 步', s.moves.length, 0, s.moves);
  eq('① 红方先行、轮到红方', s.turn, RED);
  ok('① 用户可以立刻走红棋', s.canUserMove === true, s.canUserMove);
  ok('① 换边本身不让引擎先走', s.thinking === false, s.thinking);

  // ① 用户执红走第一步；引擎必须以黑方应手。
  const redMove = positionFromMoves([]).generateLegalMoves(RED)[0];
  const redUci = moveToUci(redMove);
  r = await api('/api/move', { from: redMove.from, to: redMove.to });
  ok('② 用户执红走子被接受', r.status === 200, r.data.error);
  s = r.data.state;
  eq('② 走完后共 2 步（用户 1 + 引擎应手 1）', s.moves.length, 2, s.moves);
  eq('② 第 1 步是用户走的红棋', s.moves[0], redUci);
  ok('② 第 2 步是引擎应答的黑棋', /^[a-i][0-9][a-i][0-9]$/.test(s.moves[1]), s.moves[1]);
  eq('② 引擎应手后轮到红方（用户）', s.turn, RED);
  eq('② 用户仍执红', s.userColor, RED);
  verifyConsistency('② 用户执红后', s);
  const legalBlack = positionFromMoves([redUci]).generateLegalMoves(BLACK).map(moveToUci);
  ok(`② 引擎应答 ${s.moves[1]} 是黑方的合法着法`, legalBlack.includes(s.moves[1]), legalBlack.slice(0, 5));

  // ③ 走过棋之后不能再换边
  const lateSwap = await api('/api/swap-sides', {});
  ok('③ 走过棋之后换边被拒绝', lateSwap.status === 400, lateSwap.status);

  // ④ 「重新开始」保留执子；执红时不需要（也不允许）让引擎先走
  await api('/api/new', {});
  s = (await api('/api/state')).data;
  eq('④ 重新开始保留执红', s.userColor, RED);
  eq('④ 重新开始后轮到红方（用户）', s.turn, RED);
  ok('④ 重新开始后用户可以直接走', s.canUserMove === true, s.canUserMove);
  const redFirstOnRed = await api('/api/red-first', {});
  ok('④ 执红时「让引擎先走」被拒绝', redFirstOnRed.status === 400, redFirstOnRed.status);

  // ⑤ 换回执黑：红方仍是引擎，要按「让引擎先走」才能开局
  r = await api('/api/swap-sides', {});
  ok('⑤ 换回执黑成功', r.status === 200, r.data.error);
  s = r.data.state;
  eq('⑤ 换回后用户执黑', s.userColor, BLACK);
  eq('⑤ 换回后轮到红方', s.turn, RED);
  ok('⑤ 换回后用户不能直接走', s.canUserMove === false, s.canUserMove);
  const engineStarts = await api('/api/red-first', {});
  ok('⑤ 让引擎先走成功', engineStarts.status === 200, engineStarts.data.error);
  s = engineStarts.data.state;
  eq('⑤ 引擎先走后轮到黑方（用户）', s.turn, BLACK);
  verifyConsistency('⑤ 引擎先走后', s);

  // ⑥ 执红时悔棋也退回"用户该走"的红方回合
  await api('/api/new', {});
  await ensureUserColor(RED);
  const undoRedMove = positionFromMoves([]).generateLegalMoves(RED)[0];
  r = await api('/api/move', { from: undoRedMove.from, to: undoRedMove.to });
  ok('⑥ 执红走子成功', r.status === 200, r.data.error);
  r = await api('/api/undo', {});
  s = r.data.state;
  eq('⑥ 悔棋后步数回到 0', s.moves.length, 0, s.moves);
  eq('⑥ 悔棋后轮到红方', s.turn, RED);
  eq('⑥ 悔棋后仍执红', s.userColor, RED);
  ok('⑥ 悔棋后用户可以继续走', s.canUserMove === true, s.canUserMove);

  // ---- 清理：回到默认执黑的干净开局 ----
  await api('/api/new', {});
  await ensureUserColor(BLACK);

  console.log('\n========================================');
  console.log(`  通过 ${pass.length}   失败 ${fail.length}`);
  if (fail.length) {
    console.log('\n失败项：');
    fail.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  } else {
    console.log('  ✅ 全部通过');
  }
}

main().catch((e) => {
  console.error('测试整体失败：' + e.message);
  process.exit(1);
});
