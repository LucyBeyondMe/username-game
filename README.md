# Username Game — Prototype

Core engine for a real-time multiplayer game where players race to claim
unique usernames (3-15 chars, `[A-Za-z0-9]`, case-sensitive). Each player
has a permanent, separate Player ID and can hold an unlimited collection
of claimed usernames. Once claimed, a username is retired forever.

## Run it

```bash
npm install
npm start
```

Server listens on `ws://localhost:8080`.

Then open `client/index.html` directly in a browser (or serve it with any
static file server). Open it in two tabs to see the race-condition
handling in action — try claiming the same username from both at once.

## Architecture

- `server/store.js` — the authoritative data store, backed by SQLite
  (Node's built-in `node:sqlite` module — no extra install needed). Data
  lives in `server/game.db`, a single file that survives server
  restarts. All claim logic lives here.
- `server/server.js` — WebSocket connection handling and message protocol.
- `client/index.html` — minimal vanilla JS test client.

## Persistence

Claims are stored in `server/game.db` (created automatically on first
run). This file IS your game's save data — back it up before deploying
changes, and don't delete it unless you want to wipe every claim ever
made. If you ever want a clean slate, just delete `game.db` and a fresh
one will be created next time the server starts.

## Why claims are race-safe

Two layers of protection, both load-bearing:

1. Node.js runs JavaScript on a single thread, so `Store.claimUsername()`
   does its "is this taken? / if not, take it" logic synchronously with
   no `await` in between — no window where two requests can both see
   "unclaimed" at once.
2. The `usernames` table's `value` column is a PRIMARY KEY, so even if
   step 1's check somehow raced, the database itself would reject a
   second insert of the same value with a constraint-violation error,
   which the code catches and reports as `ALREADY_CLAIMED`.

That second layer is what makes this safe to eventually run with
multiple server processes (if this ever needs to scale beyond one Node
instance) — the guarantee comes from the database, not from JavaScript's
single-threadedness alone.

## Protocol (WebSocket, JSON messages)

**Client -> Server**
- `{ type: "hello", token?: string }` — establish or resume identity
- `{ type: "claim_username", value: string }` — attempt to claim
- `{ type: "get_my_usernames" }` — fetch full collection
- `{ type: "get_stats" }` — fetch counts

**Server -> Client**
- `{ type: "welcome", playerId, token, resumed, collection }`
- `{ type: "claim_result", value, success, reason?, collectionCount }`
- `{ type: "my_usernames", collection }`
- `{ type: "stats", totalClaimed, myCount }`
- `{ type: "error", reason }`

## Known v1 simplifications (by design, for now)

- No scoring/leaderboard yet — just the claim/collect mechanics.
- No profanity/content filtering — explicitly deferred per design.
- No global claim feed — claim feedback is private to the claiming
  player only.
- Single server process — no horizontal scaling yet. Fine until you have
  enough concurrent players that one Node process becomes the bottleneck.
- SQLite is great for one server instance, but isn't built for multiple
  servers writing to the same file at once. If this ever needs to run on
  more than one machine simultaneously, that's the point to move to a
  networked database (Postgres, etc.) — the unique-constraint pattern in
  `store.js` carries over directly.
