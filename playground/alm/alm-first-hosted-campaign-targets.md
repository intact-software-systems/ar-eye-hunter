# First hosted campaign: targets

Ruled by the maintainer: 2026-11-13 (D643 in the [improvement roadmap](alm-improvement-plan.md)).

D642 ends its ruled sequence with a first campaign on the three-replica fleet and leaves the campaign's targets to the
maintainer. This document records those targets: what is run, what counts as passing, what is only reported, and what
must exist before the first run.

**What this document is not.** Nothing in it is a measurement of the campaign. Every number is either a repository fact
with its source, or a value chosen for this campaign and marked as such; a chosen value is not a repository number.
Hosted results stay guidance (D434) until a later decision says otherwise. The addendum (§9) says a numeric service
level needs its own representative workload and not a copied historical figure, so a level that no run has yet
informed is reported first and set afterwards.

## 1. The fleet today

- Three servers: `api` in fsn1 (api-v1, Caddy, a local Postgres), `control` in hel1 (control server and headless
  workers), `games` in hel1 (`scripts/hosted-rallar/controller/README.md`, server table).
- The api role runs three api-v1 replicas on ports 8080, 8081 and 8082 behind one Postgres, with
  `RALLAR_DB_PUBSUB=postgres` for cross-instance fanout. Caddy health-checks `GET /api/config` and skips a replica that
  is down, so a down or restarting replica costs no new HTTP request or WebSocket upgrade
  (`scripts/hosted-rallar/controller/rallar-controller-role.sh`, the replica block near the top).
- Postgres is one local instance on the api host. There is no failover.
- Browser agents come from one of two flows:
  - `Run GitHub Free Distributed Recipe` in `hetzner-control` mode runs the browsers in GitHub-hosted jobs: 3 agents per
    job, 50 agents and 17 parallel jobs by default, at most 19 jobs
    (`.github/workflows/github-free-distributed-recipe.yml` inputs;
    `scripts/hosted-rallar/actions/plan-github-free-headless-matrix.mjs`, `MAX_GITHUB_FREE_AGENT_JOBS`). The agent job
    has `timeout-minutes: 75`, so no run can exceed 75 minutes.
  - `Run Hetzner Distributed Recipe` runs the workers on the single `HETZNER_HOST`, the api host
    (`plans/active/deno-to-bun-validation.md`, "Follow-up (out of scope here)"; `plans/backlog.md`, the entry on workers sharing the api
    host), so the load generator shares the API's machine. The campaign does not use it.
- Every hosted manifest uses one room: one effective group per run, unique to the workflow run attempt
  (`.agents/skills/rallar-hetzner-ops/SKILL.md`, "Do not reset the database").
- The workflow concurrency group `hetzner-production-distributed-recipe` queues every distributed run, the main-push
  `Run Hetzner Supported Distributed Manifests` included (`.github/workflows/hetzner-supported-distributed-manifests.yml`,
  `github-free-distributed-recipe.yml`, `hetzner-distributed-recipe.yml`: each `concurrency` block).
- Hosted formation time is paused and hosted results are guidance (D434).

### Load anchors

Logical deliveries per second are the manifest's `logicalFanoutMessages` divided by its run length.

| Manifest                 | Agents | Shape                                          | Deliveries per second | Hosted result recorded                                                                                                                                                                                            |
| ------------------------ | ------ | ---------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21 ALM conformance       | 50     | one director, 6 shots plus 2 lifecycle in 30 s | 392 / 30 = 13         | Passed (run 43131389341); failed once before it on an RTT re-plan (`plans/active/deno-to-bun-validation.md`)                                                                                                      |
| 23 principal tree, 2 Hz  | 15     | 1 sender, 78 minutes                           | 131,040 / 4,680 = 28  | None found                                                                                                                                                                                                        |
| 07 principal tree, 20 Hz | 50     | 1 sender, 30 s                                 | 29,400 / 30 = 980     | After #813 (run 43382453664): the failing step named 2 of 49 receivers under 570 of 600 frames; the recorded events show 8. A re-plan without make-before-break (section 4). See the comment on pull request #813 |
| 09 all-peer tree, 5 Hz   | 50     | 50 senders, 30 s                               | 367,500 / 30 = 12,250 | After #813 (run 43383760956): 9 agents at 0.89 to 0.94 send success against 0.95, in 2 to 3 s bursts of `RALLAR_BB_RTC_SEND_FAILED`. The same cause (section 4). See the same comment                             |

The evidence supports this pattern: 50 agents pass at about 13 deliveries per second and fail at 980 and 12,250. Whether
50 agents pass at about 100 per second is not established. The two failures are not a size limit: section 4 gives the
cause, which applies at any room size.

## 2. Targets

### 2.1 Size, shape and duration

| Target             | Ruled value                                                                                                            | Rests on                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First rung         | 15 agents, one room, one publisher at 2 messages a second, 3 API replicas                                              | Manifests 10 to 12 and 23 are 15-agent manifests (`apps/rallar-black-box/manifests/hetzner/`). Manifest 23 has the same load, 28 deliveries per second (`hetzner-multicast-manifest-entries.ts`, `rateHz: 2`, `participantCount: 15`). Hosted formation at 15 passed (D435, manifest 19; guidance).                      |
| Stretch rung       | 50 agents as five rooms of ten, one publisher per room at 2 messages a second: 5 x 2 x 9 = 90 deliveries per second    | Manifest 21 passed at 50 agents on this fleet at about 13 deliveries per second; manifest 07 fails at 980. 50 is the fleet's design size (17 jobs of 3 agents is 51). Five rooms of ten is chosen for this campaign; it is not a repository number. A multi-room hosted run needs the workload family's group parameter. |
| Measurement window | 5 minutes, starting after every agent is connected and traffic-ready                                                   | The hosted windows today are 30 s (manifests 07, 09, 21) and 78 minutes (manifest 23). 30 s gives 60 frames per receiver at 2 Hz, too few for a tail; 5 minutes gives 600. 78 minutes does not fit the 75-minute job cap once connect time is added.                                                                     |
| Carriers           | `rtc` is the headline. `ws` is the control. `rtc-with-ws-fallback` runs as well, and carries the fault legs with `rtc` | The addendum's "After Slice 9" names the three carriers (`packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts`). Hosted large manifests carry `messages.rtc` only (`create-alm-scale-manifest-entries.ts`). `ws` is the run that isolates the API from the browser mesh.                     |
| Cadence            | Declared per run and reported beside the measured rate                                                                 | Addendum §9: never call the configured cadence a measured delivered rate.                                                                                                                                                                                                                                                |
| Agent source       | `hetzner-control` mode: browsers on GitHub-hosted runners, off the api host                                            | The 50-agent evidence all came from it. The other flow loads the api host with its own load generator (`plans/backlog.md`).                                                                                                                                                                                              |
| Database           | The existing single Postgres on the api host                                                                           | README server table. Failover is out of scope (section 3).                                                                                                                                                                                                                                                               |
| Payload size       | The byte sizes the games' real frames send, measured first in one small task and then used as they are                 | No repository number states the size of an AR Eye or position frame. Until the task is done the size is not established.                                                                                                                                                                                                 |

### 2.2 Faults and recovery

| Target               | Ruled value                                                                                                                                                    | Rests on                                                                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fault 1: one replica | On the first rung, one of the three API replicas is stopped for 30 s, then started. Run on `rtc` and `rtc-with-ws-fallback`                                    | The role script keeps new requests off a down replica. Sessions already on it drop and reconnect, which is what the leg measures. The 30 s is chosen for this campaign. No hosted fault step exists (section 5).                                               |
| Fault 2: seeded loss | On the first rung, 10 % seeded message loss in the browsers. Run on `rtc` and `rtc-with-ws-fallback`                                                           | Chosen for this campaign. Whether a seeded loss command to the browser can run hosted without a controller step is not verified.                                                                                                                               |
| Recovery that passes | Within 45 s after the fault ends: every receiver is back above the delivery level (section 2.3), no message was delivered twice, and every receipt has settled | 45 s is `RALLAR_BLACK_BOX_RTC_READINESS_TIMEOUT_MS` (`packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts`), the budget for a cold RTC edge, taken here as the recovery budget. No recorded hosted reconnect figure exists to anchor a tighter one. |

One replica is the limit of the campaign's fault tolerance (section 3).

### 2.3 Service levels that pass

| Target                       | Ruled value                                                   | Rests on                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery, one publisher      | Each receiver gets at least 95 % of that publisher's messages | Manifests 07, 10 to 15 and 23 use `minReceiveRatio` 0.95 (`packages/shared-test/rallar-bb-test/fixtures/rtc-multicast-recipes.ts`, the `minReceiveRatio` default; manifest 07: 570 of 600). On the first rung's window, 570 of 600. |
| Delivery, several publishers | At least 90 %                                                 | The same default is 0.9 when every peer sends (manifest 09 metadata).                                                                                                                                                               |
| Send success                 | Each publisher at least 95 %                                  | `minSendSuccessRatio` 0.95 in manifests 07 and 09. The schema allows 0 to 1 (`packages/shared-test/rallar-bb-test/schema.ts`); a recipe-console fixture uses 0.99 (`recipe-console-tune-scale-fixture.ts`).                         |

### 2.4 Reported, not gated

Each of these is recorded with every run. None can fail a run until a level is set.

| Figure                                  | Rule                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery latency and missed windows     | Report median, 95th and 99th percentile of delivered sample age (from payload timestamps, D642) and the share of missed windows. A level is set afterwards from two runs of the same build.                                                                                               |
| API replica memory                      | Report resident memory per replica. A ceiling is set afterwards from two runs of the same build. The existing bounds are per browser session, not per replica.                                                                                                                            |
| Connect time                            | Report it. Hosted formation time is paused (D434).                                                                                                                                                                                                                                        |
| Direct connections that failed          | Each report lists the browser pairs that could not connect directly (section 3, TURN).                                                                                                                                                                                                    |
| Regions                                 | Each report states that the agents' region was not controlled: GitHub-hosted runners take no region input in any workflow, and the servers are in fsn1 and hel1.                                                                                                                          |
| Store size                              | Each run records the hosted store's row counts. Runs are compared only at a similar store size.                                                                                                                                                                                           |
| Send duration, 95th and 99th percentile | Report them. The recipes' existing budgets are 200 ms and 1,000 ms at 2 agents and 2,500 ms and 4,000 ms at 50 agents (`apps/rallar-black-box/src/hetzner/hetzner-rtc-manifest-entries.ts`, `hetzner-multicast-manifest-entries.ts`). They are send-call durations, not delivery latency. |
| ALM per-session counters                | Sample every 5 s. The scale recipe's limits are 1,000 admissions, 4,194,304 bytes, 300,000 ms oldest age, 64 tracks, 512 ordering tracks, no overload and no congestion drop (`create-alm-scale-acceptance.ts`).                                                                          |

### 2.5 Repetitions, environment and what counts as a result

| Target                  | Ruled value                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs per point          | 2, of the same build, on the same fleet state and shape.                                                                                                                                                             |
| When a rung passes      | Both runs of every point pass and agree within a band declared from those two runs. A red run is reported, not dropped, and the point is rerun as a new pair.                                                        |
| Runs for the first rung | The full rung: 3 carriers x 2 = 6 steady-state runs, plus fault 1 on 2 carriers x 2 = 4, plus fault 2 on 2 carriers x 2 = 4. Total 14.                                                                               |
| Approval                | The campaign needs its own go-ahead before its first run. The standing approval covers exactly two hosted guidance runs (D642).                                                                                      |
| Baseline                | The local half of a same-regime baseline is built first (D642; D31), then a hosted same-build-twice pair.                                                                                                            |
| Database between runs   | No reset; a unique group per run (the operations rule in section 1). The row counts in section 2.4 let a reader tell drift from change.                                                                              |
| Scheduling              | A campaign run starts only while no push to `main` is pending. Merges to `main` are held until a compared pair has finished. The shared concurrency group queues every run behind the main-push manifests otherwise. |

## 3. Out of scope

- TURN. The controller writes `RALLAR_ICE_MODE=local`, which returns no ICE servers, until Metered is configured with
  `METERED_APP_NAME` and `METERED_API_KEY` (`scripts/hosted-rallar/controller/README.md`, the Metered TURN section).
  Cross-region RTC may fail without it, and that is part of what a report shows through its list of pairs that could
  not connect directly. Whether the live API returns Metered servers is not established from the repository.
- Loss of the api host, and a Postgres restart or failover. Each has no mechanism and no designed recovery claim, and
  each is its own slice starting with a design.
- A relay partition, one RTC edge cut while the others stay. No fault step exists and the transport fault port sees no
  edge (`plans/backlog.md`).
- A database-session cut and a sustained-overload leg. Neither is part of these targets.

## 4. First rung and stretch rung

**What caps both rungs.** The 50-agent RTC delivery loss is a layout re-plan landing inside a running stream, in a browser
without make-before-break routing, which is what those runs measured (built since: D645). This was found by an analysis of the recorded events of runs
43382453664 (manifest 07) and 43383760956 (manifest 09); the repository itself cannot show it.

- The server published a new tree layout around or inside the stream (layout 635 in run 07, 653 in run 09). Each browser
  then routed only over the new layout's edges before those edges were open. For 0.7 to 2.4 s a sender or relay dropped
  its own sends (`planner-drop`, "No downstream forwarding candidates resolved for group message", which is the recipe's
  `RALLAR_BB_RTC_SEND_FAILED`), a receiver refused frames still arriving from its old parent (`unauthorized`), and a relay
  that had switched stopped forwarding.
- It was not a link drop, backpressure or CPU starvation. In run 07, 8 of 49 receivers ended under the delivery level, all
  of them with a changed parent; six were still polling when the run ended, so the failing step named only 2.
- It is not a 50-agent limit. The RTT re-plan minimum layout age defaults to 15 s (`rttReplanMinimumLayoutAgeMs` in
  `apps/api-v1/resources/configuration/defaults-config.json`; environment name
  `RALLAR_RTC_TOPOLOGY_RTT_REPLAN_MINIMUM_LAYOUT_AGE_MS`, read in
  `apps/api-v1/src/configuration/read-api-v1-configuration-environment.ts`), and #810's churn gate was in the build. The
  layouts replaced in the two runs were 32 s and 37 s old. A re-plan can therefore land inside any stream longer than 15 s,
  at any room size, including the first rung's 5-minute window.
- Make-before-break routing, where a new layout's edges open before routing moves to them, is built (D644, D645). No hosted
  run has read it yet, and a hosted read is the prerequisite of the first rung and of the stretch rung.
- Reproduced in unit tests of the routing code before D645, for an at-least-once and a best-effort frame: a browser routed only over
  the layout it held as accepted and kept no copy of the previous one, and in an active or reconfiguring group
  the new layout's edges were dialled only after the switch, so all three signatures appear while the previous edges are
  still open (dropped links stay open for 15 s). With the layout switch removed from the same fixtures, every frame is
  delivered.
- The `unauthorized` refusal is confirmed from the code: a hop that is not a neighbour in the accepted layout is refused
  with "RTC relay edge is not permitted by current server room topology", and no NACK is sent
  (`resolveRtcRoomEdgeDenial` in `packages/shared/multicast/room-authority/rtc-room-snapshot-admission.ts`).
- Still open: which server path produced the two hosted re-plans, with neither run recording the server's planning
  decision. Two paths can switch to a high-churn layout with no membership change and both skip #810's churn gate: the
  rebuild used as it is when a tree's leader-rooting or an update failure asks for a full rebuild, and the mesh rebuild,
  which is used unconditionally. Which applied is not verified. Also open: run 09's full coverage (22 recorded agents),
  and a browser-level reproduction. Three browsers form a star, whose plan ignores RTT, and a leaderless tree on loopback
  never passes #810's gate, so the only local trigger is an owner's topology reconfigure mid-stream, which needs a new
  spec. There is no local figure for frames lost or for the gap's length.

**First rung.** 15 agents, one room, one publisher at 2 messages a second, a 5-minute window, 3 API replicas; `rtc`,
`ws` and `rtc-with-ws-fallback`, plus the two fault legs on `rtc` and `rtc-with-ws-fallback`.

- The load equals manifest 23's, a manifest the catalog already carries.
- Formation at 15 passed hosted (D435).
- Manifest 21 passed at 50 agents on this fleet at about 13 deliveries per second.
- Browsers run on GitHub-hosted runners, off the api host.
- It waits for a hosted read of make-before-break routing (D645): a 5-minute window is long enough for a re-plan to land inside it.
- Not established: that any 15-agent delivery manifest has a recorded hosted pass. The first action is to find or make
  one.

**Stretch rung.** 50 agents as five rooms of ten, one publisher per room at 2 messages a second, 90 deliveries per
second. Five publishers per room would be 450 per second, about half of manifest 07's failing load, and waits.

It is not attempted until a hosted run has read make-before-break routing (D645). Other known limits:

- A re-plan in the middle of a window can fail a run for a reason that is not the platform's service level until then
  (`plans/active/deno-to-bun-validation.md`).
- Hosted load generators vary run to run: 17 concurrent GitHub jobs at 50 agents, connect 32 to 69 s on the two runs
  above (see the comment on pull request #813).
- No hosted fault step, and no relay-partition step.

## 5. Before the campaign can be measured

From D642 and the addendum's "After Slice 9":

1. **Lane determinism.** Every lane cell starts from a declared, settled room.
2. **Make-before-break routing in the browser** (D644, built in D645). A re-plan landing in a stream drops
   sends and refuses frames without it (section 4), at any room size; the build has no hosted read yet.
3. **Publication figures.** Selection age, missed windows, drain usage, congestion duration in the stage, and one
   bounded histogram with a nearest-rank percentile in `packages/shared/measurement`. Without them the reported figures
   in section 2.4 have no numbers to read.
4. **A local same-regime baseline.** An environment record and a comparator whose band is declared from two runs.
5. **Delivered sample age from payload timestamps.** The workload carries a timestamp; no envelope field (D642).
6. **Platform fault steps**, locally first: the runner `SERVER` step, the database-session cut, seeded loss and
   jittered delay.
7. **Receipt truth and the held-send path**, so a settled receipt in the recovery rule is true.
8. **The publication workload family.** Rate, publisher count, group count, drain budgets, payload, subscription churn
   and seeded loss as parameters, and a hosted manifest whose roles resolve their principals at run time
   (`plans/backlog.md`, the entry on the hosted four-agent manifest).
9. **Probes at the owners**, so a miss can be assigned to an owner.
10. **The byte sizes of the games' real frames**, measured once.
11. **A hosted fault step in the controller scripts.** The replica stop of fault 1 needs a controller step over the api
    role's systemd units (`RALLAR_ROLE_APP_SERVICES`). It does not exist (`plans/backlog.md`).
12. **The connect fix, met.** Pull request #813 is merged. On `main` at `2eb11a707`, manifests 07 and 09 failed at
    `rtc.connect` with a 10 s command timeout (the two `main` runs 43362135791 and 43363180415); the recipe now names a 65 s connect
    bound. Runs 43382453664 (manifest 07) and 43383760956 (manifest 09) connected every agent and failed later, on
    delivery. The runs are recorded in the comment on that pull request and in its squash commit message.
13. **The campaign's own go-ahead** for about 14 hosted runs on the first rung (section 2.5).

## 6. Not established

- Whether any hosted 15-agent delivery manifest has a recorded pass.
- Whether the live API returns Metered ICE servers.
- Whether a seeded loss command to the browser can run hosted without a controller step.
- The byte sizes of the multicast position frame and the AR Eye fixtures.
- How many agents a single GitHub-hosted runner can carry beyond 3 per job.
- Which server path produced the re-plans of runs 43382453664 and 43383760956; neither run records the server's
  planning decision. The candidates are the rebuild used as it is for a tree's leader-rooting or update failure, and the
  unconditional mesh rebuild; both skip #810's churn gate.
- Run 09's full coverage: the recorded events cover 22 agents.
- A browser-level reproduction of the loss, and any local figure for frames lost or the gap's length. The routing code
  reproduces it in unit tests only.
