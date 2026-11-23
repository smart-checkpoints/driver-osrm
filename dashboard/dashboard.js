"use strict";

/* Smart Checkpoints driver dashboard. Talks only to the driver that served it. */

(() => {
  const API = "/dashboard/api";
  const $ = (id) => document.getElementById(id);

  const STATES = {
    connected: { label: "Connected", tone: "good" },
    connecting: { label: "Connecting…", tone: "busy" },
    reconnecting: { label: "Reconnecting…", tone: "busy" },
    "needs-project": { label: "Choose a project", tone: "ask" },
    rejected: { label: "Key rejected", tone: "bad" },
    fatal: { label: "Stopped", tone: "bad" },
    "config-error": { label: "Settings problem", tone: "bad" },
    stopped: { label: "Disconnected", tone: "idle" },
  };

  let state = null;
  let tab = null;
  let settingsDirty = false;
  let sessionAdminPassword = "";
  let serverProjects = null;
  let serverListFor = null;
  let loadingServer = false;

  // --- helpers ----------------------------------------------------------

  async function api(path, body) {
    const res = await fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sc-dashboard": "1" },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty */
    }
    if (!res.ok) {
      const err = new Error(data.error || `The driver answered ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  let toastTimer = null;
  function toast(message, tone = "") {
    const el = $("toast");
    el.textContent = message;
    el.dataset.tone = tone;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), tone === "bad" ? 6000 : 3200);
  }

  /** Runs an action with its button disabled; shows what went wrong. */
  async function busy(button, fn) {
    if (button) button.disabled = true;
    try {
      return await fn();
    } catch (err) {
      toast(err.message, "bad");
      throw err;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function hostOf(origin) {
    try {
      return new URL(origin).host;
    } catch {
      return origin || "—";
    }
  }

  /** ws://localhost:3000/distance-driver reads better as localhost:3000. */
  function friendlyServer(wsUrl) {
    try {
      const url = new URL(wsUrl);
      if (url.pathname === "/distance-driver") {
        return url.protocol === "wss:" ? `https://${url.host}` : url.host;
      }
    } catch {
      /* fall through */
    }
    return wsUrl || "";
  }

  function since(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  }

  function apply(next) {
    state = next;
    render();
  }

  // --- rendering --------------------------------------------------------

  function render() {
    if (!state) return;
    const look = STATES[state.status.state] || { label: state.status.state, tone: "idle" };

    document.title = `${state.active ? state.active.name + " · " : ""}${state.driver.title}`;
    $("driver-title").textContent = `${state.driver.title} · v${state.driver.version}`;
    $("status-pill").dataset.tone = look.tone;
    $("status-label").textContent = look.label;
    for (const node of document.querySelectorAll(".server-name")) {
      node.textContent = hostOf(state.server);
    }
    $("store-file").textContent = state.storeFile;

    renderHero(look);
    renderStats(look);
    renderSaved();
    renderServerTab();
    if (!settingsDirty) renderSettings();

    if (!tab) {
      const hasSavedHere = state.saved.some((p) => p.here);
      selectTab(state.active || hasSavedHere ? "saved" : "server");
    }
    $("projects-card").classList.toggle("ask", state.status.state === "needs-project");
  }

  function renderHero(look) {
    const { active, status } = state;
    $("hero").dataset.tone = look.tone;
    $("active-name").textContent = active ? active.name : "No project yet";

    const meta = $("active-meta");
    meta.replaceChildren();
    if (active) {
      meta.append(
        active.projectId != null ? el("b", { text: `Project #${active.projectId}` }) : el("b", { text: "Project not confirmed yet" }),
        ` · ${hostOf(active.server)} · key ${active.keyHint}`,
      );
      if (status.state === "connected") meta.append(` · connected for ${since(status.since)}`);
    } else if (!status.detail) {
      meta.append(`Server ${hostOf(state.server)}. Pick a project below to start.`);
    }

    $("status-detail").textContent = status.detail || "";

    const running = ["connected", "connecting", "reconnecting"].includes(status.state);
    $("btn-disconnect").hidden = !active || !running;
    const reconnect = $("btn-reconnect");
    reconnect.hidden = !active || running;
    reconnect.textContent = status.state === "stopped" ? "Connect" : "Try again";
  }

  function renderStats(look) {
    const dl = $("stats");
    dl.replaceChildren();
    const row = (label, value, opts = {}) => {
      dl.append(el("dt", { text: label }));
      const dd = el("dd", { class: opts.mono ? "mono" : null, dataset: opts.tone ? { tone: opts.tone } : undefined });
      if (opts.href) dd.append(el("a", { href: opts.href, target: "_blank", rel: "noreferrer", text: value }));
      else dd.textContent = value;
      dl.append(dd);
    };
    row("State", look.label, { tone: look.tone === "good" ? "good" : look.tone === "bad" ? "bad" : look.tone === "busy" ? "warn" : "" });
    row("Server", state.wsUrl || "—", { mono: true });
    if (state.status.state === "connected") row("Connected", `${since(state.status.since)} ago`);
    for (const s of state.stats) row(s.label, s.value, s);
  }

  function renderSaved() {
    const list = $("saved-list");
    list.replaceChildren();
    $("saved-empty").hidden = state.saved.length > 0;
    for (const p of state.saved) {
      const actions = [];
      if (!p.active) {
        actions.push(
          el("button", {
            type: "button",
            class: "btn ghost small",
            text: "Use",
            onclick: (e) =>
              busy(e.currentTarget, async () => {
                apply(await api("/projects/use", { id: p.id }));
                toast(`Switching to ${p.name}`, "good");
              }),
          }),
        );
      }
      actions.push(
        el("button", {
          type: "button",
          class: "btn danger small",
          title: "Forget this project",
          "aria-label": `Forget ${p.name}`,
          text: "✕",
          onclick: (e) => {
            if (!confirm(`Forget "${p.name}" and its key on this computer?`)) return;
            busy(e.currentTarget, async () => apply(await api("/projects/remove", { id: p.id })));
          },
        }),
      );
      list.append(
        el(
          "li",
          { class: `item${p.active ? " active" : ""}` },
          el("span", { class: "item-mark", text: `#${p.projectId}` }),
          el(
            "div",
            { class: "item-body" },
            el(
              "div",
              { class: "item-title" },
              p.name,
              p.active ? el("span", { class: "tag", text: "In use" }) : null,
              !p.here ? el("span", { class: "tag quiet", text: "other server" }) : null,
            ),
            el("div", { class: "item-meta", text: `${hostOf(p.server)} · key ${p.keyHint}` }),
          ),
          ...actions,
        ),
      );
    }
  }

  function renderServerTab() {
    const remembered = state.adminRemembered;
    const unlocked = remembered || sessionAdminPassword !== "";
    $("admin-form").hidden = unlocked && serverProjects !== null;
    $("server-browser").hidden = serverProjects === null;
    $("admin-forget").hidden = !remembered;

    // A changed server means a different list.
    if (serverListFor && serverListFor !== state.server) {
      serverProjects = null;
      serverListFor = null;
      $("server-browser").hidden = true;
      $("admin-form").hidden = false;
    }
    if (tab === "server" && remembered && serverProjects === null && !loadingServer) {
      void loadServerProjects();
    }
    if (serverProjects) renderServerList();
  }

  function renderServerList() {
    const list = $("server-list");
    list.replaceChildren();
    $("server-empty").hidden = serverProjects.length > 0;
    const active = state.active;
    for (const p of serverProjects) {
      const isActive = Boolean(active && active.server === state.server && active.projectId === p.projectId);
      list.append(
        el(
          "li",
          { class: `item${isActive ? " active" : ""}` },
          el("span", { class: "item-mark", text: `#${p.projectId}` }),
          el(
            "div",
            { class: "item-body" },
            el("div", { class: "item-title" }, p.name, isActive ? el("span", { class: "tag", text: "In use" }) : null),
            el("div", {
              class: "item-meta",
              text: `${p.nodes} checkpoint${p.nodes === 1 ? "" : "s"} · ${p.connections} section${p.connections === 1 ? "" : "s"}`,
            }),
          ),
          isActive
            ? null
            : el("button", {
                type: "button",
                class: "btn ghost small",
                text: "Use",
                onclick: (e) =>
                  busy(e.currentTarget, async () => {
                    apply(
                      await api("/server-projects/use", {
                        projectId: p.projectId,
                        password: sessionAdminPassword || undefined,
                      }),
                    );
                    toast(`Switching to ${p.name}`, "good");
                  }),
              }),
        ),
      );
    }
  }

  async function loadServerProjects(password, remember) {
    loadingServer = true;
    try {
      const data = await api("/server-projects", { password, remember });
      serverProjects = data.projects;
      serverListFor = state && state.server;
      if (password && !remember) sessionAdminPassword = password;
      render();
    } catch (err) {
      if (err.data && err.data.needsPassword) {
        serverProjects = null;
        sessionAdminPassword = "";
        render();
      }
      toast(err.message, "bad");
    } finally {
      loadingServer = false;
    }
  }

  function renderSettings() {
    const box = $("settings-fields");
    box.replaceChildren();
    for (const f of state.settings) {
      const id = `set-${f.name}`;
      const label = el(
        "span",
        {},
        f.label,
        el("span", {
          class: "source",
          dataset: { source: f.source },
          text: f.source === "dashboard" ? "set here" : f.source === ".env" ? "from .env" : "default",
        }),
      );

      let input;
      if (f.type === "secret") {
        input = el(
          "div",
          { class: "input-row" },
          el("input", {
            type: "password",
            id,
            name: f.name,
            class: "mono",
            spellcheck: "false",
            placeholder: f.hasValue ? `Saved (${f.hint2}). Leave blank to keep it.` : "Not set",
          }),
          el("button", { type: "button", class: "btn ghost small", dataset: { reveal: id }, text: "Show" }),
        );
      } else {
        const listId = f.options ? `${id}-options` : null;
        input = el("input", {
          type: f.type === "int" ? "number" : "text",
          min: f.type === "int" ? "1" : null,
          step: f.type === "int" ? "1" : null,
          id,
          name: f.name,
          class: f.type === "int" ? null : "mono",
          spellcheck: "false",
          list: listId,
          value: f.type === "server" ? friendlyServer(f.value) : f.value,
          placeholder: f.type === "server" ? friendlyServer(f.default) : f.default || "",
        });
        if (listId) {
          input = el(
            "div",
            {},
            input,
            el("datalist", { id: listId }, ...f.options.map((o) => el("option", { value: o }))),
          );
        }
      }

      box.append(el("label", { class: "field", for: id }, label, input, f.hint ? el("small", { text: f.hint }) : null));
    }
  }

  // --- tabs -------------------------------------------------------------

  function selectTab(name) {
    tab = name;
    for (const button of document.querySelectorAll(".tabs button")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === name));
    }
    for (const panel of document.querySelectorAll(".tab-panel")) {
      panel.hidden = panel.dataset.panel !== name;
    }
    if (name === "server") renderServerTab();
    if (name === "key") $("key-input").focus();
  }

  for (const button of document.querySelectorAll(".tabs button")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
  }

  // --- forms and buttons ------------------------------------------------

  document.addEventListener("click", (e) => {
    const button = e.target.closest("[data-reveal]");
    if (!button) return;
    const input = $(button.dataset.reveal);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
  });

  $("key-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const button = e.submitter;
    busy(button, async () => {
      const next = await api("/projects", {
        apiKey: $("key-input").value,
        name: $("key-name").value,
      });
      $("key-input").value = "";
      $("key-name").value = "";
      apply(next);
      toast(`Key accepted. Connecting to ${next.active ? next.active.name : "the project"}.`, "good");
      selectTab("saved");
    }).catch(() => {});
  });

  $("admin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const password = $("admin-password").value;
    if (!password) {
      toast("Enter the admin password", "bad");
      return;
    }
    const remember = $("admin-remember").checked;
    const button = e.submitter;
    button.disabled = true;
    loadServerProjects(password, remember).finally(() => {
      button.disabled = false;
      $("admin-password").value = "";
    });
  });

  $("server-refresh").addEventListener("click", () => {
    void loadServerProjects(sessionAdminPassword || undefined);
  });

  $("admin-forget").addEventListener("click", (e) => {
    busy(e.currentTarget, async () => {
      sessionAdminPassword = "";
      serverProjects = null;
      apply(await api("/admin/forget"));
      toast("Admin password forgotten on this computer.");
    }).catch(() => {});
  });

  $("settings-form").addEventListener("input", () => {
    settingsDirty = true;
  });

  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const values = {};
    for (const f of state.settings) values[f.name] = $(`set-${f.name}`).value;
    busy(e.submitter, async () => {
      const next = await api("/settings", { values });
      settingsDirty = false;
      apply(next);
      toast("Settings saved. Reconnecting.", "good");
    }).catch(() => {});
  });

  $("settings-reset").addEventListener("click", (e) => {
    if (!confirm("Drop every setting saved here and go back to the values in .env?")) return;
    busy(e.currentTarget, async () => {
      const next = await api("/settings/reset");
      settingsDirty = false;
      apply(next);
      toast("Back to the .env settings.", "good");
    }).catch(() => {});
  });

  $("btn-disconnect").addEventListener("click", (e) => {
    busy(e.currentTarget, async () => apply(await api("/disconnect"))).catch(() => {});
  });
  $("btn-reconnect").addEventListener("click", (e) => {
    busy(e.currentTarget, async () => apply(await api("/reconnect"))).catch(() => {});
  });

  // --- live log ---------------------------------------------------------

  const logList = $("log");
  function addLog(entry) {
    const time = new Date(entry.time);
    const stamp = time.toLocaleTimeString([], { hour12: false });
    logList.append(
      el(
        "li",
        { class: entry.level },
        el("time", { datetime: entry.time, text: stamp }),
        el("span", { class: "lvl", text: entry.level }),
        entry.message,
      ),
    );
    while (logList.childElementCount > 500) logList.firstElementChild.remove();
    if ($("log-follow").checked) logList.scrollTop = logList.scrollHeight;
  }
  $("log-clear").addEventListener("click", () => logList.replaceChildren());

  // --- live connection to the driver ------------------------------------

  function connectEvents() {
    const events = new EventSource(`${API}/events`);
    events.addEventListener("state", (e) => apply(JSON.parse(e.data)));
    events.addEventListener("log-history", (e) => {
      logList.replaceChildren();
      for (const entry of JSON.parse(e.data)) addLog(entry);
    });
    events.addEventListener("log", (e) => addLog(JSON.parse(e.data)));
    events.addEventListener("error", () => {
      $("status-pill").dataset.tone = "bad";
      $("status-label").textContent = "Driver not running";
    });
  }

  // Keeps "connected for…" honest between updates.
  setInterval(() => {
    if (state && state.status.state === "connected") {
      const look = STATES.connected;
      renderHero(look);
      renderStats(look);
    }
  }, 15000);

  connectEvents();
})();
