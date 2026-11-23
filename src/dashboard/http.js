"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const log = require("../logger");
const { UserError } = require("./controller");

const STATIC_DIR = path.join(__dirname, "..", "..", "dashboard");
const PREFIX = "/dashboard";
const MAX_BODY = 64 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The dashboard holds API keys and can switch the driver to another project,
 * so it answers this computer only, whatever address the process binds to.
 *
 * - the request has to come from loopback;
 * - the Host header has to be a loopback name, which stops a web page that
 *   rebinds its own DNS name to 127.0.0.1 from reading the API;
 * - API calls need a custom header, which a page on another origin cannot
 *   send without a CORS preflight this server never answers.
 */
function isLocal(req) {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)) return false;
  const host = String(req.headers.host || "").toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK_NAMES.has(name);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new UserError("Request too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new UserError("Request body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, relative) {
  const file = path.resolve(STATIC_DIR, `.${relative === "/" ? "/index.html" : relative}`);
  if (!file.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".woff2" || ext === ".svg" ? "public, max-age=86400" : "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    res.end(body);
  });
}

/** A live feed of state changes and log lines, for the open dashboard. */
function serveEvents(req, res, controller) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("state", controller.snapshot());
  send("log-history", log.recent());

  const onChange = () => send("state", controller.snapshot());
  controller.on("change", onChange);
  const unsubscribe = log.subscribe((entry) => send("log", entry));
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);

  req.on("close", () => {
    controller.off("change", onChange);
    unsubscribe();
    clearInterval(ping);
  });
}

const ACTIONS = {
  "/api/state": (c) => c.snapshot(),
  "/api/projects": async (c, b) => {
    await c.addKey(b.apiKey, b.name);
    return c.snapshot();
  },
  "/api/projects/use": (c, b) => {
    c.useSaved(b.id);
    return c.snapshot();
  },
  "/api/projects/remove": (c, b) => {
    c.removeSaved(b.id);
    return c.snapshot();
  },
  "/api/server-projects": async (c, b) => ({
    projects: await c.serverProjects(b.password, Boolean(b.remember)),
  }),
  "/api/server-projects/use": async (c, b) => {
    await c.useServerProject(b.projectId, b.password);
    return c.snapshot();
  },
  "/api/admin/forget": (c) => {
    c.forgetAdmin();
    return c.snapshot();
  },
  "/api/settings": (c, b) => {
    c.saveSettings(b.values || {});
    return c.snapshot();
  },
  "/api/settings/reset": (c) => {
    c.resetSettings();
    return c.snapshot();
  },
  "/api/disconnect": (c) => {
    c.disconnect();
    return c.snapshot();
  },
  "/api/reconnect": (c) => {
    c.reconnect();
    return c.snapshot();
  },
};

async function handleApi(req, res, route, controller) {
  const action = ACTIONS[route];
  if (!action) return sendJson(res, 404, { error: "Unknown dashboard call" });
  if (req.method !== "POST" || req.headers["x-sc-dashboard"] !== "1") {
    return sendJson(res, 405, { error: "Dashboard calls are POST with x-sc-dashboard: 1" });
  }
  try {
    const body = await readJson(req);
    sendJson(res, 200, await action(controller, body));
  } catch (err) {
    if (err instanceof UserError) {
      sendJson(res, err.status, { error: err.message, needsPassword: Boolean(err.needsPassword) });
    } else {
      log.error(`dashboard call ${route} failed: ${err.stack || err.message}`);
      sendJson(res, 500, { error: err.message || "Something went wrong" });
    }
  }
}

/**
 * Handles everything under /dashboard. Returns false for any other path, so
 * the map driver can hang it in front of its own page server.
 */
function createDashboardHandler(controller) {
  return function handle(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    if (!isLocal(req)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return true;
    }
    const route = url.pathname.slice(PREFIX.length) || "";
    if (route === "") {
      res.writeHead(302, { location: `${PREFIX}/` }).end();
    } else if (route === "/api/events") {
      serveEvents(req, res, controller);
    } else if (route.startsWith("/api/")) {
      void handleApi(req, res, route, controller);
    } else {
      serveStatic(res, route);
    }
    return true;
  };
}

/**
 * A server of its own, for a driver that has no page server.
 * Tries the next few ports if the first is taken - by a second driver, say.
 */
function startStandaloneDashboard(controller, { host, port }) {
  const handle = createDashboardHandler(controller);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(302, { location: `${PREFIX}/` }).end();
      return;
    }
    if (!handle(req, res, url)) res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const candidate = port + attempt;
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && attempt < 9) {
          attempt += 1;
          tryListen();
        } else {
          reject(err);
        }
      });
      server.listen(candidate, host, () => {
        server.removeAllListeners("error");
        resolve({ server, port: candidate, stop: () => server.close() });
      });
    };
    tryListen();
  });
}

module.exports = { createDashboardHandler, startStandaloneDashboard, PREFIX };
