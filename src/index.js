"use strict";

const path = require("path");

const log = require("./logger");
const { loadConfig } = require("./config");
const { Driver } = require("./driver");

const pkg = require("../package.json");

/**
 * Two ways to run.
 *
 * By default a dashboard opens in the browser: it asks which project to serve,
 * remembers keys, and switches between projects without a restart.
 *
 * SC_DASHBOARD=off is the old behaviour, for a service manager or a server
 * with no browser: the key comes from .env, and a second copy of the driver
 * holding the slot makes this one exit non-zero.
 */
const dashboardOff = /^(0|off|false|no)$/i.test(process.env.SC_DASHBOARD || "");

process.on("unhandledRejection", (reason) => {
  log.error(`unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on("uncaughtException", (err) => {
  log.error(`uncaught exception: ${err.stack || err.message}`);
});

if (dashboardOff) runHeadless();
else void runWithDashboard();

function runHeadless() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    console.error("See .env.example for the variables this driver reads.");
    process.exit(1);
  }

  log.setTag(`${config.driverName}/${config.driverVersion}`);
  log.info(
    `starting: server=${config.wsUrl} ` +
      `osrm=${config.osrmBaseUrl} timeout=${config.requestTimeoutMs}ms ` +
      `max_concurrent=${config.maxConcurrentOsrm}`,
  );

  // Some things reconnecting cannot fix. A second copy of this driver holding
  // the project's distance slot is one of them, and the useful response is to
  // stop with a non-zero exit code so whatever started this one notices.
  const driver = new Driver(config, { onFatal: () => process.exit(1) });
  driver.start();
  onShutdown(() => driver.stop());
}

async function runWithDashboard() {
  const { Store } = require("./dashboard/store");
  const { Controller } = require("./dashboard/controller");
  const { startStandaloneDashboard, PREFIX } = require("./dashboard/http");
  const { openBrowser } = require("./dashboard/open-browser");
  const profile = require("./dashboard/profile");

  log.setTag(`${pkg.name}/${pkg.version}`);

  const store = new Store(
    path.resolve(process.env.SC_DASHBOARD_FILE || path.join(__dirname, "..", "projects.json")),
  );
  const controller = new Controller({ profile, store });

  const port = Number.parseInt(process.env.SC_DASHBOARD_PORT || "", 10) || 4200;
  let site;
  try {
    site = await startStandaloneDashboard(controller, { host: "127.0.0.1", port });
  } catch (err) {
    console.error(`Cannot start the dashboard on port ${port}: ${err.message}`);
    console.error("Set SC_DASHBOARD_PORT to a free port, or SC_DASHBOARD=off to run without it.");
    process.exit(1);
  }

  const url = `http://127.0.0.1:${site.port}${PREFIX}/`;
  controller.dashboardUrl = url;
  log.info(`dashboard: ${url}`);

  await controller.start();

  if (!/^(0|off|false|no)$/i.test(process.env.SC_DASHBOARD_OPEN || "")) openBrowser(url);

  onShutdown(() => {
    controller.stop();
    site.stop();
  });
}

function onShutdown(fn) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log.info(`${signal} received, shutting down`);
      fn();
      process.exit(0);
    });
  }
}
