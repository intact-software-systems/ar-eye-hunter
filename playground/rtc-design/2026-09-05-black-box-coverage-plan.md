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

| ID | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 | **Runner work IS required first — this decision is superseded.** The original reading, that `ws.wait` already matches on payload/route/targets/id and captures for a later `assert`, is true as far as it goes. A framework audit then found three needs genuinely absent: no `expect.count` on a wait, no negative expectation on `ws.open` (which is _why_ the WS upgrade paths sit under Not in this plan), and `expect` on a `parallel` step is silently ignored. `poll-until` is also HTTP-only, and no comparison mode checks array order. The sequenced prerequisite list, with costs and the evidence behind each, is the **Black-box framework notes** section of `2026-09-05-browser-lifecycle-command-surface-implementation-plan.md`; items 1-5 there land before slice 3. The original instinct still holds where it matters: a slice discovering a further gap stops and re-plans rather than widening the runner opportunistically. |
| D2 | **Sixty gaps is not sixty recipes.** A recipe costs CI wall-clock in two profiles and a login/create/join preamble. Gaps that share a preamble land as steps appended to one recipe. The slice tables below name the recipe, not the gap count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D3 | **Every new recipe is identity-audited against the whole corpus before it is registered.** `{runId}` is shared across every recipe in one profile run, so any identity-shaped string a clone did not rename is literally the same string in two recipes. The audit is: enumerate every `/requests/<id>` segment, `msgId`, `resourceId` and group/app/workspace id, diff against every other file, then run the profile **with and without** the new matrix entry. A green new recipe is not evidence the suite is unbroken.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D4 | **Profile placement is a per-recipe design decision, not a checkbox.** The base pair (`api-v1-black-box` + `api-v1-black-box-recipes`) runs on the memory backend in the fast loop and on Postgres in CI's base phase. `api-v1-black-box-cluster` runs against three nodes under one run id. A recipe in **both** replays its request ids with fresh login sessions and self-conflicts on idempotency, so each recipe picks one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D5 | **Two hand-maintained sorted id lists in `recipe-matrix.test.ts` must be updated with every new recipe** (the `api-v1-black-box` and `api-v1-black-box-recipes` membership assertions). They are the only thing that fails when a recipe is added to the matrix but not to a profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D6 | **A lifecycle command inside a `parallel` block has no precedent in the corpus.** Slice 4 establishes the pattern and every later concurrency recipe follows it. Expect the first one to cost more than its size suggests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D7 | **Not every race can be expressed as a `parallel` block.** Where one side is automation (a trigger latch, a deadline timer, a clock), that side has no HTTP surface to put in a parallel group. Those scenarios are sequenced by settle time instead, and the recipe must pin manual triggers so nothing else advances the stage. Mislabelling one of these as a race is how a recipe ends up asserting a timing coincidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D8 | **Assert the denial's code, not just its status.** The corpus has recipes asserting `403` without asserting which `GroupPolicyReasonCode` produced it. A denial recipe that does not name the code does not distinguish a correct denial from a differently-wrong one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D9 | **Cluster lifecycle coverage starts from one recipe.** `api-v1-black-box-cluster` has seven members and exactly one is a lifecycle recipe (`api-v1-group-lifecycle-stage-metrics`). Every other lifecycle behaviour is pinned single-node only. Slice 5 is therefore larger than its gap count implies — it is the first real cluster lifecycle work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Slices

Ordered by risk of a **silent** regression times the authority of the surface — not by lens, and not
by how easy each is to write.

### Slice 1 — Governance authority denials

The highest-authority mutations on the group aggregate have owner-happy-path coverage only. A
regression that let any member seize ownership, or that left a demoted owner still privileged, would
pass every black-box gate today.

| Recipe                              | Pins                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-v1-group-ownership-transfer`   | a plain member's transfer is `403 forbidden-role`; the owner's transfer is `200` and swaps roles to `owner`/`admin`; a non-member target is `400 group-mutation-rejected`; self-transfer is the declared no-op |
| `api-v1-group-governance-authority` | ban, unban, remove and role promotion each denied for a non-owner with the code named; `last-owner` returned when the sole owner is removed, demoted or leaves                                                 |
| `api-v1-group-invite-revocation`    | revoke-then-accept is denied; `group-invite-required` and `group-invite-expired` are returned by a real join                                                                                                   |
| `api-v1-group-director-appoint`     | the appointment route's status mapping, actor binding, and metadata-patch containment                                                                                                                          |

**Hazards.** The demoted owner becomes `admin`, not a member, and an admin may still govern regular
members — a recipe asserting "the old owner can no longer do anything" will fail for the wrong
reason. `member-removed` is returned by the same path as `member-banned`, which has coverage; the
removal arm does not.

**Gates:** baseline plus both black-box profiles.

### Slice 2 — Admission modes that exist nowhere in the corpus

Two entire join paths — code-protected and invite-only — have zero coverage across all 51 recipes,
and four denial codes have never been returned by any route.

| Recipe                             | Pins                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `api-v1-group-join-code-admission` | `joinMode: "code"` end to end: `group-code-required`, `group-code-invalid`, a successful coded join, and `join-code/rotate` |
| `api-v1-group-invite-admission`    | `joinMode: "invite-only"`: the invite branch of `canJoinGroup` and its two denial codes                                     |
| `api-v1-group-business-status`     | archive and delete: `group-archived` and `group-deleted` returned by a real route, and what the read surface then shows     |
| `api-v1-group-limits`              | `expiresAtEpochMs` producing `group-not-active`, and `maxSessionsPerMember` producing `member-session-limit-reached`        |

**Hazards.** A group whose clock has passed keeps `status: "active"` on the row — the denial comes
from the liveness projection, not the stored status, so the recipe must assert the denial rather than
the field.

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
