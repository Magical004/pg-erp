// SQLite database (built-in node:sqlite) with schema and helpers.
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.ERP_DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.ERP_DB || path.join(DATA_DIR, "erp.db");

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','accountant')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  floor INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'Non-AC' CHECK (type IN ('AC','Non-AC')),
  beds INTEGER NOT NULL CHECK (beds BETWEEN 1 AND 12),
  rent_per_bed INTEGER NOT NULL CHECK (rent_per_bed >= 0),
  UNIQUE (property_id, number)
);

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  id_proof TEXT NOT NULL DEFAULT '',
  emergency_contact TEXT NOT NULL DEFAULT '',
  room_id INTEGER REFERENCES rooms(id) ON DELETE RESTRICT,
  monthly_rent INTEGER NOT NULL CHECK (monthly_rent >= 0),
  deposit INTEGER NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  join_date TEXT NOT NULL,
  leave_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenants_room ON tenants(room_id, status);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period TEXT NOT NULL,                -- YYYY-MM
  description TEXT NOT NULL DEFAULT 'Monthly rent',
  amount INTEGER NOT NULL CHECK (amount >= 0),
  due_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, period, description)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','upi','bank','card','other')),
  paid_on TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  spent_on TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const get = (sql, ...p) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : null;
};
const run = (sql, ...p) => db.prepare(sql).run(...p);

// Runs fn inside a transaction; rolls back if it throws.
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function audit(user, action, entity, entityId, detail = "") {
  run(
    "INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)",
    user ? user.id : null,
    user ? user.name : "system",
    action,
    entity,
    entityId ?? null,
    String(detail).slice(0, 300)
  );
}

module.exports = { db, all, get, run, tx, audit, DB_FILE };
