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
const { hashPassword, verifyPassword, validateLoginName, validatePassword } = require('./auth');

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
    this._migrateAddAccountColumns();
  }

  /**
   * Older databases (created before account support existed) won't have
   * login_name/password_hash columns. SQLite's ALTER TABLE ADD COLUMN is
   * safe to run repeatedly if we check first — this lets existing
   * deployments (with existing claimed usernames) gain account support
   * without losing any data.
   */
  _migrateAddAccountColumns() {
    const columns = this.db.prepare("PRAGMA table_info(players)").all();
    const columnNames = columns.map((c) => c.name);

    if (!columnNames.includes('login_name')) {
      this.db.exec('ALTER TABLE players ADD COLUMN login_name TEXT');
    }
    if (!columnNames.includes('password_hash')) {
      this.db.exec('ALTER TABLE players ADD COLUMN password_hash TEXT');
    }
    // Enforce uniqueness on login_name via a separate unique index rather
    // than a table-level constraint, since SQLite can't add a UNIQUE
    // constraint to an existing column with ALTER TABLE directly.
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_players_login_name ON players(login_name)'
    );
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
      setAccountCredentials: this.db.prepare(
        'UPDATE players SET login_name = ?, password_hash = ? WHERE id = ?'
      ),
      getPlayerByLoginName: this.db.prepare(
        'SELECT id, created_at as createdAt, login_name as loginName, password_hash as passwordHash FROM players WHERE login_name = ?'
      ),
      loginNameTaken: this.db.prepare('SELECT 1 FROM players WHERE login_name = ?'),
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

  // ---- Accounts (login name + password) ----

  /**
   * Create a brand-new account (not linked to any existing anonymous
   * play history). Returns { success, player?, token?, reason? }.
   */
  signup(loginName, password) {
    const nameError = validateLoginName(loginName);
    if (nameError) return { success: false, reason: nameError };

    const passwordError = validatePassword(password);
    if (passwordError) return { success: false, reason: passwordError };

    if (this.stmts.loginNameTaken.get(loginName)) {
      return { success: false, reason: 'LOGIN_NAME_TAKEN' };
    }

    const { player, token } = this.createPlayer();
    const passwordHash = hashPassword(password);

    try {
      this.stmts.setAccountCredentials.run(loginName, passwordHash, player.id);
    } catch (err) {
      if (String(err.message).includes('UNIQUE constraint failed')) {
        return { success: false, reason: 'LOGIN_NAME_TAKEN' };
      }
      throw err;
    }

    return { success: true, player, token };
  }

  /**
   * Attach a login name + password to an ALREADY EXISTING player (e.g.
   * an anonymous session that claimed usernames before signing up), so
   * that play history is preserved rather than starting over.
   */
  attachAccountToPlayer(playerId, loginName, password) {
    const nameError = validateLoginName(loginName);
    if (nameError) return { success: false, reason: nameError };

    const passwordError = validatePassword(password);
    if (passwordError) return { success: false, reason: passwordError };

    if (!this.stmts.playerExists.get(playerId)) {
      return { success: false, reason: 'UNKNOWN_PLAYER' };
    }

    const passwordHash = hashPassword(password);
    try {
      this.stmts.setAccountCredentials.run(loginName, passwordHash, playerId);
    } catch (err) {
      if (String(err.message).includes('UNIQUE constraint failed')) {
        return { success: false, reason: 'LOGIN_NAME_TAKEN' };
      }
      throw err;
    }
    return { success: true };
  }

  /**
   * Verify credentials and, if correct, issue a fresh session token for
   * that player. Returns { success, player?, token?, reason? }.
   */
  login(loginName, password) {
    const row = this.stmts.getPlayerByLoginName.get(loginName);
    if (!row || !row.passwordHash) {
      return { success: false, reason: 'INVALID_CREDENTIALS' };
    }
    if (!verifyPassword(password, row.passwordHash)) {
      return { success: false, reason: 'INVALID_CREDENTIALS' };
    }

    const token = randomUUID();
    this.stmts.insertToken.run(token, row.id);
    return {
      success: true,
      player: { id: row.id, createdAt: row.createdAt },
      token,
    };
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
