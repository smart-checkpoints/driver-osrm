"use strict";

// Fixed by the driver contract: at most three attempts per edge, backing off
// between them. Three attempts of REQUEST_TIMEOUT_MS plus 1.5s of backoff has
// to stay inside the 30s the Smart Checkpoints server waits for a
// distance-result.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/**
 * The OSRM codes that mean "I looked, and there is no road here".
 *
 * These are final. The road network does not change between attempts, and a
 * Smart Checkpoints server told `no-route` marks the edge and stops asking.
 */
const NO_ROUTE_CODES = new Set(["NoRoute", "NoSegment", "NoTrips"]);

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

/**
 * OSRM takes coordinates as lon,lat -- the opposite of how they are spoken.
 *
 * `overview=simplified` with `geometries=geojson` returns the route shape in
 * the one format Smart Checkpoints stores, in the same HTTP call that returns
 * the distance: geometry costs a larger response and no extra request.
 * `simplified`, not `full`, because there is one of these per edge and full
 * polylines get large quickly.
 */
function buildRouteUrl(baseUrl, from, to) {
  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  return (
    `${baseUrl}/route/v1/driving/${coordinates}` +
    "?overview=simplified&geometries=geojson" +
    "&alternatives=false&steps=false&annotations=false"
  );
}

/**
 * The route shape, if OSRM returned one worth forwarding.
 *
 * Geometry is presentation: an edge with a distance and no shape is correct
 * and enforceable, so anything doubtful is dropped rather than repaired.
 */
function readGeometry(route) {
  const geometry = route && route.geometry;
  if (!geometry || geometry.type !== "LineString") return null;
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
    return null;
  }
  return geometry;
}

/**
 * How far, in metres, each requested coordinate was from the road OSRM
 * actually routed on.
 *
 * A checkpoint two hundred metres from the nearest road is either mispositioned
 * or on a road OSRM does not know about, and either way the distance it
 * produced is not the distance a car drives. The server stores this; Phase 5
 * is what reads it.
 */
function readEndpointOffsets(body) {
  if (!Array.isArray(body.waypoints)) return null;
  const offsets = body.waypoints.map((waypoint) =>
    waypoint && typeof waypoint.distance === "number" ? waypoint.distance : NaN,
  );
  return offsets.every((offset) => Number.isFinite(offset)) ? offsets : null;
}

/**
 * The Smart Checkpoints protocol code for an OSRM failure.
 *
 * The distinction the server acts on is whether asking again could give a
 * different answer. A refused route will be refused again; a timeout or a
 * 500 will not necessarily be.
 */
function protocolErrorCode(err) {
  if (!(err instanceof OsrmError)) return "unavailable";
  if (err.retryable) return "unavailable";
  if (err.code && NO_ROUTE_CODES.has(err.code)) return "no-route";
  // A query OSRM read and rejected: a coordinate it cannot use, a malformed
  // request, a service that is not there. Retrying will not help, and the
  // server logs this one loudly because it means the request was wrong.
  return "invalid-input";
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

  if (response.status >= 500 || response.status === 429) {
    // 5xx is the server having a bad time; 429 is it asking for less of us.
    // Neither says anything about whether these two points are connected.
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

  return {
    distance: route.distance,
    path: readGeometry(route),
    endpointOffsets: readEndpointOffsets(body),
  };
}

/**
 * The driving route between two GPS points, exactly as OSRM reports it:
 * `{ distance, path, endpointOffsets, attempts }`, distance in metres.
 *
 * Retries network errors, 5xx and rate limits only; a considered "no route"
 * answer is raised to the caller and never substituted with an estimate.
 */
async function routeDistanceMeters(from, to, { baseUrl, timeoutMs }) {
  const url = buildRouteUrl(baseUrl, from, to);

  for (let attempt = 1; ; attempt++) {
    try {
      const route = await requestRoute(url, timeoutMs);
      return { ...route, attempts: attempt };
    } catch (err) {
      err.attempts = attempt;
      const retryable = err instanceof OsrmError && err.retryable;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

module.exports = {
  routeDistanceMeters,
  buildRouteUrl,
  protocolErrorCode,
  OsrmError,
  MAX_ATTEMPTS,
};
