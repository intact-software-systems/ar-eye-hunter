# Deno and Bun for the server apps

Static comparison. No runtime was switched, and no Deno-versus-Bun measurement of api-v1, the relic server, or the black-box control server was run. Counts are from the working tree on 18 October 2026.

The browser apps and `apps/rallar-black-box-headless` are out of scope. They already run on Node.

## Judgment

Keep Deno for `apps/api-v1`, `apps/relic-hunter-server-v1`, and `apps/rallar-black-box-control-server`.

On the current host that is because production is three Deno Deploy apps. With a replacement host, and with the SPAs still excluded, Deno remains the closer fit: the permission sandbox, the standard `WebSocket`, and one module graph for run, test, and typecheck are already how these processes work. Bun's advantages are install speed, process-restart speed, and an ordinary npm lifecycle for the Prisma CLI.

The [bun.com](https://bun.com) Postgres and WebSocket charts are real, and they do not describe these servers. The Postgres gap is `Bun.sql` against `postgres.js`. The large WebSocket gap is native topic publish against a JavaScript `send` loop. A runtime swap that keeps `postgres.js` and `JsonWebSocketServer` does not collect either headline number.

## What Deno owns

`packages/shared-server` has no `Deno` calls. Its Node surface is `node:crypto` `createHash` and `node:util` `types`. Authoritative behavior — Postgres, AppInbox, rooms, CRDT — is already runtime-neutral.

Deno owns the process edge. Of 193 TypeScript files under the three apps' `src/` trees, 15 call `Deno`:

| Edge                    | Files                                                                                                                    | Surface                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Process boot            | `apps/api-v1/src/main.ts`, `apps/relic-hunter-server-v1/src/main.ts`, `apps/rallar-black-box-control-server/src/main.ts` | `Deno.env`, `Deno.readTextFile`, `Deno.serve`, and on the control server `Deno.addSignalListener` and `Deno.exit` |
| Room WebSocket          | `apps/api-v1/src/routes/ws-routes.ts`, `apps/api-v1/src/composition/create-api-v1-route-installers.ts`                   | `Deno.upgradeWebSocket` returns `{ socket, response }` after the connect transaction commits                      |
| Control WebSocket       | `apps/rallar-black-box-control-server/src/routes/control-socket-route.ts`                                                | `Deno.upgradeWebSocket` inside the request, then `onmessage` / `onclose`                                          |
| Local files             | Control snapshot, run completion, artifact recorder, `apps/api-v1/src/db/pglite-black-box-evidence-snapshot.ts`          | Temp file, `Deno.rename`, `Deno.pid`, `Deno.errors.NotFound`, mode `0700`                                         |
| Aborted mutation body   | `apps/api-v1/src/group-state/read-group-state-route-request.ts`                                                          | `Deno.errors.BadResource`, `Http`, `ConnectionReset`, `UnexpectedEof`, `Interrupted` become a typed 400           |
| OpenAPI and schema text | Both swagger route modules, `apps/api-v1/src/db/in-memory-schema-bootstrap.ts`                                           | `Deno.readTextFile`                                                                                               |

The room path passes that socket into `packages/shared/websocket/json-web-socket-server.ts`. `ConnectionContext` requires a platform `WebSocket`. The server subscribes with `addEventListener` for `open`, `message`, `error`, and `close`. `broadcast` filters each connection and calls `socket.send`. It does not read `bufferedAmount`.

Around that edge:

- 951 `Deno.test` calls in 192 files under the three apps, plus the release-gate `deno` lane.
- 68 direct `jsr:@hono/hono@4.11.9` import sites. Each app has its own `deno.lock`. Import maps in the app `deno.json` files alias `@shared/` and `@shared-server/`.
- npm is already in use: `postgres` `^3.4.9`, the Prisma migration CLI, PGlite, and `graphology`, through `npm:` specifiers. There is no `PrismaClient` on the request path.
- Start permissions, from the app `deno.json` tasks: api-v1 and relic allow network, environment, and read. The control server adds write. None of the three start tasks grant `--allow-run`. The api-v1 Prisma task is the exception: `deno run -A` with an `allow-scripts` pin for `prisma` and `@prisma/engines`.

## Current host

Production is `deno deploy` of `rallar-server`, `rallar-bb-server`, and `relic-hunters`. `.github/workflows/deploy.yml` pins the CLI at Deno 2.9.5. The upload uses the root `deno.json` so `packages/**` is included. Bun cannot deploy onto those apps.

Deno Deploy runs a full Deno process and starts it with all permissions allowed, so the `--allow-*` flags are a local and CI boundary there. Instances idle, stay isolated from each other, and get scratch disk. Live sockets and queue workers are process-local; the API already labels those facts that way and keeps authority in Postgres. The control server's snapshot and artifact files assume a directory that outlives one request.

That host friction is real. It is a hosting question. The rest of this note assumes a replacement host and ignores the SPAs.

## Advantages once the host is replaceable

### Deno

The start tasks already describe a sandbox a self-hosted process can enforce. api-v1 and the relic server can be refused write and subprocess spawn. The control server can be refused subprocess spawn. Bun has no equivalent.

`Deno.upgradeWebSocket` returns the standard `WebSocket` that `JsonWebSocketServer` already consumes, and it returns a `Response` the Hono handler can return after the connect commit. Bun's `server.upgrade(request)` returns no `Response`. Handlers are registered once on `Bun.serve`, and the socket is `ServerWebSocket`, which is not an `EventTarget` with `addEventListener`.

`deno run`, `deno test`, and `deno check` share the import maps, the `jsr:` pins, and the `npm:` specifiers. The 951 `Deno.test` calls run under explicit permissions, so an undeclared network, disk, or subprocess use fails the test.

The aborted-body classifier matches the HTTP stack that raised the error. Those five `Deno.errors` classes do not exist on Bun. The typed 400 needs a new classifier there.

### Bun

Prisma is only the migration CLI. Bun runs it as a normal package script, without `deno run -A` and the `allow-scripts` pin.

One Node-compatible resolver would absorb the 68 `jsr:` Hono imports and the npm packages into `node_modules`. JSR on Bun goes through the `@jsr` npm scope (`bunx jsr add`), not through a `jsr:` specifier.

Install and process restart are faster. That shows up in dependency install, test cold start, and watch mode. A resident process backed by Postgres spends its time on queries and application fanout. This repo has not compared the two runtimes on that path.

`ServerWebSocket` can report backpressure and expose a drain callback. The current sender does not use backpressure on either runtime. `publish` / `publishText` is a different fanout, covered below.

### Tie

Hono's `fetch` handler fits `Deno.serve` and `Bun.serve`. `postgres.js` and PGlite run on both. The control server's temp-file-and-rename snapshots map onto `node:fs`. Signals map onto `process.on`. Neither runtime makes the single JavaScript thread concurrent. The in-memory profile's cost, where it has been observed, sits in embedded PGlite on that thread; production uses Postgres.

## What bun.com measured

Figures below are from [bun.com](https://bun.com) on 18 October 2026: Bun 1.4, Deno 2.9.5, Node.js 26.7.0, Linux x64 on an EPYC 9R14, medians of 3. The same Deno version is the one this repo's deploy CLI pins. Sources: `oven-sh/bun` `bench/postgres/index.mjs` and `bench/websocket-server/`.

### Postgres

The page reports Bun at 20,243 queries/sec (80 MB) and Deno at 10,406 (181 MB). Node.js is at 10,000 (168 MB). The caption names the clients: `Bun.sql` versus `postgres.js` 3.4.9.

The script uses `Bun.sql` when that binding exists and `postgres()` otherwise. The body is 100,000 copies of `SELECT * FROM users_bun_bench LIMIT 100`, 100 queries in flight, against localhost PostgreSQL 18.3. There is no transaction and no write.

Deno and Node, on the same library, are within about 4%. The twofold gap is the built-in client. These servers pin `npm:postgres@^3.4.9`, the library on the Deno bar. `PSqlSql` in `packages/shared-server/postgres/p-sql-sql.ts` is that driver's tagged template plus `begin()`. A Bun process that kept `postgres.js` belongs near the Node bar. Collecting 20,243 means replacing the driver, then measuring transactional compare-and-set writes. Those writes are not in the chart.

### WebSockets

32 clients broadcast. Each client must receive the round before the next one starts. Compression is off.

| Bar                   | Messages/sec | Peak RAM | Fanout                                                                   |
| --------------------- | -----------: | -------: | ------------------------------------------------------------------------ |
| Bun 1.4 `publishText` |    4,170,027 |    51 MB | Every socket subscribes to `"room"`; one native publish copies the frame |
| Bun 1.4 `send`        |      159,379 |    37 MB | A send per socket, as a separate homepage row                            |
| Deno 2.9.5            |      124,088 |   1.2 GB | JavaScript loop calling `client.send`                                    |
| Node.js 26.7.0 `ws`   |      123,486 |    78 MB | The `ws` package, same loop shape                                        |

The file on `oven-sh/bun` main, `bench/websocket-server/chat-server.bun.js`, implements the publish row: `ws.subscribe("room")` and `ws.publishText("room", out)`, with `perMessageDeflate: false`. uWebSockets fans that out in native code. The Deno file loops `client.send`.

`JsonWebSocketServer.broadcast` is the send loop, with a per-connection filter. `publishText` delivers the same bytes to every subscriber of a topic and cannot apply that filter. The comparable published row is 159,379 against Deno's 124,088, about 1.3×. The 4.17 million row is a different delivery mechanism.

The 1.2 GB Deno peak is their measurement of that 32-client program. It is large enough to reproduce on the room fanout before treating it as a property of these servers. It has not been measured here.

A single-connection ping-pong published on 10 October 2026 (Daniel Lemire, C client, one core for the server) had `Deno.serve` 2.9.7 at 40,000 round trips/sec and `Bun.serve` 1.4.2 at 37,000. Node.js 26 with uWebSockets.js led at 49,000. With the `ws` package on all three, the order was Node, then Bun, then Deno. Fanout throughput and one-socket latency are different tests. Both published results can stand.

## If the runtime changed anyway

The production shell is 15 files. The surrounding system is the cost:

- 68 `jsr:` Hono import sites to move onto the `@jsr` npm scope or the npm `hono` package.
- 951 `Deno.test` calls. `bun:test` does not run `Deno.test`.
- The release-gate `deno` lane, `deno check`, and `deno lint` for these apps.
- The room upgrade, which today returns a `Response` only after a committed connect, and the control upgrade, which does the same inside the request.
- The aborted-body classifier.
- Local snapshot and artifact code, which ports onto `node:fs` once a durable directory exists.

A server-only Bun port leaves Vitest and the rest of the Node tooling in place. Ignoring the SPAs does not remove that second runtime from the repository. It only removes it from this decision.

Collecting the homepage Postgres number is a `PSqlSql` driver change, measured on the real transaction mix. Collecting the 4.17 million WebSocket number is a fanout change that drops the per-connection filter, or applies that filter before a native publish of bytes that are already authorized. Neither falls out of `bun run`.

## Sources

- App `deno.json` start tasks and import maps: `apps/api-v1/deno.json`, `apps/relic-hunter-server-v1/deno.json`, `apps/rallar-black-box-control-server/deno.json`.
- Deploy pin and app names: `docs/production-deployment.md`, `.github/workflows/deploy.yml`.
- Deno Deploy permissions and instance lifecycle: [Deno Deploy runtime](https://docs.deno.com/deploy/reference/runtime/).
- Homepage numbers and captions: [bun.com](https://bun.com), read 18 October 2026.
- Benchmark programs: [bench/postgres/index.mjs](https://github.com/oven-sh/bun/blob/main/bench/postgres/index.mjs), [chat-server.bun.js](https://github.com/oven-sh/bun/blob/main/bench/websocket-server/chat-server.bun.js), [chat-server.deno.mjs](https://github.com/oven-sh/bun/blob/main/bench/websocket-server/chat-server.deno.mjs).
- Single-connection ping-pong: [Daniel Lemire, 10 October 2026](https://lemire.me/blog/2026/10/10/websocket-servers-in-javascript-node-js-bun-and-deno-in-2026/).
