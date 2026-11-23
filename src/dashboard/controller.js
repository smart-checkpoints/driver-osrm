"use strict";

const { EventEmitter } = require("events");

const log = require("../logger");
const { projectId: savedId } = require("./store");
const {
  ServerError,
  httpOrigin,
  normalizeServerAddress,
  authenticate,
  adminProjects,
} = require("./sc-server");

/** A placeholder that satisfies config validation when only the URLs matter. */
const NO_KEY = "dashboard-placeholder";

function keyHint(apiKey) {
  return apiKey && apiKey.length > 4 ? `…${apiKey.slice(-4)}` : "…";
}

/** A key copied from .env.example is not a key. */
function realKey(value) {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "replace-me"
    ? value.trim()
    : null;
}

class UserError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Owns the driver for the dashboard: which project it serves, which settings
 * it runs with, and what state it is in.
 *
 * Switching project is stop, rebuild the config, start - the same thing a
 * restart did, without the restart. Only one driver is ever connected.
 */
class Controller extends EventEmitter {
  #profile;
  #store;
  #env;
  #driver = null;
  #config = null;
  #stats;
  #status = { state: "needs-project", detail: "", since: Date.now() };
  /** A key from .env that has not been confirmed and saved yet. */
  #temporary = null;
  #changeTimer = null;
  dashboardUrl = null;

  constructor({ profile, store, env = process.env }) {
    super();
    this.#profile = profile;
    this.#store = store;
    this.#env = env;
    this.#stats = profile.initialStats();
  }

  // --- configuration ----------------------------------------------------

  #mergedEnv(overrides = this.#store.settings()) {
    return { ...this.#env, ...overrides };
  }

  /** The config the current settings produce, or the reason they do not. */
  #resolve(apiKey = NO_KEY, overrides) {
    try {
      return { config: this.#profile.loadConfig({ ...this.#mergedEnv(overrides), SC_API_KEY: apiKey }) };
    } catch (err) {
      return { error: err.message };
    }
  }

  #wsUrl() {
    const { config } = this.#resolve();
    return config ? config.wsUrl : null;
  }

  #server() {
    const wsUrl = this.#wsUrl();
    return wsUrl ? httpOrigin(wsUrl) : null;
  }

  #requireServer() {
    const server = this.#server();
    if (!server) {
      throw new UserError(`Fix the settings first: ${this.#resolve().error}`);
    }
    return server;
  }

  #active() {
    return this.#temporary || this.#store.activeProject();
  }

  /** The config the driver runs with now, or would with the saved settings. */
  currentConfig() {
    const active = this.#active();
    return this.#resolve(active ? active.apiKey : NO_KEY).config || this.#config;
  }

  // --- lifecycle --------------------------------------------------------

  /** Picks up where the last run left off, or from the key in .env. */
  async start() {
    const resolved = this.#resolve();
    if (resolved.error) {
      this.#setStatus("config-error", resolved.error);
      return;
    }

    const saved = this.#store.activeProject();
    if (saved && saved.server === httpOrigin(resolved.config.wsUrl)) {
      this.#run(saved);
      return;
    }

    const envKey = realKey(this.#profile.envApiKey(this.#env));
    if (envKey) {
      await this.#adoptEnvKey(envKey, resolved.config.wsUrl);
      return;
    }

    this.#setStatus("needs-project", "Choose the project this driver should serve.");
  }

  /**
   * The key in .env is used the first time, and saved once the server says
   * which project it opens. After that the dashboard's choice wins.
   */
  async #adoptEnvKey(apiKey, wsUrl) {
    const server = httpOrigin(wsUrl);
    try {
      const info = await authenticate(server, apiKey);
      const project = this.#store.saveProject({ server, wsUrl, apiKey, ...info });
      this.#store.setActive(project.id);
      log.info(`using the key from .env: project ${info.projectId} "${info.name}"`);
      this.#run(project);
    } catch (err) {
      if (err instanceof ServerError && err.kind === "rejected") {
        this.#setStatus("needs-project", `The key in .env was rejected: ${err.message}`);
        return;
      }
      // The server is not up yet. Connect anyway and keep retrying, like the
      // driver always did; it is saved once it gets through.
      this.#temporary = {
        id: null,
        temporary: true,
        server,
        wsUrl,
        apiKey,
        projectId: null,
        name: "Key from .env",
      };
      this.#run(this.#temporary);
    }
  }

  #run(project) {
    this.#stopDriver();
    this.#stats = this.#profile.initialStats();

    const { config, error } = this.#resolve(project.apiKey);
    if (error) {
      this.#setStatus("config-error", error);
      return;
    }
    this.#config = config;

    const driver = this.#profile.createDriver(config);
    this.#driver = driver;
    driver.on("status", (status) => {
      if (this.#driver === driver) this.#onDriverStatus(status);
    });
    this.#profile.track(driver, this.#stats, () => this.#changed());
    this.#setStatus("connecting", "");
    driver.start();
  }

  #stopDriver() {
    if (!this.#driver) return;
    const driver = this.#driver;
    this.#driver = null;
    driver.removeAllListeners();
    driver.stop();
  }

  #onDriverStatus(status) {
    switch (status.state) {
      case "connecting":
        this.#setStatus("connecting", "Opening the connection");
        break;
      case "authenticating":
        this.#setStatus("connecting", "Authenticating");
        break;
      case "connected":
        this.#setStatus("connected", "", { projectId: status.projectId });
        if (this.#temporary) void this.#confirmTemporary();
        break;
      case "reconnecting":
        this.#setStatus(
          "reconnecting",
          `${status.reason}. Trying again in ${Math.round(status.delayMs / 1000)}s ` +
            `(attempt ${status.attempt}).`,
        );
        break;
      case "rejected":
        this.#stopDriver();
        this.#setStatus("rejected", `The server rejected this key: ${status.message}`);
        break;
      case "fatal":
        this.#stopDriver();
        this.#setStatus("fatal", status.reason);
        break;
      default:
        break;
    }
  }

  /** The .env key got through, so the server is up: save it properly. */
  async #confirmTemporary() {
    const temp = this.#temporary;
    try {
      const info = await authenticate(temp.server, temp.apiKey);
      if (this.#temporary !== temp) return;
      const project = this.#store.saveProject({ ...temp, ...info });
      this.#store.setActive(project.id);
      this.#temporary = null;
      log.info(`saved the key from .env as project ${info.projectId} "${info.name}"`);
      this.#changed();
    } catch {
      // Still connected; it will be saved the next time it connects.
    }
  }

  #setStatus(state, detail, extra = {}) {
    this.#status = { state, detail, since: Date.now(), ...extra };
    this.#changed();
  }

  /** Coalesces bursts - a project's whole graph arrives at once. */
  #changed() {
    if (this.#changeTimer) return;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      this.emit("change");
    }, 80);
  }

  stop() {
    this.#stopDriver();
  }

  // --- actions from the dashboard ---------------------------------------

  async addKey(apiKey, name) {
    const key = realKey(apiKey);
    if (!key) throw new UserError("Paste the project's API key");
    const server = this.#requireServer();
    const wsUrl = this.#wsUrl();
    let info;
    try {
      info = await authenticate(server, key);
    } catch (err) {
      throw new UserError(err.message, err.kind === "rejected" ? 401 : 502);
    }
    const project = this.#store.saveProject({
      server,
      wsUrl,
      apiKey: key,
      projectId: info.projectId,
      name: (name && name.trim()) || info.name,
    });
    this.#switchTo(project);
    return project;
  }

  useSaved(id) {
    const project = this.#store.project(id);
    if (!project) throw new UserError("That project is no longer saved", 404);
    // A project on another server takes its server with it.
    if (project.wsUrl && project.wsUrl !== this.#wsUrl()) {
      this.#store.setSettings({ ...this.#store.settings(), SC_WS_URL: project.wsUrl });
    }
    this.#switchTo(project);
    return project;
  }

  #switchTo(project) {
    this.#temporary = null;
    this.#store.setActive(project.id);
    log.info(`switching to project ${project.projectId} "${project.name}" on ${project.server}`);
    this.#run(project);
  }

  removeSaved(id) {
    const active = this.#active();
    if (active && active.id === id) {
      this.#stopDriver();
      this.#setStatus("needs-project", "Choose the project this driver should serve.");
    }
    this.#store.removeProject(id);
    this.#changed();
  }

  async serverProjects(password, remember) {
    const server = this.#requireServer();
    const given = typeof password === "string" && password !== "" ? password : null;
    const pw = given || this.#store.adminPassword(server);
    if (!pw) throw new UserError("Enter the server's admin password", 401, { needsPassword: true });

    let list;
    try {
      list = await adminProjects(server, pw);
    } catch (err) {
      if (err.kind === "rejected" && !given) this.#store.setAdminPassword(server, null);
      throw new UserError(err.message, err.kind === "rejected" ? 401 : 502, {
        needsPassword: err.kind === "rejected",
      });
    }
    if (given && remember) this.#store.setAdminPassword(server, given);
    this.#changed();

    const active = this.#active();
    return list.map((p) => ({
      projectId: p.projectId,
      name: p.name,
      nodes: p.nodes,
      connections: p.connections,
      saved: Boolean(this.#store.project(savedId(server, p.projectId))),
      active: Boolean(active && active.server === server && active.projectId === p.projectId),
    }));
  }

  async useServerProject(projectId, password) {
    const server = this.#requireServer();
    const pw = (typeof password === "string" && password) || this.#store.adminPassword(server);
    if (!pw) throw new UserError("Enter the server's admin password", 401, { needsPassword: true });
    let list;
    try {
      list = await adminProjects(server, pw);
    } catch (err) {
      throw new UserError(err.message, err.kind === "rejected" ? 401 : 502);
    }
    const found = list.find((p) => p.projectId === Number(projectId));
    if (!found) throw new UserError(`Project ${projectId} is not on this server`, 404);
    const project = this.#store.saveProject({
      server,
      wsUrl: this.#wsUrl(),
      apiKey: found.apiKey,
      projectId: found.projectId,
      name: found.name,
    });
    this.#switchTo(project);
    return project;
  }

  forgetAdmin() {
    const server = this.#server();
    if (server) this.#store.setAdminPassword(server, null);
    this.#changed();
  }

  disconnect() {
    this.#stopDriver();
    this.#setStatus("stopped", "Disconnected from the dashboard. Connect to resume.");
  }

  reconnect() {
    const active = this.#active();
    if (!active) throw new UserError("Choose a project first");
    this.#run(active);
  }

  /**
   * Saves settings and reconnects with them.
   *
   * A value equal to the one .env gives is not stored, so the setting keeps
   * following .env. A blank secret field means "keep the saved one".
   */
  saveSettings(values) {
    const current = this.#store.settings();
    const next = {};
    for (const field of this.#profile.settings) {
      const raw = values[field.name];
      let value = typeof raw === "string" ? raw.trim() : "";
      if (field.type === "secret" && value === "") {
        if (current[field.name]) next[field.name] = current[field.name];
        continue;
      }
      if (value === "") continue;
      if (field.type === "server") {
        try {
          value = normalizeServerAddress(value);
        } catch (err) {
          throw new UserError(err.message);
        }
      }
      if (value !== this.#envValue(field)) next[field.name] = value;
    }
    this.#applySettings(next);
  }

  resetSettings() {
    this.#applySettings({});
  }

  #applySettings(next) {
    const check = this.#resolve(NO_KEY, next);
    if (check.error) throw new UserError(check.error);

    const before = this.#server();
    this.#store.setSettings(next);
    const after = httpOrigin(check.config.wsUrl);
    log.info("settings saved from the dashboard");

    const active = this.#active();
    if (!active) {
      this.#setStatus("needs-project", "Choose the project this driver should serve.");
      return;
    }
    if (after !== before && active.server !== after) {
      // The project belongs to the old server; its key means nothing here.
      this.#stopDriver();
      this.#temporary = null;
      this.#store.setActive(null);
      this.#setStatus("needs-project", `Now on ${after}. Choose a project on this server.`);
      return;
    }
    if (active.temporary) active.wsUrl = check.config.wsUrl;
    this.#run(active);
  }

  #envValue(field) {
    for (const name of field.envNames || [field.name]) {
      const value = this.#env[name];
      if (value !== undefined && value !== "") return value;
    }
    return undefined;
  }

  // --- what the page shows ----------------------------------------------

  snapshot() {
    const server = this.#server();
    const wsUrl = this.#wsUrl();
    const active = this.#active();
    const overrides = this.#store.settings();
    const effective = this.#resolve(active ? active.apiKey : NO_KEY).config || null;

    return {
      driver: {
        kind: this.#profile.kind,
        title: this.#profile.title,
        name: this.#profile.packageName,
        version: this.#profile.version,
      },
      status: this.#status,
      server,
      wsUrl,
      active: active
        ? {
            id: active.id,
            name: active.name,
            projectId: active.projectId,
            server: active.server,
            keyHint: keyHint(active.apiKey),
            temporary: Boolean(active.temporary),
          }
        : null,
      saved: this.#store
        .projects()
        .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)))
        .map((p) => ({
          id: p.id,
          name: p.name,
          projectId: p.projectId,
          server: p.server,
          keyHint: keyHint(p.apiKey),
          active: Boolean(active && active.id === p.id),
          here: p.server === server,
        })),
      adminRemembered: Boolean(server && this.#store.adminPassword(server)),
      settings: this.#profile.settings.map((field) => {
        const envValue = this.#envValue(field);
        const override = overrides[field.name];
        const source = override !== undefined ? "dashboard" : envValue !== undefined ? ".env" : "default";
        const value = override !== undefined ? override : envValue !== undefined ? envValue : field.default;
        const base = { ...field, source, hasValue: Boolean(value) };
        if (field.type === "secret") return { ...base, value: "", hint2: value ? keyHint(value) : "" };
        return { ...base, value: value || "", envValue: envValue || "" };
      }),
      stats: this.#profile.describe({
        config: effective || this.#config,
        stats: this.#stats,
        status: this.#status,
      }),
      storeFile: this.#store.file,
      dashboardUrl: this.dashboardUrl,
    };
  }
}

module.exports = { Controller, UserError };
