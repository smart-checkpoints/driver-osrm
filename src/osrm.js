"use strict";

// Fixed by the driver contract: at most three attempts per edge, backing off
// between them. Three attempts of REQUEST_TIMEOUT_MS plus 1.5s of backoff has
// to stay inside the 30s the GBDS server waits for a distance-result.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

class OsrmError extends Error {
  constructor(message, { retryable = false, code = null } = {}) {
    super(message);
    this.name = "OsrmError";
    this.retryable = retryable;
    this.code = code;
    this.attempts = 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** OSRM takes coordinates as lon,lat -- the opposite of how they are spoken. */
function buildRouteUrl(baseUrl, from, to) {
  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  return (
    `${baseUrl}/route/v1/driving/${coordinates}` +
    "?overview=false&alternatives=false&steps=false&annotations=false"
  );
}

/**
 * OSRM explains a rejection in the response body, and it is the only place
 * that says whether a 400 meant NoRoute, NoSegment, or a malformed query.
 */
async function describeRejection(response) {
  try {
    const body = await response.json();
    if (body && body.code) {
      const detail = body.message ? `: ${body.message}` : "";
      return { code: body.code, text: ` (${body.code}${detail})` };
    }
  } catch {
    // Not JSON. The status code alone will have to do.
  }
  return { code: null, text: "" };
}

async function requestRoute(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // DNS failures, resets, and our own timeout all land here. None of them
    // say anything about the query itself, so they are worth another try.
    throw new OsrmError(`network error: ${err.message}`, { retryable: true });
  }

  if (response.status >= 500) {
    throw new OsrmError(`HTTP ${response.status} from OSRM`, { retryable: true });
  }
  if (!response.ok) {
    // A 4xx means OSRM read the query and answered it: no route between the
    // points, no road near a coordinate, or a malformed request. The road
    // network will not change between attempts, so this is final.
    const rejection = await describeRejection(response);
    throw new OsrmError(`HTTP ${response.status} from OSRM${rejection.text}`, {
      retryable: false,
      code: rejection.code,
    });
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    // A 200 whose body did not arrive intact is a transport problem.
    throw new OsrmError(`unreadable OSRM response: ${err.message}`, { retryable: true });
  }

  if (body.code !== "Ok") {
    const detail = body.message ? `: ${body.message}` : "";
    throw new OsrmError(`OSRM answered ${body.code}${detail}`, {
      retryable: false,
      code: body.code,
    });
  }

  const route = Array.isArray(body.routes) ? body.routes[0] : undefined;
  if (!route || typeof route.distance !== "number" || !Number.isFinite(route.distance)) {
    throw new OsrmError("OSRM answered Ok but returned no usable route distance", {
      retryable: false,
      code: "NoRoute",
    });
  }

  return route.distance;
}

/**
 * Driving distance in metres between two GPS points, exactly as OSRM reports
 * it. Retries network errors and 5xx only; a considered "no route" answer is
 * raised to the caller and never substituted with an estimate.
 */
async function routeDistanceMeters(from, to, { baseUrl, timeoutMs }) {
  const url = buildRouteUrl(baseUrl, from, to);

  for (let attempt = 1; ; attempt++) {
    try {
      const distance = await requestRoute(url, timeoutMs);
      return { distance, attempts: attempt };
    } catch (err) {
      err.attempts = attempt;
      const retryable = err instanceof OsrmError && err.retryable;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

module.exports = { routeDistanceMeters, buildRouteUrl, OsrmError, MAX_ATTEMPTS };
