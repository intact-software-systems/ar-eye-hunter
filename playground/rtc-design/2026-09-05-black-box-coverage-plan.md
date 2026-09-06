# API-v1 Black-Box Coverage — Implementation Plan (2026-09-05)

Status: **planned, not started.** Written after the group-activation workstream merged (slices 0–14,
PRs #483–#493), when the corpus could be audited as a finished whole rather than slice by slice.

Implements nothing new in the server. Every slice below is **recipe authoring plus matrix
registration** — see D1, which is the finding that shapes the whole plan.

## What this plans

Sixty verified gaps in the api-v1 black-box recipe corpus
(`packages/shared-test/black-box-runner/tests/api-v1/`, registered in `recipe-matrix.json`). Each is
a named scenario a recipe could execute today against the real server, and each was checked to be
absent rather than assumed absent.

## Evidence basis

Six independent audit lenses swept the corpus against the server surface — route coverage,
concurrency, the policy denial matrix, failure and recovery paths, multi-server behaviour, and
WebSocket assertions. **Seventy-two** candidate gaps were proposed; each was then handed to a
separate adversarial pass instructed to refute it, with instructions to default to refuted when
uncertain and to accept only gaps that are real, specific and executable. **Twelve were refuted**
(covered by an existing recipe, adequately covered by a unit test, not expressible against the real
server, or too vague to execute). **Sixty survived**, 41 marked high severity.

The refutation pass also _corrected_ many survivors rather than merely accepting them — for example
the ownership-transfer gap was accepted but its claimed 404/409 was corrected to the `400
group-mutation-rejected` the compute actually throws, and its claimed demotion-to-member was
corrected to demotion-to-admin. Those corrections are the reason the slice descriptions below name
specific status codes: they came from reading the compute, not from reading the OpenAPI entry.

Two findings are worth stating separately because they frame everything else:

- **No recipe runs any `/lifecycle/{command}` call inside a `parallel` block, and none races group
  creation.** All eight application-facing commands are only ever issued sequentially. Parallel
  _join_ is well covered (the formation-burst tiers, via the `burst-client-flow` fragment); parallel
  creation and parallel lifecycle commands are not covered at all.
- **The corpus counts WebSocket frames without reading them.** `overlay.topology` frames are matched
  155 times and their contents are asserted zero times; no recipe waits for a `group-state.event`
  carrying a named `eventType`.

## Implementation decisions

| ID | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 | **Runner work IS required first — this decision is superseded.** The original reading, that `ws.wait` already matches on payload/route/targets/id and captures for a later `assert`, is true as far as it goes. A framework audit then found three needs genuinely absent: no `expect.count` on a wait, no negative expectation on `ws.open` (which is _why_ the WS upgrade paths sit under Not in this plan), and `expect` on a `parallel` step is silently ignored. `poll-until` is also HTTP-only, and no comparison mode checks array order. The sequenced prerequisite list, with costs and the evidence behind each, is **Framework prerequisites** below; items 1-5 there land before slice 3. The original instinct still holds where it matters: a slice discovering a further gap stops and re-plans rather than widening the runner opportunistically. |
| D2 | **Sixty gaps is not sixty recipes.** A recipe costs CI wall-clock in two profiles and a login/create/join preamble. Gaps that share a preamble land as steps appended to one recipe. The slice tables below name the recipe, not the gap count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D3 | **Every new recipe is identity-audited against the whole corpus before it is registered.** `{runId}` is shared across every recipe in one profile run, so any identity-shaped string a clone did not rename is literally the same string in two recipes. The audit is: enumerate every `/requests/<id>` segment, `msgId`, `resourceId` and group/app/workspace id, diff against every other file, then run the profile **with and without** the new matrix entry. A green new recipe is not evidence the suite is unbroken.                                                                                                                                                                                                                                                                                                                                       |
| D4 | **Profile placement is a per-recipe design decision, not a checkbox.** The base pair (`api-v1-black-box` + `api-v1-black-box-recipes`) runs on the memory backend in the fast loop and on Postgres in CI's base phase. `api-v1-black-box-cluster` runs against three nodes under one run id. A recipe in **both** replays its request ids with fresh login sessions and self-conflicts on idempotency, so each recipe picks one.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D5 | **Two hand-maintained sorted id lists in `recipe-matrix.test.ts` must be updated with every new recipe** (the `api-v1-black-box` and `api-v1-black-box-recipes` membership assertions). They are the only thing that fails when a recipe is added to the matrix but not to a profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D6 | **A lifecycle command inside a `parallel` block has no precedent in the corpus.** Slice 4 establishes the pattern and every later concurrency recipe follows it. Expect the first one to cost more than its size suggests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D7 | **Not every race can be expressed as a `parallel` block.** Where one side is automation (a trigger latch, a deadline timer, a clock), that side has no HTTP surface to put in a parallel group. Those scenarios are sequenced by settle time instead, and the recipe must pin manual triggers so nothing else advances the stage. Mislabelling one of these as a race is how a recipe ends up asserting a timing coincidence.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D8 | **Assert the denial's code, not just its status.** The corpus has recipes asserting `403` without asserting which `GroupPolicyReasonCode` produced it. A denial recipe that does not name the code does not distinguish a correct denial from a differently-wrong one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D9 | **Cluster lifecycle coverage starts from one recipe.** `api-v1-black-box-cluster` has seven members and exactly one is a lifecycle recipe (`api-v1-group-lifecycle-stage-metrics`). Every other lifecycle behaviour is pinned single-node only. Slice 5 is therefore larger than its gap count implies — it is the first real cluster lifecycle work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Slices

Ordered by risk of a **silent** regression times the authority of the surface — not by lens, and not
by how easy each is to write.

### Slice 1 — Governance authority denials

The highest-authority mutations on the group aggregate have owner-happy-path coverage only. A
regression that let any member seize ownership, or that left a demoted owner still privileged, would
pass every black-box gate today.

| Recipe                              | Pins                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-v1-group-ownership-transfer`   | a plain member's transfer is `403 forbidden-role`; the owner's transfer is `200` and swaps roles to `owner`/`admin`; a non-member target is `400 group-mutation-rejected`; a sole owner's self-transfer is `403 last-owner`                                                                                                                                                                    |
| `api-v1-group-governance-authority` | ban, unban, remove and role promotion each denied for a non-owner with the code named; `last-owner` returned when the sole owner is removed, demoted or leaves                                                                                                                                                                                                                                 |
| `api-v1-group-invite-revocation`    | revoke-then-accept is denied; `group-invite-required` and `group-invite-expired` are returned by a real join                                                                                                                                                                                                                                                                                   |
| `api-v1-group-director-appoint`     | every eligibility branch: not-a-member, no active room session, a plain member while an owner is online, and a second member against an active fallback director are each `400 group-mutation-rejected` with the reason named; each acceptance advances the epoch and metadata version by one, pins the heartbeat TTL default, and leaves the group fields and seeded metadata entry unchanged |

**Hazards.** The demoted owner becomes `admin`, not a member, and an admin may still govern regular
members — a recipe asserting "the old owner can no longer do anything" will fail for the wrong
reason. `member-removed` is returned by the same path as `member-banned`, which has coverage; the
removal arm does not.

Self-transfer never reaches the compute's no-op: the governance policy answers `403 last-owner`
("Cannot leave an active group without an owner.") first, because it reads a sole owner handing
ownership to themselves as that owner leaving. The row above records the observed outcome; an
earlier draft of it claimed the no-op.

`forbidden-role` is returned by two different checks — `Only active group owners/admins can govern
group members.` for a plain member, and `Only active group owners can transfer group ownership.`
for a demoted owner who is still an admin. A recipe pinning only the code cannot tell them apart,
so both slice-1 recipes pin the message as well.

**Open contract defect (raised, not adapted around).** `POST .../owner/transfer/requests/{requestId}`
declares `200/401/403/404/409` in `api-v1-openapi.yaml`; the server answers `400
group-mutation-rejected` ("Ownership target must be active.") for an inactive or non-member target.
The sibling `/director/appoint` route does declare `400`, so this reads as a contract gap rather
than a deliberate exclusion. The recipe pins the observed `400` so the behaviour is not unobserved,
but the disagreement is real work: either the contract gains `400` for this route, or the route
returns the contracted `404`. Do not close this by editing the recipe.

Every director-appointment denial is raised as `GroupMutationRejectedError('Forbidden: ' + reason)`,
so the route answers **`400 group-mutation-rejected`** carrying a `Forbidden:` message rather than the
`403` the wording implies — the status mapping this slice set out to pin. The reason string is the
only thing separating the four denial branches, so the recipe pins it rather than the shared code.

**Gates:** baseline plus both black-box profiles.

### Slice 2 — Admission modes that exist nowhere in the corpus

Two entire join paths — code-protected and invite-only — have zero coverage across all 51 recipes,
and four denial codes have never been returned by any route.

| Recipe                             | Pins                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-v1-group-join-code-admission` | `joinMode: "code"` end to end: `group-code-required`, `group-code-invalid`, a successful coded join, and `join-code/rotate`                                                                                                                                                                                                         |
| `api-v1-group-invite-admission`    | `joinMode: "invite-only"`: the invite branch of `canJoinGroup` and its two denial codes                                                                                                                                                                                                                                             |
| `api-v1-group-business-status`     | archive and delete: `group-archived` and `group-deleted` returned by a real route, and what the read surface then shows                                                                                                                                                                                                             |
| `api-v1-group-limits`              | `expiresAtEpochMs` producing `group-not-active` with the message that separates a passed clock from a non-active status, a future clock admitting through the same guard, that an expired group still stores `active` and stays readable, and `maxSessionsPerMember` producing `member-session-limit-reached` on the second session |

Rotation **rewrites** the code it is given: trim, upper-case, strip every non-alphanumeric, cut to 12
characters, and reject anything under 4. The join side applies the same rule, so the form an operator
typed and the form `join-code/rotate` handed back verify alike — a regression normalizing on only one
side would lock every user out, so the recipe pins both. The plaintext code is returned **only** by the
rotate response; group state stores a verifier.

**Hazards.** A group whose clock has passed keeps `status: "active"` on the row — the denial comes
from the liveness projection, not the stored status, so the recipe must assert the denial rather than
the field.

**Archived is terminal at the route, and that is not the same as the compute being dead.**
`assertCanUpdateGroup` runs before AppInbox and before the body is parsed
(`register-group-state-mutation-routes.ts:67`), so `requireActiveGroup` denies `group-archived`
regardless of actor role, flag or requested status — an already-archived group has no exit through any
route, admin surface, WS command or worker. The `allowsArchivedDeletion` carve-out below it
(`compute-group-aggregate-mutation.ts:130`) is **not** dead: it is the convergence branch for a delete
admitted while the group was still active, it is reachable by racing archive against delete (both pass
the guard on an active read), and it is already pinned green by
`apps/api-v1/test/services/group-state-service.test.ts:344-388`. Do not describe it as dead code.

**Gates:** baseline plus both black-box profiles.

### Slice 3 — Read what the sockets actually carry

The corpus proves frames _arrive_. It does not prove what is _in_ them. This slice is sequenced third
because the assertion shapes it establishes are reused by slices 4 and 5.

| Recipe                                   | Pins                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `api-v1-overlay-topology-publication`    | the published `overlay.topology` body equals the authoritative HTTP topology read for the same layout                    |
| `api-v1-group-state-delta-contents`      | the delta envelope's causal chain and its **removal** sets — the stronger and entirely uncovered half                    |
| `api-v1-group-lifecycle-events`          | a `group-state.event` waited for by named `eventType`, including `group-activation-status-changed` observed on a socket  |
| _(append to `api-v1-group-data-policy`)_ | the transport-halt NACK to the **sender** (today's step has no `expect` at all), and that a pause is topic-**selective** |

**Hazards.** `aliceDoesNotReceivePausedData` is currently indistinguishable from the whole room going
dark — the selective-pause assertion needs a frame that is _supposed_ to survive the halt. Cross-topic
ordering is not guaranteed, so no assertion may depend on a total order across topics.

**Gates:** baseline plus both black-box profiles.

### Slice 4 — Lifecycle concurrency

The first lifecycle commands ever placed inside a `parallel` block (D6). Read D7 before writing any
of these: several are settle-sequenced, not raced.

| Recipe                                   | Pins                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `api-v1-group-lifecycle-command-race`    | two authorized principals commanding one group at once — the `planned --plan--> planned` idempotent cell and `initiator: 'any-member'` |
| `api-v1-group-admission-decision-race`   | grant vs decline on the same pending principal (asymmetric: `400` vs `200` no-op, exactly one decision event); two grants for one seat |
| `api-v1-connect-layout-fence`            | `connect` naming a layout a replan superseded — the typed `409` that twelve fenced connect steps never produce                         |
| `api-v1-activation-command-race`         | a principal's `activate` racing the criterion's own fenced `activate`; a `join` racing the transition that closes the lobby            |
| `api-v1-reconfigure-landing-concurrency` | two concurrent `reconfigure`s — and the `apply` landing, which has **no** coverage at all, concurrent or sequential                    |

**Hazards.** The connect-trigger latch and the deadline arm have no HTTP surface, so those legs are
settle-sequenced (D7). The `managed` preset auto-connects after plan since slice 11a — every recipe
here needs an explicit policy with manual triggers, not a preset, or the automation will move the
stage underneath the race.

**Gates:** baseline, both profiles, **medium-scale** (mutation-path), and a state-write verdict if any
recipe changes the registered read population.

### Slice 5 — Cluster lifecycle

Today exactly one lifecycle recipe runs against three nodes (D9). Everything else about the lifecycle
is pinned single-node.

| Recipe                                  | Pins                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `api-v1-group-lifecycle-cluster`        | a command issued to a node that handled none of the group's setup writes, read back on the two that did                      |
| `api-v1-group-lifecycle-ws-convergence` | the first cluster recipe combining a lifecycle transition with any WebSocket; a client-to-server frame on a non-primary node |
| `api-v1-group-governance-fencing`       | ban, admission and removal fencing across nodes; logout on node A fencing a live socket on node B                            |
| `api-v1-group-event-cursor-paging`      | event cursor paging over HTTP at all, and continued on a second node                                                         |

**Hazards.** `RALLAR_WS_BASE_URL_SECONDARY` is exported by the runner and referenced by zero recipes;
the only non-primary socket in the corpus is receive-only. Expect the first client-to-server frame on
a non-primary node to surface wiring nobody has exercised.

**Gates:** baseline, the cluster profile, **topology-replay**.

### Slice 6 — Timers, clocks and recovery

Durable machinery whose late-firing behaviour is asserted nowhere.

| Recipe                                  | Pins                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `api-v1-group-clock-after-the-fact`     | a formation timer or activation clock firing after the group moved on; the evidence-expiry heartbeat decaying a quiet group |
| `api-v1-group-reconnect-across-stages`  | reconnect hydration across a lifecycle stage change; reconnecting to a different node than the one that dropped you         |
| `api-v1-group-presence-lease-lifecycle` | presence-lease expiry against a lifecycle-managed group                                                                     |
| _(append to `api-v1-admin-support`)_    | explain against a **real** RETRY or FAILED queue entry, and the FAILED row in the queue breakdown                           |

**Hazards.** The evidence-expiry arm is the `degraded` band no read can derive — it must be asserted
off the group row, not the formation view, because only a writer can put a status there.

**Gates:** baseline, both profiles, **topology-replay**.

### Slice 7 — Admin and diagnostic surface

Lower product risk, real coverage debt. Batched last deliberately.

| Recipe                                  | Pins                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `api-v1-admin-authorization-boundary`   | the whole admin surface against an authenticated **non-admin** principal, centred on the CRDT admin read guard |
| `api-v1-crdt-admin-write-surface`       | backup-export, rebuild-projection and a successful erase                                                       |
| `api-v1-graph-diagnostics-read`         | the two graph diagnostic reads the OpenAPI assertion covers but no recipe requests                             |
| _(append to `api-v1-admin-operations`)_ | the six admin read/reset routes and the three unexercised explain routes                                       |

**Gates:** baseline plus both black-box profiles.

## Framework prerequisites (2026-09-05)

Requested during planning, and recorded here rather than in the coverage plan because two of the four
answers change what a _browser_ surface can be tested with. Every figure below was verified against
the runner and the corpus, not inferred.

### The identity discipline is a convention with no gate and no documentation

`{runId}` is **per-profile-run, not per-recipe**. It resolves from one environment variable
(`RALLAR_BB_RUN_ID`, set once in `api-v1-black-box-run.mts`) that every recipe binds under the same
name, so it is byte-identical in all 46 recipes that reference it during a run. Recipes execute
sequentially against **one server and one database for the whole run**, which is why a collision
breaks the _other_ recipe rather than the one that introduced it.

Nothing in the framework namespaces identifiers per recipe. The interpolation root carries no recipe
identity at all, and the one place the framework already does namespace per entry — live preflight,
which builds `bb-live-preflight-<entryId>-<runId>` — never passes that identity into the recipe
process. `recipe-matrix.test.ts` enforces uniqueness of matrix entry ids and artifact names only;
nothing inspects identifiers inside recipes.

**And it is undocumented.** `grep -rn "runId" .agents/skills/` returns **zero matches**. There is no
black-box authoring skill; `rallar-testing` covers only which commands to run. The runner's own
1,236-line recipe guide has a 7-bullet authoring checklist with no identifier rule, and its
`runnerRunId` section documents trace correlation without ever mentioning `{runId}` the variable — so
an author reasonably reads `{runId}` as "unique per recipe". It is not.

**Recommended, cheapest first.** A corpus collision preflight in `recipe-matrix.test.ts` (~120 lines,
no runtime change) catches exactly the reported failure. A `{recipeId}` interpolation token seeded
from the matrix entry id makes the convention mechanical. A `--strict` lint flagging any
identifier-shaped literal containing neither `{runId}` nor `{recipeId}` catches it at authoring time.
**Do not** auto-prefix request ids: it rewrites the wire, and it would break both the deliberate
20-and-128-character boundary fixtures and the intentional same-requestId replay steps in
`api-v1-idempotency-contract.json`. A scan of all four identifier dimensions found **zero
cross-recipe collisions today** — clean by discipline alone, with nothing holding it there.

### Re-runnability: achievable, and closer than it looks

Recipes are re-runnable today **only because `{runId}` changes per run**, not because anything is
idempotent-safe. Two mechanisms hide the question: the default run id is `local-<Date.now()>`, and
`npm run test:api-v1:black-box:postgres` creates and drops a throwaway database per run
(`rallar_bb_<runId>_<uuid>`). A re-run against a dirty database is only reachable via
`--recipes-only` against an external base URL, the operator SPA, distributed runs, or a pinned
`--run-id` — which is precisely where nobody is looking.

**Nothing blocks full re-runnability in principle.** No recipe asserts a server-global absolute count
and none requires a fresh server. Two concrete things block it in practice:

- **Five of 51 recipes have no `runId` variable at all** — `api-v1-admin-support`, `api-v1-ice-config`,
  `api-v1-admin-operations`, `api-v1-black-box-control-auth` and `api-v1-openapi-topology-auth` (the
  last is stateless and genuinely fine). Re-run against the same database, the other four go **green
  by AppInbox replay while executing no new server logic** — the worst failure mode, because it is
  silent. Note `api-v1-admin-operations` already uses a fresh `{executionToken}` for its
  evidence-bearing prune, so its author knew freshness mattered and left the login ids fixed anyway:
  the signature of a convention nobody wrote down.
- **A replayed request id is permanent.** AppInbox rows are written with `NEVER_EXPIRE_TS`, so a
  replay returns the first receipt verbatim — success _or_ the original failure — and `prune-expired`
  can never reclaim them. Group mutations replay through a second, session-independent key
  (`commandId` = hash of operation, scope, group, target, caller, requestId — no session, no clock),
  which is why a fresh login does not produce a fresh outcome.

**So the answer to "must every test be self-contained and re-runnable without cleaning the DB" is
yes, and the work is small**: give the four recipes a `{runId}`, then keep them that way with the
lint above. That is worth doing before this plan's browser recipes exist, because a browser-driven
recipe runs against a long-lived server far more often than a CI recipe does.

### Lifecycle tracing: the evidence is durable and unreadable

For convergence-style assertions — many groups and clients, no step-by-step determinism, assert the
end state and trace failures — the current surface is **end state only**.

`explainGroup` reports the current lifecycle plane well (13 facts) and history not at all: its
timeline maps each event to `{atEpochMs, eventType, summary}` and **discards actor, requestId,
reason, snapshotVersion, causalRevision and payload**, capped at 50 events. That is strictly _less_
per-event information than the member-readable `/events` route.

Four questions a convergence test needs, and today's answers:

| Question                                | Today                                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which stage transitions, in what order? | Order yes; **which transition, no** — all seven lifecycle transitions, both transport commands, `applyPlannedLayout` and plain metadata updates all write the same `group-updated` |
| With what outcome and epoch?            | **No.** `GroupEvent` carries no `lifecycleState` and no `formationEpoch`, and the payload is `{}` for every lifecycle transition                                                   |
| Command, automatic trigger, or clock?   | Only by string-matching an undocumented synthetic `requestId` prefix (`formation-criterion:v2:…`, `formation-automation:v2:…`) — no contract sanctions that                        |
| Which node handled it?                  | Only for automatic transitions, and only implicitly via `actor.serviceId`. For a principal-commanded transition the handling node is recorded **nowhere**                          |

**What is durable but exposed by nothing.** The `GroupMutationReceipt` is written into
`resource_inbox_results` in the same transaction as the state write and carries `outcome`
(`applied` / `no-op` / `rejected`), `attemptCount` and the typed `rejection` — _exactly_ "what
happened to this transition and why it did not take" — and no API returns any of it. The receipt holds
both `requestId` and `eventId` and the event row holds the same pair, so the command→event join
exists in the data and is offered to no caller. Formation-timer rows (which clock, which epoch,
firing when) and the connect-trigger latch are equally durable and equally unreadable.

**Proposal: `POST /api/admin/support/explain/group-lifecycle`.** Group-scoped like every other explain
route, returning `current` (the end state a convergence assertion compares against), an ordered
`transitions[]` with `from`/`to`/`formationEpoch`/`origin`/`outcome`/`rejection`/`handledByServerId`,
a compact `signature` string, and — because the runner has no array filter or count transform —
scalar `transitionCount` and `rejectedTransitionCount` so a recipe can assert "nothing was rejected"
at all.

It needs one honest write-side change: the trace is **not** derivable from what exists today, so
`toGroupEventPayload` must record `{lifecycleOperation, fromLifecycleState, toLifecycleState,
formationEpoch, handledByServerId}` for lifecycle writes. `payload` is already `ApiJsonObject` inside
a text column, so this is additive and needs no migration. The alternative — regexing the synthetic
`requestId` prefixes — turns an internal dedup key into a public contract.

Constraints on the surface: **no principal, session or client ids** in `transitions[]` (`actorKind`
only, so it cannot become a roster read); no queue payloads or command bodies, keeping
`explain/queue-item`'s redaction posture; no cross-group listing. The troubleshooting checklist's
"never add tenant, group, session or request IDs as metric labels" constrains **metrics**, not scoped
admin reads — an admin operations route already takes tenant scope in its path — so the trace may
carry the `groupRef` it was asked about, but this work must add no counter dimensioned by group,
request or session.

### The framework itself — and a correction to the coverage plan

**The coverage plan's D1 ("no runner work is required") is about two-thirds right.** The runner is far
more capable than the corpus uses — unordered event sets, absence, bounded HTTP polling, latency
bounds, WS-vs-HTTP comparison and durable queue-row evidence all work today, several of them
undocumented. But three needs are genuinely absent, and one item the coverage plan lists under _Not
in this plan_ is deferred **because** the runner cannot express it:

1. **No cardinality on a wait.** There is no `expect.count`, so "exactly one decision event" needs a
   consume-then-absent idiom nobody has written.
2. **No negative expectation on `ws.open`.** A rejected upgrade is an unconditional step failure; the
   only escape discards the assertion. This is why "WS upgrade negative paths" is deferred.
3. **`expect` on a `parallel` step is silently ignored.** The executor never compares the parallel
   result, so "at most K of 70 admitted" is unreachable — and any recipe that writes such an expect
   gets a silent no-op.
4. **No ordered array comparison in any mode**, including `exact`.
5. **No rendezvous barrier for `parallel` groups** — workers start unsynchronised, which is precisely
   the "timing coincidence" hazard the coverage plan's own D7 warns about.
6. **`poll-until` is HTTP-only** — `assert`, `set` and `parallel` have no retry loop at all.

**The dominant failure mode is undiscoverable capability, not missing capability.** Four working
primitives (`missingActualValue`, `monotonicPaths`, `set.state-write-evidence`, `anyOfMatchedIndex`)
appear nowhere in the recipe guide, which also still says "There is no separate poll step yet" 250
lines after documenting the poll step. The measured consequences, verified independently:

- **371.2 seconds of unconditional sleep** across 59 `delayMs` steps, concentrated in five recipes
  (86.0s, 72.8s, 64.0s × 3) — hand-rolled polling with step names like
  `delayBeforeConvergenceAttempt1..4`, each attempt marked `nonBlockingFailure` so it passes
  regardless of outcome.
- Essentially the whole corpus runs on the default `compatible` comparison, which the guide itself
  calls the vacuous-assertion mode: `{events: []}` matches `{events: [{x:1},{y:2}]}`.
- Because array comparison is unordered in **every** mode, five recipes enumerate both permutations of
  a race outcome in `expect.anyOf` — the second alternative is dead code in all five.
- A 70-iteration join storm accepts `[200, 429]` per attempt with **no follow-up assertion on how many
  were admitted**, so the rate-limit contract is not asserted at all.

`rallar-bb-test` is the best design reference here, because it already has three primitives the runner
lacks: path-scoped `equals`/`notEquals`/`exists` operators, a `payloadPath` matcher, and a
`stableForMs` stability wait. It also has a divergence worth fixing on its own: its wait scans
**backward** (most-recent-first) while the runner scans **forward** (earliest-first) — two semantics
for one conceptual operation, with the earliest-match behaviour already a known trap in this repo, and
nothing testing the difference.

**Recommended sequencing, and it revises the coverage plan's D1.** Items 1–5 below are prerequisites,
not opportunistic widening; the coverage plan should adopt them rather than route around them.

| Order | Change                                                                                     | Cost       | Why first                                                                                       |
| ----- | ------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------- |
| 1     | Document the four hidden primitives and the unordered-array semantics                      | doc only   | Highest value per hour; the sleeps and the dead permutations both trace to not knowing          |
| 2     | Strict-profile vacuity lint (no `expect`, ignored `expect` key, empty expected array)      | ~80 lines  | The only mechanism that would have caught every item above; run it from `recipe-matrix.test.ts` |
| 3     | Generalise `poll-until` to every step type, with `stableForMs`                             | ~130 lines | Unblocks the coverage plan's slices 4, 5 and 6, and retires most of the 371s sleep budget       |
| 4     | `expect.count` on `ws.wait` / `rtc.wait`                                                   | ~60 lines  | "Exactly one event" assertions                                                                  |
| 5     | Path comparators `equals` / `notEquals` / `exists`                                         | ~40 lines  | The coverage plan's D8 — assert the denial code, not just the status                            |
| 6     | Honour `expect` on a `parallel` step                                                       | ~30 lines  | Closes a latent silent no-op                                                                    |
| 7     | Negative expectation on `ws.open`; `exact-ordered` comparison; parallel rendezvous barrier | ~130 lines | Un-defers the WS upgrade paths and makes the race recipes real races                            |

Items 1 and 2 should land regardless of whether any recipe is written: **they are what stops the next
agent from adapting a test instead of fixing the framework.**

### Prerequisite delivery

| Item | State                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Delivered** (#503). The guide's self-contradiction is gone, the four hidden primitives are documented from their implementations, the unordered-array semantics are stated with a measured table, and identifiers have a section.                                                                                                                                                                               |
| 2    | **Delivered** (#503). Three strict checks in `plan-preflight.ts`, ratcheted per recipe from `preflight/strict-expectation-debt.json` so a new finding fails while the 47 existing ones stay visible as debt. Its first catch was real: `aliceNeverReceivesTheBlockedMessage` is a `ws.send` carrying `expect.absent`, which the runner never reads.                                                               |
| 5    | **Delivered.** `equals`, `notEquals` and `exists` join the comparator registry. `exists` is decided before the path is required to resolve, because an absent path is the assertion rather than a failure to make one. Deep equality reuses `jsonEquals` from `@shared/repository/state-utils.ts` rather than adding a third implementation.                                                                      |
| 6    | **Delivered.** A `parallel` step's `expect` is now compared against its aggregate — groups, counts, concurrency, timing — through the same comparator and comparison path an `assert` uses. Child failures are still decided first, so an aggregate expectation cannot mask one.                                                                                                                                  |
| 3    | **Delivered.** The poll loop moved to `execution/with-poll-until.ts`; HTTP calls it rather than keeping a private copy, and `assert`, `set` and `parallel` are wrapped in it. `stableForMs` requires the condition to hold _continuously_, and a run whose last attempt passed but never held the full window is reported as a failure — calling that a pass would be the weakening the window exists to prevent. |
| 4    | **Delivered.** `expect.count` on `ws.wait`, `rtc.wait` and `ws.send`, waiting the full window before counting because `expect.message` resolves on its first match and cannot tell "exactly one" from "at least one". The bound parser is shared between the WS and RTC waits.                                                                                                                                    |
| 7    | **Delivered.** `expect.rejected` on `ws.open` (with an optional close code, so "rejected" cannot mean "rejected for the wrong reason"), the `exact-ordered` comparison — the only mode that compares arrays positionally — and `barrier: true` on a `parallel` step, which makes every group arrive before any is released rather than starting them as slots free.                                               |

All seven prerequisites are delivered. **The slices above are unblocked.**

Two facts worth carrying into the remaining items. The runner may import from `@shared/**` — several
modules already do — but only resolves the alias when the entry point is inside the workspace, so a
probe script written to a temporary directory fails on the import rather than on the code under test.
And a `parallel` group's steps use the runner's `{TRANSPORT: {request, response}, name: {}}` pair
shape, not the flat `{name, type, expect}` shape recipes use at the top level; a group written the
flat way executes nothing and reports `success: 0` rather than failing.

## Not in this plan

- **WS upgrade negative paths** (reused, expired, foreign, missing ticket) — worth doing, but they
  belong with the auth surface rather than with group behaviour.
- **The AppInbox wait-budget 503 and its durable completion.** It needs a dedicated profile whose one
  node runs with `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS=0` while the others keep the default. That is
  profile infrastructure, not a recipe, and it should be costed on its own.
- **`group-data-blocked-until-active` asserted by code.** Every WS room denial is flattened to
  `unauthorized` on the wire, so the code cannot be observed there. Asserting it requires a wire
  change the group-activation plan deliberately deferred (its "Typed WS NACK reasons" entry), so this
  is blocked on that decision, not on a recipe.
- **The four acceptance scenarios** the group-activation plan records as needing live-RTC, headless or
  browser-side infrastructure. Unchanged by this plan.

## Gate assignment

Every recipe PR carries the baseline: `format:check`,
`check:repo-style:changed -- origin/main HEAD`, `typecheck`, `typecheck:tests`, `test:unit`,
`test:deno`, `build`, plus `npm run test:api-v1:black-box:memory` and
`test:api-v1:black-box:postgres`.

| Gate                | Required when                                                                |
| ------------------- | ---------------------------------------------------------------------------- |
| **medium-scale**    | any recipe exercising the mutation path under concurrency — all of slice 4   |
| **cluster profile** | every slice 5 recipe                                                         |
| **topology-replay** | slices 5 and 6                                                               |
| **state-write**     | only if a recipe changes the registered read population; none is expected to |

Per D3, every recipe PR must also record the profile run **with and without** its new matrix entry.

## Appendix — the sixty gaps

`playground/rtc-design/audits/2026-09-05-black-box-coverage-gaps.json` carries all sixty, each with
its scenario, why it matters, the evidence of absence that was actually run, the refutation proof,
and the corrected restatement where the refutation pass sharpened the claim. **That file is the
authority for what each recipe must assert**, not the slice tables above, which are only the
grouping.

Regenerate it before starting a slice if the corpus has moved: several gaps are stated relative to
recipes this plan itself will change, and a gap that names `api-v1-group-data-policy.json` as the
place to append is stale once slice 3 has appended to it.
