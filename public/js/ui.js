// Small UI toolkit: DOM helper, API client, dialogs, tables, toasts. Everything is rendered with
// textContent / DOM nodes (never innerHTML), so stored data cannot inject markup.
const UI = (() => {
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  const inr = (n) => (Number(n) < 0 ? "-₹" : "₹") + Math.abs(Number(n || 0)).toLocaleString("en-IN");
  const today = () => new Date().toISOString().slice(0, 10);
  const thisMonth = () => today().slice(0, 7);
  const titleCase = (s) => String(s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const badge = (value) => h("span", { class: `badge ${value}`, text: titleCase(value) });

  /* ----- API ----- */
  let onUnauthorized = () => {};
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const isJson = (res.headers.get("content-type") || "").includes("json");
    const data = isJson ? await res.json() : null;
    if (!res.ok) {
      if (res.status === 401 && !url.startsWith("/api/login") && !url.startsWith("/api/me")) onUnauthorized();
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  }
  const A = {
    get: (u) => api("GET", u),
    post: (u, b = {}) => api("POST", u, b),
    put: (u, b) => api("PUT", u, b),
    del: (u) => api("DELETE", u),
    onUnauthorized: (fn) => (onUnauthorized = fn),
  };

  /* ----- toasts ----- */
  function toast(message, kind = "") {
    const el = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status", text: message });
    document.getElementById("toasts").append(el);
    setTimeout(() => el.remove(), kind === "error" ? 6000 : 3500);
  }

  /* ----- dialogs ----- */
  function openDialog(content, { wide = false } = {}) {
    const dlg = h("dialog", { class: wide ? "wide" : "" }, content);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  }

  function buildField(f, value) {
    let input;
    const common = { name: f.name, id: `f-${f.name}` };
    if (f.type === "select") {
      input = h("select", common);
      if (!f.required) input.append(h("option", { value: "", text: f.blank || "— none —" }));
      for (const o of f.options || []) {
        input.append(h("option", { value: String(o.value), text: o.label, disabled: o.disabled }));
      }
      input.value = value == null ? "" : String(value);
    } else if (f.type === "textarea") {
      input = h("textarea", { ...common, rows: 3, maxlength: f.max });
      input.value = value ?? "";
    } else {
      input = h("input", {
        ...common, type: f.type || "text", min: f.min, max: f.max, step: f.step, maxlength: f.maxlength,
        placeholder: f.placeholder, autocomplete: f.type === "password" ? "new-password" : "off",
      });
      input.value = value ?? "";
    }
    if (f.required) input.required = true;
    return h("label", { class: f.full ? "full" : "", for: common.id }, f.label + (f.required ? " *" : ""), input, f.hint ? h("small", { text: f.hint, class: "hint" }) : null);
  }

  // fields: [{name,label,type,options,required,full}], onSubmit(data) may throw to show an error
  function formDialog({ title, fields, values = {}, submitLabel = "Save", onSubmit }) {
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { class: "btn primary", type: "submit", text: submitLabel });
    const form = h(
      "form",
      { novalidate: false },
      h("h2", { text: title }),
      h("div", { class: "fields" }, fields.map((f) => buildField(f, values[f.name]))),
      error,
      h("div", { class: "dlg-actions" }, h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => dlg.close() }), submit)
    );
    const dlg = openDialog(form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = {};
      for (const f of fields) {
        const el = form.elements[f.name];
        data[f.name] = f.type === "number" && el.value !== "" ? Number(el.value) : el.value;
      }
      submit.disabled = true;
      error.hidden = true;
      try {
        await onSubmit(data);
        dlg.close();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
    const first = form.querySelector("input, select, textarea");
    if (first) first.focus();
    return dlg;
  }

  function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
    return new Promise((resolve) => {
      let answer = false;
      const dlg = openDialog(
        h(
          "div",
          { class: "dlg" },
          h("h2", { text: title }),
          h("p", { text: message }),
          h(
            "div",
            { class: "dlg-actions" },
            h("button", { class: "btn", text: "Cancel", onclick: () => dlg.close() }),
            h("button", { class: `btn ${danger ? "danger" : "primary"}`, text: confirmLabel, onclick: () => ((answer = true), dlg.close()) })
          )
        )
      );
      dlg.addEventListener("close", () => resolve(answer));
    });
  }

  /* ----- tables ----- */
  // columns: [{label, key|render(row), num, badge}], rowActions(row) -> array of nodes
  function table(columns, rows, { rowActions, empty = "Nothing here yet." } = {}) {
    if (!rows.length) return h("div", { class: "empty", text: empty });
    const head = h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : "", text: c.label })), rowActions ? h("th") : null);
    const body = rows.map((r) =>
      h(
        "tr",
        {},
        columns.map((c) => {
          let content = c.render ? c.render(r) : r[c.key];
          if (c.badge && content != null && content !== "") content = badge(content);
          if (c.money) content = inr(content);
          return h("td", { class: c.num ? "num" : "" }, content == null || content === "" ? "—" : content);
        }),
        rowActions ? h("td", {}, h("div", { class: "row-actions" }, rowActions(r))) : null
      )
    );
    return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, head), h("tbody", {}, body)));
  }

  const panel = (title, ...body) => h("section", { class: "panel" }, title ? h("h2", { text: title }) : null, ...body);
  const btn = (text, onclick, cls = "") => h("button", { type: "button", class: `btn ${cls}`, text, onclick });

  return { h, inr, today, thisMonth, titleCase, badge, A, toast, openDialog, formDialog, confirmDialog, table, panel, btn };
})();
