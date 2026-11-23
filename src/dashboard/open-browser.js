"use strict";

const { spawn } = require("child_process");

const log = require("../logger");

/** Opens `url` in the default browser. Failing to is never fatal. */
function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => log.warn(`could not open a browser; open ${url} yourself`));
    child.unref();
  } catch {
    log.warn(`could not open a browser; open ${url} yourself`);
  }
}

module.exports = { openBrowser };
