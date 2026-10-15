/**
 * 规则引擎测试。重点是四类"中国特色"规则和胜负判定。
 * 用 perft（走法树计数）对标准答案，这是验证走法生成最硬的手段。
 */
import {
  Position, START_FEN_BOARD, RED, BLACK, idx, fileOf, rankOf,
  moveToUci, moveFromUci, toEngineSquare, fromEngineSquare,
  positionFromMoves, validateMove, CELLS,
} from '../lib/board.js';

const pass = [];
const fail = [];
const ok = (name, cond, extra) => (cond ? pass.push(name) : fail.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')));
const eq = (name, got, want) => ok(name, got === want, { got, want });

/** 用 90 字符棋盘串 + 轮走方构造局面 */
function pos(board, turn = RED) {
  const p = new Position(board);
  p.turn = turn;
  return p;
}
/** 从一个"稀疏描述"建局面：{ 'e0': 'k', 'e9': 'K' } 这类 */
function fromPieces(pieces, turn = RED) {
  const b = new Array(CELLS).fill('.');
  for (const [sq, p] of Object.entries(pieces)) {
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]);
    b[idx(f, r)] = p;
  }
  return pos(b.join(''), turn);
}
const hasMove = (p, fromSq, toSq) => {
  const from = idx(fromSq.charCodeAt(0) - 97, Number(fromSq[1]));
  const to = idx(toSq.charCodeAt(0) - 97, Number(toSq[1]));
  return p.generateLegalMoves(p.turn).some((m) => m.from === from && m.to === to);
};

// ---------------------------------------------------------------- 1. 起始局面
{
  const p = new Position();
  eq('开局红方走法数', p.generateLegalMoves(RED).length, 44);
  eq('开局黑方走法数', p.generateLegalMoves(BLACK).length, 44);
  eq('开局轮到红方', p.turn, RED);
  eq('棋子总数', p.board.filter((c) => c !== '.').length, 32);
  eq('FEN 往返', p.toFen().split(' ')[0], 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR');
}

// ---------------------------------------------------------------- 2. 马蹩腿
{
  // 马在 e4，四周无阻挡 → 8 个落点
  const free = fromPieces({ e0: 'k', e8: 'K', e4: 'N' }, RED);
  const nMoves = free.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 4));
  eq('马无阻挡有 8 个着法', nMoves.length, 8);

  // 马腿正上方（e5）有子 → 向上的两个着法被蹩掉
  const blockedUp = fromPieces({ e0: 'k', e8: 'K', e4: 'N', e5: 'P' }, RED);
  const up = blockedUp.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 4));
  eq('蹩上方马腿后剩 6 个', up.length, 6);
  ok('蹩腿后不能到 d6', !up.some((m) => m.to === idx(3, 6)));
  ok('蹩腿后不能到 f6', !up.some((m) => m.to === idx(5, 6)));
  ok('蹩腿后仍能到 d2', up.some((m) => m.to === idx(3, 2)));

  // 马腿在左侧（d4）有子 → 向左的两个着法被蹩
  const blockedLeft = fromPieces({ e0: 'k', e8: 'K', e4: 'N', d4: 'P' }, RED);
  const left = blockedLeft.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 4));
  eq('蹩左侧马腿后剩 6 个', left.length, 6);
  ok('蹩腿后不能到 c3', !left.some((m) => m.to === idx(2, 3)));
  ok('蹩腿后不能到 c5', !left.some((m) => m.to === idx(2, 5)));
}

// ---------------------------------------------------------------- 3. 象塞眼 + 不过河
{
  // 红象放在红方半场（rank >= 5）：c7 的田字目标是 a5/e5（都在己半场，合法）
  const p = fromPieces({ d0: 'k', e9: 'K', c7: 'B' }, RED);
  const bm = p.generatePseudoMoves(RED).filter((m) => m.from === idx(2, 7));
  eq('象在 c7 有 3 个着法（a9/a5/e5，过河的 c3/g3 被禁）', bm.length, 3);
  ok('象能到 a5', bm.some((m) => m.to === idx(0, 5)));
  ok('象能到 e5', bm.some((m) => m.to === idx(4, 5)));

  // 塞象眼：c7→a5 的象眼是 b6
  const p2 = fromPieces({ d0: 'k', e9: 'K', c7: 'B', b6: 'P' }, RED);
  const bm2 = p2.generatePseudoMoves(RED).filter((m) => m.from === idx(2, 7));
  eq('塞象眼（b6）后剩 2 个', bm2.length, 2);
  ok('塞眼后不能到 a5', !bm2.some((m) => m.to === idx(0, 5)));
  ok('塞眼后仍能到 e5', bm2.some((m) => m.to === idx(4, 5)));
  ok('塞眼后仍能到 a9', bm2.some((m) => m.to === idx(0, 9)));

  // 象不能过河：红象在 e5，田字目标是 c3/c7/g3/g7 —— c3/g3 在敌半场
  const p3 = fromPieces({ d0: 'k', e9: 'K', e5: 'B' }, RED);
  const bm3 = p3.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 5));
  eq('象过河目标被禁止', bm3.length, 2);
  ok('象不能到 c3（敌半场）', !bm3.some((m) => m.to === idx(2, 3)));
  ok('象能到 c7（己半场）', bm3.some((m) => m.to === idx(2, 7)));
}

// ---------------------------------------------------------------- 4. 炮翻山
{
  // 炮 e4，同一行有 e2 炮架、e0 敌车 → 可吃 e0
  const p = fromPieces({ e9: 'K', e0: 'r', e4: 'C', e2: 'P' }, RED);
  const cm = p.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 4));
  ok('炮能隔子吃 e0 的车', cm.some((m) => m.to === idx(4, 0)), cm.map((m) => moveToUci(m)));
  // 中间没有炮架时不能吃
  const p2 = fromPieces({ e9: 'K', e0: 'r', e4: 'C' }, RED);
  const cm2 = p2.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 4));
  ok('无炮架不能吃 e0', !cm2.some((m) => m.to === idx(4, 0)));
  ok('无炮架仍能走空位 e1', cm2.some((m) => m.to === idx(4, 1)));
  // 隔两个子不能吃
  const p3 = fromPieces({ e9: 'K', e0: 'r', e1: 'P', e2: 'P', e4: 'C' }, RED);
  const cm3 = p3.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 4));
  ok('隔两子不能吃', !cm3.some((m) => m.to === idx(4, 0)));
}

// ---------------------------------------------------------------- 5. 兵卒
{
  // 红兵未过河（rank 6）：只能向前
  const p = fromPieces({ e0: 'k', e9: 'K', e6: 'P' }, RED);
  const pm = p.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 6));
  eq('未过河红兵只有 1 个着法', pm.length, 1);
  ok('红兵向上（rank 减小）', pm[0].to === idx(4, 5));

  // 红兵已过河（rank 4）：可向前 + 左右
  const p2 = fromPieces({ e0: 'k', e9: 'K', e4: 'P' }, RED);
  const pm2 = p2.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 4));
  eq('过河红兵有 3 个着法', pm2.length, 3);
  ok('过河红兵不能后退', !pm2.some((m) => m.to === idx(4, 5)));
}

// ---------------------------------------------------------------- 6. 士与将的九宫
{
  const p = fromPieces({ e0: 'k', e9: 'K', d9: 'A' }, RED);
  const am = p.generatePseudoMoves(RED).filter((m) => m.from === idx(3, 9));
  eq('士在 d9（九宫角）只有 1 个着法', am.length, 1);
  ok('士只能回 e8', am[0].to === idx(4, 8));

  // 将不能出九宫
  const p2 = fromPieces({ e0: 'k', e9: 'K' }, RED);
  const km = p2.generatePseudoMoves(RED).filter((m) => m.from === idx(4, 9));
  eq('将帅在 e9 有 3 个着法（九宫内）', km.length, 3);
  ok('将不能到 d9 之外', km.every((m) => rankOf(m.to) >= 7 && fileOf(m.to) >= 3 && fileOf(m.to) <= 5));
}

// ---------------------------------------------------------------- 7. 飞将（将帅照面）
{
  // 红帅 e9，黑将 e0，中间无子 → 照面，红方任何走法都不能让这局面持续
  const face = fromPieces({ e0: 'k', e9: 'K' }, RED);
  ok('中间无子判为照面', face.kingsFaceEachOther());

  const blocked = fromPieces({ e0: 'k', e9: 'K', e5: 'P' }, RED);
  ok('中间有子不算照面', !blocked.kingsFaceEachOther());

  // 照面时，红方不能走到"让照面持续"的着法。这里红帅只能左右挪开
  const moves = face.generateLegalMoves(RED);
  ok('照面时红方仍有合法着法', moves.length > 0);
  ok('照面时红帅不能往前走（仍照面）', !moves.some((m) => m.to === idx(4, 8)));
}

// ---------------------------------------------------------------- 8. 将军检测
{
  // 黑车 e1 将军红帅 e9？中间无子 → 是将军
  const p = fromPieces({ d0: 'k', e9: 'K', e1: 'r' }, RED);
  ok('车直线将军被识别', p.isInCheck(RED));
  const p2 = fromPieces({ d0: 'k', e9: 'K', e1: 'r', e5: 'P' }, RED);
  ok('有子挡住不算将军', !p2.isInCheck(RED));

  // 炮将军：需要炮架
  const p3 = fromPieces({ d0: 'k', e9: 'K', e1: 'c', e5: 'P' }, RED);
  ok('炮隔子将军被识别', p3.isInCheck(RED));
  const p4 = fromPieces({ d0: 'k', e9: 'K', e1: 'c' }, RED);
  ok('炮无架不算将军', !p4.isInCheck(RED));

  // 马将军（带蹩腿判断）
  // 关键几何：能攻击红帅 e9 的马位**只有 d7 与 f7**（马从 d7 跳到 e9 是"横 1 纵 2"）。
  // 马腿在 d8 —— 这个真值是引擎实测确认的，不是我推的。
  const p5 = fromPieces({ a0: 'k', e9: 'K', d7: 'n' }, RED);
  ok('马将军被识别（马腿 d8 为空）', p5.isInCheck(RED));
  const p6 = fromPieces({ a0: 'k', e9: 'K', d7: 'n', d8: 'P' }, RED);
  ok('马腿被蹩则不算将军', !p6.isInCheck(RED));
  // c7 不是这条腿，在那里放子不该影响判定
  const p7 = fromPieces({ a0: 'k', e9: 'K', d7: 'n', c7: 'P' }, RED);
  ok('非马腿位置放子不影响将军判定', p7.isInCheck(RED));
  // 对称位置 f7，马腿在 f8
  const p8 = fromPieces({ a0: 'k', e9: 'K', f7: 'n' }, RED);
  ok('马从 f7 将军同样识别', p8.isInCheck(RED));
  const p9 = fromPieces({ a0: 'k', e9: 'K', f7: 'n', f8: 'P' }, RED);
  ok('f8 被占则该马将军失效', !p9.isInCheck(RED));
}

// ---------------------------------------------------------------- 8b. 兵的横吃边界（评审发现的漏判）
{
  // 红帅恰好站在**河沿 rank 5**，黑卒也在同一排 → 黑卒已过河（rank>=5），可以横吃。
  // 这一条是被代码评审指出来的：原实现用"将是否在己方半场"判断，在 kr==5 时会漏判。
  const onRiver = fromPieces({ a0: 'k', e5: 'K', d5: 'p' }, RED);
  ok('河沿上的红帅被同排黑卒横吃（kr=5 边界）', onRiver.isInCheck(RED), `kr=${rankOf(onRiver.kingIndex(RED))}`);
  // 换到另一侧
  const onRiver2 = fromPieces({ a0: 'k', e5: 'K', f5: 'p' }, RED);
  ok('河沿上的红帅被右侧黑卒横吃', onRiver2.isInCheck(RED));
  // 红帅在 rank 6（己方半场深处），黑卒在 rank 6 也意味着已过河 → 同样可横吃
  const deeper = fromPieces({ a0: 'k', e6: 'K', d6: 'p' }, RED);
  ok('rank 6 的红帅被同排黑卒横吃', deeper.isInCheck(RED));
  // 但红兵未过河（rank>=5）在同一排不能横吃黑将
  const redPawnHome = fromPieces({ a0: 'k', e6: 'K', d6: 'P' }, RED);
  ok('未过河的红兵不能横吃（不是将军）', !redPawnHome.isInCheck(RED));
  // 红兵已过河（rank<=4）与黑将同排 → 可横吃
  const redPawnCrossed = fromPieces({ e4: 'k', a9: 'K', d4: 'P' }, BLACK);
  ok('过河红兵可横吃黑将', redPawnCrossed.isInCheck(BLACK));
  // 黑卒向前吃将（正上方一排）
  const forward = fromPieces({ a0: 'k', e6: 'K', e5: 'p' }, RED);
  ok('黑卒向前攻击红帅被识别', forward.isInCheck(RED));
}

// ---------------------------------------------------------------- 9. 将死 / 困毙
{
  // 经典杀型：红方孤帅在 e9，黑方双车封住 d 线与 f 线，e1 车贴脸将军。
  // 关键：**两条逃路都要被覆盖**。只放一辆车时红帅还有 e9f9 可逃 —— 这是实测出来的，
  // 一开始我漏了这条竖线，测试才误报"将死判定失败"。
  const m = new Array(CELLS).fill('.');
  m[idx(3, 0)] = 'k';    // 黑将 d0（刻意与红帅错开列，否则飞将会污染判定）
  m[idx(4, 9)] = 'K';    // 红帅 e9（孤子）
    m[idx(5, 0)] = 'r';    // 黑车 f0 → 封 f 线
  m[idx(4, 1)] = 'r';    // 黑车 e1 → 将军
  const mateSet = pos(m.join(''), RED);
  ok('该局面红方被将军', mateSet.isInCheck(RED));
  ok('红方无合法着法', mateSet.hasNoLegalMove(RED));
  const st = mateSet.status();
  eq('判定为将死', st.over, true);
  eq('胜方是黑方', st.winner, BLACK);
  ok('原因标注为 checkmate', st.reason === 'checkmate', st.reason);

  // 对照组：抽掉 f 线那辆车，红帅就有 e9f9 逃路，不应判将死
  const m2 = m.slice();
  m2[idx(5, 0)] = '.';
  const escape = pos(m2.join(''), RED);
  ok('少一辆车时红方有逃路', !escape.hasNoLegalMove(RED));
  eq('此时不判将死', escape.status().over, false);
}

// ---------------------------------------------------------------- 10. 悔棋的撤销正确性
{
  const p = new Position();
  const before = p.board.join('');
  // 红炮在 h3（rank 0 是黑方底线，红方底线是 rank 9）
  const mv = p.generateLegalMoves(RED).find((m) => moveToUci(m) === 'h2e2');
  ok('开局有炮二平五着法（引擎坐标 h2e2，内部 rank7→rank2）', Boolean(mv));
  const cap = p.makeMove(mv);
  const after = p.board.join('');
  ok('走子后局面改变', before !== after);
  p.undoMove(mv, cap);
  eq('撤销后局面复原', p.board.join(''), before);
  eq('撤销后轮到红方', p.turn, RED);
}

// ---------------------------------------------------------------- 11. 由走子序列重建局面
{
  const seq = ['h2e2', 'h9g7', 'h0g2', 'b9c7'];
  const p = positionFromMoves(seq);
  ok('4 步后轮到红方', p.turn === RED);
  eq('4 步后子数不变（无吃子）', p.board.filter((c) => c !== '.').length, 32);
  // 验证 h3 已空、e3 有红炮
  eq('原位置已空', p.board[idx(7, 7)], '.');
  eq('目标位置是红炮', p.board[idx(4, 7)], 'C');
}

// ---------------------------------------------------------------- 12. perft（走法树计数）
{
  const perft = (p, depth) => {
    if (depth === 0) return 1;
    let nodes = 0;
    for (const mv of p.generateLegalMoves(p.turn)) {
      const cap = p.makeMove(mv);
      nodes += perft(p, depth - 1);
      p.undoMove(mv, cap);
    }
    return nodes;
  };
  const p = new Position();
  const d1 = perft(p, 1);
  const d2 = perft(p, 2);
  const d3 = perft(p, 3);
  console.log(`  perft(1)=${d1}  perft(2)=${d2}  perft(3)=${d3}`);
  eq('perft(1) = 44', d1, 44);
  eq('perft(2) = 1920', d2, 1920);
  eq('perft(3) = 79666', d3, 79666);
}

// ---------------------------------------------------------------- 13. 非法着法拒绝
{
  const p = new Position();
  // 红方想走黑方的子（车在 a0）
  const r1 = validateMove(p, idx(0, 0), idx(0, 1));
  ok('不能动对方的子', !r1.ok, r1.reason);
  // 红方想把兵往回走
  const r2 = validateMove(p, idx(0, 6), idx(0, 7));
  ok('红兵不能后退', !r2.ok, r2.reason);
  // 合法的炮二平五（h3 → e3）
  const r3 = validateMove(p, idx(7, 7), idx(4, 7));
  ok('合法的炮二平五被接受', r3.ok, r3.reason);
}

// ---------------------------------------------------------------- 14. 坐标映射（引擎 rank 与内部 rank 相反）
{
  // 这是实测确认的约定：内部 rank 0 在顶部（黑方底线），
  // 引擎 UCI 的 rank 0 在底部（红方底线）。两者 rank 相加恒为 9。
  const p = new Position();
  const h7 = idx(7, 7);            // 内部：红炮在 h7
  eq('内部 h7 → 引擎 h2', toEngineSquare(h7), 'h2');
  eq('引擎 h2 → 内部 h7', fromEngineSquare('h2'), h7);
  eq('内部 rank 与实际棋子一致（h7 上是红炮）', p.board[h7], 'C');
  eq('引擎说 rank2 是红炮位（映射后一致）', p.board[fromEngineSquare('h2')], 'C');

  // 往返一致性：所有 90 格
  let roundTripOk = true;
  for (let i = 0; i < CELLS; i++) {
    if (fromEngineSquare(toEngineSquare(i)) !== i) { roundTripOk = false; break; }
  }
  ok('90 格 UCI 坐标往返全部一致', roundTripOk);

  // 炮二平五：内部 h7→e7，引擎坐标必须是 h2e2（引擎实测给的就是这个）
  eq('炮二平五的引擎坐标是 h2e2', moveToUci({ from: h7, to: idx(4, 7) }), 'h2e2');
  // 反向：引擎的 h2e2 解回内部应是 h7→e7
  const back = moveFromUci('h2e2');
  eq('引擎 h2e2 解回内部起点', back.from, h7);
  eq('引擎 h2e2 解回内部终点', back.to, idx(4, 7));

  // 回归：引擎实测着法必须在我的规则引擎里合法
  const legalNow = p.generateLegalMoves(RED).map(moveToUci);
  ok('引擎实测着法 h2e2 在规则引擎里合法', legalNow.includes('h2e2'), legalNow.slice(0, 6));
}

// ---------------------------------------------------------------- 输出
console.log('\n========================================');
console.log(`  通过 ${pass.length}   失败 ${fail.length}`);
if (fail.length) {
  console.log('\n失败项：');
  fail.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('  ✅ 全部通过');
}
