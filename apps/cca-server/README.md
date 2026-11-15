# CCA practice server

An embedded Rallar API plus one ephemeral market simulation owner. It uses the
existing Rallar auth, room admission, WebSocket topic authorization and live
publication APIs. Do not run multiple owners against the same room scope.

Start the SPA in one terminal and this server in another:

```sh
npm --workspace cca-server run local
```

The launcher selects the in-memory demo profile and port 8092, generates ephemeral
secrets without writing them to disk, and configures `http://localhost:5180` as the
single browser origin. For an existing HTTPS preview, set `CCA_ORIGIN` to that
exact origin. Every client must use the configured origin. Use separate browser
profiles for two accounts on one computer; tabs share Rallar sign-in storage.
Restart resets all accounts' sessions and practice state.

For a managed environment, supply Rallar configuration and secrets through the
environment and use `npm --workspace cca-server run start`.

The SPA proxies `/api` HTTP and WebSocket traffic to port 8092. This explicit local
profile uses Rallar's demo accounts (alice and bob, password secret). Those are
public development credentials; this profile must not be exposed as a production
service. Real remote play needs HTTPS and an appropriate non-demo auth profile.

`GET /api/cca` returns this process's incarnation and server sender ID. Input
uses `room.cca-input`, a members-only, server-consumed live channel. Snapshots use
`rallar.cca-state`, a reserved server-only room topic. An input names protocol,
full room reference, incarnation, controller, sequence and normalized intent.
Neither positions nor balances are accepted from clients.

The simulation advances at 30Hz and publishes at 10Hz. Held inputs refresh at up
to 20Hz through a latest-value lane retaining one message. Input expires at 250ms;
seats expire at ten seconds and idle rooms at one minute. Capacity is two runners
per room and sixteen rooms per process. No match results are persisted. The
Rallar database owns authentication and room membership through its AppInbox;
the in-memory simulation does not perform database writes.

A new controller for an existing session is accepted only after one second
without input from its old controller. Older sequences and wrong process
incarnations cannot change the simulation. The first slice has no seamless
process failover, durable results or spectator mode.

Run the focused public HTTP contract against this server:

```sh
bun packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/tests/cca/connection-metadata.json --artifact-dir=tmp/cca-black-box
```
