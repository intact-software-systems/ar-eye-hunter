# CRDT Mutation And Administration Ownership Refactor Design

## Purpose

This design defines the next two concrete slices of the human traceability refactoring program:

1. establish one visible shared-server owner for CRDT realtime ingress, AppInbox mutation
   orchestration, mutation decisions, and persistence;
2. align API-v1 CRDT administration and the remaining repository consumers with that owner.

The work is a behavior-preserving ownership refactor by default. Two affected defects are already
confirmed and receive failing semantic tests and fixes: default audit delivery registers without a
sink, and final CRDT outbox writes accept an identical pre-existing row instead of rolling the
mutation back on every collision. Other actual bugs discovered while recovering or moving an
affected path receive the same treatment. Other confirmed code or performance weaknesses are
checked against open issues and receive a focused issue when no accurate owner already exists.

The design applies to current `main` at
`22bb4919c92f96d785ff65d7f308a6d2fd3318e7`. Historical CRDT plans remain evidence for the
contracts they introduced, but current source, current tests, and current repository standards
govern this refactor.

## Current evidence

The server-side CRDT feature is currently spread across four ownership areas:

- `packages/shared-server/crdt/` owns the public CRDT realtime capability module and the in-memory
  log repository;
- `packages/shared-server/rallar-system/services/` owns the AppInbox service, authenticated append,
  mutation contracts, codecs, compute, validation, results, and outbox construction;
- `packages/shared-server/postgres/crdt/` owns the PostgreSQL log and mutation repositories plus the
  persisted-row codec;
- `apps/api-v1/src/routes/` and `apps/api-v1/src/services/` own CRDT HTTP administration,
  authorization, mutation composition, and WebSocket mutation ingress.

The runtime mutation path is coherent in behavior but difficult to locate from the tree:

1. an accepted WebSocket envelope is translated into a durable CRDT command;
2. `AppCrdtInboxService` enqueues the command and later decodes it in an AppInbox attempt;
3. the mutation service reads the current database facts, computes an immutable mutation, validates
   it, and writes it through a transaction-bound repository;
4. the repository compare-and-sets document revision and lifecycle facts, writes update or snapshot
   state, and writes final WS or APP outbox rows in the same transaction;
5. an optimistic conflict causes the complete AppInbox read/compute/validate/write attempt to retry;
6. append replies and fanout are delivered through durable WS outbox work, while erase audit work is
   delivered through durable APP outbox work.

Mutating API administration uses the same AppInbox path for projection rebuild, compact, lifecycle,
and erase. Catch-up, listing, integrity inspection, debug export, and backup export are reads and
remain direct repository operations.

The current source has concrete traceability problems:

- a developer following an append must cross generic `services`, root `crdt`, PostgreSQL `crdt`, and
  API service directories before the complete decision and transaction become visible;
- `AppCrdtInboxService` owns command routing, authenticated append, audit delivery registration,
  mutation execution, admin request translation, and wake-up effects;
- the mutation decision is split among many `crdt-mutation-*` files in a generic services directory,
  so filenames identify mechanism but the directory does not identify the owning feature;
- public-capability files use PascalCase paths while new repository standards use capability-named
  kebab-case paths;
- test files carry task and correction history in their names instead of naming the behavior they
  protect;
- touched-file style evidence identifies decision density, long positional signatures, propagated
  `unknown`, line-width debt, and runtime-export pressure in the current owners;
- `PSqlCrdtLogRepository` still implements mutation methods only to reject them at runtime, while the
  supported mutation owner is the transaction-bound AppInbox repository.

## Selected approach

Consolidate server-side CRDT ownership under `packages/shared-server/rallar-system/crdt/`. Keep four
meaningful internal boundaries: realtime, inbox, mutation, and persistence. Keep HTTP routing,
API-session authorization, environment selection, and API runtime composition in
`apps/api-v1/src/crdt/`.

This is preferred over two alternatives:

- Leaving the current directories in place and adding navigation documentation would describe the
  indirection without removing it.
- Moving every existing file unchanged would improve path locality but preserve mixed owners,
  construction mutation, dense interfaces, and task-history tests.

The refactor therefore moves behavior and recovers ownership together. A separate module stays only
when it owns a real protocol, lifecycle, decision, translation, transaction, persistence, or
side-effect boundary. Files that only rename or forward another capability are consolidated.

## Compatibility decision

Existing package-root exports remain stable:

- `installRallarCrdtWsTopics` and `validateRallarCrdtServerLiveEnvelope`;
- the `RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES` and
  `RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES` constants;
- every type currently exported by `packages/shared-server/crdt/RallarCrdtServer.ts`;
- `InMemoryRallarCrdtLogRepository` and its current options type;
- `PSqlCrdtLogRepository` and its current options type;
- their existing runtime behavior.

`packages/shared-server/mod.ts` changes its internal export paths to the canonical owners. Known
repository consumers migrate from the old deep paths. The old
`packages/shared-server/crdt/`, `packages/shared-server/postgres/crdt/`, and
`packages/shared-server/rallar-system/services/crdt-*` paths are removed after migration; the design
does not retain deep-path re-export shims, deprecated duplicates, or dual implementations.

Repository searches currently show no package-level contract for those deep paths. Discovery of a
verified external consumer that cannot use the package root is a new public compatibility decision
and stops implementation for maintainer direction.

This decision does not authorize changes to REST paths, HTTP response shapes, OpenAPI contracts,
WebSocket topic or payload contracts, AppInbox message types, queue keys, persisted schemas, CRDT
document keys, mutation command or result versions, retry policy, authorization policy, document
policy defaults, or shared CRDT algorithm semantics.

## Target ownership

The target shape is:

```text
packages/shared-server/rallar-system/crdt/
  README.md
  realtime/
    rallar-crdt-server-contracts.ts
    install-rallar-crdt-ws-topics.ts
    validate-rallar-crdt-server-live-envelope.ts
    validate-rallar-crdt-catch-up-envelope.ts
  inbox/
    app-crdt-inbox-service.ts
    create-authenticated-crdt-append.ts
    create-crdt-ws-mutation-ingress.ts
    register-crdt-audit-delivery.ts
  mutation/
    crdt-mutation-contracts.ts
    crdt-mutation-command-codec.ts
    decode-crdt-mutation-result.ts
    crdt-mutation-value-codec.ts
    crdt-mutation-result-detail-codec.ts
    compute-crdt-mutation.ts
    validate-crdt-mutation.ts
    create-crdt-mutation-service.ts
    create-crdt-mutation-outbox.ts
  persistence/
    in-memory-crdt-document-store.ts
    compute-in-memory-crdt-append.ts
    in-memory-crdt-append.ts
    in-memory-crdt-administration.ts
    in-memory-crdt-log-repository.ts
    psql-crdt-log-repository.ts
    psql-crdt-mutation-repository.ts
    crdt-mutation-row-codec.ts

apps/api-v1/src/crdt/
  create-api-crdt-document-authorizer.ts
  create-api-crdt-inbox-service.ts
  create-api-crdt-inbox-factory.ts
  create-crdt-admin-mutations.ts
  register-crdt-admin-routes.ts
```

This is a responsibility map, not an instruction to preserve every listed file. During
implementation, small codecs or builders that have the same callers, vocabulary, and reason to
change are consolidated. A proposed support file that only reduces line count is not part of the
target design. Conversely, a codec that enforces a persisted or wire boundary remains explicit even
when it is small.

No nested barrel is added. Callers import the direct capability owner, while
`packages/shared-server/mod.ts` remains the package-root public surface.

### Realtime

The realtime owner installs CRDT WebSocket topics, validates the transport envelope, authorizes the
document scope, serves catch-up reads, and passes accepted mutations to a required durable ingress.
It owns no database mutation and no AppInbox retry.

The current `RallarCrdtServer.ts` is a public capability module, not a class. Its installer,
validator, constants, and type names keep their current package-root identities and observable
behavior while their implementations move to capability-named kebab-case owners. The current
WebSocket-to-AppInbox ingress adapter depends only on shared-server contracts and moves to the
inbox boundary. API-specific session construction and authorization stay in
`apps/api-v1/src/crdt/`.

The public validator's existing five positional arguments are preserved as an approved thin
compatibility adapter over a named-input pure validator. Its final path and symbol receive a focused
production-legacy registry entry with the package-root dependency, direct semantic tests, and a
separately approved public API migration as the removal condition. Internal realtime functions do
not copy that signature.

The construction contract requires the durable ingress before topic installation. There is no
setter, late binding, optional production default, or callback that becomes valid after
construction.

### Inbox

The inbox owner controls the durable command lifecycle:

- create or accept a canonical mutation command;
- enqueue it with the existing type, topic, resource, context, sender, and expiry identities;
- route each mutation type to one mutation service;
- expose waiting and no-waiting operations required by HTTP and WebSocket adapters;
- wake the queue engine after the same accepted operations as today;
- register optional post-commit audit delivery only when an audit sink is supplied at construction.

The inbox service does not compute mutation results and does not own SQL statements. Authenticated
append becomes a direct inbox capability rather than a separate pass-through helper family.

Administration-specific request decoding, API session translation, public result projection, and
HTTP error mapping leave the inbox service. The shared inbox accepts a canonical mutation actor and
command and therefore no longer imports API `AuthSession` or constructs an API response.

`setAuditSink` is removed. All optional effects are immutable construction inputs, and the service
is fully usable when its constructor returns.

### Mutation

The mutation owner is the functional core and transaction shell for one CRDT mutation attempt:

```text
decode command
  -> read immutable database facts
  -> compute immutable mutation
  -> validate command/facts/mutation relationships
  -> write through a transaction-bound repository
  -> return the canonical durable result
```

The compute function has no database, clock, queue, network, or process-global dependency. Its
input contains the decoded command and complete immutable read facts. Its output contains the
expected revision and lifecycle, records to write, final outbox entries, receipt, and canonical
result.

Validation remains a separate fail-closed boundary because it authenticates relationships between
command, read facts, mutation result, receipt, and outbox effects before persistence. It returns
all typed issues and never throws. The inbox boundary converts a non-empty issue list into the same
observable `TypeError` used by the current implementation before opening the write transaction. It
does not recompute business decisions or normalize an invalid shape.

The stateful mutation service owns one attempt: read, compute, validate, and invoke the writer in an
AppInbox transaction. It performs no service-local conflict retry. `CrdtMutationConflictError`
continues to escape so AppInbox reruns the complete attempt against fresh facts.

Contracts retain one canonical type name each. Command, result, operation, snapshot, update, and
audit codecs may share low-level exact-object helpers, but they do not alias or rename canonical
types. Helpers with more than three inputs use a named input object.

### Persistence

The persistence boundary owns the two supported storage roles:

- log and administration reads, implemented for memory and PostgreSQL;
- transaction-bound CRDT mutation reads and writes, implemented for PostgreSQL.

The PostgreSQL mutation repository continues to receive either the root SQL capability for the
pre-transaction read or the transaction SQL capability for the guarded write. It never begins,
commits, rolls back, or retries a transaction itself.

The write order remains:

1. compare-and-set document revision, lifecycle, and append-sequence facts;
2. write updates, snapshots, projection state, or erasure state;
3. write final ResourceInbox WS outbox or APP outbox rows;
4. return to AppInbox so its durable result and completion can commit in the same transaction.

A zero-row compare-and-set is the optimistic conflict. Update-ID uniqueness remains the immutable
replay and collision check. No row lock, advisory lock, hidden retry, or post-commit database write
is introduced.

The current CRDT mutation writer calls `writeIfAbsentOrMatch` for final outbox entries. That permits
an identical pre-existing row to survive as a successful mutation effect, contrary to the current
insert-only final-outbox contract. Slice 1 adds a transaction-level RED test with an identical
collision, switches the CRDT writer to the insert-only repository operation, and proves the
document/update/result/outbox attempt rolls back. It does not change the shared repository method
or unrelated callers.

`PSqlCrdtLogRepository` retains read and administration capabilities required by current consumers.
Its unsupported direct mutation methods remain fail-closed only while the public shared CRDT
repository contract requires them. The tiny rejection owner is consolidated if doing so makes that
compatibility boundary more visible. Removing the methods or narrowing the shared public interface
is a separate compatibility decision and is not part of this refactor.

The approved retained boundary is recorded against the final `PSqlCrdtLogRepository` owner in the
focused production-legacy registry. One class-symbol entry covers the fail-closed direct methods;
one checker-owned `unclassified-symbol` entry covers the open public options index signature. Both
name the package-root dependency and compatibility tests and define removal as a separately
approved public-interface migration. The in-memory repository is the canonical supported
implementation, not a legacy wrapper.

### API-v1 CRDT

API-v1 owns transport and application composition only:

- parse HTTP bodies and map canonical results or failures to the existing HTTP responses;
- require API user or administrator sessions;
- translate sessions into the canonical CRDT mutation actor and document authorization inputs;
- construct PostgreSQL repositories and the shared inbox owner from explicit runtime dependencies;
- install CRDT REST and WebSocket adapters.

Mutating admin routes require the inbox mutation capability. They never fall back to direct
repository mutation. Read-only routes continue to use the log repository directly.

The current unused `audit` option on the admin route is removed. External audit delivery belongs to
CRDT runtime construction, not an HTTP route contract.

## Runtime sequences

### WebSocket append

```text
CRDT WS topic
  -> validate envelope and current session/document authority
  -> create canonical append command
  -> enqueue CRDT AppInbox entry
  -> return transport acceptance

CRDT AppInbox attempt
  -> decode command and revalidate current authority
  -> read mutation facts
  -> compute and validate append
  -> guarded transaction-bound write
  -> commit update + receipt + reply/fanout WS outbox + AppInbox completion
```

The transport handler never publishes a live-only success or fanout. Reconnect delivery identity,
principal and room audience behavior, trusted capture time, and retry expiry remain unchanged.

### Mutating HTTP administration

```text
CRDT admin route
  -> require administrator session
  -> parse and validate operation request
  -> create canonical admin mutation command
  -> process through CRDT AppInbox until completion
  -> map canonical result or failure to the existing HTTP response
```

Projection rebuild, compact, lifecycle, and erase use this sequence. Their command, result,
authorization, conflict, and durable completion behavior does not diverge from WebSocket append.

### Read-only HTTP and catch-up

```text
HTTP or WS read request
  -> require current session and document authority where applicable
  -> call CRDT log repository
  -> return existing snapshot/page/integrity/export contract
```

No command, AppInbox entry, or transaction is introduced for a read-only operation.

### Erasure audit

The written mutation contract permits either a durable audit record or an immutable APP outbox
audit command in the mutation transaction. The current implementation uses the latter and retains
it.

The recovered default production composition currently passes no audit sink but still registers an
audit outbox handler. Accepted erase therefore commits correctly and returns its result, after which
audit delivery repeatedly fails with `CRDT audit sink is unavailable`. This is an actual bug, not an
ownership preference.

The implementation adds a failing regression test, removes `setAuditSink`, and makes audit delivery
registration conditional on an explicit immutable sink supplied during construction. With no
external sink, the durable APP outbox command remains the authoritative audit record and no invalid
handler is registered. With a sink, the handler decodes the exact audit event and retries external
delivery after commit through the existing outbox lifecycle. The sink is never invoked from the
mutation transaction.

## Two implementation slices

### Slice 1: core mutation ownership

Slice 1 establishes the canonical shared-server CRDT feature boundary and moves the complete core
write path:

- characterize current append, compact, lifecycle, erase, projection rebuild, conflict, replay,
  authorization, receipt, and outbox behavior before production movement;
- create `rallar-system/crdt` navigation and the realtime, inbox, mutation, and persistence owners;
- move and remediate the mutation contracts, codecs, computation, validation, service, outbox,
  in-memory repository, PostgreSQL repositories, and realtime server;
- preserve package-root exports while migrating all known shared-server and test imports;
- replace positional helpers, propagated `unknown`, mixed responsibility, and task-history tests in
  every touched file;
- fix the missing-audit-sink registration bug with semantic regression coverage;
- fix final-outbox collision matching so every collision rolls the transaction back;
- remove vacated old files and directories after exact consumer searches.

The slice is complete only when a developer can start at the package-root CRDT export or the CRDT
README and reach protocol ingress, one mutation attempt, guarded persistence, and durable effects
without searching a generic services directory.

### Slice 2: administration and consumer alignment

Slice 2 moves the application boundary and closes the remaining navigation:

- move API-v1 CRDT routes, authorization, and inbox construction into `apps/api-v1/src/crdt`, and
  replace the app-local WebSocket ingress adapter with the shared inbox capability;
- make construction inputs explicit and remove route-level audit plumbing and any late binding;
- preserve all REST, OpenAPI, WebSocket, policy, and error behavior;
- rename API and integration tests by the invariant or behavior they protect;
- migrate remaining app, package, example, test, and documentation consumers;
- update active CRDT navigation and source maps;
- run a cold code-only trace from package root and API server construction without using this design
  as a map;
- remove every vacated compatibility path that has no approved consumer.

The slice is complete only when a developer can find every mutating admin operation from its route,
see the AppInbox boundary directly, and reach the same canonical mutation and persistence owners as
WebSocket append.

The two slices are delivered as two stacked pull requests. A pull request boundary represents an
independently reviewable ownership result, not an arbitrary file count. Slice 2 does not merge
before Slice 1.

## Behavior-preservation contract

Both slices preserve:

- package-root export names and runtime identities;
- CRDT protocol version, WebSocket topics, message type IDs, request and delivery identities, and
  binary or JSON envelope rules;
- REST paths, authentication and authorization outcomes, response status codes, and JSON shapes;
- AppInbox types, topic IDs, queue keys, sender and context identities, retry expiry, durable result
  shape, and completion timing;
- command, persisted row, snapshot, result, receipt, debug bundle, and audit event formats;
- document-key derivation and room/application/workspace scope;
- document policy selection, lifecycle rules, quotas, compact behavior, projection rebuild behavior,
  erasure modes, and append rejection taxonomy;
- optimistic compare-and-set facts, update-ID replay and collision behavior, transaction boundaries,
  and full-attempt retry;
- reply and fanout audiences, outbox identifiers, post-commit delivery, and queue-engine wake timing;
- catch-up paging, snapshot inclusion, integrity, backup, and debug export semantics;
- shared CRDT merge, ordering, causal, graph, numeric, spatial, and local persistence algorithms.

Executable ordering is part of compatibility where a dependency, clock, metric, queue attempt, or
public override can throw or be observed. Characterization tests must cover those boundaries before
moving them.

## Touched-file closure and legacy handling

Every changed human-authored file is reviewed in full and remediated to current standards. A support
file changed by that remediation enters the same closure recursively. Independent untouched debt
stays outside the slice.

Closure includes:

- one canonical type name, direct type qualification, and no rename-only aliases;
- named input objects for more than three parameters;
- no construction-time setter, module-global runtime, hidden default, double assertion, or optional
  production dependency that fails later;
- no pass-through owner, one-use wrapper, mechanical split, or test-only production export;
- behavior-named tests with direct semantic assertions rather than source-text, exact-tree, or
  historical task inventories;
- removal of affected unused helpers, legacy paths, and compatibility vocabulary when no verified
  consumer requires them;
- explicit maintainer approval before retaining any affected public, persisted, protocol, or
  migration compatibility boundary.

The runtime-rejecting direct PostgreSQL mutation surface is treated as a compatibility boundary,
not silently deleted. Any other old-path or old-shape consumer found during closure is classified
from executable evidence. A test that merely imports an old path does not establish a production
requirement.

## Validation strategy

Validation is proportional to the affected surface and runs from focused to broad.

### Direct semantic tests

Direct shared-server tests cover:

- exact command and result decoding, including rejection of extra and legacy shapes;
- immutable read/compute/validate/write relationships for all five mutation operations;
- append authorization, trusted time, expiry, reply/fanout audience, and reconnect identity;
- optimistic conflict and complete-attempt revalidation;
- update replay versus collision, quota, lifecycle, compact, rebuild, erase, and integrity behavior;
- transaction atomicity and rollback of document state, mutation records, results, receipts, and
  final outbox entries;
- post-commit audit delivery with a sink, and safe durable audit retention without one;
- catch-up, snapshot, paging, duplicate, encryption, retention, and in-memory/PostgreSQL parity.

Direct API tests cover mutating-versus-read routing, authentication and authorization, request and
response compatibility, missing mutation construction, and the absence of direct mutation fallback.

### Package and application checks

Each slice runs the focused CRDT Vitest and Deno suites selected from the changed modules, followed
by:

```text
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
```

The API black-box commands run when their documented service prerequisites are available. A skipped
external-service check is reported explicitly and is not represented as a pass.

The existing API-v1 state-write benchmark does not execute CRDT mutations and is not presented as
CRDT performance evidence. The refactor preserves query and mutation counts through semantic tests
and reviews hot-path allocation, scan, and retention behavior statically. If implementation changes
an algorithm or query plan, or finds a credible performance weakness, it activates the performance
analysis workflow and adds or selects a representative CRDT workload before making a performance
claim. Generated profiles remain outside the tracked change.

Static review already confirmed that `PSqlCrdtMutationRepository.readMutation` selects and decodes
the document's complete update history for every append even though `computeAppend` does not consume
`CrdtMutationRead.records`. The unnecessary full-history read and decode are proven code facts; their
runtime cost has not been measured. Issue
[#265](https://github.com/intact-software-systems/ar-eye-hunter/issues/265) owns the measurement and
operation-specific read-set follow-up. This ownership refactor preserves the existing query boundary
and does not claim to optimize it.

### Repository closure

Both slices run changed-file Prettier, width, style, construction-detail, structure, legacy, and
`git diff --check` evidence. The final slice also runs package-root public import probes, a current
consumer search for removed paths, the relevant repository-governance tests when navigation or
checker contracts change, and a cold code-only ownership trace.

## Bugs and weaknesses discovered during implementation

The missing-audit-sink registration and final-outbox collision defects are already classified as
in-scope bugs and do not need follow-up issues. Their regression tests and fixes belong to Slice 1.

For each additional unexpected behavior:

1. reproduce it with the narrowest semantic test;
2. compare it with current written contracts and current `main` behavior;
3. fix it in the active slice when it is a real affected bug;
4. preserve it and escalate only when a fix would require a new public or migration decision.

For each confirmed weakness that is not a behavior bug and cannot be closed without expanding the
active slice, search open issues first. Reuse an accurate issue or create a focused issue describing
the owner, evidence, risk, and removal condition. Do not leave a confirmed code or performance
weakness only in a report or pull-request comment.

## Non-goals

This refactor does not:

- redesign shared CRDT algorithms, wire protocols, persisted schemas, or document policy;
- add a new audit database or require an external audit service;
- change CRDT rollout defaults or enable document types currently disabled;
- optimize the mutation algorithm without representative measurement;
- close issue #265 or claim a CRDT append performance improvement without representative
  before/after evidence;
- refactor unrelated QueueBox, AppInbox, authentication, or PostgreSQL infrastructure;
- perform the following mutating-admin ownership initiative from the human traceability program;
- retain historical task structure as permanent production or test architecture.

## Acceptance criteria

The design is implemented when:

- one canonical `rallar-system/crdt` feature boundary owns realtime, inbox, mutation, and persistence
  behavior;
- API-v1 owns only CRDT transport, API authorization, route mapping, and explicit composition;
- the complete WebSocket and admin mutation paths are visible without crossing generic service
  directories;
- read-only operations remain direct and every mutating operation uses the same AppInbox owner;
- the immutable read/compute/validate/write transaction and complete-attempt retry remain exact;
- package-root exports, protocols, persisted formats, queue identities, HTTP contracts, and
  observable ordering remain compatible;
- audit APP outbox work remains durable, external delivery is construction-explicit, and default
  production no longer registers a handler that can only fail;
- every CRDT final outbox write is insert-only and any collision rolls the whole mutation back;
- known consumers use canonical paths and vacated legacy paths are removed unless separately
  approved;
- touched-file standards closure, focused and broad correctness checks, performance evidence, and a
  cold navigation trace pass;
- every actual bug is regression-fixed and every unresolved confirmed weakness has an accurate
  issue owner.
