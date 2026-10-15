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
  // 轮走方不能只靠"重放 moves"推导 —— 黑方先走模式下奇偶关系是反的
  // （第 1 步是黑棋抢走，走完仍该红方）。所以这里按模式算期望值。
  const odd = state.moves.length % 2 === 1;
  const blackFirstActive = state.blackFirst && state.moves.length > 0;
  const expectTurn = blackFirstActive ? (odd ? 'red' : 'black') : (odd ? 'black' : 'red');
  eq(`${label}：轮走方一致`, state.turn, expectTurn);
  eq(`${label}：棋谱数与走子数一致`, state.notation.length, state.moves.length);
}

async function main() {
  // ---- 重置到干净开局 ----
  await api('/api/new', {});
  let s = (await api('/api/state')).data;
  eq('开局无走子', s.moves.length, 0);
  eq('开局轮到红方', s.turn, RED);
  ok('引擎就绪', s.engineReady, s.engineError);
  verifyConsistency('开局', s);

  // ---- 语义验证：开局是红方回合，用户不能替黑方先走 ----
  // （产品设计：引擎恒执红、红先。用户执黑，所以开局应先让引擎走，见下。）
  const illegalFirst = await api('/api/move', { from: idx(2, 3), to: idx(2, 4) });
  ok('开局替黑方走子被拒绝（还没轮到黑方）', illegalFirst.status === 400, illegalFirst.status);

  // ---- 用户"代走红方"：三段式完整验证 ----
  // 语义验证（当前设计）：用户**不能**替红方代走。
  // 早先版本允许"代走红方"，后来被明确的「切换到黑方先走」按钮取代 ——
  // 因为代走会让引擎的红方与用户交错走子，语义含混。现在红方一律归引擎。
  const redProxy = { from: idx(0, 9), to: idx(0, 8) };   // 红车九进一（a9→a8）
  let r = await api('/api/move', redProxy);
  ok('① 开局不能替红方代走', r.status === 400, r.status);
  s = (await api('/api/state')).data;
  eq('① 被拒后局面未变', s.moves.length, 0, s.moves);
  eq('① 仍是红方回合', s.turn, RED);

  // 黑方先走模式的完整验证见文件后半部分。
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

  // ---- 悔棋：应回到"轮到黑方"的状态，且局面与走子序列重新一致 ----
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

  // ---- 两个"谁先走"接口都只在开局可用 ----
  const again = await api('/api/engine-first', {});
  ok('非开局时 切换到黑方先走 被拒绝', again.status === 400, again.status);
  const againRed = await api('/api/red-first', {});
  ok('非开局时 让引擎先走 被拒绝', againRed.status === 400, againRed.status);

  // ---- 黑方先走模式（用户要求：按一下按钮切过来，引擎原地不动）----
  // 语义：① 切换后引擎**不动**、仍是 0 步
  //       ② 此时用户可以走黑棋（虽然局面记的是红方回合）
  //       ③ 用户走完黑方第一步，引擎立刻接管红方应手
  await api('/api/new', {});
  r = await api('/api/engine-first', {});
  ok('① 切换到黑方先走成功', r.status === 200, r.data.error);
  s = r.data.state;
  eq('① 切换后引擎不动（仍是 0 步）', s.moves.length, 0, s.moves);
  ok('① 状态里 blackFirst 已置位', s.blackFirst === true, s.blackFirst);
  ok('① 状态里标记了"用户可以走子"', s.canUserMove === true, s.canUserMove);
  eq('① 局面仍记红方回合（引擎的红方未动）', s.turn, RED);

  // ② 用户走黑方第一步。注意这步用黑方着法生成器校验
  const bfMove = { from: idx(2, 3), to: idx(2, 4) };   // 黑卒 3 进 1
  r = await api('/api/move', bfMove);
  ok('② 黑方先走模式下可以走黑棋', r.status === 200, r.data.error);
  s = r.data.state;
  eq('② 走完后共 2 步（用户 1 + 引擎应手 1）', s.moves.length, 2, s.moves);
  eq('② 第 1 步是用户走的黑棋', s.moves[0], moveToUci(bfMove));
  ok('② 第 2 步是引擎应答的红棋', /^[a-i][0-9][a-i][0-9]$/.test(s.moves[1]), s.moves[1]);
  eq('② 引擎应手后轮到黑方（用户）', s.turn, BLACK);
  verifyConsistency('② 黑方先走后', s);

  // ③ 引擎那一步必须是"黑方已走第一步"之后红方的合法着法
  const posAfterBF = positionFromMoves([moveToUci(bfMove)]);
  const legalRedBF = posAfterBF.generateLegalMoves(RED).map(moveToUci);
  ok(`③ 引擎应手 ${s.moves[1]} 合法`, legalRedBF.includes(s.moves[1]), legalRedBF.slice(0, 5));

  // ④ 走子后不能再切换（按钮只该在开局可用）
  const lateSwitch = await api('/api/engine-first', {});
  ok('④ 走过棋之后切换被拒绝', lateSwitch.status === 400, lateSwitch.status);

  // ⑤ 未开模式时，红方回合用户不能走黑棋
  await api('/api/new', {});
  const noMode = await api('/api/move', { from: idx(2, 3), to: idx(2, 4) });
  ok('⑤ 未开黑方先走模式时替黑方走子被拒', noMode.status === 400, noMode.status);

  // ⑥ 重新开始必须清掉黑方先走模式
  await api('/api/engine-first', {});
  await api('/api/new', {});
  s = (await api('/api/state')).data;
  ok('⑥ 重新开始后 blackFirst 被清掉', s.blackFirst === false, s.blackFirst);
  ok('⑥ 重新开始后回到红方回合、用户不能走', s.canUserMove === false, s.canUserMove);

  // ---- 清理 ----
  await api('/api/new', {});

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
