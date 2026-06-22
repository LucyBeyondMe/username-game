// store.js
// Persistent store backed by SQLite (Node's built-in node:sqlite module).
// Data survives server restarts — the database lives in a single file,
// game.db, sitting alongside this script.
//
// CONCURRENCY NOTE:
// node:sqlite's DatabaseSync runs synchronously on Node's single thread,
// same as the old in-memory Map did. The claim-checking logic below still
// has no `await` between checking availability and writing the row, BUT
// we no longer even rely on that ordering for correctness: the `value`
// column has a UNIQUE (PRIMARY KEY) constraint, so the database itself
// will reject a duplicate insert with a constraint-violation error.
// That's the authoritative guarantee now — the in-app check is just
// there to return a clean, fast "no" without throwing/catching in the
// common case.

const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('crypto');
const path = require('path');

const USERNAME_PATTERN = /^[A-Za-z0-9]{3,15}$/;
// In production (Render), DB_PATH points at the persistent disk mount
// (e.g. /data/game.db) so data survives redeploys. Locally, it defaults
// to a file right next to this script.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'game.db');

class Store {
  constructor(dbPath = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS usernames (
        value TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES players(id),
        claimed_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_usernames_owner ON usernames(owner_id);
    `);
  }

  _prepareStatements() {
    this.stmts = {
      insertPlayer: this.db.prepare('INSERT INTO players (id, created_at) VALUES (?, ?)'),
      insertToken: this.db.prepare('INSERT INTO tokens (token, player_id) VALUES (?, ?)'),
      getPlayerByToken: this.db.prepare(`
        SELECT players.id as id, players.created_at as createdAt
        FROM tokens JOIN players ON players.id = tokens.player_id
        WHERE tokens.token = ?
      `),
      playerExists: this.db.prepare('SELECT 1 FROM players WHERE id = ?'),
      usernameExists: this.db.prepare('SELECT 1 FROM usernames WHERE value = ?'),
      insertUsername: this.db.prepare(
        'INSERT INTO usernames (value, owner_id, claimed_at) VALUES (?, ?, ?)'
      ),
      getCollection: this.db.prepare(`
        SELECT value, owner_id as ownerId, claimed_at as claimedAt
        FROM usernames WHERE owner_id = ? ORDER BY claimed_at ASC
      `),
      countCollection: this.db.prepare('SELECT COUNT(*) as n FROM usernames WHERE owner_id = ?'),
      countAll: this.db.prepare('SELECT COUNT(*) as n FROM usernames'),
    };
  }

  // ---- Player lifecycle ----

  createPlayer() {
    const id = randomUUID();
    const token = randomUUID();
    const createdAt = Date.now();
    this.stmts.insertPlayer.run(id, createdAt);
    this.stmts.insertToken.run(token, id);
    return { player: { id, createdAt }, token };
  }

  getPlayerByToken(token) {
    const row = this.stmts.getPlayerByToken.get(token);
    return row || null;
  }

  // ---- Username claiming (the hot path) ----

  validateFormat(value) {
    if (typeof value !== 'string') return 'INVALID_TYPE';
    if (!USERNAME_PATTERN.test(value)) return 'INVALID_FORMAT';
    return null;
  }

  /**
   * Attempt to claim a username for a player.
   * Returns { success, reason? }.
   */
  claimUsername(playerId, value) {
    const formatError = this.validateFormat(value);
    if (formatError) {
      return { success: false, reason: formatError };
    }

    if (!this.stmts.playerExists.get(playerId)) {
      return { success: false, reason: 'UNKNOWN_PLAYER' };
    }

    // Fast-path check for a clean error message in the common case.
    if (this.stmts.usernameExists.get(value)) {
      return { success: false, reason: 'ALREADY_CLAIMED' };
    }

    // Authoritative guarantee: the PRIMARY KEY constraint on `value` means
    // even a same-millisecond duplicate attempt will be rejected here
    // with a thrown error, which we catch and translate.
    try {
      this.stmts.insertUsername.run(value, playerId, Date.now());
      return { success: true };
    } catch (err) {
      if (String(err.message).includes('UNIQUE constraint failed')) {
        return { success: false, reason: 'ALREADY_CLAIMED' };
      }
      throw err;
    }
  }

  getCollection(playerId) {
    return this.stmts.getCollection.all(playerId);
  }

  getTotalClaimedCount() {
    return this.stmts.countAll.get().n;
  }

  getPlayerCollectionCount(playerId) {
    return this.stmts.countCollection.get(playerId).n;
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store, USERNAME_PATTERN };
