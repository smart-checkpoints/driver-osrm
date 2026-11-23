"use strict";

const fs = require("fs");

const log = require("../logger");

const FILE_VERSION = 1;

function emptyState() {
  return { version: FILE_VERSION, active: null, projects: [], admin: {}, settings: {} };
}

function normalize(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== "object") return state;
  if (Array.isArray(raw.projects)) {
    state.projects = raw.projects.filter(
      (p) => p && typeof p.apiKey === "string" && typeof p.server === "string",
    );
  }
  if (typeof raw.active === "string") state.active = raw.active;
  if (raw.admin && typeof raw.admin === "object") state.admin = { ...raw.admin };
  if (raw.settings && typeof raw.settings === "object") {
    for (const [name, value] of Object.entries(raw.settings)) {
      if (typeof value === "string") state.settings[name] = value;
    }
  }
  return state;
}

/** One saved project is one key on one server. */
function projectId(server, id) {
  return `${server}#${id}`;
}

/**
 * The dashboard's memory: the projects this driver has been connected to,
 * which one it is on, settings changed from the dashboard, and the admin
 * passwords somebody asked it to remember.
 *
 * It lives in `projects.json` next to package.json and is git-ignored. It holds
 * API keys, so it is written owner-only where the platform supports that.
 */
class Store {
  #file;
  #state;

  constructor(file) {
    this.#file = file;
    this.#state = this.#read();
  }

  get file() {
    return this.#file;
  }

  #read() {
    let text;
    try {
      text = fs.readFileSync(this.#file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") log.warn(`cannot read ${this.#file}: ${err.message}`);
      return emptyState();
    }
    try {
      return normalize(JSON.parse(text));
    } catch (err) {
      // Never overwrite a file somebody may want back. Move it aside and say so.
      const aside = `${this.#file}.broken-${Date.now()}`;
      try {
        fs.renameSync(this.#file, aside);
        log.warn(`${this.#file} is not valid JSON (${err.message}); moved it to ${aside}`);
      } catch {
        log.warn(`${this.#file} is not valid JSON (${err.message}); ignoring it`);
      }
      return emptyState();
    }
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  // --- projects ---------------------------------------------------------

  projects() {
    return this.#state.projects.slice();
  }

  project(id) {
    return this.#state.projects.find((p) => p.id === id) || null;
  }

  /** Adds or refreshes a project, keyed by its server and project number. */
  saveProject({ server, wsUrl, projectId: number, name, apiKey }) {
    const id = projectId(server, number);
    const now = new Date().toISOString();
    const existing = this.project(id);
    if (existing) {
      Object.assign(existing, { wsUrl, name, apiKey, lastUsedAt: now });
    } else {
      this.#state.projects.push({
        id,
        server,
        wsUrl,
        projectId: number,
        name,
        apiKey,
        addedAt: now,
        lastUsedAt: now,
      });
    }
    this.#save();
    return this.project(id);
  }

  removeProject(id) {
    const before = this.#state.projects.length;
    this.#state.projects = this.#state.projects.filter((p) => p.id !== id);
    if (this.#state.active === id) this.#state.active = null;
    if (this.#state.projects.length !== before) this.#save();
  }

  activeProject() {
    return this.#state.active ? this.project(this.#state.active) : null;
  }

  setActive(id) {
    this.#state.active = id;
    const project = id ? this.project(id) : null;
    if (project) project.lastUsedAt = new Date().toISOString();
    this.#save();
  }

  // --- admin passwords, per server -------------------------------------

  adminPassword(server) {
    const value = this.#state.admin[server];
    return typeof value === "string" && value !== "" ? value : null;
  }

  setAdminPassword(server, password) {
    if (password) this.#state.admin[server] = password;
    else delete this.#state.admin[server];
    this.#save();
  }

  // --- settings overrides ----------------------------------------------

  settings() {
    return { ...this.#state.settings };
  }

  /** Replaces the whole set of overrides; an empty value removes one. */
  setSettings(values) {
    const next = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string" && value.trim() !== "") next[name] = value.trim();
    }
    this.#state.settings = next;
    this.#save();
  }
}

module.exports = { Store, projectId };
