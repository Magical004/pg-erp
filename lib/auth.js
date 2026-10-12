// Password hashing (scrypt), DB-backed sessions, role permissions, login throttling.
const crypto = require("crypto");
const { get, run, all } = require("./db");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE = "erp_session";

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
  run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)", sha(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function destroySession(token) {
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", sha(token));
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

function userFromRequest(req) {
  const token = sessionToken(req);
  if (!token) return null;
  return (
    get(
      `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
      sha(token),
      Date.now()
    ) || null
  );
}

function cookieHeader(token, secure) {
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  return `${COOKIE}=${token || ""}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

// Role -> resource -> allowed actions. Anything not listed is denied.
const PERMISSIONS = {
  admin: "*",
  manager: {
    dashboard: ["read"], properties: ["read", "write"], rooms: ["read", "write"], tenants: ["read", "write"],
    invoices: ["read"], payments: ["read"], expenses: ["read"], tickets: ["read", "write"], reports: ["read"],
  },
  accountant: {
    dashboard: ["read"], properties: ["read"], rooms: ["read"], tenants: ["read"], invoices: ["read", "write"],
    payments: ["read", "write"], expenses: ["read", "write"], tickets: ["read"], reports: ["read"],
  },
};

function can(user, resource, action) {
  const p = PERMISSIONS[user.role];
  if (p === "*") return true;
  return !!(p && p[resource] && p[resource].includes(action));
}

// Throttle failed logins per (ip, email): 5 failures -> 5 minute lockout.
const attempts = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

function throttled(key) {
  const a = attempts.get(key);
  return !!a && a.count >= MAX_FAILS && Date.now() - a.last < LOCK_MS;
}
function recordFail(key) {
  const a = attempts.get(key);
  const fresh = !a || Date.now() - a.last > LOCK_MS;
  attempts.set(key, { count: fresh ? 1 : a.count + 1, last: Date.now() });
}
function clearFails(key) {
  attempts.delete(key);
}

// First run: create an admin account with a random password (printed once).
function ensureAdmin() {
  if (get("SELECT 1 AS x FROM users LIMIT 1")) return null;
  const password = process.env.ERP_ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  const email = process.env.ERP_ADMIN_EMAIL || "admin@pg.local";
  run("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,'admin')", "Administrator", email, hashPassword(password));
  return { email, password, generated: !process.env.ERP_ADMIN_PASSWORD };
}

module.exports = {
  tokenHash: sha, hashPassword, verifyPassword, createSession, destroySession, sessionToken, userFromRequest,
  cookieHeader, can, throttled, recordFail, clearFails, ensureAdmin, PERMISSIONS, all,
};
