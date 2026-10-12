// PG ERP server: static SPA + JSON API. Zero dependencies (Node >= 22.5 for node:sqlite).
const http = require("http");
const fs = require("fs");
const path = require("path");

const auth = require("./lib/auth");
const { get, run, audit, DB_FILE } = require("./lib/db");
const { routes, HttpError } = require("./lib/api");
const { validate, ValidationError } = require("./lib/validate");

const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 100 * 1024;
const SECURE_COOKIE = process.env.ERP_SECURE_COOKIE === "1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function mapDbError(e) {
  const msg = String(e && e.message);
  if (/UNIQUE constraint failed/.test(msg)) return new HttpError(409, "A record with those details already exists");
  if (/FOREIGN KEY constraint failed/.test(msg)) return new HttpError(409, "This record is referenced by other records");
  if (/CHECK constraint failed/.test(msg)) return new HttpError(400, "A value is out of the allowed range");
  return null;
}

// Reject cross-site mutating requests (defence in depth on top of SameSite=Strict).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const DUMMY_HASH = auth.hashPassword("not-a-real-password");

async function handleAuth(req, res, url) {
  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const v = validate(body, {
      email: { type: "email", required: true, label: "Email" },
      password: { type: "string", required: true, max: 200, label: "Password" },
    });
    const key = `${req.socket.remoteAddress}|${v.email}`;
    if (auth.throttled(key)) throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");
    const row = get("SELECT * FROM users WHERE email = ?", v.email);
    const ok = auth.verifyPassword(v.password, row ? row.password_hash : DUMMY_HASH) && row && row.active;
    if (!ok) {
      auth.recordFail(key);
      throw new HttpError(401, "Incorrect email or password");
    }
    auth.clearFails(key);
    const token = auth.createSession(row.id);
    const user = { id: row.id, name: row.name, email: row.email, role: row.role };
    audit(user, "login", "user", row.id);
    return send(res, 200, { user, permissions: auth.PERMISSIONS[row.role] }, { "Set-Cookie": auth.cookieHeader(token, SECURE_COOKIE) });
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    auth.destroySession(auth.sessionToken(req));
    return send(res, 200, { ok: true }, { "Set-Cookie": auth.cookieHeader(null, SECURE_COOKIE) });
  }

  if (url.pathname === "/api/me" && req.method === "GET") {
    const user = auth.userFromRequest(req);
    if (!user) throw new HttpError(401, "Not signed in");
    return send(res, 200, { user, permissions: auth.PERMISSIONS[user.role] });
  }
  return false;
}

async function handleApi(req, res, url) {
  if (req.method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "Cross-origin request blocked");
  if ((await handleAuth(req, res, url)) !== false) return;

  const user = auth.userFromRequest(req);
  if (!user) throw new HttpError(401, "Not signed in");

  if (url.pathname === "/api/password" && req.method === "POST") {
    const v = validate(await readBody(req), {
      current: { type: "string", required: true, max: 200, label: "Current password" },
      next: { type: "string", required: true, max: 100, label: "New password" },
    });
    if (v.next.length < 8) throw new ValidationError("New password must be at least 8 characters");
    const row = get("SELECT password_hash FROM users WHERE id = ?", user.id);
    if (!auth.verifyPassword(v.current, row.password_hash)) throw new HttpError(403, "Current password is incorrect");
    run("UPDATE users SET password_hash = ? WHERE id = ?", auth.hashPassword(v.next), user.id);
    // Sign out every other device; keep the session making this request.
    run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", user.id, auth.tokenHash(auth.sessionToken(req)));
    audit(user, "password", "user", user.id, "password changed");
    return send(res, 200, { ok: true });
  }

  let pathMatched = false;
  for (const r of routes) {
    const m = url.pathname.match(r.re);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method) continue;
    if (!auth.can(user, r.resource, r.action)) throw new HttpError(403, "You do not have permission to do that");

    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const query = Object.fromEntries(url.searchParams);
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
    const result = await r.fn({ user, params, query, body });

    if (result && typeof result.csv === "string") {
      return send(res, 200, result.csv, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${params.name || "export"}.csv"`,
      });
    }
    if (result && result.status && result.data !== undefined) return send(res, result.status, result.data);
    return send(res, 200, result ?? { ok: true });
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method not allowed" : "Not found");
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "Bad request");
  }
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, "Not found");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    const err = e instanceof HttpError || e instanceof ValidationError ? e : mapDbError(e);
    if (err) return send(res, err.status, { error: err.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "Internal server error" });
  }
});

function start(port = PORT, host = HOST) {
  const admin = auth.ensureAdmin();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`PG ERP running at http://${host === "127.0.0.1" ? "localhost" : host}:${server.address().port}  (db: ${DB_FILE})`);
      if (admin) {
        console.log("\nFirst run: admin account created");
        console.log(`  email:    ${admin.email}`);
        console.log(`  password: ${admin.password}${admin.generated ? "   (random, shown once; change it under Users)" : ""}\n`);
      }
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { start, server };
