/**
 * Pikafish UCI 引擎封装。
 *
 * 设计要点：
 * - 常驻一个子进程，用 UCI 长连接，避免每步重启（重启要重新加载 50 MB 权重）。
 * - 局面**永远用完整走子序列**下发（position startpos moves ...），
 *   不在本地维护引擎侧局面 —— 这样悔棋就是 pop 后重发，不会出现两侧不同步。
 * - 所有命令串行化：引擎是单线程协议，并发写会让输出错乱。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 难度档位：Elo 与思考时间。Skill Level 由 Elo 反推（见下方注释）。 */
export const LEVELS = {
  1: { name: '入门', elo: 1280, movetime: 200, skill: 0 },
  2: { name: '初级', elo: 1500, movetime: 300, skill: 3 },
  3: { name: '中级', elo: 1800, movetime: 500, skill: 7 },
  4: { name: '较强', elo: 2100, movetime: 800, skill: 11 },
  5: { name: '高手', elo: 2400, movetime: 1200, skill: 15 },
  6: { name: '大师', elo: 2700, movetime: 1800, skill: 18 },
  7: { name: '满血', elo: null, movetime: 2500, skill: 20 },
};

export class UciEngine {
  /**
   * @param {object} opts
   * @param {string} opts.exePath   引擎可执行文件路径
   * @param {string} [opts.cwd]     工作目录（必须是 nnue 权重所在目录）
   * @param {number} [opts.threads] 搜索线程数
   * @param {number} [opts.hash]    哈希表 MB
   */
  constructor({ exePath, cwd, threads = 4, hash = 256 }) {
    this.exePath = exePath;
    this.cwd = cwd ?? dirname(exePath);
    this.threads = threads;
    this.hash = hash;
    this.proc = null;
    this.buffer = '';
    this.ready = false;
    this.info = [];            // 最近一次搜索的 info 行（面板用）
    this.onInfo = null;        // 回调：搜索过程中实时推送
    this._queue = Promise.resolve();
    this._pendingBestmove = null;   // 当前等待 bestmove 的 promise 控制器
    this._lineHandlers = null;      // 握手阶段的临时行处理器
    this._exited = false;
    this._lastError = null;
  }

  /**
   * 启动并完成 UCI 握手。
   * 失败会抛错，调用方决定怎么提示 —— 此时已经不留下任何监听器或子进程。
   */
  async start() {
    if (!existsSync(this.exePath)) {
      throw new Error(`找不到引擎文件：${this.exePath}`);
    }
    this.proc = spawn(this.exePath, [], { cwd: this.cwd, windowsHide: true });
    this.buffer = '';
    this._exited = false;

    let spawnError = null;
    // 只在这里各挂一次：进程级监听器不随握手结束而增删
    this.proc.on('error', (e) => {
      spawnError = e;
      this.ready = false;
      this._lastError = e;
      this._failPending(`引擎进程错误：${e.message}`);
    });
    this.proc.on('exit', (code) => {
      this.ready = false;
      this._exited = true;
      this._failPending(`引擎进程已退出（code=${code}）`);
    });

    // 单条 stdout 解析路径：握手和搜索共用它。
    // （早先版本给握手和搜索各写了一条路径，结果搜索那条从来没被挂上，
    //  引擎明明回了 bestmove 却没人接 —— 这类"两条路径"的设计本身就是 bug 温床。）
    this._lineHandlers = [];
    this._pendingLines = [];
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));

    const waitLine = (token, timeoutMs = 25000) => new Promise((resolve, reject) => {
      // 已经收到过就直接返回（避免竞态：命令发出前输出就到了）
      const idx = this._pendingLines.indexOf(token);
      if (idx !== -1) { this._pendingLines.splice(idx, 1); return resolve(); }

      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.proc?.off?.('exit', onExit);
        const i = this._lineHandlers.indexOf(handler);
        if (i !== -1) this._lineHandlers.splice(i, 1);
      };
      const finish = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        err ? reject(err) : resolve();
      };
      const handler = (line) => { if (line === token) finish(); };
      const onExit = () => finish(new Error(`等待 "${token}" 时引擎进程已退出`));
      const timer = setTimeout(() => finish(new Error(`等待 "${token}" 超时`)), timeoutMs);

      this._lineHandlers.push(handler);
      this.proc.once('exit', onExit);
    });

    try {
      const uciOk = waitLine('uciok');
      this.proc.stdin.write('uci\n');
      await uciOk;
      if (spawnError) throw spawnError;

      this.proc.stdin.write(`setoption name Threads value ${this.threads}\n`);
      this.proc.stdin.write(`setoption name Hash value ${this.hash}\n`);

      const readyOk = waitLine('readyok');
      this.proc.stdin.write('isready\n');
      await readyOk;
    } catch (e) {
      // 启动失败：带走进程，不留下半死不活的子进程和悬挂的监听器
      try { this.proc.kill(); } catch { /* 已退出 */ }
      this.proc = null;
      this.ready = false;
      throw e;
    }

    this.ready = true;
    this._lineHandlers = [];        // 握手结束：不再缓存未消化行（见 _onStdout 的 handshakeActive）
    this._pendingLines = [];        // 顺手丢掉握手期间缓存的行，搜索期间不再需要
    return true;
  }

  /** 让所有等待中的 promise 立刻失败（进程死掉时用，避免挂到超时） */
  _failPending(message) {
    const p = this._pendingBestmove;
    if (p && !p.settled) {
      p.settled = true;
      clearTimeout(p.timer);
      clearTimeout(p.hardTimer);
      p.reject(new Error(message));
    }
    this._pendingBestmove = null;
  }

  /**
   * **唯一的** stdout 解析入口。先给握手的行处理器机会，再走常规解析。
   * 不要再为搜索另开一条监听路径 —— 那样必然出现"引擎回了但没人接"。
   */
  _onStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      let handled = false;
      const handshakeActive = this._lineHandlers !== null;
      if (this._lineHandlers?.length) {
        for (const h of [...this._lineHandlers]) {
          const before = this._lineHandlers.length;
          h(line);
          // 处理器匹配成功会把自己摘掉；以此判断这一行是否已被消化
          if (this._lineHandlers.length < before) { handled = true; break; }
        }
      }
      // 只有在**握手期间**才缓存未被消化的行（waitLine 需要回看"命令发出前就到了"的 token）。
      // 握手结束后必须彻底停止缓存，否则每轮搜索的几十行 info 都会堆进 _pendingLines，
      // 长时间运行就是一条稳定的泄漏。
      if (handshakeActive && !handled) this._pendingLines.push(line);
      if (handled) continue;

      if (line.startsWith('info ')) {
        const parsed = parseInfo(line);
        if (parsed) {
          this.info.push(parsed);
          if (this.info.length > 400) this.info.splice(0, 200);
          if (this.onInfo) { try { this.onInfo(parsed); } catch { /* 回调异常不影响引擎 */ } }
        }
      } else if (line.startsWith('bestmove')) {
        const mv = line.split(/\s+/)[1];
        const p = this._pendingBestmove;
        if (p && !p.settled) {
          p.settled = true;
          clearTimeout(p.timer);
          clearTimeout(p.hardTimer);
          this._pendingBestmove = null;
          p.resolve(mv === '(none)' || !mv ? null : mv);
        }
      }
    }
  }

  /**
   * 串行执行，防止并发写命令（引擎是单线程协议，并发写会让输出错乱）。
   * 注意：这里故意让链上错误继续传播给调用方，只在链式记录里吞掉，
   * 避免后一个任务对着已死的进程写 stdin。
   */
  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(
      () => { this._lastError = null; },
      (e) => { this._lastError = e; },
    );
    return run;
  }

  /**
   * 设定难度。
   * 说明：Pikafish 的 UCI_Elo 只在 UCI_LimitStrength=true 时生效；
   * 满血档关掉限制，让 Skill Level 20 + 长思考发挥真实棋力。
   */
  async setLevel(level) {
    const cfg = LEVELS[level] ?? LEVELS[3];
    return this._enqueue(async () => {
      if (!this.ready) return cfg;
      if (cfg.elo === null) {
        this.proc.stdin.write('setoption name UCI_LimitStrength value false\n');
      } else {
        this.proc.stdin.write('setoption name UCI_LimitStrength value true\n');
        this.proc.stdin.write(`setoption name UCI_Elo value ${cfg.elo}\n`);
      }
      this.proc.stdin.write(`setoption name Skill Level value ${cfg.skill}\n`);
      this.proc.stdin.write('setoption name MultiPV value 3\n');
      return cfg;
    });
  }

  /** 清空 info 缓冲（每次搜索前调用） */
  clearInfo() { this.info = []; }

  /**
   * 搜索并返回最佳着法。
   *
   * 超时处理是刻意这样写的：超时后**先发 `stop` 让引擎停下来**，再等它的 bestmove，
   * 而不是直接把 promise reject 掉。
   * 原因（评审指出的竞态）：如果直接 reject，而 bestmove 恰好在同一时刻到达，
   * 着法会被静默丢弃 —— 引擎明明算出来了，上层却收到"超时"。
   *
   * @param {string[]} moves 走子序列（UCI 串数组）
   * @param {object} [opts]
   *   - movetime / level：思考时间与难度
   *   - fen：**用 FEN 直接下发局面**，优先于 moves。
   *     服务端统一走这条路径：FEN 把轮走方显式带上，不依赖 `startpos moves`
   *     的"红先 + 从开局严格交替"前提，少一套分支。
   * @returns {Promise<string|null>} UCI 着法；无着法时返回 null
   */
  async search(moves, opts = {}) {
    return this._enqueue(() => this._searchNow(moves, opts));
  }

  async _searchNow(moves, opts = {}) {
    if (!this.ready) throw new Error('引擎未就绪');
    const cfg = LEVELS[opts.level ?? 3] ?? LEVELS[3];
    const movetime = Math.max(50, Math.min(60000, opts.movetime ?? cfg.movetime));

    this.clearInfo();
    if (opts.fen) {
      this.proc.stdin.write(`position fen ${opts.fen}\n`);
    } else {
      const seq = moves.length ? ' moves ' + moves.join(' ') : '';
      this.proc.stdin.write(`position startpos${seq}\n`);
    }

    const bestmove = await new Promise((resolve, reject) => {
      const pending = { resolve, reject, settled: false, timer: null, hardTimer: null };
      const settle = (err, mv) => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        clearTimeout(pending.hardTimer);
        if (this._pendingBestmove === pending) this._pendingBestmove = null;
        err ? reject(err) : resolve(mv);
      };

      // 软超时：让引擎收手，但仍等它把 bestmove 交出来
      pending.timer = setTimeout(() => {
        try { this.proc?.stdin.write('stop\n'); } catch { /* 进程可能已死 */ }
      }, movetime + 4000);
      // 硬超时：引擎彻底没反应，才判定失败
      pending.hardTimer = setTimeout(
        () => settle(new Error(`引擎在 ${movetime + 20000}ms 内未返回 bestmove`)),
        movetime + 20000,
      );

      this._pendingBestmove = pending;
      this.proc.stdin.write(`go movetime ${movetime}\n`);
    });

    if (!bestmove) {
      // 引擎说没有着法。区分"真无着法"和"引擎出问题"由调用方用规则引擎判断。
      return null;
    }
    return bestmove;
  }

  /** 关掉引擎进程，等它真正退出（Windows 上 kill 是异步的，50MB 权重要清理） */
  async stop(timeoutMs = 3000) {
    const proc = this.proc;
    this.ready = false;
    if (!proc) return;
    const exited = new Promise((resolve) => {
      if (proc.exitCode !== null || this._exited) return resolve();
      proc.once('exit', resolve);
    });
    try { proc.stdin.write('quit\n'); } catch { /* 已退出 */ }
    // 给它一点时间优雅退出，超时就强杀
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), Math.min(timeoutMs, 1500))),
    ]);
    if (!graceful) {
      try { proc.kill(); } catch { /* 已退出 */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    this.proc = null;
  }
}

/**
 * 解析一行 info。
 * 真实样例：
 *   info depth 19 seldepth 31 multipv 1 score cp 6 wdl 18 981 1 nodes 1062867 nps 1328583 hashfull 332 tbhits 0 time 800 pv h3e3 h7e7 ...
 */
export function parseInfo(line) {
  const depth = line.match(/\bdepth (\d+)/);
  const selDepth = line.match(/\bseldepth (\d+)/);
  const multipv = line.match(/\bmultipv (\d+)/);
  const scoreCp = line.match(/\bscore cp (-?\d+)/);
  const scoreMate = line.match(/\bscore mate (-?\d+)/);
  const nodes = line.match(/\bnodes (\d+)/);
  const nps = line.match(/\bnps (\d+)/);
  const time = line.match(/\btime (\d+)/);
  const wdl = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  if (!pv && !scoreCp && !scoreMate) return null;   // 纯 hashfull/nodes 行，跳过
  return {
    depth: depth ? Number(depth[1]) : null,
    selDepth: selDepth ? Number(selDepth[1]) : null,
    multipv: multipv ? Number(multipv[1]) : 1,
    scoreCp: scoreCp ? Number(scoreCp[1]) : null,
    scoreMate: scoreMate ? Number(scoreMate[1]) : null,
    nodes: nodes ? Number(nodes[1]) : null,
    nps: nps ? Number(nps[1]) : null,
    time: time ? Number(time[1]) : null,
    wdl: wdl ? { win: Number(wdl[1]), draw: Number(wdl[2]), loss: Number(wdl[3]) } : null,
    pv: pv ? pv[1].trim().split(/\s+/) : [],
  };
}
