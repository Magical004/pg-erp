// PG ERP single-page app: login, role-aware navigation and one view per module.
(() => {
  const { h, inr, today, thisMonth, titleCase, badge, A, toast, formDialog, confirmDialog, openDialog, table, panel, btn } = UI;

  const root = document.getElementById("app");
  let me = null;
  let perms = null;
  let renderToken = 0;

  const can = (res, act) => perms === "*" || !!(perms && perms[res] && perms[res].includes(act));
  const opts = (rows, label, value = (r) => r.id) => rows.map((r) => ({ value: value(r), label: label(r) }));
  const confirmThen = async (cfg, fn, okMsg) => {
    if (!(await confirmDialog(cfg))) return;
    try {
      await fn();
      if (okMsg) toast(okMsg);
      render();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const saveThen = (fn, okMsg) => async (data) => {
    await fn(data);
    toast(okMsg);
    render();
  };

  /* ================= login & shell ================= */

  function showLogin(message) {
    me = perms = null;
    const err = h("p", { class: "form-error", role: "alert", text: message || "", hidden: !message });
    const email = h("input", { type: "email", required: true, autocomplete: "username", id: "login-email" });
    const pw = h("input", { type: "password", required: true, autocomplete: "current-password", id: "login-pw" });
    const submit = h("button", { class: "btn primary", type: "submit", text: "Sign in" });
    const form = h(
      "form",
      { class: "login" },
      h("div", {}, h("h1", { text: "PG ERP" }), h("p", { text: "Sign in to manage your properties." })),
      h("label", { for: "login-email" }, "Email", email),
      h("label", { for: "login-pw" }, "Password", pw),
      err,
      submit
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const res = await A.post("/api/login", { email: email.value, password: pw.value });
        me = res.user;
        perms = res.permissions;
        location.hash = "#/dashboard";
        showShell();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        submit.disabled = false;
      }
    });
    root.replaceChildren(h("div", { class: "login-wrap" }, form));
    email.focus();
  }

  const NAV = [
    { id: "dashboard", label: "Dashboard", res: "dashboard" },
    { sep: "Property" },
    { id: "properties", label: "Properties", res: "properties" },
    { id: "rooms", label: "Rooms", res: "rooms" },
    { id: "tenants", label: "Tenants", res: "tenants" },
    { sep: "Finance" },
    { id: "invoices", label: "Invoices", res: "invoices" },
    { id: "payments", label: "Payments", res: "payments" },
    { id: "expenses", label: "Expenses", res: "expenses" },
    { id: "reports", label: "Reports", res: "reports" },
    { sep: "Operations" },
    { id: "tickets", label: "Maintenance", res: "tickets" },
    { sep: "Admin" },
    { id: "users", label: "Users", res: "users" },
    { id: "audit", label: "Audit log", res: "users" },
  ];

  function showShell() {
    const items = NAV.filter((n, i) => {
      if (n.sep) {
        // keep a separator only if the next item is visible
        const next = NAV[i + 1];
        return next && !next.sep && can(next.res, "read");
      }
      return can(n.res, "read");
    });
    const nav = h("nav", { "aria-label": "Main" }, items.map((n) => (n.sep ? h("div", { class: "sep", text: n.sep }) : h("a", { href: `#/${n.id}`, "data-id": n.id, text: n.label }))));
    root.replaceChildren(
      h(
        "div",
        { class: "shell" },
        h("aside", { class: "side" }, h("div", { class: "brand", text: "PG ERP" }), nav),
        h(
          "div",
          { class: "main" },
          h(
            "header",
            { class: "topbar" },
            h("h1", { id: "page-title" }),
            h(
              "div",
              { class: "userbox" },
              h("span", { text: `${me.name} · ${titleCase(me.role)}` }),
              btn("Change password", changePassword, "small"),
              btn("Sign out", signOut, "small")
            )
          ),
          h("main", { class: "content", id: "content" })
        )
      )
    );
    render();
  }

  async function signOut() {
    try {
      await A.post("/api/logout");
    } catch {
      /* already signed out */
    }
    showLogin();
  }

  function changePassword() {
    formDialog({
      title: "Change password",
      submitLabel: "Update password",
      fields: [
        { name: "current", label: "Current password", type: "password", required: true, full: true },
        { name: "next", label: "New password (min 8 characters)", type: "password", required: true, full: true },
      ],
      onSubmit: async (d) => {
        await A.post("/api/password", { current: d.current, next: d.next });
        toast("Password updated");
      },
    });
  }

  /* ================= router ================= */

  const VIEWS = {};

  async function render() {
    if (!me) return;
    const token = ++renderToken;
    const [path, qs = ""] = location.hash.replace(/^#\//, "").split("?");
    let id = path || "dashboard";
    const query = Object.fromEntries(new URLSearchParams(qs));
    const nav = NAV.find((n) => n.id === id);
    if (!VIEWS[id] || !nav || !can(nav.res, "read")) id = "dashboard";

    document.querySelectorAll(".side a").forEach((a) => a.classList.toggle("active", a.dataset.id === id));
    document.getElementById("page-title").textContent = NAV.find((n) => n.id === id).label;
    document.title = `${NAV.find((n) => n.id === id).label} · PG ERP`;

    const box = document.getElementById("content");
    try {
      const nodes = await VIEWS[id](query);
      if (token !== renderToken) return; // a newer navigation superseded this one
      box.replaceChildren(...[].concat(nodes));
    } catch (e) {
      if (token !== renderToken) return;
      box.replaceChildren(panel("Something went wrong", h("div", { class: "body" }, e.message)));
    }
  }

  /* ================= dashboard ================= */

  VIEWS.dashboard = async () => {
    const d = await A.get("/api/dashboard");
    const kpi = (label, value, sub, cls = "") => h("div", { class: `kpi ${cls}` }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }), h("div", { class: "sub", text: sub || "" }));
    const max = Math.max(1, ...d.trend.flatMap((t) => [t.billed, t.collected, t.expenses]));
    const bar = (cls, v, label) => {
      const el = h("div", { class: `bar ${cls}`, title: `${label}: ${inr(v)}` });
      el.style.height = `${Math.round((v / max) * 100)}%`;
      return el;
    };

    return [
      h(
        "div",
        { class: "kpis" },
        kpi("Occupancy", `${d.occupancy_pct}%`, `${d.occupied} of ${d.beds} beds · ${d.rooms} rooms`),
        kpi("Billed this month", inr(d.billed), d.month),
        kpi("Collected this month", inr(d.collected), `Expenses ${inr(d.expenses)}`, "good"),
        kpi("Net this month", inr(d.net), "Collected minus expenses", d.net < 0 ? "bad" : ""),
        kpi("Outstanding", inr(d.outstanding), "All unpaid invoices"),
        kpi("Overdue", inr(d.overdue), `${d.overdue_count} invoice${d.overdue_count === 1 ? "" : "s"}`, d.overdue ? "bad" : ""),
        kpi("Open tickets", String(d.open_tickets), "Maintenance")
      ),
      h(
        "div",
        { class: "grid2" },
        panel(
          "Last 6 months",
          h("div", { class: "body" }, h("div", { class: "bars", role: "img", "aria-label": "Billed, collected and expenses by month" }, d.trend.map((t) => h("div", { class: "bargroup" }, h("div", { class: "cols" }, bar("billed", t.billed, "Billed"), bar("collected", t.collected, "Collected"), bar("expenses", t.expenses, "Expenses")), h("small", { text: t.month.slice(2) }))))),
          h("div", { class: "legend" }, h("span", {}, h("i", { class: "billed" }), "Billed"), h("span", {}, h("i", { class: "collected" }), "Collected"), h("span", {}, h("i", { class: "expenses" }), "Expenses"))
        ),
        h(
          "div",
          { class: "stack" },
          panel("Highest dues", d.top_dues.length ? h("ul", { class: "list-plain" }, d.top_dues.map((t) => h("li", {}, h("span", { text: t.tenant_name }), h("strong", { text: inr(t.balance) })))) : h("div", { class: "empty", text: "No dues 🎉" })),
          panel("Recent payments", d.recent_payments.length ? h("ul", { class: "list-plain" }, d.recent_payments.map((p) => h("li", {}, h("span", { text: `${p.tenant_name} · ${p.paid_on}` }), h("strong", { text: inr(p.amount) })))) : h("div", { class: "empty", text: "No payments yet" }))
        )
      ),
    ];
  };

  /* ================= properties ================= */

  const propertyFields = [
    { name: "name", label: "Name", required: true, full: true },
    { name: "city", label: "City" },
    { name: "address", label: "Address", full: true },
  ];

  VIEWS.properties = async () => {
    const rows = await A.get("/api/properties");
    const w = can("properties", "write");
    const add = () => formDialog({ title: "New property", fields: propertyFields, onSubmit: saveThen((d) => A.post("/api/properties", d), "Property added") });
    return [
      h("div", { class: "toolbar" }, h("span"), w ? btn("+ Add property", add, "primary") : null),
      panel(
        null,
        table(
          [
            { label: "Name", key: "name" },
            { label: "City", key: "city" },
            { label: "Address", key: "address" },
            { label: "Rooms", key: "rooms", num: true },
            { label: "Beds", key: "beds", num: true },
            { label: "Occupancy", render: (r) => { const pct = r.beds ? Math.round((r.occupied / r.beds) * 100) : 0; const m = h("div", { class: "meter", title: `${r.occupied}/${r.beds} beds` }, h("span")); m.firstChild.style.width = pct + "%"; return h("div", {}, `${r.occupied}/${r.beds} `, m); } },
          ],
          rows,
          {
            empty: "No properties yet. Add your first one to get started.",
            rowActions: (r) => [
              h("a", { class: "btn small", href: `#/rooms?property_id=${r.id}`, text: "Rooms" }),
              w ? btn("Edit", () => formDialog({ title: "Edit property", fields: propertyFields, values: r, onSubmit: saveThen((d) => A.put(`/api/properties/${r.id}`, d), "Property updated") }), "small") : null,
              w ? btn("Delete", () => confirmThen({ title: "Delete property", message: `Delete ${r.name}? This only works if it has no rooms, expenses or tickets.`, confirmLabel: "Delete", danger: true }, () => A.del(`/api/properties/${r.id}`), "Property deleted"), "small danger") : null,
            ],
          }
        )
      ),
    ];
  };

  /* ================= rooms ================= */

  VIEWS.rooms = async (q) => {
    const [rooms, props] = await Promise.all([A.get("/api/rooms" + (q.property_id ? `?property_id=${encodeURIComponent(q.property_id)}` : "")), A.get("/api/properties")]);
    const w = can("rooms", "write");
    const fields = [
      { name: "property_id", label: "Property", type: "select", required: true, options: opts(props, (p) => p.name), full: true },
      { name: "number", label: "Room number", required: true },
      { name: "floor", label: "Floor", type: "number", min: -2, max: 100 },
      { name: "type", label: "Type", type: "select", required: true, options: [{ value: "Non-AC", label: "Non-AC" }, { value: "AC", label: "AC" }] },
      { name: "beds", label: "Beds", type: "number", required: true, min: 1, max: 12 },
      { name: "rent_per_bed", label: "Rent per bed (₹)", type: "number", required: true, min: 0, full: true },
    ];
    const filter = h("select", { onchange: () => (location.hash = `#/rooms${filter.value ? "?property_id=" + filter.value : ""}`) }, h("option", { value: "", text: "All properties" }), props.map((p) => h("option", { value: p.id, text: p.name })));
    filter.value = q.property_id || "";
    return [
      h("div", { class: "toolbar" }, h("div", { class: "filters" }, h("label", {}, "Property", filter)), w ? btn("+ Add room", () => formDialog({ title: "New room", fields, values: { property_id: q.property_id, beds: 2, type: "Non-AC" }, onSubmit: saveThen((d) => A.post("/api/rooms", d), "Room added") }), "primary") : null),
      panel(
        null,
        table(
          [
            { label: "Property", key: "property" },
            { label: "Room", key: "number" },
            { label: "Floor", key: "floor", num: true },
            { label: "Type", key: "type" },
            { label: "Occupied", render: (r) => `${r.occupied}/${r.beds}`, num: true },
            { label: "Status", render: (r) => (r.occupied >= r.beds ? "full" : r.occupied === 0 ? "vacant" : "partial"), badge: true },
            { label: "Rent / bed", key: "rent_per_bed", money: true, num: true },
          ],
          rooms,
          {
            empty: props.length ? "No rooms yet." : "Add a property first, then add rooms.",
            rowActions: (r) => [
              w ? btn("Edit", () => formDialog({ title: `Edit room ${r.number}`, fields, values: r, onSubmit: saveThen((d) => A.put(`/api/rooms/${r.id}`, d), "Room updated") }), "small") : null,
              w ? btn("Delete", () => confirmThen({ title: "Delete room", message: `Delete room ${r.number}?`, confirmLabel: "Delete", danger: true }, () => A.del(`/api/rooms/${r.id}`), "Room deleted"), "small danger") : null,
            ],
          }
        )
      ),
    ];
  };

  /* ================= tenants ================= */

  async function tenantForm(existing) {
    const rooms = await A.get("/api/rooms");
    const roomOptions = rooms.map((r) => ({
      value: r.id,
      label: `${r.property} · ${r.number} (${r.occupied}/${r.beds}, ${inr(r.rent_per_bed)})`,
      disabled: r.occupied >= r.beds && (!existing || existing.room_id !== r.id),
    }));
    formDialog({
      title: existing ? `Edit ${existing.name}` : "New tenant",
      fields: [
        { name: "name", label: "Full name", required: true },
        { name: "phone", label: "Phone", type: "tel", required: true },
        { name: "email", label: "Email", type: "email" },
        { name: "emergency_contact", label: "Emergency contact" },
        { name: "id_proof", label: "ID proof (type / number)", full: true },
        { name: "room_id", label: "Room", type: "select", required: true, options: roomOptions, full: true },
        { name: "monthly_rent", label: "Monthly rent (₹)", type: "number", min: 0, hint: "Blank = room's rent per bed" },
        { name: "deposit", label: "Security deposit (₹)", type: "number", min: 0 },
        { name: "join_date", label: "Join date", type: "date", required: true, full: true },
      ],
      values: existing || { join_date: today(), deposit: 0 },
      onSubmit: saveThen((d) => (existing ? A.put(`/api/tenants/${existing.id}`, d) : A.post("/api/tenants", d)), existing ? "Tenant updated" : "Tenant added"),
    });
  }

  function checkoutDialog(t) {
    formDialog({
      title: `Check out ${t.name}`,
      submitLabel: "Check out",
      fields: [{ name: "leave_date", label: "Leave date", type: "date", required: true, full: true }],
      values: { leave_date: today() },
      onSubmit: async (d) => {
        const res = await A.post(`/api/tenants/${t.id}/checkout`, d);
        toast(res.outstanding > 0 ? `${t.name} checked out. Outstanding dues: ${inr(res.outstanding)}` : `${t.name} checked out`, res.outstanding > 0 ? "error" : "");
        render();
      },
    });
  }

  async function tenantDetail(id) {
    const t = await A.get(`/api/tenants/${id}`);
    const kv = (k, v) => [h("dt", { text: k }), h("dd", {}, v == null || v === "" ? "—" : v)];
    const dlg = openDialog(
      h(
        "div",
        { class: "dlg" },
        h("h2", { text: t.name }),
        h("dl", { class: "kv" }, kv("Status", badge(t.status)), kv("Phone", t.phone), kv("Email", t.email), kv("Emergency", t.emergency_contact), kv("ID proof", t.id_proof), kv("Room", t.room ? `${t.property} · ${t.room}` : null), kv("Monthly rent", inr(t.monthly_rent)), kv("Deposit", inr(t.deposit)), kv("Joined", t.join_date), kv("Left", t.leave_date), kv("Balance due", h("strong", { text: inr(t.balance) }))),
        h("h3", { text: "Invoices" }),
        table(
          [
            { label: "Period", key: "period" },
            { label: "Description", key: "description" },
            { label: "Amount", key: "amount", money: true, num: true },
            { label: "Paid", key: "paid", money: true, num: true },
            { label: "Balance", key: "balance", money: true, num: true },
            { label: "Status", key: "status", badge: true },
          ],
          t.invoices,
          { empty: "No invoices yet." }
        ),
        h("div", { class: "dlg-actions" }, btn("Close", () => dlg.close()))
      ),
      { wide: true }
    );
  }

  VIEWS.tenants = async (q) => {
    const status = q.status === undefined ? "active" : q.status;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (q.q) params.set("q", q.q);
    const rows = await A.get("/api/tenants?" + params);
    const w = can("tenants", "write");
    const go = () => {
      const p = new URLSearchParams();
      p.set("status", statusSel.value);
      if (search.value.trim()) p.set("q", search.value.trim());
      location.hash = "#/tenants?" + p;
    };
    const statusSel = h("select", { onchange: go }, [["active", "Active"], ["left", "Checked out"], ["", "All"]].map(([v, l]) => h("option", { value: v, text: l })));
    statusSel.value = status;
    const search = h("input", { type: "search", placeholder: "Name or phone", value: q.q || "", onkeydown: (e) => e.key === "Enter" && go() });
    return [
      h("div", { class: "toolbar" }, h("div", { class: "filters" }, h("label", {}, "Status", statusSel), h("label", {}, "Search", search), btn("Search", go)), w ? btn("+ Add tenant", () => tenantForm(), "primary") : null),
      panel(
        null,
        table(
          [
            { label: "Name", key: "name" },
            { label: "Phone", key: "phone" },
            { label: "Property", key: "property" },
            { label: "Room", key: "room" },
            { label: "Rent", key: "monthly_rent", money: true, num: true },
            { label: "Deposit", key: "deposit", money: true, num: true },
            { label: "Joined", key: "join_date" },
            { label: "Status", key: "status", badge: true },
          ],
          rows,
          {
            empty: "No tenants match.",
            rowActions: (r) => [
              btn("View", () => tenantDetail(r.id).catch((e) => toast(e.message, "error")), "small"),
              w ? btn("Edit", () => tenantForm(r), "small") : null,
              w && r.status === "active" ? btn("Check out", () => checkoutDialog(r), "small danger") : null,
            ],
          }
        )
      ),
    ];
  };

  /* ================= invoices & payments ================= */

  function payDialog(inv) {
    formDialog({
      title: `Record payment: ${inv.tenant_name} (${inv.period})`,
      submitLabel: "Record payment",
      fields: [
        { name: "amount", label: `Amount (₹) — balance ${inr(inv.balance)}`, type: "number", required: true, min: 1, max: inv.balance, full: true },
        { name: "method", label: "Method", type: "select", required: true, options: ["cash", "upi", "bank", "card", "other"].map((m) => ({ value: m, label: titleCase(m) })) },
        { name: "paid_on", label: "Paid on", type: "date", required: true, max: today() },
        { name: "reference", label: "Reference / transaction id", full: true },
      ],
      values: { amount: inv.balance, method: "upi", paid_on: today() },
      onSubmit: saveThen((d) => A.post("/api/payments", { ...d, invoice_id: inv.id }), "Payment recorded"),
    });
  }

  async function paymentHistory(inv) {
    const pays = await A.get(`/api/payments?invoice_id=${inv.id}`);
    const dlg = openDialog(
      h("div", { class: "dlg" }, h("h2", { text: `Payments: ${inv.tenant_name} (${inv.period})` }),
        table([{ label: "Date", key: "paid_on" }, { label: "Amount", key: "amount", money: true, num: true }, { label: "Method", key: "method" }, { label: "Reference", key: "reference" }, { label: "Recorded by", key: "recorded_by" }], pays, { empty: "No payments yet." }),
        h("div", { class: "dlg-actions" }, btn("Close", () => dlg.close())))
    );
  }

  VIEWS.invoices = async (q) => {
    const params = new URLSearchParams();
    const period = q.period === undefined ? thisMonth() : q.period;
    if (period) params.set("period", period);
    if (q.status) params.set("status", q.status);
    const [rows, tenants] = await Promise.all([A.get("/api/invoices?" + params), can("invoices", "write") ? A.get("/api/tenants?status=active") : []]);
    const w = can("invoices", "write");
    const pw = can("payments", "write");
    const go = () => {
      const p = new URLSearchParams();
      p.set("period", periodIn.value);
      if (statusSel.value) p.set("status", statusSel.value);
      location.hash = "#/invoices?" + p;
    };
    const periodIn = h("input", { type: "month", value: period, onchange: go });
    const statusSel = h("select", { onchange: go }, [["", "All"], ["unpaid", "Unpaid"], ["partial", "Partial"], ["overdue", "Overdue"], ["paid", "Paid"]].map(([v, l]) => h("option", { value: v, text: l })));
    statusSel.value = q.status || "";

    const generate = () =>
      formDialog({
        title: "Generate monthly rent",
        submitLabel: "Generate",
        fields: [
          { name: "period", label: "Month", type: "month", required: true },
          { name: "due_day", label: "Due day of month (1-28)", type: "number", min: 1, max: 28, required: true },
        ],
        values: { period: periodIn.value || thisMonth(), due_day: 5 },
        onSubmit: async (d) => {
          const res = await A.post("/api/invoices/generate", d);
          toast(`${res.created} invoice${res.created === 1 ? "" : "s"} created, ${res.skipped} already existed`);
          location.hash = `#/invoices?period=${res.period}`;
          render();
        },
      });
    const addManual = () =>
      formDialog({
        title: "New invoice",
        fields: [
          { name: "tenant_id", label: "Tenant", type: "select", required: true, options: opts(tenants, (t) => `${t.name} (${t.property || "—"} ${t.room || ""})`), full: true },
          { name: "period", label: "Period", type: "month", required: true },
          { name: "due_date", label: "Due date", type: "date", required: true },
          { name: "description", label: "Description", full: true, hint: "e.g. Electricity, Late fee" },
          { name: "amount", label: "Amount (₹)", type: "number", required: true, min: 0, full: true },
        ],
        values: { period: period || thisMonth(), due_date: today(), description: "Monthly rent" },
        onSubmit: saveThen((d) => A.post("/api/invoices", d), "Invoice created"),
      });

    const totals = rows.reduce((s, r) => ({ amount: s.amount + r.amount, paid: s.paid + r.paid, balance: s.balance + r.balance }), { amount: 0, paid: 0, balance: 0 });
    return [
      h("div", { class: "toolbar" }, h("div", { class: "filters" }, h("label", {}, "Month", periodIn), h("label", {}, "Status", statusSel), btn("All months", () => (location.hash = "#/invoices?period="))), h("div", { class: "filters" }, w ? btn("Generate monthly rent", generate, "primary") : null, w ? btn("+ Manual invoice", addManual) : null)),
      panel(
        `${rows.length} invoice${rows.length === 1 ? "" : "s"} · Billed ${inr(totals.amount)} · Paid ${inr(totals.paid)} · Balance ${inr(totals.balance)}`,
        table(
          [
            { label: "Tenant", key: "tenant_name" },
            { label: "Room", render: (r) => (r.property ? `${r.property} · ${r.room}` : null) },
            { label: "Period", key: "period" },
            { label: "Description", key: "description" },
            { label: "Amount", key: "amount", money: true, num: true },
            { label: "Paid", key: "paid", money: true, num: true },
            { label: "Balance", key: "balance", money: true, num: true },
            { label: "Due", key: "due_date" },
            { label: "Status", key: "status", badge: true },
          ],
          rows,
          {
            empty: "No invoices for this filter. Use “Generate monthly rent” to bill all active tenants.",
            rowActions: (r) => [
              pw && r.balance > 0 ? btn("Pay", () => payDialog(r), "small primary") : null,
              r.paid > 0 ? btn("History", () => paymentHistory(r).catch((e) => toast(e.message, "error")), "small") : null,
              w && r.paid === 0 ? btn("Delete", () => confirmThen({ title: "Delete invoice", message: `Delete the ${r.description} invoice for ${r.tenant_name}?`, confirmLabel: "Delete", danger: true }, () => A.del(`/api/invoices/${r.id}`), "Invoice deleted"), "small danger") : null,
            ],
          }
        )
      ),
    ];
  };

  VIEWS.payments = async () => {
    const rows = await A.get("/api/payments");
    const admin = can("users", "write");
    return [
      panel(
        `Latest ${rows.length} payments`,
        table(
          [
            { label: "Date", key: "paid_on" },
            { label: "Tenant", key: "tenant_name" },
            { label: "For", key: "period" },
            { label: "Amount", key: "amount", money: true, num: true },
            { label: "Method", render: (r) => titleCase(r.method) },
            { label: "Reference", key: "reference" },
            { label: "Recorded by", key: "recorded_by" },
          ],
          rows,
          {
            empty: "No payments recorded yet.",
            rowActions: admin ? (r) => [btn("Reverse", () => confirmThen({ title: "Reverse payment", message: `Remove the ${inr(r.amount)} payment from ${r.tenant_name}? The invoice becomes unpaid again.`, confirmLabel: "Reverse", danger: true }, () => A.del(`/api/payments/${r.id}`), "Payment reversed"), "small danger")] : undefined,
          }
        )
      ),
    ];
  };

  /* ================= expenses ================= */

  const CATEGORIES = ["Electricity", "Water", "Internet", "Food & groceries", "Salaries", "Repairs", "Cleaning", "Rent / lease", "Taxes", "Other"];

  VIEWS.expenses = async () => {
    const [rows, props] = await Promise.all([A.get("/api/expenses"), A.get("/api/properties")]);
    const w = can("expenses", "write");
    const fields = [
      { name: "category", label: "Category", type: "select", required: true, options: CATEGORIES.map((c) => ({ value: c, label: c })) },
      { name: "spent_on", label: "Date", type: "date", required: true, max: today() },
      { name: "property_id", label: "Property", type: "select", options: opts(props, (p) => p.name), blank: "— general —" },
      { name: "amount", label: "Amount (₹)", type: "number", required: true, min: 1 },
      { name: "description", label: "Description", type: "textarea", full: true, max: 300 },
    ];
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return [
      h("div", { class: "toolbar" }, h("span"), w ? btn("+ Add expense", () => formDialog({ title: "New expense", fields, values: { spent_on: today() }, onSubmit: saveThen((d) => A.post("/api/expenses", d), "Expense added") }), "primary") : null),
      panel(
        `Latest ${rows.length} expenses · ${inr(total)}`,
        table(
          [
            { label: "Date", key: "spent_on" },
            { label: "Category", key: "category" },
            { label: "Property", key: "property" },
            { label: "Description", key: "description" },
            { label: "Amount", key: "amount", money: true, num: true },
          ],
          rows,
          {
            empty: "No expenses recorded yet.",
            rowActions: w ? (r) => [
              btn("Edit", () => formDialog({ title: "Edit expense", fields, values: r, onSubmit: saveThen((d) => A.put(`/api/expenses/${r.id}`, d), "Expense updated") }), "small"),
              btn("Delete", () => confirmThen({ title: "Delete expense", message: `Delete this ${inr(r.amount)} ${r.category} expense?`, confirmLabel: "Delete", danger: true }, () => A.del(`/api/expenses/${r.id}`), "Expense deleted"), "small danger"),
            ] : undefined,
          }
        )
      ),
    ];
  };

  /* ================= maintenance ================= */

  VIEWS.tickets = async () => {
    const [rows, props, rooms] = await Promise.all([A.get("/api/tickets"), A.get("/api/properties"), A.get("/api/rooms")]);
    const w = can("tickets", "write");
    const fields = (existing) => [
      { name: "title", label: "Title", required: true, full: true },
      { name: "property_id", label: "Property", type: "select", required: true, options: opts(props, (p) => p.name) },
      { name: "room_id", label: "Room", type: "select", options: opts(rooms, (r) => `${r.property} · ${r.number}`), blank: "— common area —" },
      { name: "priority", label: "Priority", type: "select", required: true, options: ["low", "medium", "high"].map((p) => ({ value: p, label: titleCase(p) })) },
      ...(existing ? [{ name: "status", label: "Status", type: "select", required: true, options: ["open", "in_progress", "resolved"].map((s) => ({ value: s, label: titleCase(s) })) }] : []),
      { name: "description", label: "Details", type: "textarea", full: true, max: 1000 },
    ];
    const setStatus = (r, status) => A.put(`/api/tickets/${r.id}`, { status }).then(() => render()).catch((e) => toast(e.message, "error"));
    return [
      h("div", { class: "toolbar" }, h("span"), w ? btn("+ New ticket", () => formDialog({ title: "New maintenance ticket", fields: fields(false), values: { priority: "medium" }, onSubmit: saveThen((d) => A.post("/api/tickets", d), "Ticket created") }), "primary") : null),
      panel(
        null,
        table(
          [
            { label: "Title", key: "title" },
            { label: "Property", key: "property" },
            { label: "Room", key: "room" },
            { label: "Priority", key: "priority", badge: true },
            { label: "Status", key: "status", badge: true },
            { label: "Opened", render: (r) => r.created_at.slice(0, 10) },
          ],
          rows,
          {
            empty: "No maintenance tickets. 🎉",
            rowActions: w ? (r) => [
              r.status === "open" ? btn("Start", () => setStatus(r, "in_progress"), "small") : null,
              r.status !== "resolved" ? btn("Resolve", () => setStatus(r, "resolved"), "small primary") : btn("Reopen", () => setStatus(r, "open"), "small"),
              btn("Edit", () => formDialog({ title: "Edit ticket", fields: fields(true), values: r, onSubmit: saveThen((d) => A.put(`/api/tickets/${r.id}`, d), "Ticket updated") }), "small"),
              btn("Delete", () => confirmThen({ title: "Delete ticket", message: `Delete “${r.title}”?`, confirmLabel: "Delete", danger: true }, () => A.del(`/api/tickets/${r.id}`), "Ticket deleted"), "small danger"),
            ] : undefined,
          }
        )
      ),
    ];
  };

  /* ================= reports ================= */

  VIEWS.reports = async (q) => {
    const name = q.report || "rent-roll";
    const period = q.period || thisMonth();
    const from = q.from || "";
    const to = q.to || "";
    const params = new URLSearchParams();
    if (name === "rent-roll") params.set("period", period);
    if (name === "pnl") {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    }
    const qs = params.toString();
    const res = await A.get(`/api/reports/${name}${qs ? "?" + qs : ""}`);

    const reportSel = h("select", { onchange: () => go() }, [["rent-roll", "Rent roll (by month)"], ["dues", "Outstanding dues"], ["pnl", "Profit & loss"], ["occupancy", "Occupancy"]].map(([v, l]) => h("option", { value: v, text: l })));
    reportSel.value = name;
    const periodIn = h("input", { type: "month", value: period, onchange: () => go() });
    const fromIn = h("input", { type: "date", value: from, onchange: () => go() });
    const toIn = h("input", { type: "date", value: to, onchange: () => go() });
    const go = () => {
      const p = new URLSearchParams({ report: reportSel.value });
      if (reportSel.value === "rent-roll") p.set("period", periodIn.value);
      if (reportSel.value === "pnl") {
        if (fromIn.value) p.set("from", fromIn.value);
        if (toIn.value) p.set("to", toIn.value);
      }
      location.hash = "#/reports?" + p;
    };

    const money = new Set(["amount", "paid", "balance", "income", "expenses", "net", "rent_per_bed"]);
    const cols = res.columns.map((c) => ({ label: c.label, key: c.key, money: money.has(c.key) || /^(Billed|Paid|Balance|Income|Expenses|Net)$/.test(c.label), num: money.has(c.key) || /^(Billed|Paid|Balance|Income|Expenses|Net|Beds|Occupied|Vacant|Open invoices)$/.test(c.label), badge: c.key === "status" }));
    const csvHref = `/api/reports/${name}?${new URLSearchParams([...params, ["format", "csv"]])}`;

    return [
      h("div", { class: "toolbar" },
        h("div", { class: "filters" },
          h("label", {}, "Report", reportSel),
          name === "rent-roll" ? h("label", {}, "Month", periodIn) : null,
          name === "pnl" ? [h("label", {}, "From", fromIn), h("label", {}, "To", toIn)] : null),
        h("a", { class: "btn", href: csvHref, download: `${name}.csv`, text: "Download CSV" })),
      panel(res.title || "Report", table(cols, res.rows, { empty: "No data for this selection." })),
      name === "pnl" && res.by_category && res.by_category.length
        ? panel("Expenses by category", table([{ label: "Category", key: "category" }, { label: "Amount", key: "amount", money: true, num: true }], res.by_category))
        : null,
    ].filter(Boolean);
  };

  /* ================= users & audit (admin) ================= */

  VIEWS.users = async () => {
    const rows = await A.get("/api/users");
    const roles = ["admin", "manager", "accountant"].map((r) => ({ value: r, label: titleCase(r) }));
    const createFields = [
      { name: "name", label: "Name", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "role", label: "Role", type: "select", required: true, options: roles },
      { name: "password", label: "Temporary password (min 8)", type: "password", required: true },
    ];
    const editFields = [
      { name: "name", label: "Name", required: true },
      { name: "role", label: "Role", type: "select", required: true, options: roles },
      { name: "active", label: "Account", type: "select", required: true, options: [{ value: 1, label: "Active" }, { value: 0, label: "Deactivated" }] },
      { name: "password", label: "Reset password (leave blank to keep)", type: "password", full: true },
    ];
    return [
      h("div", { class: "toolbar" }, h("span"), btn("+ Add user", () => formDialog({ title: "New user", fields: createFields, values: { role: "manager" }, onSubmit: saveThen((d) => A.post("/api/users", d), "User created") }), "primary")),
      panel(
        "Roles: Admin = everything · Manager = properties, rooms, tenants, maintenance · Accountant = invoices, payments, expenses",
        table(
          [
            { label: "Name", key: "name" },
            { label: "Email", key: "email" },
            { label: "Role", render: (r) => titleCase(r.role) },
            { label: "Status", render: (r) => (r.active ? "active" : "left"), badge: true },
            { label: "Created", render: (r) => r.created_at.slice(0, 10) },
          ],
          rows,
          {
            rowActions: (r) => [
              btn("Edit", () => formDialog({ title: `Edit ${r.name}`, fields: editFields, values: { ...r, password: "" }, onSubmit: saveThen((d) => { const body = { ...d, active: Number(d.active) }; if (!body.password) delete body.password; return A.put(`/api/users/${r.id}`, body); }, "User updated") }), "small"),
            ],
          }
        )
      ),
    ];
  };

  VIEWS.audit = async () => {
    const rows = await A.get("/api/audit");
    return [panel("Latest 300 events", table([{ label: "When (UTC)", key: "at" }, { label: "User", key: "user_name" }, { label: "Action", key: "action" }, { label: "Entity", render: (r) => `${r.entity}${r.entity_id ? " #" + r.entity_id : ""}` }, { label: "Detail", key: "detail" }], rows, { empty: "No events." }))];
  };

  /* ================= boot ================= */

  A.onUnauthorized(() => showLogin("Your session has expired. Please sign in again."));
  window.addEventListener("hashchange", render);

  (async () => {
    try {
      const res = await A.get("/api/me");
      me = res.user;
      perms = res.permissions;
      showShell();
    } catch {
      showLogin();
    }
  })();
})();
