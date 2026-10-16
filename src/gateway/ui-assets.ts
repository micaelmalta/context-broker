// src/gateway/ui-assets.ts
// The gateway web UI: one HTML page, one script, one stylesheet. No build step, no dependencies.
// The script builds DOM with textContent only (never innerHTML) and the CSP forbids inline script.

export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lazygate</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<header>
  <h1>lazygate <span>gateway</span></h1>
  <div id="who"></div>
</header>
<nav id="tabs" hidden></nav>
<main id="app"></main>
<script src="/ui/app.js"></script>
</body>
</html>
`;

export const UI_CSS = String.raw`
:root { color-scheme: light dark; --bg:#f7f7f5; --panel:#fff; --fg:#1d1d1f; --muted:#6b6b72; --line:#e2e2de; --accent:#2f6fed; --bad:#c62828; --good:#2e7d32; }
@media (prefers-color-scheme: dark) { :root { --bg:#161618; --panel:#1f1f22; --fg:#ececee; --muted:#9a9aa3; --line:#34343a; --accent:#6d9bff; --bad:#ff7b72; --good:#6fcf7a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display:flex; justify-content:space-between; align-items:center; padding:14px 24px; border-bottom:1px solid var(--line); background:var(--panel); }
h1 { font-size:17px; margin:0; } h1 span { color:var(--muted); font-weight:400; }
h2 { font-size:15px; margin:0 0 12px; }
nav { display:flex; gap:4px; padding:0 24px; background:var(--panel); border-bottom:1px solid var(--line); }
nav button { background:none; border:0; border-bottom:2px solid transparent; padding:10px 12px; color:var(--muted); cursor:pointer; font:inherit; }
nav button.on { color:var(--fg); border-bottom-color:var(--accent); }
main { max-width:980px; margin:24px auto; padding:0 24px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:500; font-size:12px; }
code, .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
input, select, textarea { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
input[type=text], input[type=password], textarea { width:100%; } textarea { min-height:70px; font-family:ui-monospace, Menlo, monospace; font-size:12.5px; }
button.btn { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--panel); color:var(--fg); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; } button.danger { color:var(--bad); }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; } .row > * { flex:0 0 auto; } .row > .grow { flex:1 1 200px; }
.muted { color:var(--muted); } .bad { color:var(--bad); } .good { color:var(--good); }
.pill { display:inline-block; font-size:11.5px; padding:1px 8px; border-radius:99px; border:1px solid var(--line); color:var(--muted); margin-right:4px; }
.notice { padding:10px 12px; border-radius:6px; border:1px solid var(--line); margin-bottom:12px; background:var(--bg); }
.notice.error { border-color:var(--bad); color:var(--bad); } .notice.ok { border-color:var(--good); }
.token { word-break:break-all; user-select:all; padding:8px; background:var(--bg); border:1px dashed var(--line); border-radius:6px; }
.login { max-width:420px; margin:60px auto; } .ml { margin-left:8px; } .fieldname { min-width:90px; } label.inline { margin:0; } label.inline.top { margin-top:20px; }
label { display:block; font-size:12px; color:var(--muted); margin:8px 0 3px; }
`;

export const UI_JS = String.raw`(function () {
  "use strict";
  var KEY = "lazygate.token";
  var token = sessionStorage.getItem(KEY) || "";
  var me = null;
  var tab = null;
  var app = document.getElementById("app");
  var tabsEl = document.getElementById("tabs");
  var whoEl = document.getElementById("who");

  // ── helpers ──────────────────────────────────────────────────────────────
  function h(tag, props) {
    var el = document.createElement(tag);
    for (var k in props || {}) {
      var v = props[k];
      if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function api(method, path, body) {
    var opts = { method: method, headers: { Authorization: "Bearer " + token } };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch("/ui/api/" + path, opts).then(function (r) {
      if (r.status === 204) return null;
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { signOut(); throw new Error("Signed out — the token is invalid or expired"); }
        if (!r.ok) throw new Error(data.error || ("Request failed (" + r.status + ")"));
        return data;
      });
    });
  }
  function notice(kind, text) { return h("div", { class: "notice " + kind }, text); }
  function ago(ts) {
    var s = Math.round((Date.now() - (typeof ts === "number" ? ts : Date.parse(ts))) / 1000);
    if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago"; if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function guard(box, fn) { return function (e) { if (e && e.preventDefault) e.preventDefault(); fn(e).catch(function (err) { show(box, notice("error", err.message)); }); }; }
  function show(box, node) { clear(box); box.appendChild(node); }
  function table(head, rows, empty) {
    if (!rows.length) return h("p", { class: "muted" }, empty);
    return h("table", null, h("thead", null, h("tr", null, head.map(function (t) { return h("th", null, t); }))),
      h("tbody", null, rows.map(function (r) { return h("tr", null, r.map(function (c) { return h("td", null, c); })); })));
  }
  function pills(list) { return (list || []).map(function (g) { return h("span", { class: "pill" }, g); }); }

  // ── sign in / out ────────────────────────────────────────────────────────
  function signOut() { token = ""; me = null; sessionStorage.removeItem(KEY); render(); }

  function loginView() {
    var box = h("div"), input = h("input", { type: "password", placeholder: "lzg_…", autocomplete: "new-password" });
    var form = h("form", { onsubmit: guard(box, function () {
      token = input.value.trim();
      return api("GET", "me").then(function (m) { me = m; sessionStorage.setItem(KEY, token); render(); }).catch(function (e) { token = ""; throw e; });
    }) }, h("label", null, "Access token"), input,
      h("p", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Sign in")),
      h("p", { class: "muted" }, "Create one with: lazygate token create --user <you> [--admin]"), box);
    return h("div", { class: "card login" }, h("h2", null, "Sign in"), form);
  }

  // ── tabs ─────────────────────────────────────────────────────────────────
  var TABS = [
    ["connections", "My credentials", false, connectionsView],
    ["activity", "Activity", false, activityView],
    ["sessions", "Sessions", true, sessionsView],
    ["tokens", "Tokens", true, tokensView],
    ["secrets", "Secrets", true, secretsView],
    ["servers", "Servers", true, serversView]
  ];

  function render() {
    clear(app); clear(tabsEl); clear(whoEl);
    if (!token || !me) {
      tabsEl.hidden = true;
      if (token && !me) { api("GET", "me").then(function (m) { me = m; render(); }).catch(function () { signOut(); }); return; }
      app.appendChild(loginView());
      return;
    }
    whoEl.appendChild(h("span", { class: "muted" }, me.user + " "));
    if (me.admin) whoEl.appendChild(h("span", { class: "pill" }, "admin"));
    pills(me.groups).forEach(function (p) { whoEl.appendChild(p); });
    whoEl.appendChild(h("button", { class: "btn ml", onclick: signOut }, "Sign out"));

    var visible = TABS.filter(function (t) { return !t[2] || me.admin; });
    if (!tab || !visible.some(function (t) { return t[0] === tab; })) tab = visible[0][0];
    tabsEl.hidden = false;
    visible.forEach(function (t) {
      tabsEl.appendChild(h("button", { class: t[0] === tab ? "on" : "", onclick: function () { tab = t[0]; render(); } }, t[1]));
    });
    var view = visible.filter(function (t) { return t[0] === tab; })[0][3];
    var holder = h("div", null, h("p", { class: "muted" }, "Loading…"));
    app.appendChild(holder);
    view(holder);
  }

  // ── my credentials ───────────────────────────────────────────────────────
  function connectionsView(root) {
    api("GET", "connections").then(function (d) {
      clear(root);
      root.appendChild(h("div", { class: "notice" }, "Keys you save here are encrypted on the gateway and used for your MCP sessions. " +
        "A key sent in an X-Lazygate-Cred-… request header takes precedence. Values are never shown again."));
      if (!d.connections.length) root.appendChild(h("p", { class: "muted" }, "No server needs a personal credential."));
      d.connections.forEach(function (c) {
        var card = h("div", { class: "card" }, h("h2", null, c.server, " ", c.oauth ? h("span", { class: "pill" }, "OAuth") : null), h("p", { class: "muted" }, c.description));
        c.fields.forEach(function (f) {
          var box = h("div"), input = h("input", { type: "password", placeholder: f.stored ? "stored — enter a new value to replace" : "value", autocomplete: "new-password" });
          var row = h("form", { class: "row", onsubmit: guard(box, function () {
            if (!input.value) return Promise.resolve();
            return api("PUT", "connections/" + encodeURIComponent(c.server) + "/" + encodeURIComponent(f.name), { value: input.value }).then(function () { connectionsView(root); });
          }) },
            h("span", { class: "mono fieldname" }, f.name), h("div", { class: "grow" }, input),
            h("button", { class: "btn primary", type: "submit" }, "Save"),
            f.stored ? h("button", { class: "btn danger", type: "button", onclick: guard(box, function () {
              return api("DELETE", "connections/" + encodeURIComponent(c.server) + "/" + encodeURIComponent(f.name)).then(function () { connectionsView(root); });
            }) }, "Remove") : null,
            f.stored ? h("span", { class: "good" }, "stored") : h("span", { class: f.sharedFallback ? "muted" : "bad" }, f.sharedFallback ? "using shared key" : "missing"));
          card.appendChild(row); card.appendChild(box);
        });
        root.appendChild(card);
      });
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── activity ─────────────────────────────────────────────────────────────
  function activityView(root) {
    var all = me.admin ? "&all=1" : "";
    api("GET", "audit?limit=200" + all).then(function (d) {
      clear(root);
      root.appendChild(h("div", { class: "card" }, h("h2", null, me.admin ? "Recent tool calls (everyone)" : "Your recent tool calls"),
        table(["When", "User", "Tool", "Server", "Result", "ms"], d.events.map(function (e) {
          return [ago(e.ts), e.user, h("code", null, e.tool), e.server || "", e.ok ? h("span", { class: "good" }, "ok") : h("span", { class: "bad", title: e.error || "" }, "error"), String(e.ms)];
        }), "Nothing yet.")));
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── sessions (admin) ─────────────────────────────────────────────────────
  function sessionsView(root) {
    api("GET", "status").then(function (s) {
      clear(root);
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Gateway"),
        h("p", null, "Up " + Math.round(s.uptimeSec / 60) + " min · " + s.servers + " servers · " + s.tokens + " tokens · " + s.secrets + " secrets · " + s.sessions.length + " live sessions"),
        h("button", { class: "btn", onclick: function () { sessionsView(root); } }, "Refresh")));
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Live sessions"),
        table(["Session", "User", "Started", "Last seen", "Active servers"], s.sessions.map(function (x) {
          return [h("code", null, x.id.slice(0, 8)), x.user, ago(x.createdAt), ago(x.lastSeen), pills(x.servers)];
        }), "No live sessions.")));
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── tokens (admin) ───────────────────────────────────────────────────────
  function tokensView(root, created) {
    api("GET", "tokens").then(function (d) {
      clear(root);
      var box = h("div");
      if (created) root.appendChild(h("div", { class: "card" }, h("h2", null, "New token for " + created.user), h("p", { class: "muted" }, "Copy it now — it is not shown again."), h("div", { class: "token mono" }, created.token)));
      var user = h("input", { type: "text", placeholder: "alice" }), groups = h("input", { type: "text", placeholder: "eng, sre" }),
        expires = h("input", { type: "text", placeholder: "90d (optional)" }), label = h("input", { type: "text", placeholder: "label (optional)" }),
        admin = h("input", { type: "checkbox" });
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Create token"),
        h("form", { onsubmit: guard(box, function () {
          return api("POST", "tokens", { user: user.value.trim(), groups: groups.value.split(","), expires: expires.value, label: label.value, admin: admin.checked })
            .then(function (t) { tokensView(root, { user: user.value.trim(), token: t.token }); });
        }) }, h("div", { class: "row" }, h("div", { class: "grow" }, h("label", null, "User"), user), h("div", { class: "grow" }, h("label", null, "Groups"), groups),
          h("div", { class: "grow" }, h("label", null, "Expires"), expires), h("div", { class: "grow" }, h("label", null, "Label"), label)),
          h("p", { class: "row" }, h("label", { class: "inline" }, admin, " admin (manage tokens, secrets, servers)"), h("button", { class: "btn primary", type: "submit" }, "Create")), box)));
      var rbox = h("div");
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Tokens"), rbox,
        table(["ID", "User", "Groups", "Created", "Expires", ""], d.tokens.map(function (t) {
          return [h("code", null, t.id), [t.user, t.admin ? h("span", { class: "pill ml" }, "admin") : null, t.label ? h("span", { class: "muted" }, " " + t.label) : null],
            pills(t.groups), ago(t.createdAt), t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "never",
            h("button", { class: "btn danger", onclick: guard(rbox, function () {
              if (!confirm("Revoke token " + t.id + " for " + t.user + "?")) return Promise.resolve();
              return api("DELETE", "tokens/" + t.id).then(function () { tokensView(root); });
            }) }, "Revoke")];
        }), "No tokens.")));
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── secrets (admin) ──────────────────────────────────────────────────────
  function secretsView(root) {
    api("GET", "secrets").then(function (d) {
      clear(root);
      var box = h("div"), path = h("input", { type: "text", placeholder: "datadog/api_key" }), value = h("input", { type: "password", autocomplete: "new-password", placeholder: "value" });
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Server-level secrets"),
        h("p", { class: "muted" }, "Shared by everyone who can use the server. Referenced from servers.json as \u0024{secret:path}. Values are never shown."),
        h("form", { class: "row", onsubmit: guard(box, function () {
          return api("PUT", "secrets", { path: path.value.trim(), value: value.value }).then(function () { secretsView(root); });
        }) }, h("div", { class: "grow" }, path), h("div", { class: "grow" }, value), h("button", { class: "btn primary", type: "submit" }, "Save")), box));
      var rbox = h("div");
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Stored"), rbox,
        table(["Path", ""], d.secrets.map(function (s) {
          return [h("code", null, s), h("button", { class: "btn danger", onclick: guard(rbox, function () {
            if (!confirm("Delete secret " + s + "?")) return Promise.resolve();
            return api("DELETE", "secrets?path=" + encodeURIComponent(s)).then(function () { secretsView(root); });
          }) }, "Delete")];
        }), "No secrets stored.")));
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── servers (admin) ──────────────────────────────────────────────────────
  function mapToText(m) { return Object.keys(m || {}).map(function (k) { return k + "=" + m[k]; }).join("\n"); }
  function textToMap(t) {
    var out = {};
    t.split("\n").forEach(function (line) { var i = line.indexOf("="); if (line.trim() && i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); });
    return out;
  }

  function serversView(root) {
    api("GET", "servers").then(function (d) {
      clear(root);
      if (!d.editable) root.appendChild(notice("error", "No servers.json is loaded, so servers can't be edited here."));
      d.servers.forEach(function (s) {
        var box = h("div"), a = s.auth;
        var scope = h("select", null, h("option", { value: "none" }, "no credentials"), h("option", { value: "server" }, "server (shared secrets)"), h("option", { value: "user" }, "user (each person's own)"));
        scope.value = a ? a.scope : "none";
        var fallback = h("input", { type: "checkbox" }); fallback.checked = Boolean(a && a.fallback);
        var env = h("textarea", { placeholder: "API_TOKEN=\u0024{cred:token}" }, mapToText(a && a.env));
        var hdr = h("textarea", { placeholder: "X-Api-Key=\u0024{secret:service/key}" }, mapToText(a && a.headers));
        var groups = h("input", { type: "text", placeholder: "everyone" }); groups.value = s.groups.join(", ");
        var auto = h("input", { type: "checkbox" }); auto.checked = s.autoActivate;
        var form = h("form", { onsubmit: guard(box, function () {
          var patch = { groups: groups.value.split(","), autoActivate: auto.checked,
            auth: scope.value === "none" ? null : { scope: scope.value, fallback: fallback.checked, env: textToMap(env.value), headers: textToMap(hdr.value) } };
          return api("PATCH", "servers/" + encodeURIComponent(s.name), patch).then(function () { show(box, notice("ok", "Saved. A backup of the previous file is next to servers.json (.bak-ui).")); });
        }) },
          h("div", { class: "row" }, h("div", null, h("label", null, "Credentials"), scope), h("label", { class: "inline top" }, fallback, " fall back to shared secret"),
            h("label", { class: "inline top" }, auto, " auto-activate")),
          h("div", { class: "row" }, h("div", { class: "grow" }, h("label", null, "Env vars (stdio) — NAME=template"), env), h("div", { class: "grow" }, h("label", null, "Headers (http) — Name=template"), hdr)),
          h("label", null, "Restrict to groups (comma separated)"), groups,
          h("p", { class: "row" }, h("button", { class: "btn primary", type: "submit", disabled: !d.editable }, "Save")), box);
        root.appendChild(h("div", { class: "card" }, h("h2", null, s.name, " ", h("span", { class: "pill" }, s.transport), s.oauth ? h("span", { class: "pill" }, "OAuth") : null),
          h("p", { class: "muted" }, s.description), h("p", { class: "mono muted" }, s.target), form));
      });
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  render();
})();
`;
