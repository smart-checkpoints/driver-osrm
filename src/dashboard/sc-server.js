"use strict";

/**
 * The two REST calls the dashboard makes to the Smart Checkpoints server:
 * checking a key, and listing projects with the admin password.
 *
 * They run here, in the driver, not in the browser. The browser never talks to
 * the server, and the keys the admin list returns never reach the page.
 */

const DRIVER_PATH = "/distance-driver";
const TIMEOUT_MS = 6000;

class ServerError extends Error {
  /** @param {"unreachable"|"rejected"|"disabled"|"server"} kind */
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

/** The server's HTTP origin, from the driver channel's ws:// URL. */
function httpOrigin(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/**
 * Turns what somebody types into the driver channel URL.
 *
 * `localhost:3000`, `http://192.168.1.5:3000` and the full
 * `ws://localhost:3000/distance-driver` all mean the same server.
 */
function normalizeServerAddress(input) {
  let text = String(input || "").trim();
  if (!text) throw new Error("Enter the server address, for example localhost:3000");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${input}" is not a server address`);
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = DRIVER_PATH;
  } else if (url.protocol === "ws:" || url.protocol === "wss:") {
    if (url.pathname === "" || url.pathname === "/") url.pathname = DRIVER_PATH;
  } else {
    throw new Error(`"${input}" is not an http(s) or ws(s) address`);
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function request(origin, path, init) {
  let res;
  try {
    res = await fetch(`${origin}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ServerError(
      `Cannot reach the Smart Checkpoints server at ${origin}. Is it running?`,
      "unreachable",
    );
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON; the status code is all there is.
  }
  return { res, body };
}

/** Checks an operator key. Resolves to the project it opens. */
async function authenticate(origin, apiKey) {
  const { res, body } = await request(origin, "/authenticate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ "api-key": apiKey }),
  });
  if (res.ok && body && body.project_id != null) {
    return {
      projectId: Number(body.project_id),
      name: body.project_name || `Project ${body.project_id}`,
    };
  }
  const message = (body && body.error) || `The server answered ${res.status}`;
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new ServerError(message, "rejected");
  }
  throw new ServerError(message, "server");
}

/** Every project on the server, with its key. Needs the admin password. */
async function adminProjects(origin, password) {
  const { res, body } = await request(origin, "/admin/projects", {
    headers: { "x-admin-password": password },
  });
  if (res.ok && Array.isArray(body)) {
    return body.map((p) => ({
      projectId: Number(p.project_id),
      name: p.project_name || `Project ${p.project_id}`,
      apiKey: p.api_key,
      nodes: Number(p.node_count) || 0,
      connections: Number(p.connection_count) || 0,
    }));
  }
  if (res.status === 401) throw new ServerError("Wrong admin password", "rejected");
  if (res.status === 503) {
    throw new ServerError(
      (body && body.error) ||
        "Administration is disabled on this server: ADMIN_PASSWORD is not set.",
      "disabled",
    );
  }
  throw new ServerError((body && body.error) || `The server answered ${res.status}`, "server");
}

module.exports = {
  ServerError,
  httpOrigin,
  normalizeServerAddress,
  authenticate,
  adminProjects,
};
