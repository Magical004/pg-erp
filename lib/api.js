// REST API: route table + business rules. Each route declares the resource/action it needs.
const { all, get, run, tx, audit } = require("./db");
const auth = require("./auth");
const { validate, ValidationError, today, thisMonth, validDate } = require("./validate");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const notFound = (what = "Record") => new HttpError(404, `${what} not found`);

/* ---------- helpers ---------- */

function insert(table, obj) {
  const keys = Object.keys(obj);
  const r = run(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => obj[k]));
  return Number(r.lastInsertRowid);
}

function update(table, id, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(",")} WHERE id = ?`, ...keys.map((k) => obj[k]), id);
}

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw notFound();
  return n;
};

function monthBounds(period) {
  const [y, m] = period.split("-").map(Number);
  const start = `${period}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${period}-${String(last).padStart(2, "0")}` };
}

function addMonths(period, n) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.label)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key])).join(","));
  return { csv: lines.join("\r\n") + "\r\n" };
}

const INVOICE_SELECT = `
  SELECT i.id, i.tenant_id, t.name AS tenant_name, r.number AS room, pr.name AS property,
         i.period, i.description, i.amount, i.due_date,
         COALESCE(p.paid, 0) AS paid, i.amount - COALESCE(p.paid, 0) AS balance,
         CASE WHEN COALESCE(p.paid, 0) >= i.amount THEN 'paid'
              WHEN i.due_date < date('now') THEN 'overdue'
              WHEN COALESCE(p.paid, 0) > 0 THEN 'partial'
              ELSE 'unpaid' END AS status
  FROM invoices i
  JOIN tenants t ON t.id = i.tenant_id
  LEFT JOIN rooms r ON r.id = t.room_id
  LEFT JOIN properties pr ON pr.id = r.property_id
  LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id`;

const ROOM_SELECT = `
  SELECT r.*, p.name AS property,
         (SELECT COUNT(*) FROM tenants t WHERE t.room_id = r.id AND t.status = 'active') AS occupied
  FROM rooms r JOIN properties p ON p.id = r.property_id`;

const TENANT_SELECT = `
  SELECT t.*, r.number AS room, p.name AS property, p.id AS property_id
  FROM tenants t LEFT JOIN rooms r ON r.id = t.room_id LEFT JOIN properties p ON p.id = r.property_id`;

/* ---------- validation specs ---------- */

const S = {
  property: {
    name: { type: "string", required: true, max: 100, label: "Name" },
    address: { type: "string", max: 300, label: "Address" },
    city: { type: "string", max: 80, label: "City" },
  },
  room: {
    property_id: { type: "int", required: true, min: 1, label: "Property" },
    number: { type: "string", required: true, max: 20, label: "Room number" },
    floor: { type: "int", min: -2, max: 100, default: 0, label: "Floor" },
    type: { type: "enum", values: ["AC", "Non-AC"], default: "Non-AC", label: "Type" },
    beds: { type: "int", required: true, min: 1, max: 12, label: "Beds" },
    rent_per_bed: { type: "int", required: true, min: 0, max: 1000000, label: "Rent per bed" },
  },
  tenant: {
    name: { type: "string", required: true, max: 100, label: "Name" },
    phone: { type: "phone", required: true, label: "Phone" },
    email: { type: "email", label: "Email" },
    id_proof: { type: "string", max: 100, label: "ID proof" },
    emergency_contact: { type: "string", max: 100, label: "Emergency contact" },
    room_id: { type: "int", required: true, min: 1, label: "Room" },
    monthly_rent: { type: "optionalInt", min: 0, max: 1000000, label: "Monthly rent" },
    deposit: { type: "int", min: 0, max: 10000000, default: 0, label: "Deposit" },
    join_date: { type: "date", required: true, label: "Join date" },
  },
  invoice: {
    tenant_id: { type: "int", required: true, min: 1, label: "Tenant" },
    period: { type: "month", required: true, label: "Period" },
    description: { type: "string", max: 100, default: "Monthly rent", label: "Description" },
    amount: { type: "int", required: true, min: 0, max: 10000000, label: "Amount" },
    due_date: { type: "date", required: true, label: "Due date" },
  },
  payment: {
    invoice_id: { type: "int", required: true, min: 1, label: "Invoice" },
    amount: { type: "int", required: true, min: 1, max: 10000000, label: "Amount" },
    method: { type: "enum", values: ["cash", "upi", "bank", "card", "other"], required: true, label: "Method" },
    paid_on: { type: "date", label: "Paid on" },
    reference: { type: "string", max: 100, label: "Reference" },
  },
  expense: {
    property_id: { type: "optionalInt", min: 1, label: "Property" },
    category: { type: "string", required: true, max: 50, label: "Category" },
    amount: { type: "int", required: true, min: 1, max: 100000000, label: "Amount" },
    spent_on: { type: "date", required: true, label: "Date" },
    description: { type: "string", max: 300, label: "Description" },
  },
  ticket: {
    property_id: { type: "int", required: true, min: 1, label: "Property" },
    room_id: { type: "optionalInt", min: 1, label: "Room" },
    title: { type: "string", required: true, max: 120, label: "Title" },
    description: { type: "string", max: 1000, label: "Description" },
    priority: { type: "enum", values: ["low", "medium", "high"], default: "medium", label: "Priority" },
    status: { type: "enum", values: ["open", "in_progress", "resolved"], default: "open", label: "Status" },
  },
  userCreate: {
    name: { type: "string", required: true, max: 80, label: "Name" },
    email: { type: "email", required: true, label: "Email" },
    role: { type: "enum", values: ["admin", "manager", "accountant"], required: true, label: "Role" },
    password: { type: "string", required: true, max: 100, label: "Password" },
  },
  userUpdate: {
    name: { type: "string", max: 80, label: "Name" },
    role: { type: "enum", values: ["admin", "manager", "accountant"], label: "Role" },
    active: { type: "int", min: 0, max: 1, label: "Active" },
    password: { type: "string", max: 100, label: "Password" },
  },
};

/* ---------- business rules ---------- */

function roomOrFail(id) {
  const room = get("SELECT * FROM rooms WHERE id = ?", id);
  if (!room) throw new ValidationError("Room does not exist");
  return room;
}

function occupancy(roomId, excludeTenantId = 0) {
  return get("SELECT COUNT(*) AS n FROM tenants WHERE room_id = ? AND status = 'active' AND id != ?", roomId, excludeTenantId).n;
}

function assertCapacity(room, excludeTenantId = 0) {
  if (occupancy(room.id, excludeTenantId) >= room.beds) throw new HttpError(409, `Room ${room.number} is full (${room.beds} beds)`);
}

function assertProperty(id, label = "Property") {
  if (id != null && !get("SELECT 1 AS x FROM properties WHERE id = ?", id)) throw new ValidationError(`${label} does not exist`);
}

function minPassword(pw) {
  if (pw.length < 8) throw new ValidationError("Password must be at least 8 characters");
}

/* ---------- handlers ---------- */

const R = []; // { method, re, keys, resource, action, fn }
function route(method, pattern, resource, action, fn) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  R.push({ method, re, keys, resource, action, fn });
}

// Properties
route("GET", "/api/properties", "properties", "read", () =>
  all(`SELECT p.*, (SELECT COUNT(*) FROM rooms r WHERE r.property_id = p.id) AS rooms,
              (SELECT COALESCE(SUM(beds),0) FROM rooms r WHERE r.property_id = p.id) AS beds,
              (SELECT COUNT(*) FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE r.property_id = p.id AND t.status='active') AS occupied
       FROM properties p ORDER BY p.name`)
);
route("POST", "/api/properties", "properties", "write", ({ body, user }) => {
  const v = validate(body, S.property);
  const id = insert("properties", v);
  audit(user, "create", "property", id, v.name);
  return { status: 201, data: get("SELECT * FROM properties WHERE id = ?", id) };
});
route("PUT", "/api/properties/:id", "properties", "write", ({ params, body, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM properties WHERE id = ?", id)) throw notFound("Property");
  update("properties", id, validate(body, S.property, { partial: true }));
  audit(user, "update", "property", id);
  return get("SELECT * FROM properties WHERE id = ?", id);
});
route("DELETE", "/api/properties/:id", "properties", "write", ({ params, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM properties WHERE id = ?", id)) throw notFound("Property");
  run("DELETE FROM properties WHERE id = ?", id);
  audit(user, "delete", "property", id);
  return { ok: true };
});

// Rooms
route("GET", "/api/rooms", "rooms", "read", ({ query }) => {
  const pid = query.property_id ? idParam(query.property_id) : null;
  return all(`${ROOM_SELECT} ${pid ? "WHERE r.property_id = ?" : ""} ORDER BY p.name, r.floor, r.number`, ...(pid ? [pid] : []));
});
route("POST", "/api/rooms", "rooms", "write", ({ body, user }) => {
  const v = validate(body, S.room);
  assertProperty(v.property_id);
  const id = insert("rooms", v);
  audit(user, "create", "room", id, v.number);
  return { status: 201, data: get(`${ROOM_SELECT} WHERE r.id = ?`, id) };
});
route("PUT", "/api/rooms/:id", "rooms", "write", ({ params, body, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM rooms WHERE id = ?", id)) throw notFound("Room");
  const v = validate(body, S.room, { partial: true });
  if (v.property_id !== undefined) assertProperty(v.property_id);
  if (v.beds !== undefined && v.beds < occupancy(id)) throw new HttpError(409, "Beds cannot be fewer than current occupants");
  update("rooms", id, v);
  audit(user, "update", "room", id);
  return get(`${ROOM_SELECT} WHERE r.id = ?`, id);
});
route("DELETE", "/api/rooms/:id", "rooms", "write", ({ params, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM rooms WHERE id = ?", id)) throw notFound("Room");
  run("DELETE FROM rooms WHERE id = ?", id);
  audit(user, "delete", "room", id);
  return { ok: true };
});

// Tenants
route("GET", "/api/tenants", "tenants", "read", ({ query }) => {
  const where = [];
  const p = [];
  if (query.status === "active" || query.status === "left") (where.push("t.status = ?"), p.push(query.status));
  if (query.q) (where.push("(t.name LIKE ? OR t.phone LIKE ?)"), p.push(`%${query.q}%`, `%${query.q}%`));
  return all(`${TENANT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.status, t.name`, ...p);
});
route("GET", "/api/tenants/:id", "tenants", "read", ({ params }) => {
  const id = idParam(params.id);
  const t = get(`${TENANT_SELECT} WHERE t.id = ?`, id);
  if (!t) throw notFound("Tenant");
  t.invoices = all(`${INVOICE_SELECT} WHERE i.tenant_id = ? ORDER BY i.period DESC`, id);
  t.balance = t.invoices.reduce((s, i) => s + i.balance, 0);
  return t;
});
route("POST", "/api/tenants", "tenants", "write", ({ body, user }) =>
  tx(() => {
    const v = validate(body, S.tenant);
    const room = roomOrFail(v.room_id);
    assertCapacity(room);
    if (v.monthly_rent == null) v.monthly_rent = room.rent_per_bed;
    const id = insert("tenants", v);
    audit(user, "create", "tenant", id, v.name);
    return { status: 201, data: get(`${TENANT_SELECT} WHERE t.id = ?`, id) };
  })
);
route("PUT", "/api/tenants/:id", "tenants", "write", ({ params, body, user }) =>
  tx(() => {
    const id = idParam(params.id);
    const cur = get("SELECT * FROM tenants WHERE id = ?", id);
    if (!cur) throw notFound("Tenant");
    const v = validate(body, S.tenant, { partial: true });
    if (v.monthly_rent === null) delete v.monthly_rent;
    if (v.room_id !== undefined && v.room_id !== cur.room_id && cur.status === "active") assertCapacity(roomOrFail(v.room_id), id);
    update("tenants", id, v);
    audit(user, "update", "tenant", id);
    return get(`${TENANT_SELECT} WHERE t.id = ?`, id);
  })
);
route("POST", "/api/tenants/:id/checkout", "tenants", "write", ({ params, body, user }) =>
  tx(() => {
    const id = idParam(params.id);
    const t = get("SELECT * FROM tenants WHERE id = ?", id);
    if (!t) throw notFound("Tenant");
    if (t.status === "left") throw new HttpError(409, "Tenant has already checked out");
    const { leave_date } = validate(body || {}, { leave_date: { type: "date", label: "Leave date" } });
    const when = leave_date || today();
    if (when < t.join_date) throw new ValidationError("Leave date is before join date");
    update("tenants", id, { status: "left", leave_date: when });
    const due = get(`SELECT COALESCE(SUM(balance),0) AS b FROM (${INVOICE_SELECT}) WHERE tenant_id = ?`, id).b;
    audit(user, "checkout", "tenant", id, `${t.name} left ${when}, dues ${due}`);
    return { ...get(`${TENANT_SELECT} WHERE t.id = ?`, id), outstanding: due };
  })
);
route("DELETE", "/api/tenants/:id", "tenants", "write", ({ params, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM tenants WHERE id = ?", id)) throw notFound("Tenant");
  if (get("SELECT 1 AS x FROM invoices WHERE tenant_id = ?", id)) throw new HttpError(409, "Tenant has invoices; check them out instead of deleting");
  run("DELETE FROM tenants WHERE id = ?", id);
  audit(user, "delete", "tenant", id);
  return { ok: true };
});

// Invoices
route("GET", "/api/invoices", "invoices", "read", ({ query }) => {
  const where = [];
  const p = [];
  if (query.period) (where.push("i.period = ?"), p.push(query.period));
  if (query.tenant_id) (where.push("i.tenant_id = ?"), p.push(idParam(query.tenant_id)));
  let sql = `${INVOICE_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.period DESC, t.name`;
  if (query.status) sql = `SELECT * FROM (${sql.replace(/ ORDER BY.*$/s, "")}) WHERE status = ? ORDER BY period DESC, tenant_name`;
  return all(sql, ...p, ...(query.status ? [query.status] : []));
});
route("POST", "/api/invoices", "invoices", "write", ({ body, user }) => {
  const v = validate(body, S.invoice);
  if (!get("SELECT 1 AS x FROM tenants WHERE id = ?", v.tenant_id)) throw new ValidationError("Tenant does not exist");
  const id = insert("invoices", v);
  audit(user, "create", "invoice", id, `${v.period} ${v.amount}`);
  return { status: 201, data: get(`${INVOICE_SELECT} WHERE i.id = ?`, id) };
});
route("POST", "/api/invoices/generate", "invoices", "write", ({ body, user }) =>
  tx(() => {
    const v = validate(body, {
      period: { type: "month", required: true, label: "Period" },
      due_day: { type: "int", min: 1, max: 28, default: 5, label: "Due day" },
    });
    const { start, end } = monthBounds(v.period);
    const tenants = all(
      "SELECT id, monthly_rent FROM tenants WHERE join_date <= ? AND (leave_date IS NULL OR leave_date >= ?)",
      end,
      start
    );
    const due = `${v.period}-${String(v.due_day ?? 5).padStart(2, "0")}`;
    let created = 0;
    for (const t of tenants) {
      const r = run(
        "INSERT OR IGNORE INTO invoices (tenant_id, period, description, amount, due_date) VALUES (?,?,?,?,?)",
        t.id, v.period, "Monthly rent", t.monthly_rent, due
      );
      created += r.changes;
    }
    audit(user, "generate", "invoice", null, `${v.period}: ${created} created, ${tenants.length - created} existing`);
    return { period: v.period, created, skipped: tenants.length - created };
  })
);
route("DELETE", "/api/invoices/:id", "invoices", "write", ({ params, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM invoices WHERE id = ?", id)) throw notFound("Invoice");
  if (get("SELECT 1 AS x FROM payments WHERE invoice_id = ?", id)) throw new HttpError(409, "Invoice has payments and cannot be deleted");
  run("DELETE FROM invoices WHERE id = ?", id);
  audit(user, "delete", "invoice", id);
  return { ok: true };
});

// Payments
route("GET", "/api/payments", "payments", "read", ({ query }) => {
  const p = [];
  let where = "";
  if (query.invoice_id) (where = "WHERE p.invoice_id = ?", p.push(idParam(query.invoice_id)));
  return all(
    `SELECT p.*, i.period, t.name AS tenant_name, u.name AS recorded_by
     FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN tenants t ON t.id = i.tenant_id
     LEFT JOIN users u ON u.id = p.created_by ${where} ORDER BY p.paid_on DESC, p.id DESC LIMIT 500`,
    ...p
  );
});
route("POST", "/api/payments", "payments", "write", ({ body, user }) =>
  tx(() => {
    const v = validate(body, S.payment);
    const inv = get(`${INVOICE_SELECT} WHERE i.id = ?`, v.invoice_id);
    if (!inv) throw new ValidationError("Invoice does not exist");
    if (v.amount > inv.balance) throw new ValidationError(`Amount exceeds the balance due (${inv.balance})`);
    v.paid_on = v.paid_on || today();
    if (v.paid_on > today()) throw new ValidationError("Payment date cannot be in the future");
    v.created_by = user.id;
    const id = insert("payments", v);
    audit(user, "create", "payment", id, `${inv.tenant_name} ${v.amount} ${v.method}`);
    return { status: 201, data: get("SELECT * FROM payments WHERE id = ?", id) };
  })
);
route("DELETE", "/api/payments/:id", "users", "write", ({ params, user }) => {
  // Reversing a payment is admin-only (reuses the admin-only "users" resource).
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM payments WHERE id = ?", id)) throw notFound("Payment");
  run("DELETE FROM payments WHERE id = ?", id);
  audit(user, "delete", "payment", id, "payment reversed");
  return { ok: true };
});

// Expenses
route("GET", "/api/expenses", "expenses", "read", () =>
  all(`SELECT e.*, p.name AS property FROM expenses e LEFT JOIN properties p ON p.id = e.property_id ORDER BY e.spent_on DESC, e.id DESC LIMIT 500`)
);
route("POST", "/api/expenses", "expenses", "write", ({ body, user }) => {
  const v = validate(body, S.expense);
  assertProperty(v.property_id);
  v.created_by = user.id;
  const id = insert("expenses", v);
  audit(user, "create", "expense", id, `${v.category} ${v.amount}`);
  return { status: 201, data: get("SELECT * FROM expenses WHERE id = ?", id) };
});
route("PUT", "/api/expenses/:id", "expenses", "write", ({ params, body, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM expenses WHERE id = ?", id)) throw notFound("Expense");
  const v = validate(body, S.expense, { partial: true });
  if (v.property_id !== undefined) assertProperty(v.property_id);
  update("expenses", id, v);
  audit(user, "update", "expense", id);
  return get("SELECT * FROM expenses WHERE id = ?", id);
});
route("DELETE", "/api/expenses/:id", "expenses", "write", ({ params, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM expenses WHERE id = ?", id)) throw notFound("Expense");
  run("DELETE FROM expenses WHERE id = ?", id);
  audit(user, "delete", "expense", id);
  return { ok: true };
});

// Maintenance tickets
const TICKET_SELECT = `SELECT k.*, p.name AS property, r.number AS room FROM tickets k
  JOIN properties p ON p.id = k.property_id LEFT JOIN rooms r ON r.id = k.room_id`;
route("GET", "/api/tickets", "tickets", "read", () =>
  all(`${TICKET_SELECT} ORDER BY k.status = 'resolved', CASE k.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, k.created_at DESC`)
);
route("POST", "/api/tickets", "tickets", "write", ({ body, user }) => {
  const v = validate(body, S.ticket);
  assertProperty(v.property_id);
  if (v.room_id && !get("SELECT 1 AS x FROM rooms WHERE id = ? AND property_id = ?", v.room_id, v.property_id))
    throw new ValidationError("Room does not belong to that property");
  v.created_by = user.id;
  if (v.status === "resolved") v.resolved_at = new Date().toISOString().slice(0, 19).replace("T", " ");
  const id = insert("tickets", v);
  audit(user, "create", "ticket", id, v.title);
  return { status: 201, data: get(`${TICKET_SELECT} WHERE k.id = ?`, id) };
});
route("PUT", "/api/tickets/:id", "tickets", "write", ({ params, body, user }) => {
  const id = idParam(params.id);
  const cur = get("SELECT * FROM tickets WHERE id = ?", id);
  if (!cur) throw notFound("Ticket");
  const v = validate(body, S.ticket, { partial: true });
  if (v.property_id !== undefined) assertProperty(v.property_id);
  if (v.status && v.status !== cur.status) v.resolved_at = v.status === "resolved" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null;
  update("tickets", id, v);
  audit(user, "update", "ticket", id, v.status ? `status ${v.status}` : "");
  return get(`${TICKET_SELECT} WHERE k.id = ?`, id);
});
route("DELETE", "/api/tickets/:id", "tickets", "write", ({ params, user }) => {
  const id = idParam(params.id);
  if (!get("SELECT 1 AS x FROM tickets WHERE id = ?", id)) throw notFound("Ticket");
  run("DELETE FROM tickets WHERE id = ?", id);
  audit(user, "delete", "ticket", id);
  return { ok: true };
});

// Users (admin only: "users" is absent from other roles' permissions)
route("GET", "/api/users", "users", "read", () => all("SELECT id, name, email, role, active, created_at FROM users ORDER BY name"));
route("POST", "/api/users", "users", "write", ({ body, user }) => {
  const v = validate(body, S.userCreate);
  minPassword(v.password);
  v.password_hash = auth.hashPassword(v.password);
  delete v.password;
  const id = insert("users", v);
  audit(user, "create", "user", id, `${v.email} (${v.role})`);
  return { status: 201, data: get("SELECT id, name, email, role, active FROM users WHERE id = ?", id) };
});
route("PUT", "/api/users/:id", "users", "write", ({ params, body, user }) =>
  tx(() => {
    const id = idParam(params.id);
    const cur = get("SELECT * FROM users WHERE id = ?", id);
    if (!cur) throw notFound("User");
    const v = validate(body, S.userUpdate, { partial: true });
    const losingAdmin = cur.role === "admin" && cur.active && ((v.role && v.role !== "admin") || v.active === 0);
    if (losingAdmin && get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").n <= 1)
      throw new HttpError(409, "There must be at least one active admin");
    if (id === user.id && v.active === 0) throw new HttpError(409, "You cannot deactivate yourself");
    if (v.password !== undefined) {
      minPassword(v.password);
      v.password_hash = auth.hashPassword(v.password);
      delete v.password;
    }
    update("users", id, v);
    if (v.active === 0 || v.password_hash) run("DELETE FROM sessions WHERE user_id = ?", id);
    audit(user, "update", "user", id, Object.keys(v).filter((k) => k !== "password_hash").join(","));
    return get("SELECT id, name, email, role, active FROM users WHERE id = ?", id);
  })
);

route("GET", "/api/audit", "users", "read", () => all("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300"));

// Dashboard
route("GET", "/api/dashboard", "dashboard", "read", () => {
  const month = thisMonth();
  const { start, end } = monthBounds(month);
  const beds = get("SELECT COALESCE(SUM(beds),0) AS n FROM rooms").n;
  const occupied = get("SELECT COUNT(*) AS n FROM tenants WHERE status='active' AND room_id IS NOT NULL").n;
  const sum = (sql, ...p) => get(sql, ...p).n;
  const collected = sum("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE paid_on BETWEEN ? AND ?", start, end);
  const expenses = sum("SELECT COALESCE(SUM(amount),0) AS n FROM expenses WHERE spent_on BETWEEN ? AND ?", start, end);
  const inv = get(`SELECT COALESCE(SUM(balance),0) AS outstanding,
                          COALESCE(SUM(CASE WHEN status='overdue' THEN balance ELSE 0 END),0) AS overdue,
                          COALESCE(SUM(CASE WHEN status='overdue' THEN 1 ELSE 0 END),0) AS overdue_count
                   FROM (${INVOICE_SELECT})`);

  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const m = addMonths(month, -i);
    const b = monthBounds(m);
    trend.push({
      month: m,
      billed: sum("SELECT COALESCE(SUM(amount),0) AS n FROM invoices WHERE period = ?", m),
      collected: sum("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE paid_on BETWEEN ? AND ?", b.start, b.end),
      expenses: sum("SELECT COALESCE(SUM(amount),0) AS n FROM expenses WHERE spent_on BETWEEN ? AND ?", b.start, b.end),
    });
  }

  return {
    month,
    properties: sum("SELECT COUNT(*) AS n FROM properties"),
    rooms: sum("SELECT COUNT(*) AS n FROM rooms"),
    beds,
    occupied,
    occupancy_pct: beds ? Math.round((occupied / beds) * 100) : 0,
    billed: sum("SELECT COALESCE(SUM(amount),0) AS n FROM invoices WHERE period = ?", month),
    collected,
    expenses,
    net: collected - expenses,
    outstanding: inv.outstanding,
    overdue: inv.overdue,
    overdue_count: inv.overdue_count,
    open_tickets: sum("SELECT COUNT(*) AS n FROM tickets WHERE status != 'resolved'"),
    trend,
    top_dues: all(
      `SELECT tenant_id, tenant_name, SUM(balance) AS balance FROM (${INVOICE_SELECT}) WHERE balance > 0
       GROUP BY tenant_id ORDER BY balance DESC LIMIT 5`
    ),
    recent_payments: all(
      `SELECT p.id, p.amount, p.method, p.paid_on, t.name AS tenant_name FROM payments p
       JOIN invoices i ON i.id = p.invoice_id JOIN tenants t ON t.id = i.tenant_id ORDER BY p.paid_on DESC, p.id DESC LIMIT 5`
    ),
  };
});

// Reports (JSON, or CSV with ?format=csv)
route("GET", "/api/reports/:name", "reports", "read", ({ params, query }) => {
  const asCsv = query.format === "csv";
  const out = (columns, rows, extra = {}) => (asCsv ? csv(columns, rows) : { columns, rows, ...extra });

  if (params.name === "rent-roll") {
    const period = query.period || thisMonth();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ValidationError("period must be YYYY-MM");
    const rows = all(`SELECT tenant_name, property, room, description, amount, paid, balance, status, due_date FROM (${INVOICE_SELECT}) WHERE period = ? ORDER BY property, room`, period);
    return out(
      [
        { key: "tenant_name", label: "Tenant" }, { key: "property", label: "Property" }, { key: "room", label: "Room" },
        { key: "amount", label: "Billed" }, { key: "paid", label: "Paid" }, { key: "balance", label: "Balance" },
        { key: "status", label: "Status" }, { key: "due_date", label: "Due date" },
      ],
      rows,
      { title: `Rent roll ${period}` }
    );
  }

  if (params.name === "dues") {
    const rows = all(
      `SELECT tenant_name, property, room, COUNT(*) AS invoices, SUM(balance) AS balance, MIN(due_date) AS oldest_due
       FROM (${INVOICE_SELECT}) WHERE balance > 0 GROUP BY tenant_id ORDER BY balance DESC`
    );
    return out(
      [
        { key: "tenant_name", label: "Tenant" }, { key: "property", label: "Property" }, { key: "room", label: "Room" },
        { key: "invoices", label: "Open invoices" }, { key: "balance", label: "Balance" }, { key: "oldest_due", label: "Oldest due date" },
      ],
      rows,
      { title: "Outstanding dues" }
    );
  }

  if (params.name === "pnl") {
    const from = query.from || addMonths(thisMonth(), -5) + "-01";
    const to = query.to || today();
    if (!validDate(from) || !validDate(to)) throw new ValidationError("from/to must be YYYY-MM-DD");
    const income = all("SELECT substr(paid_on,1,7) AS month, SUM(amount) AS income FROM payments WHERE paid_on BETWEEN ? AND ? GROUP BY 1", from, to);
    const spend = all("SELECT substr(spent_on,1,7) AS month, SUM(amount) AS expenses FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY 1", from, to);
    const months = [...new Set([...income.map((r) => r.month), ...spend.map((r) => r.month)])].sort();
    const rows = months.map((m) => {
      const inc = income.find((r) => r.month === m)?.income || 0;
      const exp = spend.find((r) => r.month === m)?.expenses || 0;
      return { month: m, income: inc, expenses: exp, net: inc - exp };
    });
    const byCategory = all("SELECT category, SUM(amount) AS amount FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC", from, to);
    return out(
      [{ key: "month", label: "Month" }, { key: "income", label: "Income" }, { key: "expenses", label: "Expenses" }, { key: "net", label: "Net" }],
      rows,
      { title: `Profit & loss ${from} to ${to}`, by_category: byCategory }
    );
  }

  if (params.name === "occupancy") {
    const rows = all(
      `SELECT p.name AS property, r.number AS room, r.type, r.beds,
              (SELECT COUNT(*) FROM tenants t WHERE t.room_id = r.id AND t.status='active') AS occupied
       FROM rooms r JOIN properties p ON p.id = r.property_id ORDER BY p.name, r.number`
    ).map((r) => ({ ...r, vacant: r.beds - r.occupied }));
    return out(
      [
        { key: "property", label: "Property" }, { key: "room", label: "Room" }, { key: "type", label: "Type" },
        { key: "beds", label: "Beds" }, { key: "occupied", label: "Occupied" }, { key: "vacant", label: "Vacant" },
      ],
      rows,
      { title: "Occupancy" }
    );
  }

  throw notFound("Report");
});

module.exports = { routes: R, HttpError, ValidationError };
