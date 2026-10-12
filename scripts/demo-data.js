// Populates an EMPTY database with sample properties, tenants, invoices, payments, expenses and tickets.
// Usage: npm run demo   (refuses to run if any property already exists)
const { get, run, tx, audit } = require("../lib/db");
const auth = require("../lib/auth");

if (get("SELECT 1 AS x FROM properties LIMIT 1")) {
  console.error("Database already has properties; refusing to add demo data.");
  process.exit(1);
}
const created = auth.ensureAdmin();
if (created) console.log(`Admin created: ${created.email} / ${created.password}`);

const month = (offset) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
};
const ins = (sql, ...p) => Number(run(sql, ...p).lastInsertRowid);

tx(() => {
  const props = [
    ["Sunrise PG", "12 MG Road", "Bengaluru"],
    ["Lotus Ladies Hostel", "45 HSR Layout, Sector 2", "Bengaluru"],
  ].map(([n, a, c]) => ins("INSERT INTO properties (name,address,city) VALUES (?,?,?)", n, a, c));

  const rooms = [];
  for (const [pi, floors] of [[0, 3], [1, 2]]) {
    for (let f = 1; f <= floors; f++) {
      for (let n = 1; n <= 3; n++) {
        const ac = n === 3;
        const beds = n === 1 ? 2 : n === 2 ? 3 : 1;
        rooms.push({ id: ins("INSERT INTO rooms (property_id,number,floor,type,beds,rent_per_bed) VALUES (?,?,?,?,?,?)", props[pi], `${f}0${n}`, f, ac ? "AC" : "Non-AC", beds, ac ? 11000 : beds === 2 ? 8500 : 7000), beds, pi });
      }
    }
  }

  const names = ["Aarav Mehta", "Isha Kapoor", "Rohan Das", "Meera Nair", "Kabir Singh", "Ananya Rao", "Vikram Patel", "Sara Khan", "Dev Sharma", "Pooja Iyer", "Nikhil Verma", "Tara Menon", "Arjun Reddy", "Neha Gupta"];
  const tenants = [];
  let n = 0;
  for (const r of rooms) {
    for (let b = 0; b < r.beds && n < names.length; b++, n++) {
      const rent = get("SELECT rent_per_bed AS r FROM rooms WHERE id = ?", r.id).r;
      const join = `${month(-(2 + (n % 4)))}-0${1 + (n % 8)}`;
      const id = ins(
        "INSERT INTO tenants (name,phone,email,room_id,monthly_rent,deposit,join_date) VALUES (?,?,?,?,?,?,?)",
        names[n], `98${String(76500000 + n * 137).padStart(8, "0")}`, `${names[n].split(" ")[0].toLowerCase()}@example.com`, r.id, rent, rent * 2, join
      );
      tenants.push({ id, rent, join });
    }
  }

  // One tenant who already left
  const leaver = tenants.pop();
  run("UPDATE tenants SET status='left', leave_date=? WHERE id=?", `${month(-1)}-15`, leaver.id);
  tenants.push({ ...leaver, left: true });

  // Invoices for the last 3 months incl. current; most pay on time, a few lag.
  let i = 0;
  for (const off of [-2, -1, 0]) {
    const period = month(off);
    for (const t of tenants) {
      if (t.join > `${period}-31` || (t.left && off === 0)) continue;
      const inv = ins("INSERT INTO invoices (tenant_id,period,description,amount,due_date) VALUES (?,?,?,?,?)", t.id, period, "Monthly rent", t.rent, `${period}-05`);
      i++;
      const lagging = i % 7 === 0;
      const partial = i % 5 === 0;
      if (lagging && off === 0) continue;
      if (lagging && off !== 0 && i % 2) continue;
      const amount = partial ? Math.round(t.rent / 2) : t.rent;
      const method = ["upi", "cash", "bank", "upi"][i % 4];
      ins("INSERT INTO payments (invoice_id,amount,method,paid_on,reference,created_by) VALUES (?,?,?,?,?,1)", inv, amount, method, `${period}-0${2 + (i % 6)}`, method === "upi" ? `UPI${100000 + i}` : "");
    }
  }

  const exp = [["Electricity", 18500], ["Water", 4200], ["Internet", 3600], ["Food & groceries", 41000], ["Salaries", 32000], ["Repairs", 7800], ["Cleaning", 5200]];
  for (const off of [-2, -1, 0]) {
    exp.forEach(([cat, amt], k) => ins("INSERT INTO expenses (property_id,category,amount,spent_on,description,created_by) VALUES (?,?,?,?,?,1)", props[k % 2], cat, amt + off * 150 + k * 40, `${month(off)}-1${k}`, `${cat} bill`));
  }

  ins("INSERT INTO tickets (property_id,room_id,title,description,priority,status,created_by) VALUES (?,?,?,?,?,?,1)", props[0], rooms[0].id, "Leaking tap in bathroom", "Slow drip, needs washer replacement", "medium", "open");
  ins("INSERT INTO tickets (property_id,title,description,priority,status,created_by) VALUES (?,?,?,?,?,1)", props[0], "Wi-Fi router dropping on 2nd floor", "", "high", "in_progress");
  ins("INSERT INTO tickets (property_id,room_id,title,priority,status,created_by,resolved_at) VALUES (?,?,?,?,?,1,datetime('now'))", props[1], rooms[7].id, "Replace tube light", "low", "resolved");

  audit(null, "seed", "system", null, "demo data loaded");
});

console.log("Demo data loaded: 2 properties, 15 rooms, 14 tenants, 3 months of invoices/payments, expenses and tickets.");
