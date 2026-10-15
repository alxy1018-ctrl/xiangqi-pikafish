/**
 * 运行期垃圾分析：反复搜索，观察内存是否累积。
 * 测的是"跑久了会不会越吃越多"，而不是单次调用的峰值。
 */
const BASE = `http://127.0.0.1:${process.env.XQ_PORT ?? 19390}`;
const api = async (p, b) => {
  const r = await fetch(BASE + p, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return { status: r.status, data: await r.json() };
};

const mb = (n) => (n === undefined || n === null ? '—' : (n / 1048576).toFixed(1) + ' MB');

await api('/api/new', {});
await api('/api/red-first', {});

console.log('轮次   分析次数   node rss      heapUsed      heapTotal     external');
console.log('─'.repeat(72));
const samples = [];
for (let round = 1; round <= 12; round++) {
  await api('/api/analyze', { movetime: 400 });
  const s = (await api('/api/state')).data;
  const m = s.memory ?? {};
  samples.push(m);
  console.log(
    String(round).padStart(3) + '    ' + String(s.analysisCount ?? '?').padStart(6) + '   ' +
    mb(m.rss).padStart(10) + '  ' + mb(m.heapUsed).padStart(11) + '  ' +
    mb(m.heapTotal).padStart(11) + '  ' + mb(m.external).padStart(10),
  );
}

const first = samples[2] ?? samples[0];
const last = samples[samples.length - 1];
console.log('\n=== 趋势（第 3 次 → 最后一次）===');
const delta = (k) => {
  const d = (last[k] ?? 0) - (first[k] ?? 0);
  const sign = d >= 0 ? '+' : '';
  return `${k}: ${mb(first[k])} → ${mb(last[k])}   ${sign}${(d / 1048576).toFixed(2)} MB`;
};
console.log('  ' + delta('rss'));
console.log('  ' + delta('heapUsed'));
console.log('  ' + delta('external'));
console.log('\n判读：heapUsed 若随次数近似线性增长 → 有泄漏；上下波动属正常 GC。');
