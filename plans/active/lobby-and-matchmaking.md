# Lobby and matchmaking product plan

Rallar should make it easy to enter a shared browser experience and keep the same people together:
share a room, enter it, participate, reconnect, and return. Rallar owns discovery, admission,
membership, and recovery. Applications own activity eligibility, readiness, match rules, and what
participants or spectators may see.

Current behavior and architecture belong in [product](../../docs/product.md) and
[architecture](../../docs/architecture.md). This plan describes the remaining outcome and its next
two implementation increments. The pull request owns delivery and validation evidence; this file
is not a completion ledger. Historical slice numbers remain useful references, not delivery order.

## Foundation for the next slice

The player-facing foundation is available in both games: private and unlisted room sharing,
spectating, recent-room return, temporary-room retention and deletion, automatic discovery refresh,
scheduled sessions, friends, matchmaking, coordinated repeat play, and Move together.
[Party support](https://github.com/intact-software-systems/ar-eye-hunter/pull/770) keeps a party
indivisible while filling remaining match seats from other searches. Party leadership remains
separate from director or Keeper authority.

The original directory, Quick Join, and existing-measurement latency ranking provide slices 0–2;
watching, room sharing, retention/recovery, social context, and scheduling supply the player-facing
outcomes of slices 3–8. Their current contracts live in the product documentation. Shipped rematch
implementation tasks and shared-browser consolidation are no longer future work.

Keep these distinctions when developing operator tools:

- Discovery, admission, membership, live presence, and gameplay participation are separate facts.
  Membership does not keep an empty temporary room alive or enroll a player in an activity.
- Private and unlisted rooms remain absent from ordinary discovery. Operator visibility must not
  change player visibility, admission permissions, or game authority.
- Quick Join selects an existing room; matchmaking creates a consented group. Scheduled reservations
  and party membership do not bypass canonical room admission.
- Latency ranking uses existing measurements and shows unknown when coverage is absent. It does
  not probe unfamiliar rooms or measure game-command completion.
- Reconnect and return recheck current authority. An operator must not resurrect a deleted room,
  restore expired consent, or infer that a historical session is currently connected.

## Selected next slice: room operations and recovery

The maintainer approved a complete operator workflow for slice 9:

**Find a room → understand its state → run an authorized recovery action → verify the result.**

An operator should be able to investigate a room used by either AR Eye or Relic without assembling
facts from separate raw endpoints. Deliver the directory, explanations, actions, and resulting state
in one PR. A read-only dashboard is the first increment, not the completed slice.

### Scope and observable acceptance

1. **Find.** Provide an authenticated, operator-authorized, bounded and paginated directory covering
   public, unlisted, private, scheduled, and archived rooms in the selected application/workspace.
   These categories overlap; listing, access, schedule, and lifecycle remain separate dimensions.
   A deleted room is absent, not reconstructed from historical evidence. Empty success, failed
   reads, stale retained results, and incomplete diagnostic results are visibly distinct.
2. **Explain.** Selecting a room shows membership versus live presence, player/spectator roles,
   admission restrictions, lifecycle/retention, and available formation/connectivity evidence.
   State why a known restriction blocks entry or formation. Unavailable facts remain unknown;
   neither transport readiness nor HTTP admission success proves gameplay participation.
3. **Report invalid records.** The operator diagnostic collection may return valid entries alongside
   explicitly identified invalid entries and a completeness indicator. An invalid entry is a
   diagnostic failure, never a usable room snapshot. Use only trustworthy storage identity and
   bounded redacted reasons; do not guess scope from corrupt payloads. If authorized scope cannot
   be established, fail that read safely. Infrastructure failures are not reclassified as corrupt
   rows. Ordinary authoritative reads and mutations retain their strict corruption behavior.
4. **Act.** Offer suitable existing authorized recovery operations with their exact scope, purpose,
   and refusal conditions. Start from the existing topology recompute and maintenance capabilities;
   confirm their actual scope and terminal-result contracts before exposing them. A global action
   must never be presented as room-local. Preserve dry-run where available and require explicit
   execution for destructive effects. Invalid records have no repair or mutation shortcut.
5. **Verify.** Show pending, accepted, completed, refused, uncertain, and failed outcomes accurately.
   A queued receipt is not completion. Recover uncertain commands with their original identity,
   then reread the affected state. If the action completes without resolving the observed problem,
   say so; do not label the room recovered merely because a request succeeded.
6. **Protect access.** Check operator authority on every read and action. Logout, revoked authority,
   account replacement, scope changes, and room changes fence old responses and pending UI work.
   Ordinary players cannot obtain private room identities through list results, errors, or diagnostics.

The diagnostic partial-result policy is confined to the authorized inspection surface. It adds no
corruption-tolerant authoritative reader, normalization of persisted records, or migration path.

### Approach and ownership

Compose the existing admin operations and support services into the current operator application.
Prefer the existing Rallar Black Box operator surface after verifying its API authentication boundary;
control-server authorization does not automatically grant API-v1 administrator authority. Do not
create a separate application or a second room repository merely to present the workflow.

Existing navigation starting points, to verify against code before implementation:

- [Admin API documentation](../../docs/rallar-api-reference.md) describes admin operations,
  authentication, topology recompute, and maintenance semantics.
- [Group support](../../packages/shared-server/rallar-system/admin-support/group-admin-support.ts)
  assembles group snapshots, recent events, topology, and lifecycle explanations.
- `packages/shared-server/rallar-system/admin-operations/` owns operational reads and commands;
  `packages/shared-server/rallar-system/group-state/` retains canonical room state and admission.
- `apps/api-v1/src/routes/` owns HTTP authorization/decoding and service composition at the API edge.
- [Operator application](../../apps/rallar-black-box/docs/README.md) owns the human workflow.
  Browser lifecycles should reuse shared notification, cancellation, and single-flight owners.
- `packages/shared-test/black-box-runner/` owns reusable API recipes and distributed evidence;
  `tests/playwright/` owns clickable application journeys.

Shared contracts belong in `packages/shared`, server capabilities in `packages/shared-server`, and
reusable browser behavior in `packages/shared-web`. Common React components belong only in
`packages/shared-react`. No React dependency enters shared, shared-web, shared-test, shared-server,
shared-graph, or Deno application locks. Use direct owner imports and existing implementations.

A read-only directory alone would leave operators switching tools to recover a room. An automatic
repair service would introduce new policy and mutation risk. The selected approach connects bounded
inspection to explicit existing actions and verified outcomes.

### Two implementation increments in the same PR

**1. Authorized inspection from directory to explanation.**

Recover existing owners, representative dataflow, authorization, strict decoding, failure boundaries,
and nearby examples/tests. Add failing tests for operator access, scoped pagination, private-room
non-disclosure, valid/invalid mixed diagnostic pages, unavailable sources, and stale browser results.
Implement the bounded diagnostic read contracts and clickable room list/detail workflow. Reuse the
existing group explanation rather than copying lifecycle or admission decisions. Verify both games'
room shapes and run affected package typechecks plus the operator application build.

**2. Explicit recovery through a verified result.**

Trace each selected existing operation from visible action through authorization, its canonical
command owner, durable result, and refreshed state. Add failing tests for refusal, duplicate/replayed
commands, lost responses, concurrent room changes, expired authority, and queued versus completed
results. Connect the controls and add real-API clickable recovery journeys covering AR Eye and Relic
rooms. Verify that authorized recovery does not bypass player consent, membership, or game authority.
Complete local and hosted validation, whole-branch review, and PR readiness in this increment.

These are implementation increments, not separate feature PRs. Exact interfaces, filenames, filters,
and recovery controls follow current owner inspection; do not invent a parallel service layer to
satisfy a speculative file list. Material ownership or acceptance changes are explained in the PR.

### Constraints and validation

- Use test-driven development. No legacy paths, compatibility aliases, migration code, duplicate
  algorithms, silent data repair, new general-purpose query language, or game-specific product code
  in generic Rallar services. Game saves and hidden gameplay state are not operator directory data.
- Authoritative database mutations retain AppInbox, visible read → compute → validate → write,
  one optimistic attempt per delivery, and outer QueueBox conflict redelivery. Existing operations
  remain canonical; do not add a second retry or mutation implementation for the UI.
- Review and remediate every changed human-authored file in full. Every support file modified by
  remediation enters closure recursively. Independent untouched code remains outside closure.
- Run focused semantic service/browser tests and real PostgreSQL cases for affected persistence
  boundaries. REST changes include OpenAPI and reusable black-box recipes in the same PR.
- Clickable Playwright journeys must operate visible controls and verify actual API/application
  state, including a refused ordinary-player request and recovery of an operator-visible problem.
  Test both games' rooms; retain their existing entry/play acceptance when affected.
- Run affected shared/server/browser/React typechecks, API-v1 Deno checks, and the operator app build.
  Include public API snapshots and browser bundle boundaries when exports or entry points change.
- Run local affected recipes and hosted equivalents. Use Run GitHub Free Distributed Recipe for
  altered distributed recipes and the supported Hetzner gate when distributed risk selects it.
  The maintainer has authorized Hetzner validation whenever needed; do not add a redundant approval.
- Run the unweakened medium-scale gate for group/topology/runtime-state or concurrency changes.
  Mutation-path or concurrency-domain changes also require a fresh controlled performance comparison.
  A read-only documentation change does not trigger runtime performance or distributed work.
- Require green Branch Release Gate and all selected checks on the candidate. Report failed,
  skipped, and passed validation honestly; do not claim an old measurement validates changed runtime.

## Later outcomes remain conditional

- Push directory updates over existing state sync only when measured freshness needs and request
  cost justify them; conditional pull remains the missed-update recovery mechanism.
- Broader social discovery, room-location sharing, or additional metadata filters require a concrete
  consumer need and explicit privacy/consent policy. Existing friendship does not authorize location.
- Tournaments are a separate possible product: rounds, trusted results, advancement, and cancellation.
  Scheduling, parties, and matchmaking are foundations, not evidence that tournament rules exist.
- Further latency, capacity, and recovery work should follow reproducible failure or participation
  evidence. Browser automation proves behavior, not adoption, actual OS suspension, or a latency SLO.

Do not select a second feature now. After room operations and recovery, use measured evidence and
maintainer priorities to choose the next outcome.

## Evidence and delivery

Retain the existing [room-journey measurements](../../tests/playwright/README.md#room-journey-measurements)
for entry, recovery, and repeat play. For this slice, additionally demonstrate time to find a room,
reach an evidence-backed explanation, and observe the terminal recovery outcome. Keep failures,
retries, unknown facts, and unreached phases visible. Baseline before proposing numeric targets.

Use one non-default feature branch and one PR for the complete slice. The PR contains Goal, Changes,
Acceptance, Validation, Risk and rollback, and Follow-up. Run `npm run pr:delivery -- status` before
broad final validation; resolve real conflicts, but do not rebase merely because a mergeable branch
is behind. Run `npm run pr:delivery -- ready` at handoff and wait for the maintainer to merge.

Before that merge, remove the completed implementation plan and preserve any genuinely remaining
outcomes in the existing backlog. Current product documentation owns delivered behavior. Do not
create a progress ledger, perform post-merge plan cleanup, or close unrelated issues without evidence.
