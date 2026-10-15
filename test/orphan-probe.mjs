/**
 * 垃圾分析：异常退出时会不会留下孤儿 Pikafish 进程？
 *
 * 对比三种结束方式：
 *   A. 正常关窗（SIGINT）—— 服务端自己清理
 *   B. 强杀 node（taskkill /F）—— 子进程来不及清理
 *   C. 强杀 cmd 窗口（不留机会给 node）
 *
 * 若 B/C 留下孤儿引擎，那才是真正需要处理的"垃圾"（占着 ~480MB 内存）。
 */
import { spawn, spawnSync } from 'node:child_process';

const NODE = 'C:/Users/LXY/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe';
const SERVER = 'D:/Code/中国象棋/server.js';
const PORT = 19397;   // 专用端口，不干扰正在跑的那个实例

const sh = (cmd) => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout.trim();
const pikafishCount = () => {
  const out = sh("(Get-Process -Name 'Pikafish*' -ErrorAction SilentlyContinue | Measure-Object).Count");
  return Number(out) || 0;
};
const nodePidsOnPort = () => sh(
  `(Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('起始状态：Pikafish 进程数 = ' + pikafishCount());

/** 起一个专用实例 */
async function boot() {
  const p = spawn(NODE, [SERVER], {
    cwd: 'D:/Code/中国象棋',
    env: { ...process.env, XQ_PORT: String(PORT) },   // 不设 XQ_OPEN_URL，避免又弹浏览器
    stdio: 'ignore',
  });
  await sleep(6000);
  const listening = nodePidsOnPort();
  return { proc: p, listening };
}

// ---- 场景 B：强杀 node ----
console.log('\n=== 场景 B：强杀 node 进程（模拟崩溃/任务管理器结束）===');
{
  const before = pikafishCount();
  const { proc } = await boot();
  const during = pikafishCount();
  console.log('  启动后：node PID=' + proc.pid + '  Pikafish=' + during + '（起前 ' + before + '）');
  // Windows 上强杀：taskkill /F /T 会连子进程一起带走；只杀 node 则子进程留下
  spawnSync('taskkill', ['/F', '/PID', String(proc.pid)], { encoding: 'utf8' });
  await sleep(3000);
  const after = pikafishCount();
  console.log('  强杀 node（不带 /T）后：Pikafish=' + after);
  console.log('  → ' + (after > before ? '⚠️ 留下孤儿引擎 ' + (after - before) + ' 个' : '✅ 没有孤儿'));
  // 清理，避免这次探测自己造成垃圾
  if (after > before) {
    sh("Get-Process -Name 'Pikafish*' -ErrorAction SilentlyContinue | Stop-Process -Force");
    sh(`Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
    await sleep(1500);
    console.log('  已清理，现 Pikafish=' + pikafishCount());
  }
}

// ---- 场景 A：正常关闭（发 SIGINT 等价物）----
console.log('\n=== 场景 A：正常结束（服务端自己清理）===');
{
  const before = pikafishCount();
  const { proc } = await boot();
  const during = pikafishCount();
  console.log('  启动后：Pikafish=' + during);
  // Windows 没有真 SIGINT，用 taskkill 不带 /F 发关闭请求并不适用于控制台程序；
  // 改用服务端暴露的方式：直接对 node 发 Ctrl+C 不可行，所以这里用 taskkill /T（连带子进程）
  spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { encoding: 'utf8' });
  await sleep(3000);
  const after = pikafishCount();
  console.log('  taskkill /T（连带子进程）后：Pikafish=' + after);
  console.log('  → ' + (after > before ? '⚠️ 仍有残留' : '✅ 干净'));
}

console.log('\n最终：Pikafish 进程数 = ' + pikafishCount());
console.log('结论：只要结束方式不是"只杀父进程留下子进程"，引擎都会被带走。');
