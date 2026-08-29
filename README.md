# Smart Checkpoints OSRM Distance Driver

Smart Checkpoints measures average speed over distance across a graph of camera
checkpoints. This is its first real-world Distance Driver, replacing the Unity
simulation driver: working, tested against the mock server, not yet field validated.

A Smart Checkpoints **Distance Driver**: it connects to the server, waits for
distance requests, asks OSRM for the driving route between the two checkpoints,
and sends back the route distance in metres and the shape of the road it found.

It does one thing. No alternative routes, no caching of distances, no second map
provider, no fallback estimate. If OSRM cannot answer, the driver says so and
says why; it never invents a number.

## The event contract

Protocol **v2**, implemented against `server.js` in the Smart Checkpoints server
repo. This driver requires a server that speaks v2 — it reads the checkpoint
coordinates out of the request rather than fetching them, so an older server
gives it requests it cannot use. It says so once, at authentication, rather than
failing quietly per edge.

**Transport.** A raw WebSocket (`ws`), not Socket.IO. Socket.IO on the Smart
Checkpoints server is for the browser clients only. The driver connects to the
upgrade path `/distance-driver` on the same origin and port as the REST API:

```
ws://<server-host>:3000/distance-driver
```

**Authentication is a message, not a header.** The driver opens the socket and
immediately sends what it is and what it can do:

```jsonc
// driver -> server
{
  "type": "auth",
  "apiKey": "<project api key>",
  "protocolVersion": 2,
  "role": "distance",
  "driverName": "osrm",
  "capabilities": { "geometry": true, "endpointOffsets": true }
}
```

```jsonc
// server -> driver, on success
{ "type": "authenticated", "projectId": 1, "protocolVersion": 2 }

// server -> driver, on failure
{ "type": "error", "message": "Invalid API key" }
```

`protocolVersion` in the reply is the version the server will actually speak,
which is the lower of the two. Capabilities are additive and optional: they tell
the console what to expect and they never gate a connection. A driver that
declares none still connects and still answers.

**The project has one distance driver.** A second one authenticating takes the
slot and the server closes the first with code `4001`, `"replaced by a newer
driver"`. This driver treats that as fatal and exits with status 1 rather than
reconnecting into a fight over the slot — a duplicate started by mistake should
stop, loudly, at the machine that started it.

**Distance requests** carry both the node indices, for logging and correlation,
and the coordinates, for routing:

```jsonc
// server -> driver
{
  "type": "calculate-distance",
  "requestId": "6f659d37-28bf-4fb7-9d39-6320585518e1",
  "fromIdInProject": 0,
  "toIdInProject": 1,
  "from": { "latitude": 30.0444, "longitude": 31.2357 },
  "to":   { "latitude": 30.0459, "longitude": 31.2243 }
}
```

**Distance results.** `distance` is in **metres**. The server divides it by a
km/h speed limit and multiplies by 3.6 to get seconds, so metres is the unit the
violation maths expects:

```jsonc
// driver -> server
{
  "type": "distance-result",
  "requestId": "6f659d37-28bf-4fb7-9d39-6320585518e1",
  "distance": 1767.5,
  "path": {
    "type": "LineString",
    "coordinates": [[31.2357, 30.0444], [31.2301, 30.0450], [31.2243, 30.0459]]
  },
  "pathFormat": "geojson-linestring-wgs84",
  "endpointOffsets": [4.2, 11.8]
}
```

- `path` is optional. Distance is what enforcement runs on; geometry is what the
  map view draws. An edge with a distance and no shape is correct and
  enforceable, so anything doubtful is left out rather than repaired.
- Coordinates are `[longitude, latitude]`. That is GeoJSON order, and it is the
  opposite of how people say it.
- `endpointOffsets` is how far, in metres, each requested coordinate was from
  the road OSRM actually routed on. A checkpoint two hundred metres from the
  nearest road is either mispositioned or on a road OSRM does not know about.
- The server stores the geometry without reading it, under a 256 KB cap. Over
  that, it keeps the distance and drops the shape.

**Failures are a message.** A request that cannot be answered gets a reply
saying why, instead of silence and a thirty-second server-side timeout:

```jsonc
// driver -> server
{
  "type": "distance-error",
  "requestId": "6f659d37-28bf-4fb7-9d39-6320585518e1",
  "code": "no-route",
  "message": "HTTP 400 from OSRM (NoRoute: Impossible route between points)"
}
```

| `code` | When this driver sends it | What the server does |
| --- | --- | --- |
| `no-route` | OSRM answered `NoRoute`, `NoSegment` or `NoTrips` | Marks the edge `no-route`. Definitive; it stops asking |
| `unavailable` | Network error, timeout, HTTP 5xx, HTTP 429 | Marks the edge `unknown`. Retried on the next reconnect |
| `invalid-input` | OSRM read the query and rejected it, or the request had no usable coordinates | Marks the edge `unknown` and logs loudly: the fault is on the server's side |

An edge that is not `ok` enforces nothing, and the console draws it as such.

**Heartbeat.** The server pings every 30 seconds and terminates a socket that
misses two. `ws` answers pings itself, so this needs no code here; it means a
driver killed outright frees its project's slot in about ninety seconds instead
of whenever TCP notices. A socket that connects and does not authenticate within
ten seconds is closed with code `4002`.

## Coordinates

**Coordinates are WGS84 degrees**, latitude and longitude, and there is no other
coordinate system anywhere in Smart Checkpoints. The server validates them on the
way in and rejects anything outside latitude ±90 / longitude ±180; this driver
checks the same range again on the way out, so a bad coordinate becomes an
`invalid-input` reply rather than a plausible route to the wrong place.

There is no node lookup. v1 sent only node indices and this driver resolved them
over `GET /project/:id/nodes`, with a cache to invalidate and a REST origin to
configure; v2 sends the positions, and all of that is gone.

## Install

```bash
npm install
```

Requires Node 20 or newer, the same floor as the rest of the ecosystem. One
dependency: `ws`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `SC_WS_URL` | `ws://localhost:3000/distance-driver` | Driver WebSocket endpoint. |
| `SC_API_KEY` | *(required)* | Project API key. The distance driver is an operator of its project, so this is the project's operator key, not a camera's reporter key. |
| `OSRM_BASE_URL` | `https://router.project-osrm.org` | OSRM server. The default is the public demo instance. |
| `REQUEST_TIMEOUT_MS` | `5000` | Per-attempt timeout for OSRM. |
| `MAX_CONCURRENT_OSRM` | `4` | How many OSRM calls may be in flight at once. |

Every Smart Checkpoints variable is also read under its old `GBDS_` name
(`GBDS_WS_URL`, `GBDS_API_KEY`), so existing `.env` files keep working
unchanged. GBDS was the graph architecture inside the server rather than the
product name, and the `SC_` spelling is what the rest of the ecosystem uses.
Where both are set, the `SC_` one wins. `SC_HTTP_URL` is no longer read: nothing
here talks to the REST API any more.

Copy `.env.example` to `.env` and run with `node --env-file=.env src/index.js`,
or export the variables yourself.

## Run

```bash
SC_API_KEY=your-project-key npm start
```

## Test it without running the server

`tools/fake-server.js` stands in for the Smart Checkpoints server. It reproduces
the upgrade path, the v2 auth exchange, the burst of requests the server fires
the instant a driver authenticates, and the 30-second pending timeout. Its
fixture graph is four Cairo checkpoints plus two deliberate failures: an edge
into the Atlantic where OSRM has no road, and an edge to a node that does not
exist.

In one terminal:

```bash
node tools/fake-server.js
```

In another:

```bash
SC_WS_URL=ws://localhost:3000/distance-driver SC_API_KEY=test-api-key npm start
```

It prints a `RESULT` line per answered edge — with the geometry size and the
endpoint offsets, and whether the real server would have kept them — and an
`ERROR` line per refused one, with the code. Press Enter in its terminal to
re-send the whole burst. `PORT`, `FAKE_API_KEY`, `FAKE_PROJECT_ID`, and
`PENDING_TIMEOUT_MS` override its defaults. It still serves
`GET /project/:id/nodes` and complains if anything calls it, because a v2 driver
never should.

## Behaviour

**OSRM retries.** Three attempts maximum, backing off 500ms then 1000ms.
Retried: network errors, timeouts, HTTP 5xx, and HTTP 429. Not retried: any
other 4xx, and any `code` other than `Ok`. Those are OSRM answering the
question, and asking the identical question again gets the identical answer.
`NoRoute` in particular is a valid answer, and is reported as `no-route` rather
than retried.

**Reconnect.** If the socket drops, the driver reconnects with exponential
backoff from 1s to a 30s ceiling, with jitter. The backoff resets once the
server confirms authentication. An invalid API key is logged at ERROR and
retried on the same backoff, since a key can be added to the project later.
Close codes `4001` and `4003` are not retried — see the slot rule above.

**Isolation.** Each request runs on its own. A failed edge is reported and
dropped; it does not close the connection, does not affect other in-flight
requests, and does not stop the process.

**Concurrency.** The server calls `recalculateAllDistances` the moment a driver
authenticates, which asks for *every* edge in the project at once. On a
reconnect that is the whole graph in one burst, so `MAX_CONCURRENT_OSRM`
throttles it rather than firing it all at the public demo server at once.
Three attempts of `REQUEST_TIMEOUT_MS` plus backoff plus queue time needs to
stay under the server's 30s budget, which holds comfortably at the defaults.

**Distances are raw.** The number sent is `routes[0].distance` from OSRM,
unrounded and unmodified. The geometry is `routes[0].geometry` at
`overview=simplified`, which comes back in the same HTTP call: geometry costs a
larger response and no extra request.

## Logging

One line per request, on stdout:

```
[2026-08-28T15:52:44.537Z] INFO  smart-checkpoints-driver-osrm/1.0.0 request=3b704795-... edge=0->1 from=30.044400,31.235700 to=30.045900,31.224300 distance=1767.5m osrm_attempts=1 geometry=42pts elapsed=344ms
```

Coordinates are printed `lat,lng`. Failures go to stderr with the same
`request=` and `edge=` fields, the protocol code the server was told, and the
reason OSRM gave.

## Known Limitations

These are properties of the current protocol and schema rather than defects in
this driver, and they are listed here so whoever operates it knows where the
edges are.

**A node with a bad GPS fix still routes.** A coordinate inside the valid range
but in the wrong place produces a real route to the wrong location, and this
driver cannot tell. `endpointOffsets` is the beginning of an answer — a
checkpoint far from any road shows up in it — but a checkpoint that is wrong and
still beside a road does not. Diagnosing that is the server's job.

**Geometry is simplified.** `overview=simplified` is what gets stored, so the
drawn route is the shape of the road rather than every vertex of it. That is a
deliberate trade: one path per edge, and full polylines get large quickly.

**One OSRM profile.** `driving`, hard-coded. There is no cycling, walking, or
per-project profile, and adding one would be a configuration surface the
protocol deliberately does not have.

## License

MIT. See [LICENSE](LICENSE).

## Links

- [Website](https://smartcheckpoints.xyz)
- [Documentation](https://docs.smartcheckpoints.xyz), including the
  [driver protocol](https://docs.smartcheckpoints.xyz/reference/driver-protocol)
  and [distance drivers](https://docs.smartcheckpoints.xyz/concepts/distance-drivers)
- [Smart Checkpoints on GitHub](https://github.com/smart-checkpoints)
- [server](https://github.com/smart-checkpoints/server), which is what this driver talks to
