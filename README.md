# Smart Checkpoints OSRM Distance Driver

Smart Checkpoints measures average speed over distance across a graph of camera
checkpoints. This is its first real-world Distance Driver, replacing the Unity
simulation driver: working, tested against the mock server, not yet field validated.

A Smart Checkpoints **Distance Driver**: it connects to the server, waits for
distance requests, asks OSRM for the driving route between the two checkpoints,
and sends back the route distance in metres.

It does one thing. No geometry, no alternative routes, no caching of distances,
no second map provider, no fallback estimate. If OSRM cannot answer, the driver
says nothing and logs why.

## The event contract

This is implemented against `server.js` in the Smart Checkpoints server repo,
not against a spec. Everything below is what that file actually does.

**Transport.** A raw WebSocket (`ws`), not Socket.IO. Socket.IO on the Smart
Checkpoints server is for the browser clients only. The driver connects to the
upgrade path `/distance-driver` on the same origin and port as the REST API:

```
ws://<server-host>:3000/distance-driver
```

**Authentication is a message, not a header.** The driver opens the socket with
no special headers and immediately sends:

```jsonc
// driver -> server
{ "type": "auth", "apiKey": "<project api key>" }
```

The server replies with one of:

```jsonc
// server -> driver, on success
{ "type": "authenticated", "projectId": 1 }

// server -> driver, on failure
{ "type": "error", "message": "Invalid API key" }
```

The `projectId` in that reply is needed for the node lookup below, so the
driver keeps it for the lifetime of the connection.

**Distance requests.** The server addresses an edge by its two node indices
(`id_in_project`) and correlates the answer by `requestId`. There is no
`edgeId` and no coordinate in this message:

```jsonc
// server -> driver
{
  "type": "calculate-distance",
  "requestId": "6f659d37-28bf-4fb7-9d39-6320585518e1",
  "fromIdInProject": 0,
  "toIdInProject": 1
}
```

**Distance results.** `distance` is in **metres**. The server divides it by a
km/h speed limit and multiplies by 3.6 to get seconds, so metres is the unit
the violation maths expects:

```jsonc
// driver -> server
{
  "type": "distance-result",
  "requestId": "6f659d37-28bf-4fb7-9d39-6320585518e1",
  "distance": 1767.5
}
```

**There is no failure event.** The Smart Checkpoints server's message handler
reads exactly two inbound types, `auth` and `distance-result`; anything else is
dropped silently. A request that the driver cannot answer is therefore handled
by the server's own 30-second timeout, after which the server falls back to
`distance = 0` on its side. This driver logs the failure at ERROR and sends
nothing. It never emits a guessed or straight-line distance.

**There is no handshake or heartbeat beyond `auth`.** The Smart Checkpoints
server configures no ping/pong on this socket.

## Coordinates

The server sends node indices, so the driver resolves them itself over the REST
API. This is the one place the `x-api-key` header is used:

```
GET http://<server-host>:3000/project/<projectId>/nodes
x-api-key: <project api key>
```

```jsonc
[ { "node_id": 1, "id_in_project": 0, "latitude": 30.0444, "longitude": 31.2357 } ]
```

**Coordinates are WGS84 degrees.** The server validates them on the way in and
rejects anything outside latitude ±90 / longitude ±180, and the driver checks
the same range again before sending anything to OSRM, so a bad coordinate fails
loudly instead of producing a plausible wrong number.

The node list is fetched once per connection and re-fetched once on a cache
miss, so nodes added while the driver is connected resolve without a restart.

## Install

```bash
npm install
```

Requires Node 18 or newer. One dependency: `ws`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `GBDS_WS_URL` | `ws://localhost:3000/distance-driver` | Driver WebSocket endpoint. |
| `GBDS_API_KEY` | *(required)* | Project API key, used for both the auth message and the `x-api-key` header. |
| `GBDS_HTTP_URL` | origin of `GBDS_WS_URL` | REST base URL. Only set this if the REST API is not on the same origin. |
| `OSRM_BASE_URL` | `https://router.project-osrm.org` | OSRM server. The default is the public demo instance. |
| `REQUEST_TIMEOUT_MS` | `5000` | Per-attempt timeout for OSRM and for the node lookup. |
| `MAX_CONCURRENT_OSRM` | `4` | How many OSRM calls may be in flight at once. |

The `GBDS_` prefix is kept deliberately. GBDS is the internal graph
architecture inside the Smart Checkpoints server, not the product name;
renaming these variables would break every existing deployment's `.env`.

Copy `.env.example` to `.env` and run with `node --env-file=.env src/index.js`,
or export the variables yourself.

## Run

```bash
GBDS_API_KEY=your-project-key npm start
```

## Test it without running the server

`tools/fake-server.js` stands in for the Smart Checkpoints server. It
reproduces the upgrade path, the auth exchange, the node endpoint, the
30-second pending timeout, and the burst of requests that the server fires the
instant a driver authenticates. Its fixture graph is four Cairo checkpoints
plus two deliberate failures: an edge into the Atlantic where OSRM has no
road, and an edge to a node that does not exist.

In one terminal:

```bash
node tools/fake-server.js
```

In another:

```bash
GBDS_WS_URL=ws://localhost:3000/distance-driver GBDS_API_KEY=test-api-key npm start
```

The fake server prints a `RESULT` line per answered edge and a `TIMEOUT` line
per unanswered one. Press Enter in its terminal to re-send the whole burst.
`PORT`, `FAKE_API_KEY`, `FAKE_PROJECT_ID`, and `PENDING_TIMEOUT_MS` override
its defaults; lowering `PENDING_TIMEOUT_MS` makes the two expected failures
report quickly instead of after the realistic 30 seconds.

## Behaviour

**OSRM retries.** Three attempts maximum, backing off 500ms then 1000ms.
Retried: network errors, timeouts, and HTTP 5xx. Not retried: HTTP 4xx and any
`code` other than `Ok`. Those are OSRM answering the question, and asking the
identical question again gets the identical answer. `NoRoute` in particular is
a valid answer and is never retried. Note that the public demo server returns
rate-limit and no-route responses as 4xx, so neither is retried by design.

**Reconnect.** If the socket drops, the driver reconnects with exponential
backoff from 1s to a 30s ceiling, with jitter. The backoff resets once the
server confirms authentication. An invalid API key is logged at ERROR and
retried on the same backoff, since a key can be added to the project later.

**Isolation.** Each request runs on its own. A failed edge is logged and
dropped; it does not close the connection, does not affect other in-flight
requests, and does not stop the process.

**Concurrency.** The server calls `recalculateAllDistances` the moment a driver
authenticates, which asks for *every* edge in the project at once. On a
reconnect that is the whole graph in one burst, so `MAX_CONCURRENT_OSRM`
throttles it rather than firing it all at the public demo server at once.
Three attempts of `REQUEST_TIMEOUT_MS` plus backoff plus queue time needs to
stay under the server's 30s budget, which holds comfortably at the defaults.

**Distances are raw.** The number sent is `routes[0].distance` from OSRM,
unrounded and unmodified.

## Logging

One line per request, on stdout:

```
[2026-08-27T15:52:44.537Z] INFO  smart-checkpoints-driver-osrm/1.0.0 request=3b704795-... edge=0->1 from=30.044400,31.235700 to=30.045900,31.224300 distance=1767.5m osrm_attempts=1 elapsed=344ms
```

Coordinates are printed `lat,lng`. Failures go to stderr with the same
`request=` and `edge=` fields and the reason OSRM or the node lookup gave.

## Known Limitations

These are known and understood. They are properties of the current protocol and
schema rather than defects in this driver, and they are listed here so whoever
operates it knows where the edges are.

**The protocol has no failure event.** The server reads exactly two inbound
message types, `auth` and `distance-result`, and silently drops anything else.
There is no message a driver can send to say that an edge could not be
resolved.

**A driver that cannot answer produces a silent zero.** With no
`distance-result`, the server's 30-second timeout sets `distance = 0` for that
edge. An edge of zero metres produces no violations at all: no vehicle can be
too fast over no distance. Nothing surfaces on either side. The server stores a
number it treats as valid, and the only record of the failure is this driver's
ERROR line in its own log. It fails safe, but it also fails silent.

**A node with a bad GPS fix still routes.** A coordinate inside the valid range
but in the wrong place produces a real route to the wrong location, and neither
side can tell. The driver has no way to detect this; diagnosing it is the
server's job.

## License

MIT. See [LICENSE](LICENSE).

## Links

- [Smart Checkpoints on GitHub](https://github.com/smart-checkpoints)
- [Documentation](https://docs.smartcheckpoints.dev)
