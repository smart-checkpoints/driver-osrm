"use strict";

let tag = "driver";

/**
 * The last few hundred lines, kept in memory for the dashboard's live log.
 *
 * The terminal still gets every line exactly as before; this is a copy, so a
 * dashboard opened after a burst of requests can show what happened.
 */
const MAX_LINES = 400;
const lines = [];
const listeners = new Set();
let seq = 0;

function setTag(value) {
  tag = value;
}

function write(stream, level, message) {
  const time = new Date().toISOString();
  stream.write(`[${time}] ${level.padEnd(5)} ${tag} ${message}\n`);

  const entry = { seq: ++seq, time, level, message };
  lines.push(entry);
  if (lines.length > MAX_LINES) lines.shift();
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // A dashboard that went away mid-write must not take logging with it.
    }
  }
}

/** Every line still held, oldest first. */
function recent() {
  return lines.slice();
}

/** Calls `listener` with each new line; returns the unsubscribe function. */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  setTag,
  recent,
  subscribe,
  info: (message) => write(process.stdout, "INFO", message),
  warn: (message) => write(process.stderr, "WARN", message),
  error: (message) => write(process.stderr, "ERROR", message),
};
