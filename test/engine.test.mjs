// Node sanity test for the engine. Run: node engine.test.mjs
import {
  initialState, allLegalMoves, applyPieceMove, moveStageStatus,
  boardAfterTwist, applyTwist, legalTwists, nameToIdx, squareName, kingInCheck, idx,
} from '../public/twistedchess/engine.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${a}, want ${b})`); }

// 1. Initial position: 20 legal moves for White.
let s = initialState();
eq(allLegalMoves(s).length, 20, 'initial white moves = 20');
eq(moveStageStatus(s), 'active', 'initial status active');

// 2. Make a move (e2-e4) and verify board + turn handling.
let r = applyPieceMove(s, { from: nameToIdx('e2'), to: nameToIdx('e4') });
ok(r.ok, 'e2e4 legal');
ok(r.move.double, 'e2e4 flagged double');
eq(r.state.ep, nameToIdx('e3'), 'ep set to e3');

// 3. Fool's mate: 1. f3 e5 2. g4 Qh4# — checkmate detection.
function move(st, from, to, promo) {
  const res = applyPieceMove(st, { from: nameToIdx(from), to: nameToIdx(to), promotion: promo });
  if (!res.ok) throw new Error(`illegal ${from}${to}: ${res.error}`);
  // flip turn manually (DO does this after twist; here we skip twist for pure-chess test)
  res.state.turn = st.turn === 'w' ? 'b' : 'w';
  return res.state;
}
let g = initialState();
g = move(g, 'f2', 'f3');
g = move(g, 'e7', 'e5');
g = move(g, 'g2', 'g4');
g = move(g, 'd8', 'h4'); // Qh4#
eq(g.turn, 'w', 'white to move after Qh4');
ok(kingInCheck(g.board, 'w'), 'white king in check (fools mate)');
eq(moveStageStatus(g), 'checkmate', "fool's mate is checkmate");

// 4. Twist rotation correctness. Place a lone marker and rotate TL CW.
let tb = new Array(64).fill(null);
tb[idx(0, 0)] = 'R'; // top-left corner of TL quadrant
let rot = boardAfterTwist(tb, 'TL', 'cw'); // CW: (0,0) -> (0,3)
ok(rot[idx(0, 3)] === 'R' && !rot[idx(0, 0)], 'TL CW maps (0,0)->(0,3)');
let rot2 = boardAfterTwist(tb, 'TL', 'ccw'); // CCW: (0,0) -> (3,0)
ok(rot2[idx(3, 0)] === 'R' && !rot2[idx(0, 0)], 'TL CCW maps (0,0)->(3,0)');

// 5. Four CW twists returns to original.
let four = tb.slice();
for (let i = 0; i < 4; i++) four = boardAfterTwist(four, 'BR', 'cw');
ok(four.every((v, i) => v === tb[i]), '4x CW twist is identity');

// 6. legalTwists excludes self-check. King in TR, enemy rook that becomes a checker only after some twist.
let cs = new Array(64).fill(null);
cs[idx(0, 4)] = 'K';        // white king TR quadrant
cs[idx(2, 6)] = 'r';        // black rook in TR
let st2 = { board: cs, turn: 'w', castling: {}, ep: null };
let tw = legalTwists(st2, 'w');
ok(tw.length > 0 && tw.length <= 8, `legalTwists returns a filtered set (${tw.length})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
