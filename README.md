# christopherrathbun.com

The Cloudflare Worker that powers [christopherrathbun.com](https://christopherrathbun.com) — a personal landing page plus **Twisted Chess**, a live two-player chess variant.

## ♞ Twisted Chess

Play at **[christopherrathbun.com/twistedchess](https://christopherrathbun.com/twistedchess)**.

Normal chess with one twist: after every piece move you must rotate one of the board's four 4×4 quadrants 90° (clockwise or counter-clockwise). Every piece in that quadrant rotates with it.

**Rules**
1. Make any legal chess move — all pieces move normally, including castling, en passant, and promotion.
2. Then **twist** one quadrant 90° in either direction. A twist may not leave your own king in check.
3. You win by delivering **checkmate at your opponent's move stage**, or on the clock.

**Features**
- Real-time two-player games over WebSockets, one room per game.
- Invite-link flow — create a game (you play White), share the `?g=<id>` link, opponent joins as Black.
- Live chess clocks with increment and flag-on-time.
- Legal-move highlighting, twist animation, move history, in-game chat, resign, and rematch.

## Architecture

| Piece | File |
|-------|------|
| Worker routing (landing, `/profile`, `/twistedchess`, API, WS upgrade) | `src/worker.js` |
| Game room — authoritative state, clocks, WebSocket coordination | `src/twisted-chess-do.js` (Durable Object) |
| Chess + twist engine (pure, shared by client & server) | `public/twistedchess/engine.js` |
| Game client (lobby, board, twist controls, timers) | `public/twistedchess/{index.html,app.js,style.css}` |
| Static landing assets | `public/index.html`, `public/profile.html` |

The chess engine is shared by the browser (for instant legal-move highlighting) and the Durable Object (which is authoritative). Its move generation is validated with **perft** — node counts match the canonical reference values through depth 4 (197,281 positions).

## Develop

```bash
npm install -g wrangler          # if not already installed
wrangler dev --config ./wrangler.toml --local
# open http://localhost:8787/twistedchess
```

Run the engine tests:

```bash
node test/engine.test.mjs
```

## Deploy

```bash
wrangler deploy --config ./wrangler.toml
```

> Deploying the Durable Object requires the Cloudflare account to have a workers.dev subdomain registered (a one-time setup in the Cloudflare dashboard under Workers & Pages).

## Stack

Cloudflare Workers · Durable Objects (SQLite) · Workers Assets · WebSockets · vanilla JS (no build step).

## Credits

Chess piece graphics: the [Cburnett SVG set](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces) by en:User:Cburnett, used under the BSD license.
