"use strict";

/**
 * Stands in for the Smart Checkpoints server so the OSRM driver can be
 * exercised end to end without running the real server or touching its
 * database.
 *
 * It reproduces the parts of server.js the driver actually talks to:
 *   - a ws server on the /distance-driver upgrade path
 *   - the { type: "auth" } / { type: "authenticated" } exchange, protocol v2
 *   - the burst of calculate-distance requests that recalculateAllDistances
 *     fires the moment a driver authenticates, coordinates included
 *   - distance-result with optional geometry, and distance-error with a code
 *   - the 30s pending-request timeout, after which the real server gives up
 *
 * It still serves GET /project/:id/nodes, and complains if anything asks: a v2
 * driver reads the coordinates out of the request and must never call it.
 */

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.FAKE_API_KEY || "test-api-key";
const PROJECT_ID = Number(process.env.FAKE_PROJECT_ID || 1);
const PENDING_TIMEOUT_MS = Number(process.env.PENDING_TIMEOUT_MS || 30000);
const PROTOCOL_VERSION = 2;
const MAX_PATH_BYTES = 256 * 1024;

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
  { from: 0, to: 3, note: "into the Atlantic, expect distance-error no-route" },
  { from: 0, to: 99, note: "no such node, expect distance-error invalid-input" },
];

/** The coordinates the real server puts in a request, by node index. */
function coordsFor(idInProject) {
  const node = NODES.find((n) => n.id_in_project === idInProject);
  if (!node) return null;
  return { latitude: node.latitude, longitude: node.longitude };
}

const pending = new Map();

function log(message) {
  console.log(`[${new Date().toISOString()}] fake-server ${message}`);
}

const app = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/project\/(\d+)\/nodes$/);

  if (req.method === "GET" && match) {
    log(
      `WARNING  GET ${url.pathname} - a protocol v2 driver reads the ` +
        "coordinates from the request and should never call this",
    );
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
  // Indices for logging, coordinates for routing. The real server sends both
  // on every request, so it never has to know which protocol is on the far end.
  ws.send(
    JSON.stringify({
      type: "calculate-distance",
      requestId,
      fromIdInProject: from,
      toIdInProject: to,
      from: coordsFor(from),
      to: coordsFor(to),
    }),
  );
  log(`REQUEST  edge ${from}->${to}  (${note})`);
}

function sendBurst(ws) {
  log(`asking for all ${EDGES.length} edges at once, as recalculateAllDistances does`);
  for (const edge of EDGES) requestDistance(ws, edge.from, edge.to, edge.note);
}

/** What the server would store, and what it would refuse to. */
function describeGeometry(message) {
  if (!message.path) return "geometry=none";
  const bytes = Buffer.byteLength(JSON.stringify(message.path), "utf8");
  if (message.path.type !== "LineString") return "geometry=DROPPED (not a LineString)";
  if (bytes > MAX_PATH_BYTES) return `geometry=DROPPED (${bytes} bytes, over the cap)`;
  const points = Array.isArray(message.path.coordinates)
    ? message.path.coordinates.length
    : 0;
  const offsets = Array.isArray(message.endpointOffsets)
    ? ` offsets=[${message.endpointOffsets.map((o) => o.toFixed(1)).join(", ")}]m`
    : "";
  return `geometry=${points}pts/${bytes}B${offsets}`;
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
      const version = Math.min(Number(message.protocolVersion) || 1, PROTOCOL_VERSION);
      ws.send(
        JSON.stringify({
          type: "authenticated",
          projectId: PROJECT_ID,
          protocolVersion: version,
        }),
      );
      const capabilities = Object.keys(message.capabilities || {}).join(", ");
      log(
        `driver "${message.driverName || "unnamed"}" authenticated for project ` +
          `${PROJECT_ID} as ${message.role || "distance"} on protocol v${version}` +
          (capabilities ? ` offering ${capabilities}` : ""),
      );
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
          `${describeGeometry(message)}  (${Date.now() - entry.startedAt}ms)`,
      );
      reportIfIdle();
      return;
    }

    if (message.type === "distance-error") {
      const entry = pending.get(message.requestId);
      if (!entry) {
        log(`late or unknown distance-error for requestId ${message.requestId}`);
        return;
      }
      clearTimeout(entry.timeout);
      pending.delete(message.requestId);
      // What the real server does with each of these: no-route marks the edge
      // as a data error and stops asking, the other two leave it unresolved
      // and try again on the next reconnect.
      log(
        `ERROR    edge ${entry.from}->${entry.to}  code=${message.code}  ` +
          `"${message.message}"  (${Date.now() - entry.startedAt}ms)`,
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
  log(`listening on http://localhost:${PORT} (protocol v${PROTOCOL_VERSION})`);
  log(`  websocket : ws://localhost:${PORT}/distance-driver`);
  log(`  nodes     : GET http://localhost:${PORT}/project/${PROJECT_ID}/nodes (v1 only)`);
  log(`  api key   : ${API_KEY}`);
  log("waiting for a driver to connect...");
});
