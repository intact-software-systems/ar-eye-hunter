# Manager Role Basis — Analysis (2026-08-18)

Status: **analysis for a decision**, requested during slice 4 planning. The question: the plan says
the manager role builds "on the existing `GROUP_DIRECTOR_APPOINT` command and payload contracts
rather than new trust machinery" — does that still hold now that slices 2–3 implemented manager
authority as a pure predicate, and what exactly should the elected variants stand on?

## What exists today

**The director** (`packages/shared/api/group-director.ts`, `computeDirector` in the aggregate
compute): a **session-scoped work delegate**. One browser session self-appoints through the
`appointDirector` AppInbox mutation; eligibility is a pure predicate over the policy snapshot
(`not-authorized` / `not-ready` / `no-local-peer`); the appointment — `sessionId`, `principalId`,
its own `epoch`, `appointedAtEpochMs`, `heartbeatTtlMs` — is merged into the **group aggregate's
`metadata`** under compare-and-set, and freshness (`none`/`fresh`/`stale`) is derived from
heartbeats against the TTL. Mode is `appointed-spa`: the duty is running browser-side work, and a
stale lease reads as absence.

**Manager authority** (decision 2.2, `denyForUnderivedManager` in `group-policy.ts`): a **pure
predicate over (snapshot, policy)**. `creator` resolves to `ownerPrincipalId`, `assigned` to
`assignedPrincipalIds`, and the elected variants return the typed `lifecycle-manager-unavailable`
rejection. No lease, no freshness, no self-appointment — authorization is decided inside the
mutation path from state that is already on the aggregate.

**The election primitive** (`packages/shared/rtc/rendezvous-score.ts`): a pairwise deterministic
score over `(groupKey, localSessionId, peerSessionId)`. Election over principals fits the existing
signature as `rendezvousScore(epochPinnedGroupKey, principalId)` — rank all candidates, take the
first `count`.

## The constraint that decides the shape

Correction 4 requires the election input pinned to the member set at a **formation epoch boundary**.
Nothing records that set today, and it is not derivable after the fact: members carry
`joined.atEpochMs`, but the epoch itself has no timestamp once `establishmentStartedAtEpochMs` is
cleared by a below-floor return. So whichever basis wins, an epoch-advancing transition must
**record** either the electorate or the election result.

Pinning has a degenerate but correct consequence worth stating: the epoch-0 boundary is group
creation, so a `phased` group's FORMING electorate is `[creator]` and elected selection collapses to
the creator for the _first_ establishment. Genuine election begins at the first epoch advance, when
the electorate is the members present at establish time. This is not a defect — it is exactly the
stability correction 4 buys, and the alternative (electing over live membership during FORMING) is
the flapping manager the correction exists to kill.

## Option A — aggregate-recorded election, authority stays pure

Epoch-advancing transitions (`startGroupEstablishment`, `activateGroup`, `reopenGroupEstablishment`,
`failGroupFormation`) record the electorate — active member principal ids at the boundary — on the
aggregate beside `formationEpoch`. Manager resolution is a pure function: rank the recorded
electorate by `rendezvousScore` keyed on (group, `formationEpoch`), filter to still-active members,
take the first `count`. Succession `next-by-selection` is the same function — a departed manager
simply stops matching the still-active filter and the next ranked member is already the answer, with
**zero extra writes** on departure. `elected-by-rank` substitutes the application-supplied rank for
the hash, same pinning, same filter.

- Authority remains where slices 2–3 put it: a synchronous predicate inside the mutation path over
  aggregate state. No new read dependency, no freshness window, no split-brain surface.
- Slice 5's `manager-approval` admission check gets the same predicate for free at the join
  boundary.
- The write is one array on the hottest row. Bounded by group size; groups at the scale this
  workstream targets (6/20/50) make that a non-issue, but it is the option's real cost.
- `GROUP_DIRECTOR_APPOINT` stays untouched, remaining the browser work-delegate lease.

## Option B — promote the director machinery

Extend `appointDirector` (or a sibling command) so managers are appointed into aggregate metadata
the way the director is, with heartbeat freshness as liveness and re-appointment as succession.

- Follows the plan's sentence literally, and the storage location is the same aggregate the
  election result would use — the distance between the options is smaller than the contracts
  suggest.
- But the semantics invert twice. The director is **claimed** by whoever is eligible first; the
  manager is **derived** from policy — election-by-claim is a race, not an election, so the server
  would have to verify each claim against the very ranking option A computes, making the claim
  command pure ceremony. And the lease is **session**-scoped with TTL freshness, while manager
  authority is **principal**-scoped: a manager whose browser tab dies should not lose lifecycle
  authority mid-phase — their membership, not their WebSocket, is the design's stated liveness
  boundary ("succession through ordinary presence/membership machinery").
- Authorization would need a freshness read beside the policy read, adding a staleness window to
  every manager-gated mutation — the exact consistency hole decision 1 split the documents to
  avoid.

## Option C — fully derived, nothing recorded (rejected)

Managers as a pure function of live membership ranked by the epoch-pinned hash. No new state — but a
joining member can take rank 1 mid-FORMING, which is precisely correction 4's flapping manager. Fails
the constraint by construction.

## Recommendation

**Option A.** It is the straight-line continuation of decision 2.2 — the elected variants replace
their `lifecycle-manager-unavailable` rejection with a real answer derived from recorded state, and
nothing else about authorization moves. The plan's `GROUP_DIRECTOR_APPOINT` sentence should be
amended to record what survives of it: the _pattern_ (aggregate-metadata appointment under
compare-and-set) is reused; the lease semantics are deliberately not, because manager liveness is
membership, not heartbeats. The director remains the session-scoped work delegate it is.

## Consequences for the slice split, if A is taken

1. **4a — dark core:** electorate recording on epoch-advancing transitions plus the pure manager
   resolution (ranking, filter, count, succession) with its unit matrix. No preset changes; elected
   variants still unreachable through any preset, so no behaviour change.
2. **4b — wiring and visibility:** `denyForUnderivedManager` becomes full manager resolution;
   presets switch their manager dimension on (`managed` → creator with succession, `match` →
   elected-by-rank); the formation view gains the resolved manager principals so applications can
   explain who may act; recipes for manager-gated establishment, succession on departure, and the
   zero-manager fallback; mutation-path gates.

Open question that stays open: the rank source for `elected-by-rank` (application-supplied member
metadata remains the least-coupled default; decide when 4b lands the preset switch).
