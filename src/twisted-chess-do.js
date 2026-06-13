// TwistedChessGame — one Durable Object per game room.
// Authoritative game state + two-player WebSocket coordination + live clocks.
import { DurableObject } from 'cloudflare:workers';
import {
  initialState, applyPieceMove, applyTwist, legalTwists,
  moveStageStatus, kingInCheck, squareName,
} from '../public/twistedchess/engine.js';

const MAX_NAME = 24;
const MAX_CHAT = 280;

export class TwistedChessGame extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.game = null;
    ctx.blockConcurrencyWhile(async () => {
      this.game = await ctx.storage.get('game');
    });
  }

  async save() {
    await this.ctx.storage.put('game', this.game);
  }

  // --- HTTP: create + websocket upgrade ---
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname.endsWith('/create')) {
      const body = await request.json();
      return Response.json(this.createGame(body));
    }

    if (url.pathname.endsWith('/exists')) {
      return Response.json({ exists: !!this.game });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      if (!this.game) return new Response('no such game', { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  createGame({ baseMinutes = 5, incrementSeconds = 3, creatorId, creatorName } = {}) {
    if (this.game) return { ok: true, alreadyExists: true };
    const base = Math.min(Math.max(Number(baseMinutes) || 5, 1), 60) * 60_000;
    const inc = Math.min(Math.max(Number(incrementSeconds) || 0, 0), 60) * 1000;
    const creator = creatorId
      ? { id: String(creatorId).slice(0, 64), name: String(creatorName || 'Anonymous').slice(0, MAX_NAME).trim() || 'Anonymous' }
      : null;
    this.game = {
      status: 'waiting',          // waiting | active | finished
      result: null,               // {type, winner}
      players: { w: creator, b: null }, // {id, name}; creator plays White
      eng: initialState(),
      phase: 'move',              // move | twist
      lastMove: null,             // {from,to}
      lastTwist: null,            // {quadrant,dir}
      check: false,
      clock: { w: base, b: base },
      increment: inc,
      base,
      turnStartedAt: null,
      history: [],
      rematchVotes: {},
    };
    this.ctx.storage.put('game', this.game);
    return { ok: true };
  }

  // --- WebSocket lifecycle ---
  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    try {
      switch (msg.type) {
        case 'join': return this.handleJoin(ws, msg);
        case 'move': return this.handleMove(ws, att, msg);
        case 'twist': return this.handleTwist(ws, att, msg);
        case 'resign': return this.handleResign(ws, att);
        case 'rematch': return this.handleRematch(ws, att);
        case 'chat': return this.handleChat(ws, att, msg);
        default: return;
      }
    } catch (e) {
      this.send(ws, { type: 'error', error: String(e && e.message || e) });
    }
  }

  async webSocketClose(ws) {
    this.broadcastPresence();
  }
  async webSocketError(ws) {
    this.broadcastPresence();
  }

  handleJoin(ws, msg) {
    if (!this.game) { this.send(ws, { type: 'error', error: 'game not found' }); return; }
    const playerId = String(msg.playerId || '').slice(0, 64);
    const name = String(msg.name || 'Anonymous').slice(0, MAX_NAME).trim() || 'Anonymous';
    const g = this.game;
    let color = null;

    if (g.players.w && g.players.w.id === playerId) color = 'w';
    else if (g.players.b && g.players.b.id === playerId) color = 'b';
    else if (!g.players.w) { g.players.w = { id: playerId, name }; color = 'w'; }
    else if (!g.players.b) { g.players.b = { id: playerId, name }; color = 'b'; }
    else color = null; // spectator

    // refresh stored name
    if (color && g.players[color]) g.players[color].name = name;

    ws.serializeAttachment({ playerId, color });

    // Start the game when both seats are filled.
    if (g.status === 'waiting' && g.players.w && g.players.b) {
      g.status = 'active';
      g.turnStartedAt = Date.now();
      this.setTimeoutAlarm();
    }
    this.save();
    this.send(ws, { type: 'joined', color, you: name });
    this.broadcastState();
  }

  requireActor(ws, att) {
    if (!this.game) throw new Error('game not found');
    if (this.game.status !== 'active') throw new Error('game not active');
    if (!att.color) throw new Error('spectators cannot play');
    return att.color;
  }

  handleMove(ws, att, msg) {
    const color = this.requireActor(ws, att);
    const g = this.game;
    if (g.phase !== 'move') throw new Error('not the move phase');
    if (g.eng.turn !== color) throw new Error('not your turn');

    const from = Number(msg.from), to = Number(msg.to);
    const res = applyPieceMove(g.eng, { from, to, promotion: msg.promotion });
    if (!res.ok) throw new Error(res.error || 'illegal move');

    g.eng = res.state;
    g.lastMove = { from: res.move.from, to: res.move.to };
    g.lastTwist = null;
    g.phase = 'twist';
    // clock keeps running for the same player through the twist
    this.save();
    this.broadcastState();
  }

  handleTwist(ws, att, msg) {
    const color = this.requireActor(ws, att);
    const g = this.game;
    if (g.phase !== 'twist') throw new Error('not the twist phase');
    if (g.eng.turn !== color) throw new Error('not your turn');

    const res = applyTwist(g.eng, msg.quadrant, msg.dir, color);
    if (!res.ok) throw new Error(res.error || 'illegal twist');
    g.eng = res.state;
    g.lastTwist = { quadrant: msg.quadrant, dir: msg.dir };

    this.finishTurn(color);
  }

  // Called after a completed move+twist by `color`. Deduct clock, swap turn,
  // evaluate the opponent's move-stage status.
  finishTurn(color) {
    const g = this.game;
    const now = Date.now();
    if (g.turnStartedAt != null) {
      g.clock[color] = Math.max(0, g.clock[color] - (now - g.turnStartedAt));
      g.clock[color] += g.increment;
    }

    // record history
    g.history.push({
      n: g.history.length + 1,
      color,
      from: squareName(g.lastMove.from),
      to: squareName(g.lastMove.to),
      twist: g.lastTwist ? { ...g.lastTwist } : null,
    });

    // swap to opponent
    const opp = color === 'w' ? 'b' : 'w';
    g.eng = { ...g.eng, turn: opp };
    g.phase = 'move';
    g.turnStartedAt = now;

    const status = moveStageStatus(g.eng);
    g.check = (status === 'check' || status === 'checkmate');

    if (status === 'checkmate') {
      this.endGame({ type: 'checkmate', winner: color });
    } else if (status === 'stalemate') {
      this.endGame({ type: 'stalemate', winner: null });
    } else {
      this.setTimeoutAlarm();
      this.save();
      this.broadcastState();
    }
  }

  handleResign(ws, att) {
    const color = this.requireActor(ws, att);
    this.endGame({ type: 'resign', winner: color === 'w' ? 'b' : 'w' });
  }

  handleRematch(ws, att) {
    const g = this.game;
    if (!g || g.status !== 'finished') return;
    if (!att.color) return;
    g.rematchVotes[att.color] = true;
    if (g.rematchVotes.w && g.rematchVotes.b) {
      // swap colors and reset, keep same players
      const w = g.players.w, b = g.players.b;
      const base = g.base, inc = g.increment;
      const players = { w: b, b: w }; // swap sides
      this.game = {
        status: 'active', result: null, players,
        eng: initialState(), phase: 'move', lastMove: null, lastTwist: null,
        check: false, clock: { w: base, b: base }, increment: inc, base,
        turnStartedAt: Date.now(), history: [], rematchVotes: {},
      };
      this.setTimeoutAlarm();
      // Colors swapped — tell every socket its new color and refresh attachment.
      this.reseatSockets();
    }
    this.save();
    this.broadcastState();
  }

  // Recompute each connected socket's color from its playerId against the
  // current players map, update its attachment, and notify it. Used after a
  // rematch (which swaps sides) so clients re-orient correctly.
  reseatSockets() {
    const g = this.game;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      let color = null;
      if (g.players.w && g.players.w.id === a.playerId) color = 'w';
      else if (g.players.b && g.players.b.id === a.playerId) color = 'b';
      ws.serializeAttachment({ playerId: a.playerId, color });
      const name = color && g.players[color] ? g.players[color].name : (a.name || '');
      this.send(ws, { type: 'joined', color, you: name });
    }
  }

  handleChat(ws, att, msg) {
    const g = this.game;
    if (!g) return;
    const text = String(msg.text || '').slice(0, MAX_CHAT).trim();
    if (!text) return;
    let who = 'Spectator';
    if (att.color && g.players[att.color]) who = g.players[att.color].name;
    this.broadcast({ type: 'chat', who, color: att.color || null, text });
  }

  endGame(result) {
    const g = this.game;
    g.status = 'finished';
    g.result = result;
    g.turnStartedAt = null;
    this.ctx.storage.deleteAlarm();
    this.save();
    this.broadcastState();
  }

  // --- Clock timeout alarm ---
  setTimeoutAlarm() {
    const g = this.game;
    if (g.status !== 'active' || g.turnStartedAt == null) return;
    const active = g.eng.turn;
    const fireAt = g.turnStartedAt + g.clock[active];
    this.ctx.storage.setAlarm(fireAt);
  }

  async alarm() {
    const g = this.game;
    if (!g || g.status !== 'active' || g.turnStartedAt == null) return;
    const active = g.eng.turn;
    const remaining = g.clock[active] - (Date.now() - g.turnStartedAt);
    if (remaining <= 0) {
      g.clock[active] = 0;
      this.endGame({ type: 'timeout', winner: active === 'w' ? 'b' : 'w' });
    } else {
      this.setTimeoutAlarm(); // shouldn't happen, but reschedule defensively
    }
  }

  // --- Outgoing ---
  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch {}
    }
  }

  publicState() {
    const g = this.game;
    const twistOptions = (g.status === 'active' && g.phase === 'twist')
      ? legalTwists(g.eng, g.eng.turn) : [];
    let connected = { w: false, b: false, spectators: 0 };
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.color === 'w') connected.w = true;
      else if (a.color === 'b') connected.b = true;
      else connected.spectators++;
    }
    return {
      type: 'state',
      status: g.status,
      result: g.result,
      board: g.eng.board,
      turn: g.eng.turn,
      castling: g.eng.castling,
      ep: g.eng.ep,
      phase: g.phase,
      check: g.check,
      players: {
        w: g.players.w ? { name: g.players.w.name } : null,
        b: g.players.b ? { name: g.players.b.name } : null,
      },
      connected,
      lastMove: g.lastMove,
      lastTwist: g.lastTwist,
      clock: g.clock,
      increment: g.increment,
      running: g.status === 'active' ? g.eng.turn : null,
      turnStartedAt: g.turnStartedAt,
      serverNow: Date.now(),
      twistOptions,
      history: g.history.slice(-30),
      rematchVotes: g.rematchVotes,
    };
  }

  broadcastState() {
    this.broadcast(this.publicState());
  }
  broadcastPresence() {
    if (this.game) this.broadcastState();
  }
}
