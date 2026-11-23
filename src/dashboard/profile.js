"use strict";

const pkg = require("../../package.json");
const { loadConfig } = require("../config");
const { Driver } = require("../driver");

/** What makes this dashboard the OSRM driver's rather than the map driver's. */
module.exports = {
  kind: "osrm",
  title: "OSRM distance driver",
  packageName: pkg.name,
  version: pkg.version,

  settings: [
    {
      name: "SC_WS_URL",
      envNames: ["SC_WS_URL", "GBDS_WS_URL"],
      label: "Smart Checkpoints server",
      type: "server",
      default: "ws://localhost:3000/distance-driver",
      hint: "localhost:3000, an IP like 192.168.1.5:3000, or a full ws:// address.",
    },
    {
      name: "OSRM_BASE_URL",
      label: "OSRM routing server",
      type: "url",
      default: "https://router.project-osrm.org",
      hint: "The public demo server is rate limited. Point this at your own OSRM for anything real.",
      options: ["https://router.project-osrm.org", "http://localhost:5000"],
    },
    {
      name: "REQUEST_TIMEOUT_MS",
      label: "Timeout per OSRM attempt (ms)",
      type: "int",
      default: "5000",
      hint: "Three attempts must fit well inside the server's 30 s wait.",
    },
    {
      name: "MAX_CONCURRENT_OSRM",
      label: "OSRM requests at once",
      type: "int",
      default: "4",
      hint: "Throttles the burst when a whole project's edges arrive together.",
    },
  ],

  envApiKey: (env) => env.SC_API_KEY || env.GBDS_API_KEY || null,

  loadConfig: (env) => loadConfig(env, { dashboard: true }),

  createDriver: (config) => new Driver(config, { stopOnReject: true }),

  initialStats: () => ({ served: 0, failed: 0, last: null, lastError: null }),

  track(driver, stats, changed) {
    driver.on("request", (event) => {
      if (event.ok) stats.served += 1;
      else {
        stats.failed += 1;
        stats.lastError = event;
      }
      stats.last = { ...event, at: Date.now() };
      changed();
    });
  },

  describe({ config, stats }) {
    const rows = [
      { label: "Edges answered", value: String(stats.served), tone: stats.served ? "good" : "" },
      { label: "Edges failed", value: String(stats.failed), tone: stats.failed ? "bad" : "" },
    ];
    if (stats.last) {
      rows.push({
        label: "Last edge",
        value: stats.last.ok
          ? `${stats.last.edge} · ${stats.last.distance} m · ${stats.last.elapsedMs} ms`
          : `${stats.last.edge} · ${stats.last.code}`,
        mono: true,
      });
    }
    if (stats.lastError) {
      rows.push({
        label: "Last failure",
        value: `${stats.lastError.edge}: ${stats.lastError.message}`,
        tone: "bad",
        mono: true,
      });
    }
    if (config) {
      rows.push({ label: "Routing via", value: config.osrmBaseUrl, mono: true });
      rows.push({
        label: "Limits",
        value: `${config.maxConcurrentOsrm} at once · ${config.requestTimeoutMs} ms timeout`,
      });
    }
    return rows;
  },
};
