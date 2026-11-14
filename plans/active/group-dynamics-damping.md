# Group dynamics damping

A room whose members keep joining and leaving is re-planned again and again, and each new layout
costs every browser more than the layout it replaces was worth. This plan damps that: the server
holds back the reshaping of a room's distribution graph while the room is restless, lets the
cheap, necessary changes through at once, and bounds how long anyone waits.

It is a plan for discussion. Nothing in it is built. The open questions at the end decide its
shape; the values in it are provisional and marked as such.

## Why

**What a new layout costs.** A promotion is not free on the browser side:

- every browser dials the edges the new layout adds;
- for the replaced-layout overlap (15 s, served in `/api/config`) each browser admits frames over
  the edges of the layout it replaced, and for the first half of it sends over both;
- a relay that changes its children re-plans its forwards, and an origin's receipts wait on hops
  that no longer carry its frames.

The overlap and the early dial are in pull request #823 (make-before-break), not on `main` yet.

**What the server does today** (on `main`):

| Mechanism         | What it bounds                                                                                                | Where                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Re-plan window    | A membership, presence or leader change re-plans after 500 ms of quiet, but never later than the max wait     | `computeTopologyReplanDueAt`, `topology/replay/work/rtc-topology-coalesced-group-revision-work.ts`  |
| Max wait          | 4 500 ms server default (`topology.recompute.formationMaxWaitMs`); 5 000 ms in the default lifecycle policy   | `defaults-config.json`, `group-lifecycle-policy-presets.ts`                                         |
| Expected members  | Once the room holds the members it expects, the re-plan is due at once (D288)                                 | the same function; `resolveTopologyExpectedMemberCount`                                             |
| Layout-age floor  | A plan is not replaced before it is 1 000 ms old                                                              | `GROUP_MINIMUM_LAYOUT_AGE_MS`                                                                       |
| Stage gate        | A `connecting` or `reconnecting` room keeps its active layout                                                 | `resolveTopologyPlanAction`                                                                         |
| Replanning policy | `auto` and `debounced` plan; `commanded` holds automatic work until the application asks                      | the same function; the lifecycle policy's `topology.replanning`                                     |
| RTT-only re-plans | Held until the layout is 15 s old; refinement at most every 30 s; a tree is kept unless 25 % and 10 ms better | `rttReplanMinimumLayoutAgeMs`, `rttRefinement.minIntervalMs`, `resolve-rtt-refinement-next-hops.ts` |
| Promotion         | An active room's plan is promoted at once; there is no cooldown                                               | `topology-promotion-request.ts`                                                                     |

**The gap.** Every bound above is a clock. None of them looks at how restless the room is. Under
steady coming and going the max wait forces a re-plan and a promotion about every 4.5 to 5 s, so each
promotion lands inside the previous layout's 15 s overlap. Evidence from #823: two promotions about
a second apart are reachable on the ordinary path (two joins in a row), and a second promotion
inside one overlap was lossy until that pull request's fix. The fix makes it safe; it does not
make it cheap.

## The balance

Two costs pull against each other.

- **Noise.** Each reshaping costs dials, an overlap window of double sending, and re-planned
  forwards on every browser of the room, including the ones that did not join or leave.
- **Wait.** While reshaping is held back, the room runs on a graph that no longer fits it: a
  joiner is served less well than it could be, and paths stay longer than they need to be.

Neither is free, so the rule is not "wait until calm". It is: **hold back only what can wait, for
no longer than a stated bound, and decide from what the room is doing.**

## The idea

**Three kinds of topology work, treated differently.**

| Kind    | What it is                                                                                      | Under damping                                      |
| ------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Attach  | A joiner gets edges to members that already have a place. Nobody else's edges change.           | At once                                            |
| Repair  | A member that others depend on left; its dependants get a new upstream. Only they change.       | At once                                            |
| Reshape | The planner recomputes the room's graph: kind, degree, parents. Many members' edges may change. | Held back while the room is restless, with a bound |

Today the planner knows one kind of work. Attach and repair are a re-plan like any other, so a
join can move members it has nothing to do with.

**The signal is the room's own behaviour, not a clock.** A layout pays for itself when it lives
longer than it costs. The server knows both: when each layout was accepted and replaced, and the
overlap it serves. Provisional signal: the room is _restless_ while its recent layouts were
replaced before they were one overlap old, or while membership changes keep arriving faster than
a stated rate; it is _calm_ when a layout has survived an overlap. Restless holds reshaping back;
calm releases it once.

**The wait has a ceiling, and what happens at the ceiling is cheap.** A room that never calms, a
lobby for example, must not run on a stale graph for ever. At the ceiling the server reshapes
once, and the ceiling then backs off (longer each time the room is still restless, up to a
maximum), so a restless room is reshaped rarely and a calm one promptly. This replaces "at least
every max wait" for reshaping only; attach and repair never wait.

**Circuit breaker is the wrong name.** A breaker refuses work after failures. This holds work back
because it would not pay for itself, and resumes on evidence that it will. The closer relatives
are back-off and route-flap damping.

## Goals

- A room under steady churn is reshaped no more often than its layouts can pay for.
- A joiner can send and receive over RTC without waiting for a reshape.
- A member whose upstream left is repaired without waiting for a reshape.
- The wait is bounded, stated, and visible: the server records why a reshape was held and when it
  is due.
- One pure rule decides, in `packages/shared-server/rallar-system/topology/planning/`, tested
  without a server. No per-application special case.

## Non-goals

- Changing what the browser does with a promotion (#823 owns that).
- A new topology kind, or a change to how a full plan is computed.
- Damping RTT-only re-plans further; they are held 15 s already.
- Replacing the lifecycle policy's `commanded` mode, which already hands the decision to the
  application.

## What would make this a failure even if it works

- A joiner waits for a calm room before it has an RTC path.
- A departed relay's dependants stay cut off while the server waits.
- The rule needs tuning per room size or per application to behave.
- A second clock is added beside the three that exist, and the room is still reshaped on a timer.

## Slices

The plan keeps two slices in view; later ones are decided by what these find.

### Slice 1 — measure before deciding

Nothing here changes behaviour.

- Record, per room, each accepted layout's lifetime and the cause of the re-plan that replaced it
  (join, leave, leader change, config, RTT), where the server already writes its topology replay
  facts. No new store.
- One black-box recipe that drives a room through a formation burst and through steady churn (a
  member joins or leaves every few seconds) and reports: promotions per minute, the share of
  promotions that landed inside the previous overlap, and how many members' edges each one
  changed.
- From that, the numbers the rule needs: how often a join or a leave changes edges of members it
  does not involve today, and what a reshape costs against what it gains.

Done when the recipe's report exists for `auto` and `debounced` rooms of three sizes and the
figures are in the pull request.

### Slice 2 — attach and repair without a reshape

- The planner gains an incremental path: given the accepted layout and one membership change, it
  returns the smallest change that gives a joiner its edges, or a departed member's dependants a
  new upstream, within the degree limit. When no such change exists it says so and a reshape is
  due.
- The existing full plan stays the reshape path.
- Pinned by planner tests: a join changes only the joiner's edges and its new neighbours'; a
  leaf's leave changes nobody else; a relay's leave changes only its dependants.

Done when the recipe of slice 1 shows joins and leaves no longer move uninvolved members.

### Later, decided after slice 2

- The restless and calm rule with its ceiling and back-off, as one pure function with the
  lifecycle policy's `topology` section as its only configuration.
- Folding in the two server paths that re-plan without the tree-keeping gate (leader rooting
  after a failed update, the mesh rebuild), which #823 leaves for a follow-up.

## Validation

- Planner and rule: unit tests under `packages/tests/shared-server/rallar-system/topology/`.
- Mutation paths change in slice 2 (a plan is written differently): AppInbox doctrine applies,
  and `test:api-v1:black-box:postgres:medium-scale` runs unweakened.
- The churn recipe of slice 1 is the before-and-after measure for every later slice.
- A hosted run is guidance, not a gate, and needs the maintainer's go-ahead each time.

## Open questions for the maintainer

Each has the plan's provisional answer and what it costs if that answer is wrong.

1. **Which restlessness matters most: the burst while a room fills, or steady coming and going in
   a long-lived room?** Provisional: both, steady churn first, because the burst already has the
   expected-members rule. Cost if wrong: the first slices measure the less important case.
2. **What may a joiner experience while reshaping is held?** Provisional: it is attached at once
   with a correct but possibly long path, and WS carries its traffic until its first edge is
   open. Cost if wrong: if a joiner must have the best path from its first second, attach cannot
   be cheap and the damping has little to hold back.
3. **How long may a restless room run without a reshape?** Provisional: a ceiling of one overlap
   (15 s) that doubles while the room stays restless, up to one minute. Cost if wrong: too short
   and nothing is damped; too long and a lobby runs on a poor graph.
4. **Who decides: one server-wide rule, the room's lifecycle policy, or the application?**
   Provisional: the rule is server-wide and the lifecycle policy's `topology` section carries its
   two bounds, as it carries the window and max wait today. Cost if wrong: either every
   application inherits one behaviour it cannot change, or every application must choose.
5. **May the max wait (product decision 31) change meaning?** Today it promises a re-plan within
   that time. Under this plan it would promise an attach or a repair within that time, and a
   reshape within the ceiling. Cost if wrong: the plan must keep reshaping on the max wait and
   can only damp below it.
6. **Is a measuring slice acceptable before any behaviour changes?** Provisional: yes. Cost if
   wrong: the rule's bounds are chosen by argument, not from the room's behaviour.
7. **Order against the other work.** Provisional: after make-before-break (#823) merges, and this
   plan absorbs that pull request's follow-up for the two ungated re-plan paths. Cost if wrong:
   two slices touch the same planner files at once.
