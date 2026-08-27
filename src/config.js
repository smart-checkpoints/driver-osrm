"use strict";

const pkg = require("../package.json");

const DEFAULT_WS_URL = "ws://localhost:3000/distance-driver";
const DEFAULT_OSRM_BASE_URL = "https://router.project-osrm.org";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

/**
 * The Smart Checkpoints REST API is served by the same http.Server that
 * hosts the distance-driver WebSocket, so the REST origin can be derived
 * from the WebSocket URL unless it is overridden explicitly.
 */
function deriveHttpUrl(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/**
 * Reads the driver's configuration from the environment.
 *
 * The GBDS_* variable names are deliberately unchanged. GBDS is the internal
 * graph architecture inside the Smart Checkpoints server; renaming the
 * variables would break every existing deployment's .env for no gain.
 */
function loadConfig(env = process.env) {
  const wsUrl = env.GBDS_WS_URL || DEFAULT_WS_URL;

  // Fail here rather than at connect time if the URL is malformed.
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`GBDS_WS_URL must be a ws:// or wss:// URL, got "${wsUrl}"`);
  }

  return {
    driverName: pkg.name,
    driverVersion: pkg.version,
    wsUrl,
    httpUrl: stripTrailingSlash(env.GBDS_HTTP_URL || deriveHttpUrl(wsUrl)),
    apiKey: requiredEnv("GBDS_API_KEY"),
    osrmBaseUrl: stripTrailingSlash(env.OSRM_BASE_URL || DEFAULT_OSRM_BASE_URL),
    requestTimeoutMs: positiveIntEnv("REQUEST_TIMEOUT_MS", 5000),
    maxConcurrentOsrm: positiveIntEnv("MAX_CONCURRENT_OSRM", 4),
  };
}

module.exports = { loadConfig };
