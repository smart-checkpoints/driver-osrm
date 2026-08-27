"use strict";

/**
 * Stands in for the Smart Checkpoints server so the OSRM driver can be
 * exercised end to end without running the real server or touching its
 * database.
 *
 * It reproduces the parts of server.js the driver actually talks to:
 *   - a ws server on the /distance-driver upgrade path
 *   - the { type: "auth" } / { type: "authenticated" } exchange
 *   - the burst of calculate-distance requests that recalculateAllDistances
 *     fires the moment a driver authenticates
 *   - GET /project/:id/nodes behind the x-api-key header
 *   - the 30s pending-request timeout, after which the real server gives up
 */

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.FAKE_API_KEY || "test-api-key";
const PROJECT_ID = Number(process.env.FAKE_PROJECT_ID || 1);
const PENDING_TIMEOUT_MS = Number(process.env.PENDING_TIMEOUT_MS || 30000);

// Real places in Cairo, stored the way Smart Checkpoints stores nodes: WGS84
// `latitude` and `longitude` in degrees. Node 3 sits in the Atlantic so OSRM
// has no road to route over, and node 99 below does not exist at all.
const NODES = [
  { node_id: 1, id_in_project: 0, latitude: 30.0444, longitude: 31.2357 },
  { node_id: 2, id_in_project: 1, latitude: 30.0459, longitude: 31.2243 },
  { node_id: 3, id_in_project: 2, latitude: 30.0626, longitude: 31.2497 },
  { node_id: 4, id_in_project: 3, latitude: 0.0, longitude: -30.0 },
];

const EDGES = [
  { from: 0, to: 1, note: "Tahrir Square -> Cairo Tower" },
  { from: 1, to: 2, note: "Cairo Tower -> Ramses Station" },
  { from: 2, to: 0, note: "Ramses Station -> Tahrir Square" },
  { from: 0, to: 3, note: "into the Atlantic, expect no route and no reply" },
  { from: 0, to: 99, note: "unknown node, expect no reply" },
];

const pending = new Map();

function log(message) {
  console.log(`[${new Date().toISOString()}] fake-server ${message}`);
}

const app = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/project\/(\d+)\/nodes$/);

  if (req.method === "GET" && match) {
    if (req.headers["x-api-key"] !== API_KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid API key" }));
      log(`GET ${url.pathname} -> 401 (bad or missing x-api-key)`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(NODES));
    log(`GET ${url.pathname} -> 200 (${NODES.length} nodes)`);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocket.Server({ noServer: true });

app.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/distance-driver") {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

function requestDistance(ws, from, to, note) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  const timeout = setTimeout(() => {
    pending.delete(requestId);
    log(`TIMEOUT  edge ${from}->${to} after ${PENDING_TIMEOUT_MS}ms, no distance-result`);
    reportIfIdle();
  }, PENDING_TIMEOUT_MS);

  pending.set(requestId, { from, to, startedAt, timeout });
  ws.send(
    JSON.stringify({
      type: "calculate-distance",
      requestId,
      fromIdInProject: from,
      toIdInProject: to,
    }),
  );
  log(`REQUEST  edge ${from}->${to}  (${note})`);
}

function sendBurst(ws) {
  log(`asking for all ${EDGES.length} edges at once, as recalculateAllDistances does`);
  for (const edge of EDGES) requestDistance(ws, edge.from, edge.to, edge.note);
}

function reportIfIdle() {
  if (pending.size === 0) {
    log("all requests settled. Press Enter to ask again, Ctrl+C to stop.");
  }
}

wss.on("connection", (ws) => {
  log("driver connected");
  let authenticated = false;

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (message.type === "auth") {
      if (message.apiKey !== API_KEY) {
        log(`AUTH FAILED (driver sent "${message.apiKey}", expected "${API_KEY}")`);
        ws.send(JSON.stringify({ type: "error", message: "Invalid API key" }));
        return;
      }
      authenticated = true;
      ws.send(JSON.stringify({ type: "authenticated", projectId: PROJECT_ID }));
      log(`driver authenticated for project ${PROJECT_ID}`);
      sendBurst(ws);
      return;
    }

    if (message.type === "distance-result") {
      const entry = pending.get(message.requestId);
      if (!entry) {
        log(`late or unknown distance-result for requestId ${message.requestId}`);
        return;
      }
      clearTimeout(entry.timeout);
      pending.delete(message.requestId);
      log(
        `RESULT   edge ${entry.from}->${entry.to}  distance=${message.distance}m  ` +
          `(${Date.now() - entry.startedAt}ms)`,
      );
      reportIfIdle();
      return;
    }

    log(`unexpected message type "${message.type}" from driver`);
  });

  ws.on("close", () => {
    log(`driver disconnected${authenticated ? "" : " before authenticating"}`);
    for (const [, entry] of pending) clearTimeout(entry.timeout);
    pending.clear();
  });

  // Pressing Enter re-runs the burst against this connection.
  if (process.stdin.isTTY) {
    process.stdin.resume();
    process.stdin.on("data", () => {
      if (ws.readyState === WebSocket.OPEN && authenticated) sendBurst(ws);
    });
  }
});

app.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}`);
  log(`  websocket : ws://localhost:${PORT}/distance-driver`);
  log(`  nodes     : GET http://localhost:${PORT}/project/${PROJECT_ID}/nodes`);
  log(`  api key   : ${API_KEY}`);
  log("waiting for a driver to connect...");
});
