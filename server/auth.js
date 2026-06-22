// auth.js
// Password hashing using Node's built-in crypto.scrypt — no external
// dependency needed. scrypt is deliberately slow/memory-hard, making
// brute-force attacks expensive even if the database were ever leaked.
//
// Each password gets its own random salt, so two players with the same
// password don't end up with the same stored hash (which would otherwise
// leak that fact to anyone with database access).

const crypto = require('crypto');

const SALT_BYTES = 16;
const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  // Store salt and hash together, separated by a marker, so verification
  // later knows which salt was used for this specific password.
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
  const [salt, originalHash] = storedValue.split(':');
  if (!salt || !originalHash) return false;
  const candidateHash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  // timingSafeEqual prevents an attacker from inferring how "close" a
  // guess was by measuring how long the comparison took.
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(originalHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const LOGIN_NAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

function validateLoginName(name) {
  if (typeof name !== 'string') return 'INVALID_TYPE';
  if (!LOGIN_NAME_PATTERN.test(name)) return 'INVALID_LOGIN_NAME';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return 'INVALID_TYPE';
  if (password.length < 8) return 'PASSWORD_TOO_SHORT';
  if (password.length > 200) return 'PASSWORD_TOO_LONG';
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  validateLoginName,
  validatePassword,
};
