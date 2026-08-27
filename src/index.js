"use strict";

const log = require("./logger");
const { loadConfig } = require("./config");
const { Driver } = require("./driver");

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
  `starting: server=${config.wsUrl} rest=${config.httpUrl} ` +
    `osrm=${config.osrmBaseUrl} timeout=${config.requestTimeoutMs}ms ` +
    `max_concurrent=${config.maxConcurrentOsrm}`,
);

const driver = new Driver(config);
driver.start();

// A single bad edge must never take the process down. Every request handler
// already catches its own failures, so anything that reaches here is logged
// and the driver keeps serving.
process.on("unhandledRejection", (reason) => {
  log.error(`unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on("uncaughtException", (err) => {
  log.error(`uncaught exception: ${err.stack || err.message}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    driver.stop();
    process.exit(0);
  });
}
