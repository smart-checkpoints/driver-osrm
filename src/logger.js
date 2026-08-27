"use strict";

let tag = "driver";

function setTag(value) {
  tag = value;
}

function write(stream, level, message) {
  stream.write(`[${new Date().toISOString()}] ${level.padEnd(5)} ${tag} ${message}\n`);
}

module.exports = {
  setTag,
  info: (message) => write(process.stdout, "INFO", message),
  warn: (message) => write(process.stderr, "WARN", message),
  error: (message) => write(process.stderr, "ERROR", message),
};
