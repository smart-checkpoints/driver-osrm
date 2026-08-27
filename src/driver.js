"use strict";

const WebSocket = require("ws");

const log = require("./logger");
const { NodeDirectory } = require("./nodes");
const { routeDistanceMeters } = require("./osrm");

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

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

class Driver {
  #config;
  #limiter;
  #socket = null;
  #nodes = null;
  #authenticated = false;
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #stopped = false;

  constructor(config) {
    this.#config = config;
    this.#limiter = new Semaphore(config.maxConcurrentOsrm);
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
    this.#nodes = null;

    socket.on("open", () => {
      log.info("connected, authenticating");
      this.#send({ type: "auth", apiKey: this.#config.apiKey }, socket);
    });

    socket.on("message", (raw) => this.#onMessage(raw, socket));

    socket.on("error", (err) => {
      // A close event always follows, so reconnection is scheduled there.
      log.error(`websocket error: ${describeError(err)}`);
    });

    socket.on("close", (code, reason) => {
      if (this.#socket !== socket) return;
      const detail = reason && reason.length ? ` (${reason.toString()})` : "";
      this.#scheduleReconnect(`connection closed with code ${code}${detail}`);
    });
  }

  #scheduleReconnect(reason) {
    this.#socket = null;
    this.#authenticated = false;
    this.#nodes = null;
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
        this.#nodes = new NodeDirectory({
          httpUrl: this.#config.httpUrl,
          apiKey: this.#config.apiKey,
          projectId: message.projectId,
          timeoutMs: this.#config.requestTimeoutMs,
        });
        log.info(
          `authenticated for project ${message.projectId}; ` +
            `nodes from ${this.#nodes.url}, routing via ${this.#config.osrmBaseUrl}`,
        );
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

  async #handleCalculateDistance(message, socket) {
    const { requestId, fromIdInProject, toIdInProject } = message;
    const edge = `${fromIdInProject}->${toIdInProject}`;
    const startedAt = Date.now();

    if (typeof requestId !== "string" || requestId === "") {
      log.warn(`discarding calculate-distance for edge ${edge} with no requestId`);
      return;
    }
    if (!this.#authenticated || !this.#nodes) {
      log.warn(`discarding request=${requestId} edge=${edge}: not authenticated yet`);
      return;
    }

    const directory = this.#nodes;
    await this.#limiter.acquire();
    try {
      const from = await directory.coordsFor(fromIdInProject);
      const to = await directory.coordsFor(toIdInProject);
      const { distance, attempts } = await routeDistanceMeters(from, to, {
        baseUrl: this.#config.osrmBaseUrl,
        timeoutMs: this.#config.requestTimeoutMs,
      });

      // The value OSRM returned, unrounded and unadjusted.
      const delivered = this.#send({ type: "distance-result", requestId, distance }, socket);

      log.info(
        `request=${requestId} edge=${edge} ` +
          `from=${formatCoords(from)} to=${formatCoords(to)} ` +
          `distance=${distance}m osrm_attempts=${attempts} ` +
          `elapsed=${Date.now() - startedAt}ms` +
          (delivered ? "" : " NOT-DELIVERED (connection dropped)"),
      );
    } catch (err) {
      // The protocol has no inbound failure event -- server.js reads only
      // "auth" and "distance-result" -- so a failed edge is logged here and
      // left to the server's 30s timeout, which then records distance = 0 for
      // this edge. Never emit a guessed distance.
      log.error(
        `request=${requestId} edge=${edge} FAILED after ${Date.now() - startedAt}ms: ` +
          `${err.message}${err.attempts ? ` (osrm_attempts=${err.attempts})` : ""}`,
      );
    } finally {
      this.#limiter.release();
    }
  }
}

module.exports = { Driver, Semaphore };
