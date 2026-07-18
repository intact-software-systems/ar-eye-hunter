# API-v1 Multi-Server Topology Convergence Black-Box Design

## Goal

Add a no-browser, no-WebRTC black-box regression test that proves two real
`apps/api-v1` processes sharing PostgreSQL converge RTC topology publications
across HTTP mutations, durable APP_OUTBOX work, PostgreSQL notifications, and
raw WebSocket fanout.

## Why This Test Is Worthwhile

The focused topology tests already prove immutable group-revision work,
out-of-order N/N+1 processing, latest-topology monotonicity, and local fanout.
The API transport test mocks PostgreSQL `LISTEN/NOTIFY`, and the existing
three-browser RTC suite starts one API server. No current test proves that two
independent API processes can share the durable queue, publish a topology on
whichever process reserves the work, notify the other process through real
PostgreSQL pub/sub, and deliver the same exact-revision publication to sockets
owned by both processes.

The new test closes that deployment-boundary gap without duplicating WebRTC
coverage.

## Non-Goals

- Do not start a browser or Playwright.
- Do not construct `RTCPeerConnection` or RTC data channels.
- Do not force a particular N/N+1 worker completion order in the process test;
  the deterministic unit suite remains authoritative for N+1-before-N.
- Do not make the PGlite-memory job multi-server because separate processes do
  not share its database or local pub/sub bus.
- Do not add topology-specific commands to the generic black-box recipe
  language.

## Architecture

Extend `api-v1-black-box-run.mts` with an optional secondary API port. When
configured with PostgreSQL, the runner starts two Deno API processes with the
same database and distinct process identities, waits for both `/api/config`
endpoints, exposes both HTTP and WebSocket base URLs to recipes, captures one
log per process, runs the ordinary API-v1 matrix, then runs a dedicated cluster
recipe by matrix entry ID.

The regular one-server behavior remains unchanged. Supplying a secondary port
with PGlite is rejected because it would produce a misleading test with two
isolated databases.

The composite action receives an optional `secondary-api-port` input. Both
Postgres workflow callers pass `18081`; the optional memory job omits it.

## Black-Box Scenario

The dedicated recipe uses only HTTP, raw WebSocket, SET, ASSERT, and PARALLEL
steps:

1. Log Alice in through server A and Bob in through server B.
2. Create a scoped room, add both members, and register both session presences.
3. Create WebSocket tickets and open Alice's socket on A and Bob's socket on B.
4. Synchronously establish a baseline topology before opening the observation
   window for concurrent mutations.
5. In parallel, send two owner-authorized group mutations to different API
   servers. Capture each returned `stateRevision`.
6. On both sockets, wait for two `overlay.topology` messages for the scoped
   group. Do not require an arrival order or predict an overlay version: a
   concurrent worker may legitimately deliver N+1 before N, and an unchanged
   graph retains the version observed by that work generation.
7. Parse all four topology payloads. Assert independently on each server that
   the unordered revision pair equals the two committed `stateRevision` values,
   and assert that every payload has the scoped group reference, active state,
   integer overlay version, and both recipient sessions.
8. Close both sockets and log both users out.

The mutations change Bob's role and the group's description without changing
active sessions. Consequently, both committed revisions must publish even
though the graph is unchanged. Concurrent branches make it possible for either
API process to execute either mutation or topology work without making the test
depend on scheduling order or a precomputed overlay version.

## Observable Guarantees

Passing the scenario proves:

- two HTTP entry points operate on the same durable group state;
- concurrent mutations receive distinct causal revisions;
- each revision retains an immutable topology publication identity;
- unchanged topology still publishes once for each group revision;
- a socket local to server A and a socket local to server B both receive both
  exact-revision publications;
- N+1 may arrive before N on either socket without failing convergence;
- real PostgreSQL notification and durable publication loading bridge the
  process boundary;
- the scenario uses no browser or WebRTC provider.

## Failure Evidence

The runner writes:

- `api-v1-server.log` for server A;
- `api-v1-server-secondary.log` for server B;
- ordinary matrix artifacts at the configured artifact root;
- cluster-recipe artifacts under `cluster/`.

Readiness and child-exit diagnostics identify the process and log path that
failed. Both processes are stopped on success or failure.

## Compatibility

- Existing `--port` and one-server runner behavior remain unchanged.
- Existing API-v1 recipes and the PGlite-memory workflow remain unchanged.
- The new matrix entry is not part of the portable recipes-only profile because
  it requires two coordinated API endpoints.
- Existing HTTP, WebSocket, RTC, queue, and artifact schemas remain unchanged.
- Existing WebRTC full-stack tests remain the authority for browser and data
  channel behavior.

## Verification

Static and focused checks cover argument parsing, environment derivation,
two-server command planning, workflow wiring, matrix registration, recipe
validation, and the absence of RTC/browser connections. The decisive
integration check is:

```sh
npm run test:api-v1:black-box:postgres
```

It must start two API processes and pass both the ordinary API matrix and the
new cluster recipe. The optional memory command remains a one-server regression
check.
