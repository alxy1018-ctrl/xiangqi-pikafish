/**
 * 中国象棋规则核心：局面表示、走法生成、合法性校验、胜负判定。
 *
 * 坐标约定（与 UCI 协议一致，刻意如此选，避免任何转换歧义）：
 *   - 棋盘是 10 行 × 9 列。
 *   - 列 file 用 0..8 表示，对应 UCI 的 a..i（左到右）。
 *   - 行 rank 用 0..9 表示，**0 是最上面一行（黑方底线），9 是最下面一行（红方底线）**。
 *   - 数组索引 index = rank * 9 + file。
 *   - UCI 着法串 = 起点file字母 + 起点rank数字 + 终点file字母 + 终点rank数字，
 *     例如 "h2e2" = 从 (file=7, rank=2) 走到 (file=4, rank=2)。
 *
 * 棋子编码：大写=红方，小写=黑方（与国际象棋 FEN 习惯一致，也和 Pikafish 一致）
 *   K/k 将帅, A/a 士仕, B/b 象相, N/n 马, R/r 车, C/c 炮, P/p 兵卒
 * 空位用 '.' 表示（棋子字符串里用 '.' 占位）。
 */

export const RANKS = 10;
export const FILES = 9;
export const CELLS = RANKS * FILES;

export const RED = 'red';
export const BLACK = 'black';

/** 棋子中文名（红方/黑方各一套，仅用于显示） */
export const PIECE_NAMES = {
  K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵',
  k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒',
};

/** 起始局面（红方在下）。字符串按 rank 0→9 排列，每行 9 个字符。 */
export const START_FEN_BOARD =
  'rnbakabnr' +
  '.........' +
  '.c.....c.' +
  'p.p.p.p.p' +
  '.........' +
  '.........' +
  'P.P.P.P.P' +
  '.C.....C.' +
  '.........' +
  'RNBAKABNR';

export const idx = (file, rank) => rank * FILES + file;
export const fileOf = (i) => i % FILES;
export const rankOf = (i) => Math.floor(i / FILES);
export const inBoard = (file, rank) => file >= 0 && file < FILES && rank >= 0 && rank < RANKS;

export const isRed = (p) => p !== '.' && p === p.toUpperCase();
export const isBlack = (p) => p !== '.' && p === p.toLowerCase();
export const sideOf = (p) => (p === '.' ? null : isRed(p) ? RED : BLACK);
export const other = (side) => (side === RED ? BLACK : RED);

/**
 * 内部索引 ↔ 引擎（UCI）坐标。
 *
 * ⚠️ 两套坐标的 **rank 方向相反**，这是实测确认的，不是推测：
 *   - 内部表示（也是渲染和 XQ FEN 的约定）：rank 0 = **黑方底线（顶部）**，rank 9 = 红方底线（底部）。
 *   - UCI（Pikafish 说的语言）：rank 0 = **红方底线（底部）**，rank 9 = 黑方底线（顶部）。
 *
 * 实测依据：标准开局下 Pikafish 给出的最佳着法是 "h2e2"（炮二平五），
 * 即它认为 **rank 2** 上是红炮；而在内部表示里红炮在 rank 7 —— 恰好 9-7=2。
 * file（a-i，左到右）两套一致，只有 rank 需要翻转。
 *
 * **这里是全项目唯一的坐标转换出口**。早先还并存过一对"不翻转"的 uciSquare/squareFromUci，
 * 结果前端 lastMove 高亮就误用了未翻转的解析、把标记画成上下镜像 —— 那对函数已删除。
 * 任何地方需要把内部格位转成字符串发给引擎，只能用下面这四个。
 */
export const toEngineSquare = (i) =>
  String.fromCharCode(97 + fileOf(i)) + (RANKS - 1 - rankOf(i));
export const fromEngineSquare = (s) =>
  idx(s.charCodeAt(0) - 97, RANKS - 1 - Number(s[1]));

/** 走法 → 引擎 UCI 串（rank 已翻转，可直接发给 Pikafish） */
export const moveToUci = (mv) => toEngineSquare(mv.from) + toEngineSquare(mv.to);

/** 引擎 UCI 串 → 内部走法 */
export const moveFromUci = (u) => ({
  from: fromEngineSquare(u.slice(0, 2)),
  to: fromEngineSquare(u.slice(2, 4)),
});

// ---------------------------------------------------------------------------
// 局面
// ---------------------------------------------------------------------------

export class Position {
  /** @param {string} [board] 90 字符的棋盘串（按 rank 0→9 排列） */
  constructor(board = START_FEN_BOARD) {
    this.board = board.split('');
    /** 轮到哪一方走。中国象棋红先。 */
    this.turn = RED;
  }

  clone() {
    const p = new Position(this.board.join(''));
    p.turn = this.turn;
    return p;
  }

  at(file, rank) {
    if (!inBoard(file, rank)) return null;         // 出界
    return this.board[idx(file, rank)];
  }

  pieceAt(i) {
    return this.board[i];
  }

  /** 找到某方将/帅的位置索引；找不到返回 -1（理论上不会发生） */
  kingIndex(side) {
    const target = side === RED ? 'K' : 'k';
    for (let i = 0; i < CELLS; i++) if (this.board[i] === target) return i;
    return -1;
  }

  /**
   * 生成某一方所有"符合走子规则"的走法（**不检查走后是否自将**）。
   * 这个区别很重要：合法性校验需要先有伪合法着法，再逐个试走。
   */
  generatePseudoMoves(side = this.turn) {
    const moves = [];
    for (let i = 0; i < CELLS; i++) {
      const p = this.board[i];
      if (p === '.' || sideOf(p) !== side) continue;
      const f = fileOf(i), r = rankOf(i);
      switch (p.toUpperCase()) {
        case 'R': this._genRook(moves, i, f, r, side); break;
        case 'N': this._genKnight(moves, i, f, r, side); break;
        case 'B': this._genBishop(moves, i, f, r, side); break;
        case 'A': this._genAdvisor(moves, i, f, r, side); break;
        case 'K': this._genKing(moves, i, f, r, side); break;
        case 'C': this._genCannon(moves, i, f, r, side); break;
        case 'P': this._genPawn(moves, i, f, r, side); break;
      }
    }
    return moves;
  }

  _add(moves, from, f, r, side) {
    if (!inBoard(f, r)) return false;
    const target = this.board[idx(f, r)];
    if (target !== '.' && sideOf(target) === side) return false;   // 自己的子，不能吃
    moves.push({ from, to: idx(f, r) });
    return target === '.';                                          // 空位才可继续滑行
  }

  /** 车：直线滑行 */
  _genRook(moves, from, f, r, side) {
    for (const [df, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      let nf = f + df, nr = r + dr;
      while (inBoard(nf, nr)) {
        if (!this._add(moves, from, nf, nr, side)) break;
        nf += df; nr += dr;
      }
    }
  }

  /** 马：走日字，**蹩马腿**（马腿位置的棋子会挡住） */
  _genKnight(moves, from, f, r, side) {
    const legs = [
      [0, -1, 1, -2], [0, -1, -1, -2],   // 向上跳，蹩腿在正上方
      [0, 1, 1, 2], [0, 1, -1, 2],       // 向下跳
      [-1, 0, -2, 1], [-1, 0, -2, -1],   // 向左跳
      [1, 0, 2, 1], [1, 0, 2, -1],       // 向右跳
    ];
    for (const [lf, lr, tf, tr] of legs) {
      if (this.at(f + lf, r + lr) === null) continue;   // 马腿出界，视为被挡
      if (this.at(f + lf, r + lr) !== '.') continue;    // 蹩马腿
      this._add(moves, from, f + tf, r + tr, side);
    }
  }

  /** 象/相：走田字，**塞象眼**，且不能过河 */
  _genBishop(moves, from, f, r, side) {
    const ownHalfTop = side === BLACK ? 4 : 9;   // 黑方在 rank 0..4，红方在 5..9
    const ownHalfBottom = side === BLACK ? 0 : 5;
    for (const [df, dr] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
      const nf = f + df, nr = r + dr;
      if (nr < ownHalfBottom || nr > ownHalfTop) continue;      // 象不过河
      const eyeF = f + df / 2, eyeR = r + dr / 2;
      if (this.at(eyeF, eyeR) !== '.') continue;                // 塞象眼
      this._add(moves, from, nf, nr, side);
    }
  }

  /** 士/仕：九宫内斜走一格 */
  _genAdvisor(moves, from, f, r, side) {
    for (const [df, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nf = f + df, nr = r + dr;
      if (!this._inPalace(nf, nr, side)) continue;
      this._add(moves, from, nf, nr, side);
    }
  }

  /** 将/帅：九宫内直走一格 */
  _genKing(moves, from, f, r, side) {
    for (const [df, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nf = f + df, nr = r + dr;
      if (!this._inPalace(nf, nr, side)) continue;
      this._add(moves, from, nf, nr, side);
    }
  }

  /** 九宫范围：红方 rank 7..9，黑方 rank 0..2；列都是 3..5 */
  _inPalace(file, rank, side) {
    if (file < 3 || file > 5) return false;
    return side === RED ? (rank >= 7 && rank <= 9) : (rank >= 0 && rank <= 2);
  }

  /** 炮：不吃子时同车；吃子必须**隔一个子**（炮架） */
  _genCannon(moves, from, f, r, side) {
    for (const [df, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      let nf = f + df, nr = r + dr;
      // 第一段：空位可以走
      while (inBoard(nf, nr) && this.board[idx(nf, nr)] === '.') {
        moves.push({ from, to: idx(nf, nr) });
        nf += df; nr += dr;
      }
      // 遇到第一个子（炮架），继续找到下一个子，若是敌方可吃
      if (!inBoard(nf, nr)) continue;
      nf += df; nr += dr;
      while (inBoard(nf, nr)) {
        const t = this.board[idx(nf, nr)];
        if (t !== '.') {
          if (sideOf(t) !== side) moves.push({ from, to: idx(nf, nr) });
          break;
        }
        nf += df; nr += dr;
      }
    }
  }

  /** 兵/卒：只进不退，过河后可横走 */
  _genPawn(moves, from, f, r, side) {
    if (side === RED) {
      this._add(moves, from, f, r - 1, side);                 // 红方向上（rank 减小）
      if (r <= 4) { this._add(moves, from, f - 1, r, side); this._add(moves, from, f + 1, r, side); }
    } else {
      this._add(moves, from, f, r + 1, side);                 // 黑方向下（rank 增大）
      if (r >= 5) { this._add(moves, from, f - 1, r, side); this._add(moves, from, f + 1, r, side); }
    }
  }

  /** 执行一个走法（不校验合法性，调用方负责）。返回被吃的子。 */
  makeMove(mv) {
    const captured = this.board[mv.to];
    this.board[mv.to] = this.board[mv.from];
    this.board[mv.from] = '.';
    this.turn = other(this.turn);
    return captured;
  }

  /** 撤销一个走法；captured 是 makeMove 的返回值 */
  undoMove(mv, captured) {
    this.board[mv.from] = this.board[mv.to];
    this.board[mv.to] = captured;
    this.turn = other(this.turn);
  }

  /**
   * 将帅是否照面（飞将）：两个将帅在同一列且中间没有任何棋子。
   * 这条规则必须单独检查 —— 因为将帅不能互相吃，但"照面"本身就是非法局面。
   */
  kingsFaceEachOther() {
    const rk = this.kingIndex(RED), bk = this.kingIndex(BLACK);
    if (rk < 0 || bk < 0) return false;
    const rf = fileOf(rk), bf = fileOf(bk);
    if (rf !== bf) return false;
    const lo = Math.min(rankOf(rk), rankOf(bk));
    const hi = Math.max(rankOf(rk), rankOf(bk));
    for (let r = lo + 1; r < hi; r++) {
      if (this.board[idx(rf, r)] !== '.') return false;   // 中间有子，不算照面
    }
    return true;   // 中间无子 → 照面
  }

  /** 某一方是否正被将军（含飞将） */
  isInCheck(side) {
    if (this.kingsFaceEachOther()) return true;
    const king = this.kingIndex(side);
    if (king < 0) return true;
    const kf = fileOf(king), kr = rankOf(king);
    const foe = other(side);

    // 车/炮的直线威胁：先数这条线上有几个子
    for (const [df, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      let nf = kf + df, nr = kr + dr, blockers = 0;
      while (inBoard(nf, nr)) {
        const t = this.board[idx(nf, nr)];
        if (t !== '.') {
          if (sideOf(t) === foe) {
            const up = t.toUpperCase();
            if (blockers === 0 && (up === 'R' || up === 'K')) return true;  // 车贴脸；将帅照面已单独判
            if (blockers === 1 && up === 'C') return true;                   // 炮隔一子
          }
          blockers++;
          if (blockers > 1) break;
        }
        nf += df; nr += dr;
      }
    }

    // 马的威胁：从将的位置反推可能的马位，并检查那个方向是否被蹩腿。
    // 数组只放 [马相对将的偏移]；马腿方向由该偏移推导（不能吃符号的短边决定），
    // 所以不要再往这里塞"腿"字段 —— 曾经有过一对冗余字段，误导性大于用处。
    const knightChecks = [
      [1, -2], [-1, -2], [1, 2], [-1, 2],
      [2, 1], [2, -1], [-2, 1], [-2, -1],
    ];
    for (const [hf, hr] of knightChecks) {
      const nf = kf + hf, nr = kr + hr;
      if (!inBoard(nf, nr)) continue;
      const t = this.board[idx(nf, nr)];
      if (t === '.' || sideOf(t) !== foe || t.toUpperCase() !== 'N') continue;
      // 马腿 = 马朝向将的方向上、跨出「长边」的第一步。
      // 长边是绝对值等于 2 的那一维，方向取反（从马指向将）。
      const stepF = Math.abs(hf) === 2 ? (hf > 0 ? -1 : 1) : 0;
      const stepR = Math.abs(hr) === 2 ? (hr > 0 ? -1 : 1) : 0;
      const legF = nf + stepF, legR = nr + stepR;
      if (this.at(legF, legR) === null) continue;          // 腿出界，视为被挡
      if (this.board[idx(legF, legR)] === '.') return true; // 腿空 → 马能跳到将
    }

    // 兵的威胁
    // 横吃的前提是「兵已过河」：黑卒过河是 rank >= 5，红兵过河是 rank <= 4。
    // 兵与将被判定在同一排（就是 kr），所以条件直接用 kr 判断，
    // **不要写成"将在己方半场"** —— 红将恰好在河沿 rank 5 时那样会漏判。
    if (side === RED) {
      // 黑卒向下走（rank 增大），能吃红将的卒在将的上一排
      const t = this.at(kf, kr - 1);
      if (t && t === 'p') return true;
      for (const d of [-1, 1]) {
        const s = this.at(kf + d, kr);
        if (s && s === 'p' && kr >= 5) return true;   // 同排的卒必有 rank==kr，过河条件即 kr>=5
      }
    } else {
      const t = this.at(kf, kr + 1);
      if (t && t === 'P') return true;
      for (const d of [-1, 1]) {
        const s = this.at(kf + d, kr);
        if (s && s === 'P' && kr <= 4) return true;   // 红兵过河是 rank<=4
      }
    }

    return false;
  }

  /** 生成合法走法（试走后自己不被将军） */
  generateLegalMoves(side = this.turn) {
    const out = [];
    for (const mv of this.generatePseudoMoves(side)) {
      const captured = this.makeMove(mv);
      const bad = this.isInCheck(side);
      this.undoMove(mv, captured);
      if (!bad) out.push(mv);
    }
    return out;
  }

  /** 某一方是否无子可动（被将死或困毙都返回 true，需要调用方区分） */
  hasNoLegalMove(side = this.turn) {
    return this.generateLegalMoves(side).length === 0;
  }

  /**
   * 对局状态判定。
   * @returns {{over:boolean, winner?:string, reason?:string}}
   *   中国象棋规则里：**困毙也算输**（与国际象棋"逼和"不同）。
   */
  status() {
    if (!this.hasNoLegalMove(this.turn)) return { over: false };
    const inCheck = this.isInCheck(this.turn);
    return {
      over: true,
      winner: other(this.turn),           // 无子可动的一方输
      reason: inCheck ? 'checkmate' : 'stalemate',
    };
  }

  /** 导出 FEN（Pikafish 用不到，但便于调试与存档） */
  toFen() {
    const rows = [];
    for (let r = 0; r < RANKS; r++) {
      let row = '', empty = 0;
      for (let f = 0; f < FILES; f++) {
        const p = this.board[idx(f, r)];
        if (p === '.') { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/') + ' ' + (this.turn === RED ? 'w' : 'b') + ' - - 0 1';
  }
}

/** 由起始局面 + 走子序列重建局面（唯一事实来源，避免状态不同步） */
export function positionFromMoves(uciMoves = []) {
  const pos = new Position();
  for (const u of uciMoves) {
    pos.makeMove(moveFromUci(u));
  }
  return pos;
}

/**
 * 校验一个着法是否合法。
 * @returns {{ok:boolean, move?:{from:number,to:number}, captured?:string, reason?:string, status?:object}}
 */
export function validateMove(pos, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= CELLS || to < 0 || to >= CELLS) {
    return { ok: false, reason: 'out-of-board' };
  }
  const legal = pos.generateLegalMoves(pos.turn).find((m) => m.from === from && m.to === to);
  if (!legal) return { ok: false, reason: 'illegal-move' };
  return { ok: true, move: legal };
}
