// Twisted Chess engine — pure, no DOM / no Worker globals.
// Shared by the browser client and the Durable Object (authoritative).
//
// Board: Array(64). index = row*8 + col. row 0 = rank 8 (top, Black back rank),
// row 7 = rank 1 (bottom, White back rank). White moves "up" (row decreases).
// Pieces: uppercase = White (P N B R Q K), lowercase = Black, null = empty.
//
// Twisted Chess rules implemented here:
//   - All standard piece movement, castling, en passant, promotion, check/mate.
//   - A turn = make a legal piece move, THEN rotate one 4x4 quadrant 90 deg.
//   - A piece move may not leave your own king in check (standard).
//   - A twist may not leave your own king in check (illegal otherwise).
//   - Checkmate is adjudicated at the piece-move stage: if it is your move and
//     your king is in check and no legal piece move escapes, you are mated.
//   - The twist clears any en-passant target (a twist always follows a move).

export const QUADRANTS = ['TL', 'TR', 'BL', 'BR']; // top-left, top-right, bottom-left, bottom-right

const KNIGHT_DELTAS = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1],
];
const KING_DELTAS = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
];
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export function idx(r, c) { return r * 8 + c; }
export function rc(i) { return [Math.floor(i / 8), i % 8]; }
export function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

export function isWhite(p) { return p && p === p.toUpperCase(); }
export function isBlack(p) { return p && p === p.toLowerCase(); }
export function colorOf(p) { return p ? (isWhite(p) ? 'w' : 'b') : null; }

// Algebraic square names <-> index (a1 = bottom-left from White's view).
export function squareName(i) {
  const [r, c] = rc(i);
  return 'abcdefgh'[c] + (8 - r);
}
export function nameToIdx(name) {
  const c = 'abcdefgh'.indexOf(name[0]);
  const r = 8 - parseInt(name[1], 10);
  return idx(r, c);
}

export function initialState() {
  const board = new Array(64).fill(null);
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let c = 0; c < 8; c++) {
    board[idx(0, c)] = back[c];          // black back rank (row 0)
    board[idx(1, c)] = 'p';              // black pawns
    board[idx(6, c)] = 'P';              // white pawns
    board[idx(7, c)] = back[c].toUpperCase(); // white back rank (row 7)
  }
  return {
    board,
    turn: 'w',
    castling: { K: true, Q: true, k: true, q: true },
    ep: null,        // en-passant target square index, or null
  };
}

export function cloneState(s) {
  return {
    board: s.board.slice(),
    turn: s.turn,
    castling: { ...s.castling },
    ep: s.ep,
  };
}

// --- Attack / check detection ---------------------------------------------

export function isSquareAttacked(board, target, by) {
  const [tr, tc] = rc(target);

  // Pawns
  if (by === 'w') {
    for (const dc of [-1, 1]) {
      const r = tr + 1, c = tc + dc;
      if (inBounds(r, c) && board[idx(r, c)] === 'P') return true;
    }
  } else {
    for (const dc of [-1, 1]) {
      const r = tr - 1, c = tc + dc;
      if (inBounds(r, c) && board[idx(r, c)] === 'p') return true;
    }
  }

  // Knights
  for (const [dr, dc] of KNIGHT_DELTAS) {
    const r = tr + dr, c = tc + dc;
    if (!inBounds(r, c)) continue;
    const p = board[idx(r, c)];
    if (p && colorOf(p) === by && p.toUpperCase() === 'N') return true;
  }

  // King
  for (const [dr, dc] of KING_DELTAS) {
    const r = tr + dr, c = tc + dc;
    if (!inBounds(r, c)) continue;
    const p = board[idx(r, c)];
    if (p && colorOf(p) === by && p.toUpperCase() === 'K') return true;
  }

  // Sliding: bishop/queen diagonals
  for (const [dr, dc] of BISHOP_DIRS) {
    let r = tr + dr, c = tc + dc;
    while (inBounds(r, c)) {
      const p = board[idx(r, c)];
      if (p) {
        if (colorOf(p) === by && (p.toUpperCase() === 'B' || p.toUpperCase() === 'Q')) return true;
        break;
      }
      r += dr; c += dc;
    }
  }
  // Sliding: rook/queen orthogonals
  for (const [dr, dc] of ROOK_DIRS) {
    let r = tr + dr, c = tc + dc;
    while (inBounds(r, c)) {
      const p = board[idx(r, c)];
      if (p) {
        if (colorOf(p) === by && (p.toUpperCase() === 'R' || p.toUpperCase() === 'Q')) return true;
        break;
      }
      r += dr; c += dc;
    }
  }
  return false;
}

export function findKing(board, color) {
  const k = color === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) if (board[i] === k) return i;
  return -1;
}

export function kingInCheck(board, color) {
  const ks = findKing(board, color);
  if (ks < 0) return false; // king missing (shouldn't happen in normal play)
  return isSquareAttacked(board, ks, color === 'w' ? 'b' : 'w');
}

// --- Pseudo-legal move generation -----------------------------------------

function pushMove(moves, from, to, opts = {}) {
  moves.push({ from, to, ...opts });
}

function pseudoMovesFrom(state, from) {
  const { board, ep, castling } = state;
  const p = board[from];
  if (!p) return [];
  const color = colorOf(p);
  const [r, c] = rc(from);
  const moves = [];
  const type = p.toUpperCase();

  if (type === 'P') {
    const dir = color === 'w' ? -1 : 1;       // white moves up (row--)
    const startRow = color === 'w' ? 6 : 1;
    const promoRow = color === 'w' ? 0 : 7;
    // forward one
    const r1 = r + dir;
    if (inBounds(r1, c) && !board[idx(r1, c)]) {
      addPawnMove(moves, from, idx(r1, c), r1 === promoRow);
      // forward two
      const r2 = r + 2 * dir;
      if (r === startRow && !board[idx(r2, c)]) {
        pushMove(moves, from, idx(r2, c), { double: true });
      }
    }
    // captures
    for (const dc of [-1, 1]) {
      const cr = r + dir, cc = c + dc;
      if (!inBounds(cr, cc)) continue;
      const t = idx(cr, cc);
      const tp = board[t];
      if (tp && colorOf(tp) !== color) {
        addPawnMove(moves, from, t, cr === promoRow);
      } else if (ep !== null && t === ep) {
        pushMove(moves, from, t, { enpassant: true });
      }
    }
    return moves;
  }

  if (type === 'N') {
    for (const [dr, dc] of KNIGHT_DELTAS) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const t = idx(nr, nc);
      if (!board[t] || colorOf(board[t]) !== color) pushMove(moves, from, t);
    }
    return moves;
  }

  if (type === 'K') {
    for (const [dr, dc] of KING_DELTAS) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const t = idx(nr, nc);
      if (!board[t] || colorOf(board[t]) !== color) pushMove(moves, from, t);
    }
    // Castling — king must be on its home square, rook on home square,
    // path clear, and king not in/through/into check.
    addCastling(state, color, moves);
    return moves;
  }

  // Sliding pieces
  let dirs;
  if (type === 'B') dirs = BISHOP_DIRS;
  else if (type === 'R') dirs = ROOK_DIRS;
  else dirs = BISHOP_DIRS.concat(ROOK_DIRS); // Q
  for (const [dr, dc] of dirs) {
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      const t = idx(nr, nc);
      if (!board[t]) pushMove(moves, from, t);
      else { if (colorOf(board[t]) !== color) pushMove(moves, from, t); break; }
      nr += dr; nc += dc;
    }
  }
  return moves;
}

function addPawnMove(moves, from, to, isPromo) {
  if (isPromo) {
    for (const pr of ['Q', 'R', 'B', 'N']) pushMove(moves, from, to, { promotion: pr });
  } else {
    pushMove(moves, from, to);
  }
}

function addCastling(state, color, moves) {
  const { board, castling } = state;
  const enemy = color === 'w' ? 'b' : 'w';
  if (color === 'w') {
    const homeK = idx(7, 4);
    if (board[homeK] !== 'K') return;
    if (kingInCheck(board, 'w')) return;
    // King-side: rook h1 (7,7), squares f1,g1 empty, king not through check
    if (castling.K && board[idx(7, 7)] === 'R' &&
        !board[idx(7, 5)] && !board[idx(7, 6)] &&
        !isSquareAttacked(board, idx(7, 5), enemy) &&
        !isSquareAttacked(board, idx(7, 6), enemy)) {
      pushMove(moves, homeK, idx(7, 6), { castle: 'K' });
    }
    // Queen-side: rook a1 (7,0), squares b1,c1,d1 empty, king through d1,c1 safe
    if (castling.Q && board[idx(7, 0)] === 'R' &&
        !board[idx(7, 1)] && !board[idx(7, 2)] && !board[idx(7, 3)] &&
        !isSquareAttacked(board, idx(7, 3), enemy) &&
        !isSquareAttacked(board, idx(7, 2), enemy)) {
      pushMove(moves, homeK, idx(7, 2), { castle: 'Q' });
    }
  } else {
    const homeK = idx(0, 4);
    if (board[homeK] !== 'k') return;
    if (kingInCheck(board, 'b')) return;
    if (castling.k && board[idx(0, 7)] === 'r' &&
        !board[idx(0, 5)] && !board[idx(0, 6)] &&
        !isSquareAttacked(board, idx(0, 5), enemy) &&
        !isSquareAttacked(board, idx(0, 6), enemy)) {
      pushMove(moves, homeK, idx(0, 6), { castle: 'k' });
    }
    if (castling.q && board[idx(0, 0)] === 'r' &&
        !board[idx(0, 1)] && !board[idx(0, 2)] && !board[idx(0, 3)] &&
        !isSquareAttacked(board, idx(0, 3), enemy) &&
        !isSquareAttacked(board, idx(0, 2), enemy)) {
      pushMove(moves, homeK, idx(0, 2), { castle: 'q' });
    }
  }
}

// --- Applying a move (board-level) ----------------------------------------
// Returns the new board AND the resulting ep / castling updates. Does NOT
// flip turn (the Durable Object flips turn after the twist).

function boardAfterMove(state, move) {
  const board = state.board.slice();
  const castling = { ...state.castling };
  let ep = null;
  const p = board[move.from];
  const color = colorOf(p);

  // En-passant capture removes the pawn behind the target
  if (move.enpassant) {
    const [tr, tc] = rc(move.to);
    const capRow = color === 'w' ? tr + 1 : tr - 1;
    board[idx(capRow, tc)] = null;
  }

  // Move the piece
  board[move.to] = p;
  board[move.from] = null;

  // Promotion
  if (move.promotion) {
    board[move.to] = color === 'w' ? move.promotion.toUpperCase() : move.promotion.toLowerCase();
  }

  // Castling: move the rook too
  if (move.castle === 'K') { board[idx(7, 5)] = 'R'; board[idx(7, 7)] = null; }
  else if (move.castle === 'Q') { board[idx(7, 3)] = 'R'; board[idx(7, 0)] = null; }
  else if (move.castle === 'k') { board[idx(0, 5)] = 'r'; board[idx(0, 7)] = null; }
  else if (move.castle === 'q') { board[idx(0, 3)] = 'r'; board[idx(0, 0)] = null; }

  // Double pawn push sets ep target
  if (move.double) {
    const [fr, fc] = rc(move.from);
    ep = idx(color === 'w' ? fr - 1 : fr + 1, fc);
  }

  // Update castling rights
  if (p === 'K') { castling.K = false; castling.Q = false; }
  if (p === 'k') { castling.k = false; castling.q = false; }
  if (move.from === idx(7, 0) || move.to === idx(7, 0)) castling.Q = false;
  if (move.from === idx(7, 7) || move.to === idx(7, 7)) castling.K = false;
  if (move.from === idx(0, 0) || move.to === idx(0, 0)) castling.q = false;
  if (move.from === idx(0, 7) || move.to === idx(0, 7)) castling.k = false;

  return { board, castling, ep };
}

// --- Legal move generation (filters own-king-in-check) --------------------

export function legalMovesFrom(state, from) {
  const p = state.board[from];
  if (!p || colorOf(p) !== state.turn) return [];
  const color = state.turn;
  const pseudo = pseudoMovesFrom(state, from);
  return pseudo.filter((m) => {
    const { board } = boardAfterMove(state, m);
    return !kingInCheck(board, color);
  });
}

export function allLegalMoves(state) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    if (state.board[i] && colorOf(state.board[i]) === state.turn) {
      for (const m of legalMovesFrom(state, i)) out.push(m);
    }
  }
  return out;
}

// Validate + apply a piece move from a client. `move` = {from, to, promotion?}.
// Returns { ok, state, move } or { ok:false, error }.
export function applyPieceMove(state, move) {
  const legal = legalMovesFrom(state, move.from);
  // Match on from/to (+ promotion if provided)
  const match = legal.find((m) =>
    m.to === move.to &&
    ((!m.promotion && !move.promotion) || m.promotion === (move.promotion || 'Q'))
  );
  if (!match) return { ok: false, error: 'illegal move' };
  const { board, castling, ep } = boardAfterMove(state, match);
  const next = { board, turn: state.turn, castling, ep };
  return { ok: true, state: next, move: match };
}

// --- The Twist ------------------------------------------------------------
// Rotate one 4x4 quadrant 90 degrees. dir: 'cw' or 'ccw'.
// Quadrants: TL = rows0-3/cols0-3, TR = rows0-3/cols4-7,
//            BL = rows4-7/cols0-3, BR = rows4-7/cols4-7.

function quadrantOrigin(q) {
  switch (q) {
    case 'TL': return [0, 0];
    case 'TR': return [0, 4];
    case 'BL': return [4, 0];
    case 'BR': return [4, 4];
    default: return null;
  }
}

export function boardAfterTwist(board, quadrant, dir) {
  const origin = quadrantOrigin(quadrant);
  if (!origin) throw new Error('bad quadrant');
  const [or, oc] = origin;
  const out = board.slice();
  // Extract 4x4
  const sub = [];
  for (let r = 0; r < 4; r++) {
    sub[r] = [];
    for (let c = 0; c < 4; c++) sub[r][c] = board[idx(or + r, oc + c)];
  }
  // Rotate
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let nv;
      if (dir === 'cw') nv = sub[3 - c][r];      // 90 clockwise
      else nv = sub[c][3 - r];                   // 90 counter-clockwise
      out[idx(or + r, oc + c)] = nv;
    }
  }
  return out;
}

// Apply a twist after a move. Returns { ok, state } or { ok:false, error }.
// A twist may not leave the twisting player's own king in check.
export function applyTwist(state, quadrant, dir, byColor) {
  if (!QUADRANTS.includes(quadrant)) return { ok: false, error: 'bad quadrant' };
  if (dir !== 'cw' && dir !== 'ccw') return { ok: false, error: 'bad direction' };
  const board = boardAfterTwist(state.board, quadrant, dir);
  if (kingInCheck(board, byColor)) return { ok: false, error: 'twist leaves your king in check' };
  const next = { board, turn: state.turn, castling: state.castling, ep: null };
  return { ok: true, state: next };
}

// Are there ANY legal twists for `byColor` after a move? (a twist is mandatory;
// if every twist self-checks, the only legal twists are those that don't).
export function legalTwists(state, byColor) {
  const out = [];
  for (const q of QUADRANTS) {
    for (const d of ['cw', 'ccw']) {
      const board = boardAfterTwist(state.board, q, d);
      if (!kingInCheck(board, byColor)) out.push({ quadrant: q, dir: d });
    }
  }
  return out;
}

// --- Status at the piece-move stage ---------------------------------------
// Call at the start of `color`'s move turn.
export function moveStageStatus(state) {
  const color = state.turn;
  const moves = allLegalMoves(state);
  const inCheck = kingInCheck(state.board, color);
  if (moves.length === 0) {
    return inCheck ? 'checkmate' : 'stalemate';
  }
  return inCheck ? 'check' : 'active';
}

export const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
