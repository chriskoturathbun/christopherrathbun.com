import {
  legalMovesFrom, idx, rc, colorOf, squareName,
  initialState, applyPieceMove, applyTwist, legalTwists, moveStageStatus,
} from '/twistedchess/engine.js';

// Use the solid figurine glyphs for BOTH colours so the silhouettes are a
// consistent Staunton set; colour is carried entirely by the .w / .b class.
// U+FE0E (text variation selector) forces TEXT rendering: the pawn glyph
// U+265F otherwise renders as a dark colour emoji on iOS/Android, which
// ignores our CSS colour and makes White's pawns look black.
const VS = '︎';
const PIECES = {
  K: '♚' + VS, Q: '♛' + VS, R: '♜' + VS, B: '♝' + VS, N: '♞' + VS, P: '♟' + VS,
  k: '♚' + VS, q: '♛' + VS, r: '♜' + VS, b: '♝' + VS, n: '♞' + VS, p: '♟' + VS,
};

// --- persistent identity ---
function getPlayerId() {
  let id = localStorage.getItem('tc_pid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('tc_pid', id); }
  return id;
}
function getName() { return localStorage.getItem('tc_name') || ''; }
function setName(n) { localStorage.setItem('tc_name', n); }

const $ = (s) => document.querySelector(s);
const playerId = getPlayerId();

// --- app state ---
const App = {
  gameId: null,
  color: null,          // 'w' | 'b' | null (spectator)
  ws: null,
  state: null,          // last server state
  flip: false,          // board orientation override
  selected: null,       // selected square idx
  legalDests: [],       // [{to, ...}]
  clockOffset: 0,       // serverNow - localNow at last state
  prevTwistKey: null,
  reconnectTimer: null,
  local: false,         // pass-and-play (two players, one screen)
  lstate: null,         // local game state (same shape as server state)
  overlayDismissed: false,
};

// Which board colour sits at the bottom of the screen right now.
function bottomColor() {
  if (App.local) return App.flip ? 'b' : 'w';
  return App.color === 'b' ? 'b' : 'w';
}

// ---------------------------------------------------------------------------
// Screen routing
// ---------------------------------------------------------------------------
function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $('#screen-' + screen).classList.remove('hidden');
}

function boot() {
  const params = new URLSearchParams(location.search);
  App.gameId = params.get('g');
  wireLobby();
  wireGameUI();

  if (!App.gameId) { show('lobby'); $('#lobby-name').value = getName(); return; }

  // We have a game id. If we already have a name, connect straight away;
  // otherwise show the join screen (invited player).
  if (getName()) {
    connect();
  } else {
    show('join');
    $('#btn-join').onclick = () => {
      const n = $('#join-name').value.trim();
      if (!n) { $('#join-status').textContent = 'Please enter a name.'; return; }
      setName(n);
      connect();
    };
    $('#join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  }
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
function wireLobby() {
  $('#btn-create').onclick = async () => {
    const name = $('#lobby-name').value.trim();
    if (!name) { $('#lobby-name').focus(); return; }
    setName(name);
    const [m, s] = $('#lobby-time').value.split(':').map(Number);
    $('#btn-create').disabled = true;
    $('#btn-create').textContent = 'Creating…';
    try {
      const res = await fetch('/twistedchess/api/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseMinutes: m, incrementSeconds: s, creatorId: playerId, creatorName: name }),
      });
      const data = await res.json();
      if (!data.gameId) throw new Error('no game id');
      location.search = '?g=' + data.gameId;
    } catch (e) {
      $('#btn-create').disabled = false;
      $('#btn-create').textContent = 'Create game & get invite link';
      alert('Could not create game. Try again.');
    }
  };
  $('#lobby-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });

  $('#btn-local').onclick = () => {
    const [m, s] = $('#lobby-time').value.split(':').map(Number);
    startLocalGame(m * 60000, s * 1000);
  };
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connect() {
  show('game');
  buildBoardGrid();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/twistedchess/ws?g=${encodeURIComponent(App.gameId)}`);
  App.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', playerId, name: getName() || 'Anonymous' }));
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };
  ws.onclose = () => {
    setPhase('Disconnected — reconnecting…', 'wait');
    clearTimeout(App.reconnectTimer);
    App.reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => {};
}

function sendWS(obj) {
  if (App.ws && App.ws.readyState === WebSocket.OPEN) App.ws.send(JSON.stringify(obj));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      App.color = msg.color;
      App.flip = (msg.color === 'b'); // black sees its own pieces at the bottom
      break;
    case 'state':
      onState(msg);
      break;
    case 'chat':
      addChat(msg);
      break;
    case 'error':
      flashBanner(msg.error, 1400);
      break;
  }
}

// ---------------------------------------------------------------------------
// Board grid
// ---------------------------------------------------------------------------
function orientedIndices() {
  // returns array of 64 board indices in display order (row-major top-left)
  const out = [];
  if (App.flip) {
    for (let r = 7; r >= 0; r--) for (let c = 7; c >= 0; c--) out.push(idx(r, c));
  } else {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) out.push(idx(r, c));
  }
  return out;
}

function buildBoardGrid() {
  const board = $('#board');
  board.innerHTML = '';
  for (const i of orientedIndices()) {
    const [r, c] = rc(i);
    const sq = document.createElement('div');
    sq.className = 'sq ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
    sq.dataset.i = i;
    // quadrant dividers: between col 3|4 and row 3|4
    if (c === 3) sq.classList.add('qedge-r');
    if (r === 3) sq.classList.add('qedge-b');
    sq.addEventListener('click', () => onSquareClick(Number(sq.dataset.i)));
    board.appendChild(sq);
  }
  App._gridFlip = App.flip; // remember the orientation this grid was built for
}

function onState(s) {
  App.state = s;
  App.clockOffset = s.serverNow - Date.now();

  // twist animation when a new twist appears
  const twistKey = s.lastTwist ? `${s.history.length}:${s.lastTwist.quadrant}:${s.lastTwist.dir}` : null;
  const isNewTwist = twistKey && twistKey !== App.prevTwistKey && App.prevBoard;
  if (isNewTwist) {
    animateTwist(App.prevBoard, s.lastTwist);
  }
  App.prevTwistKey = twistKey;
  App.prevBoard = s.board.slice();

  renderBoard();
  renderPlayers();
  renderStatus();
  renderHistory();
  renderInvite();
  renderGameOver();
}

function renderBoard() {
  const s = App.state;
  // Rebuild the grid if orientation changed (e.g. after 'joined' flips Black's
  // board, or the Flip button) so click handlers map to the right squares.
  if (App._gridFlip !== App.flip) buildBoardGrid();
  const myTurn = isMyMoveTurn();
  $('#board').classList.toggle('my-turn', myTurn);

  const squares = $('#board').children;
  const order = orientedIndices();
  for (let k = 0; k < 64; k++) {
    const i = order[k];
    const sq = squares[k];
    const p = s.board[i];
    sq.className = 'sq ' + (((Math.floor(i/8) + (i%8)) % 2 === 0) ? 'light' : 'dark');
    const [r, c] = rc(i);
    if (c === 3) sq.classList.add('qedge-r');
    if (r === 3) sq.classList.add('qedge-b');
    sq.innerHTML = '';

    // coordinates on edge squares (display-relative)
    addCoords(sq, k, i);

    if (s.lastMove && (s.lastMove.from === i || s.lastMove.to === i)) sq.classList.add('lastmove');

    if (p) {
      const span = document.createElement('span');
      span.className = 'piece ' + (colorOf(p) === 'w' ? 'w' : 'b');
      span.textContent = PIECES[p];
      sq.appendChild(span);
      const mineColor = App.local ? (s.status === 'active' ? s.turn : null) : App.color;
      if (mineColor && colorOf(p) === mineColor) sq.classList.add('mine');
    }

    // king in check highlight
    if (s.check && s.status === 'active') {
      const king = s.turn === 'w' ? 'K' : 'k';
      if (p === king) sq.classList.add('check');
    }
  }

  // selection + destinations
  if (App.selected != null) {
    const selPos = order.indexOf(App.selected);
    if (selPos >= 0) squares[selPos].classList.add('sel');
    for (const m of App.legalDests) {
      const pos = order.indexOf(m.to);
      if (pos < 0) continue;
      squares[pos].classList.add('dest-host');
      const dot = document.createElement('div');
      dot.className = 'dest';
      if (s.board[m.to]) squares[pos].classList.add('capture');
      squares[pos].appendChild(dot);
    }
  }

  renderTwistLayer();
}

function addCoords(sq, k, i) {
  const file = k % 8, rank = Math.floor(k / 8);
  if (rank === 7) { // bottom row → file letters
    const el = document.createElement('span'); el.className = 'coord file';
    el.textContent = squareName(i)[0]; sq.appendChild(el);
  }
  if (file === 0) { // left col → rank numbers
    const el = document.createElement('span'); el.className = 'coord rank';
    el.textContent = squareName(i)[1]; sq.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Move interaction
// ---------------------------------------------------------------------------
function isMyMoveTurn() {
  const s = App.state;
  return s && s.status === 'active' && s.phase === 'move' && (App.local || s.turn === App.color);
}
function isMyTwistTurn() {
  const s = App.state;
  return s && s.status === 'active' && s.phase === 'twist' && (App.local || s.turn === App.color);
}

function engineState() {
  const s = App.state;
  return { board: s.board, turn: s.turn, castling: s.castling, ep: s.ep };
}

function onSquareClick(i) {
  if (!isMyMoveTurn()) return;
  const s = App.state;
  const p = s.board[i];

  // clicking a destination of the current selection
  if (App.selected != null) {
    const move = App.legalDests.find((m) => m.to === i);
    if (move) { commitMove(App.selected, i, move); return; }
  }

  // select own piece (in local play, "own" = the side to move)
  const myColor = App.local ? s.turn : App.color;
  if (p && colorOf(p) === myColor) {
    App.selected = i;
    App.legalDests = legalMovesFrom(engineState(), i);
    renderBoard();
    return;
  }
  // click elsewhere → clear
  App.selected = null; App.legalDests = [];
  renderBoard();
}

function commitMove(from, to, move) {
  const needsPromo = App.legalDests.filter((m) => m.to === to && m.promotion).length > 0;
  App.selected = null; App.legalDests = [];
  const sendMove = (piece) => {
    if (App.local) localMove(from, to, piece);
    else sendWS(piece ? { type: 'move', from, to, promotion: piece } : { type: 'move', from, to });
  };
  if (needsPromo) choosePromotion((piece) => sendMove(piece));
  else sendMove(null);
  renderBoard();
}

function choosePromotion(cb) {
  const row = $('#promo-row');
  row.innerHTML = '';
  const side = App.local ? App.state.turn : App.color;
  const opts = side === 'w' ? ['Q', 'R', 'B', 'N'] : ['q', 'r', 'b', 'n'];
  for (const o of opts) {
    const b = document.createElement('button');
    b.textContent = PIECES[o];
    b.onclick = () => { $('#promo').classList.add('hidden'); cb(o.toUpperCase()); };
    row.appendChild(b);
  }
  $('#promo').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Twist interaction
// ---------------------------------------------------------------------------
const QUAD_CLASS = { TL: 'tl', TR: 'tr', BL: 'bl', BR: 'br' };

// Map a logical quadrant to its on-screen position given orientation.
function displayQuad(q) {
  if (!App.flip) return q;
  const opp = { TL: 'BR', TR: 'BL', BL: 'TR', BR: 'TL' };
  return opp[q];
}

function renderTwistLayer() {
  const layer = $('#twist-layer');
  layer.innerHTML = '';
  if (!isMyTwistTurn()) { layer.classList.add('hidden'); return; }
  layer.classList.remove('hidden');

  // group legal twists by quadrant
  const byQuad = {};
  for (const t of (App.state.twistOptions || [])) {
    (byQuad[t.quadrant] = byQuad[t.quadrant] || []).push(t.dir);
  }
  for (const q of ['TL', 'TR', 'BL', 'BR']) {
    const dirs = byQuad[q];
    if (!dirs) continue;
    const dq = displayQuad(q);
    const wrap = document.createElement('div');
    wrap.className = 'twist-quad ' + QUAD_CLASS[dq] + ' glow';
    for (const dir of ['ccw', 'cw']) {
      if (!dirs.includes(dir)) continue;
      const btn = document.createElement('button');
      btn.className = 'twist-btn';
      btn.title = dir === 'cw' ? 'Twist clockwise' : 'Twist counter-clockwise';
      btn.textContent = dir === 'cw' ? '↻' : '↺';
      btn.onclick = () => { if (App.local) localTwist(q, dir); else sendWS({ type: 'twist', quadrant: q, dir }); };
      wrap.appendChild(btn);
    }
    layer.appendChild(wrap);
  }
}

// ---------------------------------------------------------------------------
// Twist animation
// ---------------------------------------------------------------------------
function quadOrigin(q) { return { TL:[0,0], TR:[0,4], BL:[4,0], BR:[4,4] }[q]; }

function animateTwist(prevBoard, twist) {
  const layer = $('#anim-layer');
  layer.innerHTML = '';
  const dq = displayQuad(twist.quadrant);
  const [or, oc] = quadOrigin(twist.quadrant);

  const quad = document.createElement('div');
  quad.className = 'anim-quad';
  // position by display quadrant
  if (dq === 'TL') { quad.style.left = '0'; quad.style.top = '0'; }
  if (dq === 'TR') { quad.style.right = '0'; quad.style.top = '0'; }
  if (dq === 'BL') { quad.style.left = '0'; quad.style.bottom = '0'; }
  if (dq === 'BR') { quad.style.right = '0'; quad.style.bottom = '0'; }

  // fill the 4x4 with prev pieces, in display order
  const rows = App.flip ? [3,2,1,0] : [0,1,2,3];
  const cols = App.flip ? [3,2,1,0] : [0,1,2,3];
  for (const r of rows) {
    for (const c of cols) {
      const cell = document.createElement('div');
      cell.className = 'ap';
      const p = prevBoard[idx(or + r, oc + c)];
      if (p) {
        const span = document.createElement('span');
        span.className = 'piece ' + (colorOf(p) === 'w' ? 'w' : 'b');
        span.textContent = PIECES[p];
        cell.appendChild(span);
      }
      quad.appendChild(cell);
    }
  }
  layer.appendChild(quad);

  // On screen, a logical CW twist appears CW when not flipped, CCW when flipped.
  let deg = twist.dir === 'cw' ? 90 : -90;
  if (App.flip) deg = -deg;
  quad.animate(
    [
      { transform: 'rotate(0deg)', opacity: 1 },
      { transform: `rotate(${deg}deg)`, opacity: 0.15 },
    ],
    { duration: 460, easing: 'cubic-bezier(.2,.7,.2,1)' }
  ).onfinish = () => { layer.innerHTML = ''; };
}

// ---------------------------------------------------------------------------
// Players + clocks
// ---------------------------------------------------------------------------
function renderPlayers() {
  const bc = bottomColor();
  setSeat('bottom', bc);
  setSeat('top', bc === 'w' ? 'b' : 'w');
}
function setSeat(pos, color) {
  const s = App.state;
  const pl = s.players[color];
  const name = pl ? pl.name : 'Waiting…';
  const on = color === 'w' ? s.connected.w : s.connected.b;
  let tag = '';
  if (!App.local && color === App.color) tag = ' (you)';
  if (App.local && s.status === 'active' && s.turn === color) tag = ' — to play';
  $(`#${pos}-name`).innerHTML = `<span class="dot ${on ? 'on' : ''}"></span>${escapeHtml(name)}${tag}`;
}

function tickClocks() {
  const s = App.state;
  if (!s) return;
  const bc = bottomColor();
  for (const [pos, color] of [['bottom', bc], ['top', bc === 'w' ? 'b' : 'w']]) {
    let ms = s.clock[color];
    if (s.running === color && s.turnStartedAt != null && s.status === 'active') {
      const now = Date.now() + App.clockOffset;
      ms = s.clock[color] - (now - s.turnStartedAt);
    }
    ms = Math.max(0, ms);
    // Local mode is its own authority: flag a flag-fall here.
    if (App.local && ms <= 0 && s.status === 'active' && s.running === color) {
      s.clock[color] = 0;
      s.status = 'finished';
      s.result = { type: 'timeout', winner: color === 'w' ? 'b' : 'w' };
      s.running = null; s.turnStartedAt = null;
      lRender();
      return;
    }
    const el = $(`#${pos}-clock`);
    el.textContent = fmtClock(ms);
    el.classList.toggle('low', ms < 20000 && s.status === 'active');
    $(`#bar-${pos}`).classList.toggle('active', s.running === color && s.status === 'active');
  }
}
function fmtClock(ms) {
  const t = Math.ceil(ms / 1000);
  const m = Math.floor(t / 60), sec = t % 60;
  if (m >= 1) return `${m}:${String(sec).padStart(2, '0')}`;
  // under a minute → show tenths
  const tenths = Math.floor((ms % 1000) / 100);
  return `0:${String(sec).padStart(2, '0')}.${tenths}`;
}

// ---------------------------------------------------------------------------
// Status / phase
// ---------------------------------------------------------------------------
function setPhase(text, cls) {
  const el = $('#phase-pill');
  el.textContent = text;
  el.className = 'phase-pill ' + (cls || '');
}
function renderStatus() {
  const s = App.state;
  $('#check-pill').classList.toggle('hidden', !(s.check && s.status === 'active'));

  if (s.status === 'waiting') { setPhase('Waiting for opponent…', 'wait'); return; }
  if (s.status === 'finished') { setPhase('Game over', 'wait'); return; }

  if (App.local) {
    const who = s.turn === 'w' ? 'White' : 'Black';
    if (s.phase === 'move') setPhase(s.check ? `${who} — escape check!` : `${who} to move`, 'act-move');
    else setPhase(`${who}: twist a quadrant ⤴`, 'act-twist');
    return;
  }
  if (App.color == null) {
    setPhase(`${s.turn === 'w' ? 'White' : 'Black'} to ${s.phase}`, 'wait');
    return;
  }
  if (s.turn === App.color) {
    if (s.phase === 'move') setPhase(s.check ? 'Your move — get out of check!' : 'Your move', 'act-move');
    else setPhase('Twist a quadrant! ⤴', 'act-twist');
  } else {
    setPhase(`Opponent's ${s.phase}…`, 'wait');
  }
}

// ---------------------------------------------------------------------------
// History / chat / invite
// ---------------------------------------------------------------------------
function renderHistory() {
  const ol = $('#history');
  ol.innerHTML = '';
  for (const h of App.state.history) {
    const li = document.createElement('li');
    const tw = h.twist ? `<span class="tw"> ⟳${h.twist.quadrant}${h.twist.dir === 'cw' ? '↻' : '↺'}</span>` : '';
    li.innerHTML = `${h.n}. <b>${h.color === 'w' ? '○' : '●'}</b> ${h.from}→${h.to}${tw}`;
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

function addChat(msg) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="who ${msg.color || ''}">${escapeHtml(msg.who)}:</span> ${escapeHtml(msg.text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function renderInvite() {
  const s = App.state;
  const show = s.status === 'waiting' && (App.color === 'w');
  $('#invite-box').classList.toggle('hidden', !show);
  if (show) $('#invite-link').value = location.origin + '/twistedchess?g=' + App.gameId;
}

function renderGameOver() {
  const s = App.state;
  if (s.status !== 'finished') {
    // New game (e.g. after rematch) — reset the dismiss state.
    $('#overlay').classList.add('hidden');
    $('#btn-result').classList.add('hidden');
    App.overlayDismissed = false;
    App._prevOther = false;
    return;
  }
  const r = s.result || {};
  let title = 'Game over', sub = '';
  const youWon = r.winner && r.winner === App.color;
  const winnerName = r.winner ? (s.players[r.winner] ? s.players[r.winner].name : (r.winner === 'w' ? 'White' : 'Black')) : null;
  if (r.type === 'checkmate') { title = 'Checkmate!'; sub = `${winnerName} wins.`; }
  else if (r.type === 'resign') { title = 'Resignation'; sub = `${winnerName} wins.`; }
  else if (r.type === 'timeout') { title = 'Flag fell'; sub = `${winnerName} wins on time.`; }
  else if (r.type === 'stalemate') { title = 'Stalemate'; sub = 'Draw.'; }
  if (App.color && r.winner) title = youWon ? '🏆 You win!' : 'You lost';
  $('#over-title').textContent = title;
  $('#over-sub').textContent = sub;

  const votes = s.rematchVotes || {};
  const mine = !!(App.color && votes[App.color]);
  const other = !!(App.color && votes[App.color === 'w' ? 'b' : 'w']);
  const btn = $('#btn-rematch');
  const st = $('#rematch-status');
  btn.classList.remove('glow');
  st.classList.remove('notify');
  if (App.local) {
    btn.style.display = '';
    btn.textContent = 'Play again';
    st.textContent = '';
  } else if (!App.color) {
    btn.style.display = 'none';
    st.textContent = '';
  } else if (other && !mine) {
    // Opponent has requested — make it an unmistakable call to action.
    btn.textContent = '✓ Accept rematch';
    btn.classList.add('glow');
    st.textContent = '🔁 Your opponent wants a rematch!';
    st.classList.add('notify');
  } else if (mine && !other) {
    btn.textContent = 'Rematch requested ✓';
    st.textContent = 'Waiting for your opponent to accept…';
  } else {
    btn.textContent = 'Rematch';
    st.textContent = '';
  }

  // If the opponent has *just* requested a rematch, re-surface the modal even
  // if the player had dismissed it to study the board.
  if (other && !mine && !App._prevOther) App.overlayDismissed = false;
  App._prevOther = other && !mine;

  if (App.overlayDismissed) {
    $('#overlay').classList.add('hidden');
    $('#btn-result').classList.remove('hidden');
  } else {
    $('#overlay').classList.remove('hidden');
    $('#btn-result').classList.add('hidden');
  }
}

function dismissOverlay() {
  App.overlayDismissed = true;
  $('#overlay').classList.add('hidden');
  if (App.state && App.state.status === 'finished') $('#btn-result').classList.remove('hidden');
}
function reopenOverlay() {
  App.overlayDismissed = false;
  renderGameOver();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function wireGameUI() {
  $('#btn-copy').onclick = async () => {
    const link = $('#invite-link').value;
    try { await navigator.clipboard.writeText(link); $('#btn-copy').textContent = 'Copied!'; setTimeout(() => $('#btn-copy').textContent = 'Copy', 1500); }
    catch { $('#invite-link').select(); }
  };
  $('#btn-resign').onclick = () => {
    if (!App.state || App.state.status !== 'active') return;
    if (App.local) {
      const who = App.state.turn === 'w' ? 'White' : 'Black';
      if (confirm(`${who} resigns this game?`)) localResign();
    } else if (App.color && confirm('Resign this game?')) {
      sendWS({ type: 'resign' });
    }
  };
  $('#btn-flip').onclick = () => { App.flip = !App.flip; buildBoardGrid(); renderBoard(); };
  $('#over-close').onclick = dismissOverlay;
  $('#btn-result').onclick = reopenOverlay;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#overlay').classList.contains('hidden') && App.state && App.state.status === 'finished') dismissOverlay();
  });
  $('#btn-rematch').onclick = () => { if (App.local) startLocalGame(App.lstate.base, App.lstate.increment); else sendWS({ type: 'rematch' }); };
  $('#btn-newgame').onclick = () => { location.href = '/twistedchess'; };
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const t = $('#chat-input').value.trim();
    if (t) { sendWS({ type: 'chat', text: t }); $('#chat-input').value = ''; }
  };
}

// ===========================================================================
// Local pass-and-play (two players, one screen). Runs the engine entirely in
// the browser; the board flips to face whoever is to move.
// ===========================================================================
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function startLocalGame(baseMs, incMs) {
  App.local = true;
  App.ws = null;
  App.color = null;
  App.selected = null; App.legalDests = [];
  App.flip = false; // White moves first, faces White
  App.overlayDismissed = false;
  const eng = initialState();
  const now = Date.now();
  App.lstate = {
    status: 'active', result: null,
    board: eng.board, turn: eng.turn, castling: eng.castling, ep: eng.ep,
    phase: 'move', check: false, lastMove: null, lastTwist: null,
    players: { w: { name: 'White' }, b: { name: 'Black' } },
    connected: { w: true, b: true, spectators: 0 },
    clock: { w: baseMs, b: baseMs }, increment: incMs, base: baseMs,
    running: 'w', turnStartedAt: now, serverNow: now,
    twistOptions: [], history: [], rematchVotes: {},
  };
  App.prevTwistKey = null;
  App.prevBoard = App.lstate.board.slice();
  show('game');
  $('#btn-flip').style.display = 'none'; // orientation is automatic in local play
  buildBoardGrid();
  lRender();
}

function lEngine() {
  const s = App.lstate;
  return { board: s.board, turn: s.turn, castling: s.castling, ep: s.ep };
}

function lRender() {
  App.state = App.lstate;
  App.clockOffset = 0;
  renderBoard();
  renderPlayers();
  renderStatus();
  renderHistory();
  renderInvite();
  renderGameOver();
}

function localMove(from, to, promotion) {
  const s = App.lstate;
  if (s.status !== 'active' || s.phase !== 'move') return;
  const res = applyPieceMove(lEngine(), { from, to, promotion });
  if (!res.ok) { flashBanner(res.error || 'Illegal move', 1200); return; }
  s.board = res.state.board; s.castling = res.state.castling; s.ep = res.state.ep;
  s.lastMove = { from: res.move.from, to: res.move.to };
  s.lastTwist = null;
  s.phase = 'twist';
  s.twistOptions = legalTwists(lEngine(), s.turn);
  App.selected = null; App.legalDests = [];
  lRender();
  if (s.twistOptions.length === 0) localFinishTurn(); // no legal twist: pass
}

function localTwist(quadrant, dir) {
  const s = App.lstate;
  if (s.status !== 'active' || s.phase !== 'twist') return;
  const prev = s.board.slice();
  const res = applyTwist(lEngine(), quadrant, dir, s.turn);
  if (!res.ok) { flashBanner(res.error || 'Illegal twist', 1400); return; }
  s.board = res.state.board; s.ep = null;
  s.lastTwist = { quadrant, dir };
  s.twistOptions = [];
  lRender();
  animateTwist(prev, { quadrant, dir });
  // Let the twist settle visually, then complete the turn and flip the board.
  setTimeout(() => localFinishTurn(), prefersReducedMotion() ? 0 : 500);
}

function localFinishTurn() {
  const s = App.lstate;
  if (s.status !== 'active') return;
  const mover = s.turn;
  const now = Date.now();
  if (s.turnStartedAt != null) {
    s.clock[mover] = Math.max(0, s.clock[mover] - (now - s.turnStartedAt)) + s.increment;
  }
  s.history.push({
    n: s.history.length + 1, color: mover,
    from: squareName(s.lastMove.from), to: squareName(s.lastMove.to),
    twist: s.lastTwist ? { ...s.lastTwist } : null,
  });
  const opp = mover === 'w' ? 'b' : 'w';
  s.turn = opp; s.phase = 'move';
  s.turnStartedAt = now; s.serverNow = now; s.running = opp;

  const status = moveStageStatus(lEngine());
  s.check = (status === 'check' || status === 'checkmate');
  if (status === 'checkmate') {
    s.status = 'finished'; s.result = { type: 'checkmate', winner: mover };
    s.running = null; s.turnStartedAt = null; lRender(); return;
  }
  if (status === 'stalemate') {
    s.status = 'finished'; s.result = { type: 'stalemate', winner: null };
    s.running = null; s.turnStartedAt = null; lRender(); return;
  }
  flipLocalOrientation(opp === 'b');
  if (!prefersReducedMotion()) setTimeout(() => flashBanner(`${opp === 'w' ? 'White' : 'Black'} to move`, 1000), 240);
}

function localResign() {
  const s = App.lstate;
  if (s.status !== 'active') return;
  s.status = 'finished';
  s.result = { type: 'resign', winner: s.turn === 'w' ? 'b' : 'w' };
  s.running = null; s.turnStartedAt = null;
  lRender();
}

// Flip the board to face the new player, with a card-flip transition.
function flipLocalOrientation(toFlip) {
  const stage = document.querySelector('.board-stage');
  if (!stage || prefersReducedMotion()) { App.flip = toFlip; buildBoardGrid(); lRender(); return; }
  stage.style.transition = 'transform .22s ease-in';
  stage.style.transform = 'perspective(1600px) rotateY(90deg)';
  setTimeout(() => {
    App.flip = toFlip;
    buildBoardGrid();
    lRender();
    stage.style.transition = 'transform .26s ease-out';
    stage.style.transform = 'perspective(1600px) rotateY(0deg)';
    setTimeout(() => { stage.style.transform = ''; stage.style.transition = ''; }, 320);
  }, 220);
}

function flashBanner(text, ms = 1200) {
  const b = $('#board-banner');
  b.textContent = text;
  b.classList.remove('hidden');
  clearTimeout(b._t);
  b._t = setTimeout(() => b.classList.add('hidden'), ms);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

setInterval(tickClocks, 100);
boot();
