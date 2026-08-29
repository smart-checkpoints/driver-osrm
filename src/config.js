"use strict";

require("dotenv").config({ override: false });
const pkg = require("../package.json");

const DEFAULT_WS_URL = "ws://localhost:3000/distance-driver";
const DEFAULT_OSRM_BASE_URL = "https://router.project-osrm.org";

/**
 * Reads a variable under its current name, falling back to the legacy one.
 *
 * The ecosystem spells its variables `SC_*`. This driver shipped with `GBDS_*`,
 * after the graph architecture inside the server, and there are deployments
 * with those names in a .env file. Both are read, the current name wins, and
 * nothing existing breaks.
 */
function env(source, name, legacyName) {
  const value = source[name];
  if (value !== undefined && value !== "") return value;
  return source[legacyName];
}

function requiredEnv(source, name, legacyName) {
  const value = env(source, name, legacyName);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name} (or ${legacyName})`,
    );
  }
  return value;
}

function positiveIntEnv(source, name, fallback) {
  const raw = source[name];
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
 * Reads the driver's configuration from the environment.
 *
 * Every Smart Checkpoints variable is read under both its `SC_*` name and the
 * `GBDS_*` name this driver originally shipped with. Existing .env files keep
 * working; new ones are spelled the way the rest of the ecosystem is.
 */
function loadConfig(source = process.env) {
  const wsUrl = env(source, "SC_WS_URL", "GBDS_WS_URL") || DEFAULT_WS_URL;

  // Fail here rather than at connect time if the URL is malformed.
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`SC_WS_URL must be a ws:// or wss:// URL, got "${wsUrl}"`);
  }

  return {
    driverName: pkg.name,
    driverVersion: pkg.version,
    wsUrl,
    // No REST origin: protocol v2 carries the checkpoint coordinates inside
    // the request, so the only thing this driver talks to over HTTP is OSRM.
    // `SC_HTTP_URL` in an existing .env is simply ignored.
    apiKey: requiredEnv(source, "SC_API_KEY", "GBDS_API_KEY"),
    osrmBaseUrl: stripTrailingSlash(
      source.OSRM_BASE_URL || DEFAULT_OSRM_BASE_URL,
    ),
    requestTimeoutMs: positiveIntEnv(source, "REQUEST_TIMEOUT_MS", 5000),
    maxConcurrentOsrm: positiveIntEnv(source, "MAX_CONCURRENT_OSRM", 4),
  };
}

module.exports = { loadConfig };
