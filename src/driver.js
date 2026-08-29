"use strict";

const WebSocket = require("ws");

const log = require("./logger");
const { routeDistanceMeters, protocolErrorCode } = require("./osrm");

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

/**
 * The protocol this driver speaks.
 *
 * v2 receives the checkpoint coordinates inside the request, so this driver no
 * longer calls `GET /project/:id/nodes` and no longer keeps a node cache to
 * invalidate. It also returns route geometry, and can say why an edge failed
 * instead of going quiet and leaving the server to time out.
 */
const PROTOCOL_VERSION = 2;
const DRIVER_ROLE = "distance";
const DRIVER_NAME = "osrm";

/**
 * Additive, optional, and never negotiated: this driver says what it can
 * produce so the console knows what to expect, and a server that ignores the
 * whole field gets exactly the same answers.
 */
const CAPABILITIES = { geometry: true, endpointOffsets: true };

/** The server closes a socket with this when a newer driver takes its slot. */
const CLOSE_REPLACED = 4001;
/** ...and with this when it does not recognise the role in the auth message. */
const CLOSE_UNKNOWN_ROLE = 4003;

/** Caps how many OSRM calls run at once without dropping or reordering any. */
class Semaphore {
  #max;
  #active = 0;
  #waiting = [];

  constructor(max) {
    this.#max = max;
  }

  async acquire() {
    if (this.#active < this.#max) {
      this.#active += 1;
      return;
    }
    // The slot is handed straight over on release, so #active does not move.
    await new Promise((resolve) => this.#waiting.push(resolve));
  }

  release() {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active -= 1;
  }
}

function describeError(err) {
  // Node reports a refused connection as an AggregateError whose own
  // message is empty; the useful text is in its sub-errors.
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map((e) => (e && e.message) || String(e)).join("; ");
  }
  return (err && err.message) || String(err);
}

function formatCoords({ lat, lng }) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/**
 * A WGS84 position from a request, or null if it is not one.
 *
 * The server validates coordinates on the way in, so a bad one here means
 * either a project older than that check or something that is not a Smart
 * Checkpoints server. Either way this driver will not route on it, and says so
 * rather than sending OSRM somewhere in the Atlantic.
 */
function readCoordinate(value) {
  if (!value || typeof value !== "object") return null;
  const lat = Number(value.latitude);
  const lng = Number(value.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

class Driver {
  #config;
  #limiter;
  #socket = null;
  #authenticated = false;
  #serverProtocolVersion = 1;
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #stopped = false;
  #onFatal;

  /**
   * @param {object} config
   * @param {object} [options]
   * @param {(reason: string) => void} [options.onFatal] Called when the server
   *   has said something that reconnecting cannot fix - a slot taken by
   *   another copy of this driver, or a role it does not recognise.
   */
  constructor(config, { onFatal } = {}) {
    this.#config = config;
    this.#limiter = new Semaphore(config.maxConcurrentOsrm);
    this.#onFatal = onFatal || (() => {});
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#socket) {
      this.#socket.removeAllListeners();
      this.#socket.close();
      this.#socket = null;
    }
  }

  #connect() {
    log.info(`connecting to ${this.#config.wsUrl}`);

    const socket = new WebSocket(this.#config.wsUrl);
    this.#socket = socket;
    this.#authenticated = false;
    this.#serverProtocolVersion = 1;

    socket.on("open", () => {
      log.info("connected, authenticating");
      this.#send(
        {
          type: "auth",
          apiKey: this.#config.apiKey,
          protocolVersion: PROTOCOL_VERSION,
          role: DRIVER_ROLE,
          driverName: DRIVER_NAME,
          capabilities: CAPABILITIES,
        },
        socket,
      );
    });

    socket.on("message", (raw) => this.#onMessage(raw, socket));

    socket.on("error", (err) => {
      // A close event always follows, so reconnection is scheduled there.
      log.error(`websocket error: ${describeError(err)}`);
    });

    socket.on("close", (code, reason) => {
      if (this.#socket !== socket) return;
      const detail = reason && reason.length ? ` (${reason.toString()})` : "";

      // Two close codes mean reconnecting is the wrong move. Being replaced
      // means another copy of this driver is already serving the project, and
      // racing it for the slot would leave both flapping and neither working.
      // An unrecognised role means the configuration is wrong, and it will
      // still be wrong in a second.
      if (code === CLOSE_REPLACED || code === CLOSE_UNKNOWN_ROLE) {
        this.#socket = null;
        this.#authenticated = false;
        const reasonText =
          code === CLOSE_REPLACED
            ? "another driver took this project's distance slot" +
              " - a second copy of this driver is already running"
            : "the server does not recognise this driver's role";
        log.error(`${reasonText}${detail}; not reconnecting`);
        this.stop();
        this.#onFatal(reasonText);
        return;
      }

      this.#scheduleReconnect(`connection closed with code ${code}${detail}`);
    });
  }

  #scheduleReconnect(reason) {
    this.#socket = null;
    this.#authenticated = false;
    if (this.#stopped || this.#reconnectTimer) return;

    this.#reconnectAttempt += 1;
    const backoff = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.#reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    // Jitter keeps several drivers from reconnecting in lockstep.
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));

    log.warn(`${reason}; reconnecting in ${delay}ms (attempt ${this.#reconnectAttempt})`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #send(payload, socket) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  #onMessage(raw, socket) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      log.warn(`ignoring unparseable message from server: ${String(raw).slice(0, 200)}`);
      return;
    }

    switch (message.type) {
      case "authenticated":
        this.#reconnectAttempt = 0;
        this.#authenticated = true;
        this.#serverProtocolVersion = Number(message.protocolVersion) || 1;
        log.info(
          `authenticated for project ${message.projectId} on protocol ` +
            `v${this.#serverProtocolVersion}; routing via ${this.#config.osrmBaseUrl}`,
        );
        if (this.#serverProtocolVersion < PROTOCOL_VERSION) {
          // A v1 server sends node indices and no coordinates, and this driver
          // no longer looks them up over REST. Say so once, here, rather than
          // once per edge when every request turns out to be unusable.
          log.error(
            `this server speaks protocol v${this.#serverProtocolVersion}, and this ` +
              `driver needs v${PROTOCOL_VERSION}: it reads the checkpoint coordinates ` +
              "from the request rather than fetching them. Upgrade the server.",
          );
        }
        break;

      case "calculate-distance":
        // Deliberately not awaited: each request runs on its own so that one
        // slow or failing edge cannot hold up or sink the others.
        this.#handleCalculateDistance(message, socket).catch((err) => {
          log.error(`unexpected failure handling request: ${err.stack || err.message}`);
        });
        break;

      case "error":
        if (!this.#authenticated) {
          log.error(`authentication rejected by server: ${message.message}`);
          socket.close();
        } else {
          log.warn(`server reported an error: ${message.message}`);
        }
        break;

      default:
        log.warn(`ignoring unknown message type "${message.type}"`);
    }
  }

  /** Tells the server why an edge could not be answered, instead of going quiet. */
  #sendError(requestId, code, message, socket) {
    this.#send({ type: "distance-error", requestId, code, message }, socket);
  }

  async #handleCalculateDistance(message, socket) {
    const { requestId, fromIdInProject, toIdInProject } = message;
    const edge = `${fromIdInProject}->${toIdInProject}`;
    const startedAt = Date.now();

    if (typeof requestId !== "string" || requestId === "") {
      log.warn(`discarding calculate-distance for edge ${edge} with no requestId`);
      return;
    }
    if (!this.#authenticated) {
      log.warn(`discarding request=${requestId} edge=${edge}: not authenticated yet`);
      return;
    }

    // v2 carries the positions in the request, so there is nothing to look up
    // and no cache that can be stale by the time it is read.
    const from = readCoordinate(message.from);
    const to = readCoordinate(message.to);
    if (!from || !to) {
      log.error(
        `request=${requestId} edge=${edge} has no usable coordinates: ` +
          `from=${JSON.stringify(message.from)} to=${JSON.stringify(message.to)}`,
      );
      this.#sendError(
        requestId,
        "invalid-input",
        "the request carried no usable WGS84 coordinates",
        socket,
      );
      return;
    }

    await this.#limiter.acquire();
    try {
      const { distance, path, endpointOffsets, attempts } =
        await routeDistanceMeters(from, to, {
          baseUrl: this.#config.osrmBaseUrl,
          timeoutMs: this.#config.requestTimeoutMs,
        });

      // The values OSRM returned, unrounded and unadjusted. Geometry is
      // optional: an edge with a distance and no shape is still enforceable,
      // so a missing one is simply left out.
      const result = { type: "distance-result", requestId, distance };
      if (path) {
        result.path = path;
        result.pathFormat = "geojson-linestring-wgs84";
      }
      if (endpointOffsets) result.endpointOffsets = endpointOffsets;

      const delivered = this.#send(result, socket);

      log.info(
        `request=${requestId} edge=${edge} ` +
          `from=${formatCoords(from)} to=${formatCoords(to)} ` +
          `distance=${distance}m osrm_attempts=${attempts} ` +
          `geometry=${path ? `${path.coordinates.length}pts` : "none"} ` +
          `elapsed=${Date.now() - startedAt}ms` +
          (delivered ? "" : " NOT-DELIVERED (connection dropped)"),
      );
    } catch (err) {
      // Say why. A server told `no-route` marks the edge as a data error and
      // stops asking; one told `unavailable` tries again on the next
      // reconnect. Silence used to mean a thirty-second wait and then an edge
      // that looked resolved at zero metres. Never emit a guessed distance.
      const code = protocolErrorCode(err);
      this.#sendError(requestId, code, err.message, socket);
      log.error(
        `request=${requestId} edge=${edge} FAILED after ${Date.now() - startedAt}ms ` +
          `as ${code}: ${err.message}` +
          `${err.attempts ? ` (osrm_attempts=${err.attempts})` : ""}`,
      );
    } finally {
      this.#limiter.release();
    }
  }
}

module.exports = { Driver, Semaphore };
