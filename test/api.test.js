const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-test-"));
process.env.ERP_DATA_DIR = dir;
process.env.ERP_ADMIN_PASSWORD = "adminpass123";

const { start, server } = require("../server");
let base;

before(async () => {
  await start(0, "127.0.0.1");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  server.closeAllConnections?.();
});

// Minimal client that keeps a session cookie.
function client() {
  let cookie = "";
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u) => call("GET", u),
    post: (u, b = {}) => call("POST", u, b),
    put: (u, b) => call("PUT", u, b),
    del: (u) => call("DELETE", u),
    login: (email, password) => call("POST", "/api/login", { email, password }),
  };
}

const ctx = {};

test("requires login", async () => {
  const c = client();
  assert.equal((await c.get("/api/tenants")).status, 401);
  assert.equal((await c.login("admin@pg.local", "wrong-password")).status, 401);
  const ok = await c.login("admin@pg.local", "adminpass123");
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, "admin");
  assert.match(ok.headers.get("set-cookie"), /HttpOnly/);
  assert.match(ok.headers.get("set-cookie"), /SameSite=Strict/);
  ctx.admin = c;
});

test("static files are served with security headers; traversal is blocked", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-security-policy"));
  const t = await fetch(base + "/..%2Fserver.js");
  assert.equal(t.status, 404);
});

test("property, room and tenant capacity rules", async () => {
  const a = ctx.admin;
  const p = await a.post("/api/properties", { name: "Test House", city: "Pune" });
  assert.equal(p.status, 201);
  ctx.property = p.data;

  const r = await a.post("/api/rooms", { property_id: p.data.id, number: "101", beds: 2, rent_per_bed: 6000 });
  assert.equal(r.status, 201);
  ctx.room = r.data;
  assert.equal((await a.post("/api/rooms", { property_id: p.data.id, number: "101", beds: 1, rent_per_bed: 1 })).status, 409, "duplicate room number");

  const mk = (name, phone) => a.post("/api/tenants", { name, phone, room_id: r.data.id, join_date: "2026-01-10" });
  const t1 = await mk("Asha", "9000000001");
  assert.equal(t1.status, 201);
  assert.equal(t1.data.monthly_rent, 6000, "defaults to room rent");
  const t2 = await mk("Ravi", "9000000002");
  assert.equal(t2.status, 201);
  assert.equal((await mk("Third", "9000000003")).status, 409, "room is full");
  ctx.t1 = t1.data;
  ctx.t2 = t2.data;

  assert.equal((await a.put(`/api/rooms/${r.data.id}`, { beds: 1 })).status, 409, "cannot shrink below occupants");
  assert.equal((await a.post("/api/tenants", { name: "X", phone: "abc", room_id: r.data.id, join_date: "2026-01-10" })).status, 400);
  assert.equal((await a.post("/api/tenants", { name: "X", phone: "9000000009", room_id: r.data.id, join_date: "2026-13-45" })).status, 400);
});

test("invoice generation is idempotent; payments update status", async () => {
  const a = ctx.admin;
  const g1 = await a.post("/api/invoices/generate", { period: "2026-02" });
  assert.deepEqual([g1.data.created, g1.data.skipped], [2, 0]);
  const g2 = await a.post("/api/invoices/generate", { period: "2026-02" });
  assert.deepEqual([g2.data.created, g2.data.skipped], [0, 2]);

  // A tenant who joined after the period gets nothing
  const g0 = await a.post("/api/invoices/generate", { period: "2025-12" });
  assert.equal(g0.data.created, 0);

  const list = (await a.get("/api/invoices?period=2026-02")).data;
  assert.equal(list.length, 2);
  const inv = list.find((i) => i.tenant_id === ctx.t1.id);
  assert.equal(inv.amount, 6000);
  assert.equal(inv.status, "overdue", "past due date and unpaid");
  ctx.invoice = inv;

  assert.equal((await a.post("/api/payments", { invoice_id: inv.id, amount: 7000, method: "cash" })).status, 400, "overpayment");
  assert.equal((await a.post("/api/payments", { invoice_id: inv.id, amount: 2500, method: "upi", paid_on: "2026-02-03" })).status, 201);
  let cur = (await a.get(`/api/invoices?tenant_id=${ctx.t1.id}`)).data[0];
  assert.equal(cur.paid, 2500);
  assert.equal(cur.balance, 3500);
  const pay = await a.post("/api/payments", { invoice_id: inv.id, amount: 3500, method: "cash", paid_on: "2026-02-04" });
  assert.equal(pay.status, 201);
  ctx.payment = pay.data;
  cur = (await a.get(`/api/invoices?tenant_id=${ctx.t1.id}`)).data[0];
  assert.equal(cur.status, "paid");
  assert.equal((await a.post("/api/payments", { invoice_id: inv.id, amount: 1, method: "cash" })).status, 400, "nothing left to pay");
  assert.equal((await a.del(`/api/invoices/${inv.id}`)).status, 409, "invoice with payments is protected");
  assert.equal((await a.get("/api/invoices?status=paid")).data.length, 1);
});

test("role permissions", async () => {
  const a = ctx.admin;
  const mkUser = (role) => a.post("/api/users", { name: role, email: `${role}@test.dev`, role, password: "password123" });
  assert.equal((await mkUser("manager")).status, 201);
  assert.equal((await mkUser("accountant")).status, 201);
  assert.equal((await a.post("/api/users", { name: "x", email: "short@test.dev", role: "manager", password: "short" })).status, 400);

  const m = client();
  await m.login("manager@test.dev", "password123");
  assert.equal((await m.get("/api/users")).status, 403);
  assert.equal((await m.post("/api/payments", { invoice_id: ctx.invoice.id, amount: 1, method: "cash" })).status, 403);
  assert.equal((await m.post("/api/properties", { name: "Manager House" })).status, 201);

  const acc = client();
  await acc.login("accountant@test.dev", "password123");
  assert.equal((await acc.post("/api/tenants", { name: "N", phone: "9111111111", room_id: ctx.room.id, join_date: "2026-01-01" })).status, 403);
  assert.equal((await acc.post("/api/expenses", { category: "Electricity", amount: 4000, spent_on: "2026-02-05", property_id: ctx.property.id })).status, 201);
  assert.equal((await acc.del(`/api/payments/${ctx.payment.id}`)).status, 403, "reversing a payment is admin-only");
  assert.equal((await a.del(`/api/payments/${ctx.payment.id}`)).status, 200);
  assert.equal((await a.get(`/api/invoices?tenant_id=${ctx.t1.id}`)).data[0].paid, 2500);
});

test("cannot remove the last admin; deactivated users lose access", async () => {
  const a = ctx.admin;
  const users = (await a.get("/api/users")).data;
  const admin = users.find((u) => u.role === "admin");
  assert.equal((await a.put(`/api/users/${admin.id}`, { role: "manager" })).status, 409);
  assert.equal((await a.put(`/api/users/${admin.id}`, { active: 0 })).status, 409);

  const mgr = users.find((u) => u.role === "manager");
  const m = client();
  await m.login("manager@test.dev", "password123");
  assert.equal((await m.get("/api/tenants")).status, 200);
  assert.equal((await a.put(`/api/users/${mgr.id}`, { active: 0 })).status, 200);
  assert.equal((await m.get("/api/tenants")).status, 401, "session revoked");
  assert.equal((await client().login("manager@test.dev", "password123")).status, 401);
});

test("checkout frees the bed and reports dues", async () => {
  const a = ctx.admin;
  const out = await a.post(`/api/tenants/${ctx.t2.id}/checkout`, { leave_date: "2026-03-01" });
  assert.equal(out.status, 200);
  assert.equal(out.data.status, "left");
  assert.equal(out.data.outstanding, 6000);
  assert.equal((await a.post(`/api/tenants/${ctx.t2.id}/checkout`, {})).status, 409);
  const room = (await a.get("/api/rooms")).data.find((r) => r.id === ctx.room.id);
  assert.equal(room.occupied, 1);
  assert.equal((await a.del(`/api/tenants/${ctx.t2.id}`)).status, 409, "tenant with invoices cannot be deleted");
});

test("dashboard and reports", async () => {
  const a = ctx.admin;
  const d = (await a.get("/api/dashboard")).data;
  assert.equal(d.properties >= 1, true);
  assert.equal(d.trend.length, 6);
  assert.equal(d.occupied, 1);
  assert.ok(d.outstanding >= 3500 + 6000);

  const rr = await a.get("/api/reports/rent-roll?period=2026-02&format=csv");
  assert.equal(rr.status, 200);
  assert.match(rr.headers.get("content-type"), /text\/csv/);
  assert.match(rr.data, /^Tenant,Property,Room,Billed/);

  const pnl = (await a.get("/api/reports/pnl?from=2026-01-01&to=2026-12-31")).data;
  assert.ok(pnl.rows.length >= 1);
  assert.equal((await a.get("/api/reports/nope")).status, 404);
  assert.equal((await a.get("/api/reports/rent-roll?period=bad")).status, 400);
});

test("CSV export neutralises spreadsheet formulas", async () => {
  const a = ctx.admin;
  const t = await a.post("/api/tenants", { name: "=HYPERLINK(\"http://x\")", phone: "9222222222", room_id: ctx.room.id, join_date: "2026-04-01" });
  assert.equal(t.status, 201, "a bed was freed by the checkout");
  await a.post("/api/invoices/generate", { period: "2026-04" });
  const res = await a.get("/api/reports/rent-roll?period=2026-04&format=csv");
  assert.equal(res.status, 200);
  assert.ok(res.data.includes(`"'=HYPERLINK(""http://x"")"`), res.data);
  assert.ok(!/(^|,)=HYPERLINK/m.test(res.data), "no raw formula cell");
});

test("cross-origin writes are rejected", async () => {
  const res = await fetch(base + "/api/properties", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example", Cookie: "erp_session=whatever" },
    body: JSON.stringify({ name: "x" }),
  });
  assert.equal(res.status, 403);
});

test("users can change their own password", async () => {
  const a = ctx.admin;
  await a.post("/api/users", { name: "Pat", email: "pat@test.dev", role: "manager", password: "oldpassword1" });
  const phone = client();
  const laptop = client();
  await phone.login("pat@test.dev", "oldpassword1");
  await laptop.login("pat@test.dev", "oldpassword1");
  assert.equal((await phone.post("/api/password", { current: "wrong", next: "newpassword1" })).status, 403);
  assert.equal((await phone.post("/api/password", { current: "oldpassword1", next: "short" })).status, 400);
  assert.equal((await phone.post("/api/password", { current: "oldpassword1", next: "newpassword1" })).status, 200);
  assert.equal((await phone.get("/api/tenants")).status, 200, "current session survives");
  assert.equal((await laptop.get("/api/tenants")).status, 401, "other sessions are revoked");
  assert.equal((await client().login("pat@test.dev", "oldpassword1")).status, 401);
  assert.equal((await client().login("pat@test.dev", "newpassword1")).status, 200);
});

test("login is throttled after repeated failures", async () => {
  const c = client();
  let last;
  for (let i = 0; i < 6; i++) last = await c.login("nobody@test.dev", "bad-password");
  assert.equal(last.status, 429);
});
