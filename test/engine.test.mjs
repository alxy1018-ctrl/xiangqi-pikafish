/**
 * 引擎封装测试：验证启动、配置、搜索、超时、清理。
 * 这个测试会真的拉起 Pikafish 子进程并让它搜索，约需 10-20 秒。
 */
import { UciEngine, parseInfo, LEVELS } from '../lib/engine.js';
import { Position, RED, moveFromUci, moveToUci } from '../lib/board.js';
import { EXE, CWD } from './engine-path.mjs';

const pass = [], fail = [];
const ok = (n, c, x) => (c ? pass.push(n) : fail.push(n + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')));
const eq = (n, got, want) => ok(n, got === want, { got, want });

// ---------------------------------------------------------------- parseInfo
{
  const line = 'info depth 19 seldepth 31 multipv 2 score cp -42 wdl 18 981 1 nodes 1062867 nps 1328583 hashfull 332 tbhits 0 time 800 pv h7e7 h2e2 b9c7';
  const i = parseInfo(line);
  eq('解析 depth', i.depth, 19);
  eq('解析 seldepth', i.selDepth, 31);
  eq('解析 multipv', i.multipv, 2);
  eq('解析 score cp（含负号）', i.scoreCp, -42);
  eq('解析 nodes', i.nodes, 1062867);
  eq('解析 time', i.time, 800);
  eq('解析 wdl.win', i.wdl.win, 18);
  eq('解析 pv 首着', i.pv[0], 'h7e7');
  eq('pv 长度', i.pv.length, 3);

  const m = parseInfo('info depth 8 score mate 3 pv h2e2');
  eq('解析 mate', m.scoreMate, 3);
  eq('mate 时 scoreCp 为 null', m.scoreCp, null);
  ok('无关行返回 null', parseInfo('info hashfull 332') === null || parseInfo('info hashfull 332').depth === null);
}

// ---------------------------------------------------------------- 引擎生命周期
const engine = new UciEngine({ exePath: EXE, cwd: CWD, threads: 2, hash: 64 });

try {
  await engine.start();
  ok('引擎启动并完成握手', engine.ready);

  await engine.setLevel(3);
  ok('设定难度不抛错', true);

  // 开局搜索：红方视角，最佳着法应是合法的
  const t0 = Date.now();
  const mv = await engine.search([], { level: 3, movetime: 600 });
  const cost = Date.now() - t0;
  ok('搜索返回了着法', typeof mv === 'string' && mv.length === 4, mv);
  ok(`搜索耗时在合理范围（实测 ${cost}ms）`, cost > 300 && cost < 10000, cost);

  // 校验引擎给的着法在规则引擎里合法 —— 交叉验证两套实现
  const pos = new Position();
  const { from, to } = moveFromUci(mv);
  const legal = pos.generateLegalMoves(RED).some((m) => m.from === from && m.to === to);
  ok(`引擎着法 ${mv} 在规则引擎里合法（两套实现交叉验证）`, legal);

  // info 缓冲应有内容，且能汇总出面板数据
  ok('info 缓冲非空', engine.info.length > 0, engine.info.length);
  const withPv = engine.info.filter((i) => i.pv.length);
  ok('info 里有带 pv 的行', withPv.length > 0);

  // 连续两次搜索：验证串行化没有把状态搞乱
  const mv2 = await engine.search([mv], { level: 3, movetime: 500 });
  const pos2 = new Position();
  pos2.makeMove(moveFromUci(mv));
  const { from: from2, to: to2 } = moveFromUci(mv2);
  const legal2 = pos2.generateLegalMoves(pos2.turn).some((m) => m.from === from2 && m.to === to2);
  ok(`第二次搜索的着法 ${mv2} 也在对应局面合法`, legal2);

  // 难度切换后仍能搜索
  await engine.setLevel(1);
  const mv3 = await engine.search([], { level: 1, movetime: 200 });
  ok('低难度档仍返回着法', typeof mv3 === 'string' && mv3.length === 4, mv3);

  // 关闭：应真正退出且不留进程
  await engine.stop();
  ok('stop() 后 ready=false', !engine.ready);
  ok('stop() 后 proc 引用已清空', engine.proc === null);

  // 关闭后搜索应抛错（不是静默挂住）
  let threw = false;
  try { await engine.search([]); } catch { threw = true; }
  ok('关闭后调用 search 会抛错', threw);

} catch (e) {
  fail.push('引擎测试整体抛错：' + e.message);
} finally {
  try { await engine.stop(); } catch { /* 已退出 */ }
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
