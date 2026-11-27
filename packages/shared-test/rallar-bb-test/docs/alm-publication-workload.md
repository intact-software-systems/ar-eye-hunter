# ALM publication workload family

The family lives in `conformance/alm/publication-workload/`. One point of it is one or more rooms of
one shape, all run at once: in each room one or more publishers each send paced `live` publications
and every other agent subscribes. A run of a point gives a figures record: what the point asked
for, beside what the run observed, with the ages of the delivered samples of each subscriber, of
each room and of the point. The family builds recipes and reads results. It starts no browser and
holds no manifest; a caller puts the recipes into a distributed run.

## A point

`PublicationWorkloadParameters` has no default: a caller states every field.
`validatePublicationWorkloadParameters` returns every issue of a point, each under its `$.field` path.
A field reports the first bound it breaks; each group, under `$.groups[n]`, `publication` and
`loss` report every issue of their own validators. A bound stated against another field is checked only when that
field holds its own bound; a group with an issue of its own is held to no rule among the groups.

| Field                 | Bound                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `groups`              | One or more valid group references, no two alike, all in one application and workspace: the rooms of the point.                      |
| `participantCount`    | A whole number from 2 to 50: the agents of each room.                                                                                |
| `publisherCount`      | A whole number of at least 1 and at most `participantCount - 1`: the agents of each room that publish. Every other agent subscribes. |
| `carrier`             | `ws`, `rtc` or `rtc-with-ws-fallback`.                                                                                               |
| `publishIntervalMs`   | A positive whole number of milliseconds, at least `publication.cadenceMs`.                                                           |
| `windowMs`            | A positive multiple of `publishIntervalMs`; the frame count `windowMs / publishIntervalMs` is at most 2,000.                         |
| `publication`         | An `ALPublicationPolicy` that `validateALPublicationPolicy` passes.                                                                  |
| `payloadBytes`        | A whole number of UTF-8 bytes: at least the payload with no filler, at most 65,536 and at most `publication.drain.bytes`.            |
| `ttlMs`               | A positive whole number of milliseconds.                                                                                             |
| `minReceiveRatio`     | A share above 0 and at most 1.                                                                                                       |
| `minSendSuccessRatio` | A share above 0 and at most 1: the share of its frames each publisher's publication stage must hand to a carrier.                    |
| `readyTimeoutMs`      | A positive whole number of milliseconds: the setup's allowance.                                                                      |
| `loss`                | `{ kind: 'none' }`, or `{ kind: 'seeded', ratio, seed }`: a ratio and a seed the platform's seeded loss accepts, the ratio below 1.  |

Every room has the same shape, so a point has `groups.length x participantCount` agents, and at
most 50: more is `agent-count-above-limit` at `$.groups`, checked when `participantCount` holds its
own bound. A group that repeats an earlier one is `duplicate-group`, and one outside the first
group's application and workspace is `group-outside-first-scope`, each at `$.groups[n]`: a run signs
every one of its agents into one application and workspace. That scope is the first group's
`applicationId` and `workspaceId` alone, so a later group is held to it when those two are valid,
whatever the first group's own `groupId` is.

A point states its loss; no loss is the stated value `{ kind: 'none' }`, never an absent field,
and a point with it builds the commands it built before the field existed. A seeded loss names the
seed that repeats it, so the record of a run holds what repeats the run. Its issues, each checked
only where the fields it depends on hold their own bounds:

| Code                       | Path           | When                                                                                                                                                             |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-loss`             | `$.loss`       | The loss is of neither kind.                                                                                                                                     |
| `invalid-seeded-loss`      | `$.loss`       | One issue for each sentence of the platform's `validateSeededTransportFaultAction`: the platform owns what can be injected.                                      |
| `loss-ratio-not-below-one` | `$.loss.ratio` | The ratio is 1. No frame then leaves a publisher: that is a hold, not a loss.                                                                                    |
| `loss-drops-no-frame`      | `$.loss`       | The seed's first `minAcceptedSends` draws all pass, so the recipe's assert that the fault acted could not pass. Needs the frame count and `minSendSuccessRatio`. |
| `loss-leaves-no-frame`     | `$.loss`       | On `ws`, the seed drops every frame, so a subscriber expects none. Needs the frame count.                                                                        |

The interval, the window and the frame count are one publisher's: every publisher of a point sends
`frameCount` frames. The rate is the integer interval, so `configuredRateHz`
(`1000 / publishIntervalMs`) is never rounded. A threshold is the smallest whole count whose share
reaches its ratio: 57 of 60 at 0.95. A publisher's threshold is a share of its own frames. A
subscriber's is a share of the frames of all the room's publishers together, since it counts them
together: with two publishers of 60 frames, 114 of 120. Under a seeded loss on `ws`, the plan's
`expectedLostFrames` is the number of the seed's first `frameCount` draws below the ratio, read from
the platform's own `SeededTransportFaultDraws`, and a subscriber expects
`(expectedAdmissions - expectedLostFrames) x publisherCount`. Seed 7 at 0.25 drops sequence numbers
1, 2, 8, 12, 15, 21, 23, 24, 25, 29, 38, 39, 42, 43, 53, 54, 57 and 60 of 60 frames: 18 lost, 42
expected, 40 of them at 0.95. On `rtc` and `rtc-with-ws-fallback` `expectedLostFrames` is 0: a
refused frame is sent again. `expectedAdmissions` stays `frameCount` under any loss, since the stage
counts `admitted` when it hands a value on, before any carrier writes it.

Each frame's payload is `{ seq, sentAtEpochMs, pad }`. `payloadBytes` is its serialised size at the
last sequence number; an earlier frame is smaller by the digits its sequence number lacks.
`payloadBytes <= publication.drain.bytes` is necessary, not sufficient: the stage charges the whole
message envelope against the drain budget. One run of the `one-room` local point charged about
1.5 KiB for a 256-byte payload (`drainBytesPercent` of 2.27 on a 65,536-byte budget). That is an
observation of that run, not a contract: no test pins it.

## What a run does

`createPublicationWorkloadRecipes(parameters)` returns `{ rooms: [{ group, roles }] }` with one room
per group of the point, in the groups' order, or every validation issue as its left
(`RallarValidationIssue[]`). A role is `{ kind, recipe, agentCount }`: its `kind` is `publisher` or
`subscriber`, and `agentCount` is how many agents of the room run its recipe. A room's roles come in
this order: the publisher that writes the group (one agent), the joining publishers
(`publisherCount - 1` agents, absent for one publisher), the subscribers. Which agent runs which
recipe is not the family's to say, since it holds no manifest: the caller's role-map manifest gives
each recipe to its agents.

Every room runs the same commands in its own group. A recipe's `recipeId` is
`publication-workload-room-<n>-<publisher|joining-publisher|subscriber>`, with `n` the room's place
among the groups counted from 1, and its `name` carries the same number. Nothing else carries the
room: command ids, connection names and barrier ids are the same in every room. So every room's
results are read by the same command ids, and all rooms meet at the same four barriers and start
their windows together. It also means that an agent that fails before a barrier fails the agents of
every room there, not only its own room's, and that an agent that stalls holds every room at the
next barrier until that barrier times out.

Every role first runs the cohort setup the scale family also uses (`conformance/alm/cohort/`): sign
in, the first publisher's group, the connects, the audience wait, an accepted RTC layout that stays
stable, and the `setup-complete` barrier. A joining publisher joins the group as a subscriber does,
once a peer exists, under the first publisher's command ids and connection name. The setup is the
same for all three carriers. A `ws` point is therefore WS sends in a room that has also formed its
RTC layout; the conformance lane's `ws` cells connect on `messages.ws` and open no RTC lane.

Each publisher then runs:

1. Under a seeded loss, `publication-workload-publisher-loss-arm`: a `fault.inject` of fault id
   `publication-workload-loss` on `ws` for a `ws` point and on `rtc` otherwise, matching the frame
   type, with `action: { loss: { ratio, seed } }` and `remaining: 'until-cleared'`.
2. A `loop` of one `messages.send` per frame, `publishIntervalMs` apart, with `purpose: 'live'`, the
   point's publication policy, carrier and `ttlMs`.
3. A pause of `publication.cadenceMs + ttlMs`. After it the stage holds no frame of the window, so
   its counters are final, and no frame of the window is still resubmitted. A long lifetime
   lengthens every run by that much.
4. Under a seeded loss, `publication-workload-publisher-loss-release`: the same fault with
   `remaining: 0`, whose result's `acted` counts are the fault's totals.
5. `stats`, then the `complete` barrier, whose timeout holds every command of the window, the two
   fault steps included.
6. Its gate: the stage's `admitted` counter is at least `minAcceptedSends`; under a seeded loss,
   then `publication-workload-publisher-assert-loss-acted`: the release's `acted.drop` is at least 1.

A subscriber waits at the `complete` barrier and then runs:

1. `messages.received` for the frame type, with `count: minExpectedInboundMessages`,
   `ageFrom: 'sentAtEpochMs'` and a window of `ttlMs`. The count is by frame type, so it takes the
   frames of every publisher together: a subscriber can reach it though one publisher delivered
   little.
2. Its gates: no message without an age, as many ages as messages, and no more messages than the
   plan's `expectedInboundMessages`: the room's publishers' frames together, less those a `ws` loss
   drops. A subscriber arms no fault.
3. `stats`.

The subscriber's recipe asks for a `full` event history, because the count reads the page's whole
inbound log. A distributed manifest that names its own `eventHistory` replaces it, so a manifest of
the family names none. A barrier id is used once per control run, so each run needs a control run of
its own. A subscriber whose count fails stops there: its `received` value is recorded, its `stats`
is not. A publisher that fails in its window fails every other agent of the run, in every room, at
the `complete` barrier.

## The local points

```sh
npm run test:rallar:full-stack:memory:publication-workload
RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT=two-rooms npm run test:rallar:full-stack:memory:publication-workload
RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT=one-room-ws-loss npm run test:rallar:full-stack:memory:publication-workload
RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT=one-room-rtc-loss npm run test:rallar:full-stack:memory:publication-workload
```

`tests/playwright/rallar-black-box/full-stack-publication-workload.spec.ts` holds four points, one
test each, and a fifth test that fails the run when `RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT`
names none of them. A run of the script runs the point the variable names, `one-room` where it is
unset, and skips the other points' tests. A point is a distributed run on headless agents against
the in-memory API. Every point sends 500 ms apart, 256-byte payloads with a 5 s lifetime. The two
loss points are `one-room` under the conformance lane's seeded loss, a quarter from seed 7, whose
first lost frames the lane already pins.

| Point               | Carrier | Loss             | Rooms | Agents a room | Publishers a room | Window | Frames a publisher | `minSendSuccessRatio` | `minReceiveRatio` |
| ------------------- | ------- | ---------------- | ----- | ------------- | ----------------- | ------ | ------------------ | --------------------- | ----------------- |
| `one-room`          | `rtc`   | none             | 1     | 3             | 1                 | 30 s   | 60                 | 0.95                  | 0.95              |
| `two-rooms`         | `rtc`   | none             | 2     | 3             | 2                 | 15 s   | 30                 | 0.95                  | 0.9               |
| `one-room-ws-loss`  | `ws`    | 0.25 from seed 7 | 1     | 3             | 1                 | 30 s   | 60                 | 1                     | 1                 |
| `one-room-rtc-loss` | `rtc`   | 0.25 from seed 7 | 1     | 3             | 1                 | 30 s   | 60                 | 0.95                  | 0.95              |

Over `ws` the seed decides which frames are lost, so `one-room-ws-loss` asks for exactly what it
expects: the stage hands on all 60 frames, and each subscriber counts exactly the 42 the loss lets
pass and refuses a 43rd. `one-room-rtc-loss` keeps the family's band of 0.95, which is a band for a
loaded machine and not a loss allowance: at this ratio a frame is lost only after about ten refusals
in a row at one hop, or on a page that stalls for most of a publish interval, while a product that
stopped resubmitting a refused frame would deliver about three quarters and fail it.

The test's manifest is a role map with one role per recipe, named by the recipe's id, so each recipe
runs on its own agents and on no other. The agents are handed out in the order the rooms and their
roles come: in `two-rooms`, `controller-01` and `controller-02` publish in the first room and
`controller-03` subscribes there, and `controller-04` to `controller-06` do the same in the second.
The test's worker gives every agent the manifest's one group as its identity, which is the first
room's, so a second room's agents register under the first room's group. The run still resolves its
targets, because every agent reports the group the manifest names; an agent's reported group is
therefore no evidence of the room it ran in. Its recipe id is.

Three runs in a row of `one-room` and of `two-rooms`, when they were the family's only points,
passed on one 4-CPU machine that other work was using at the time. From the command to its exit, `one-room` took 58.8, 62.4 and 63.5 s, and `two-rooms` took 52.3, 50.0
and 52.1 s; the tests themselves took 52.5 to 57.5 s and 45.0 to 46.4 s. `two-rooms` is the shorter
because its window is half as long, though it has twice the agents. In all six runs every
publisher's stage admitted every one of its frames, and every subscriber observed every frame of its
room, 120 messages a point: two subscribers of 60 frames in `one-room`, and two rooms of one
subscriber of 2 x 30 frames in `two-rooms`, so the merge inside a room ran only in `one-room`, and
the merge across rooms only in `two-rooms`. The point's delivered sample age had its median in the
10 to 20 ms bucket in all six runs; its largest age was 63, 72 and 31 ms in `one-room` and 105, 72
and 78 ms in `two-rooms`. These are observations of those runs on one machine, where the two clocks
of an age are one clock. No test pins them, and none of them is a level.

Three runs in a row of each of the four points passed from one committed tree, on one 4-CPU machine
that other work was using at the time. From the command to its exit, `one-room-ws-loss` took 68.9,
62.5 and 69.7 s and `one-room-rtc-loss` 65.1, 67.8 and 76.9 s; `one-room` took 66.2, 66.7 and
57.1 s and `two-rooms` 51.7, 51.1 and 53.4 s. In every run of `one-room-ws-loss` the publisher's
stage admitted 60 frames, its fault dropped 18 sends, and each subscriber observed 42: the 18 the
seed names. The point's median age was in the 20 to 50 ms bucket and its largest age 310, 62 and
76 ms: a lost frame has no age, so the histogram is the carrier's own. In every run of
`one-room-rtc-loss` the stage admitted 60 frames, the fault dropped 37 sends, and each subscriber
observed all 60. The median stayed in the 10 to 20 ms bucket, the 95th percentile was in the 100 to
200 ms bucket (100-181, 100-174 and 100-172 ms), and the largest age 181, 174 and 172 ms, where the
two points without loss had their 95th percentile at or under 100 ms. That every run dropped 37 is
what the seed gives when a fault is asked until 120 sends have passed, in a room of three where the
publisher sends straight to both other members: it is an observation of that layout, not a property
of the product, and no test asserts it.

A run of the script runs one point. Playwright always starts the in-memory API itself and refuses to
run while its port already answers. It starts the headless SPA and the control server only when
nothing answers on their ports; with `CI` set it starts those two itself as well. The API must be new
to the point: every launch gives the same users, `controller-01` onward, a new password, so two
points cannot share one API. The control server keeps whole results only in recorder storage, which
the script puts under `tmp/publication-workload/recorder` unless `RALLAR_BLACK_BOX_STORAGE_DIR` names
another directory. The default directory is reused from run to run and grows with each.

The test asserts that the run passed and that the figures record could be read, then on the record,
for each room: it holds the figures of every publisher and every subscriber; each publisher's stage
admitted at least `minAcceptedSends`; each subscriber observed at least `minExpectedInboundMessages`
and at most `expectedInboundMessages`, left no sample unrecorded, and its oldest sample is younger
than the window; the room's `delivered` figure states a sample age and counts the messages of all
its subscribers. For the point, the delivered sample age holds as many ages as the rooms' together.
Each page, a publisher's too, ran on a `full` event history with no evicted event and no capture
gap, and its `stats` read `rallar.alm.overloaded` as `false`. Under a seeded loss it also
asserts that each publisher's `droppedSends` is at least 1, and for a `ws` point that each
subscriber observed exactly its room's `published.admittedFrames` less `published.droppedSends`: two
measured counts, which hold whatever frames the stage handed on, where a count against the plan
would not. The test asserts no latency level, no percentile and no rate. The record is attached to the test as `publication-workload-figures.json`,
beside the operator's native evidence in `observation/`.

No CI lane runs the tests. The app browser lane's `npm run test:rallar` lists the file, as it lists
every full-stack spec, and skips every test because it does not set the opt-in environment. Only
these four points have a test that runs them. A `ws` point without loss, an `rtc-with-ws-fallback`
point with or without loss, points of two publishers on every carrier with or without loss, and
five rooms of ten are checked against the recipe schema, the control validation and the distributed
preflight only.

## The figures record

`toPublicationWorkloadFigures({ parameters, rooms: [{ group, publishers, subscribers }] })` reads
the result values of four commands: each publisher's `publication-workload-publisher-frames`
(`loop`), `publication-workload-publisher-stats` (`stats`) and
`publication-workload-publisher-loss-release` (`lossRelease`, `undefined` for a point with no loss),
and each subscriber's `publication-workload-subscriber-received` (`received`), every one beside its
`agentId`. `rooms`
holds one entry per group of the point, in the groups' order, and each names the `group` its results
were read under. A room holds one result per publisher and one per subscriber of the point,
`publisherCount` and the plan's `subscriberCount` of them: a run that left fewer is no run of the
point. A run names an agent once, whatever the room and the role, since an agent runs one recipe in
one room: a result given twice would count its messages twice, in its room's figures or, given to
two rooms, in the point's. Its left is `readonly string[]`: every field it could not read, each
starting with the field's path, which is `$.parameters...`, `$.rooms` for another number of rooms
than the point's, `$.rooms[r].group` for a room that names another group than the point's at that
place, `$.rooms[r].publishers` or `$.rooms[r].subscribers` for another number of results than the
point has agents of that role, `...publishers[p].agentId` or `...subscribers[s].agentId` for each
result that names an agent an earlier result of the run names, `$.rooms[r].publishers[p].loop...`,
`$.rooms[r].publishers[p].stats...`, `$.rooms[r].publishers[p].lossRelease...` (a seeded point's
release with no readable `acted` counts, or a release for a point with no loss) or
`$.rooms[r].subscribers[s].received...`. The issues come in
that order: the point's, the rooms', the repeated agents', then the fields of each result. A run
that breaks several has all of them in its left. A point that breaks a bound has no plan, so its
results are not counted against it. The record keeps `configured` and `measured` apart, and it
judges nothing: the recipes' asserts are the gates.

`measured.rooms[]` holds one entry per room, each with its `group`: the group the run states for
the room's results, which the record has checked against the point's group at that place. In the
table, `room` is one of them.

| Field                                     | Kind       | Meaning                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configured.parameters`                   | configured | The point as given, its `loss` included: the kind, and for a seeded loss its ratio and seed.                                                                                                                                                                                                            |
| `configured.plan`                         | configured | Every number derived from the point; the list follows the table. `expectedLostFrames` is derived from the seed and never read from a run.                                                                                                                                                               |
| `room.publishers[].submittedSends`        | measured   | The loop's `passed`: the send commands the harness submitted. A live send returns once its value is staged or refused, so this is not what reached a carrier.                                                                                                                                           |
| `room.publishers[].publicationStage`      | measured   | That publisher page's stage as its `stats` read it. `counters.admitted` is what the stage handed to a carrier, and the publisher's gate.                                                                                                                                                                |
| `...publishers[].achievedIterationRateHz` | measured   | The loop's iteration rate, whether a send was admitted or not: the intervals between iterations over the loop's elapsed time. `null` where the loop states none.                                                                                                                                        |
| `...publishers[].completedIterations`     | measured   | The iterations the loop ran, with `elapsedMs` their time.                                                                                                                                                                                                                                               |
| `...publishers[].droppedSends`            | measured   | The loss release's `acted.drop` on that publisher's page. Over `ws` each is a socket write it dropped, a frame no recipient got; over `rtc` each is a send to one next hop its channel refused, tried again 50 ms later. `null` for a point with no loss, whose recipes arm none; never 0 in its place. |
| `room.subscribers[].observed`             | measured   | The distinct messages of the frame type delivered to the application when the count settled, whichever publisher sent them.                                                                                                                                                                             |
| `...subscribers[].unrecordedSamples`      | measured   | The observed messages that gave no age: no finite stamp, or a stamp later than the arrival. Never clamped into a bucket.                                                                                                                                                                                |
| `...subscribers[].sampleAgeMs`            | measured   | `no-samples`, or `recorded` with `count`, `min`, `max` and `p50`, `p95`, `p99`.                                                                                                                                                                                                                         |
| `room.published`                          | measured   | The room's publisher results as one: `publisherCount` of them, `admittedFrames` (their stages' `admitted` added) and `droppedSends` (added; `null` with no loss).                                                                                                                                       |
| `room.delivered`                          | measured   | The room's subscriber results as one: `subscriberCount` of them, their `observed` and `unrecordedSamples` added, and one `sampleAgeMs` over every age they recorded.                                                                                                                                    |
| `measured.published`                      | measured   | The same as `room.published` over the publisher results of every room.                                                                                                                                                                                                                                  |
| `measured.delivered`                      | measured   | The same as `room.delivered` over the subscriber results of every room.                                                                                                                                                                                                                                 |

`configured.plan` holds `roomCount` and `agentCount`; one room's `subscriberCount`; one publisher's
`frameCount`, `configuredRateHz`, `expectedAdmissions`, `expectedLostFrames` and `minAcceptedSends`;
one subscriber's `expectedInboundMessages` and `minExpectedInboundMessages`; and
`logicalFanoutMessages`, every publisher's expected admissions less its expected lost frames, to
every other member of its room, over all rooms.

Read each figure with these limits:

- **The age starts before the product does.** The stamp is the publisher's clock when the loop
  resolves the send command, before the runtime admits it and before the publication stage holds the
  value. The age ends when the subscriber's event log records the message. One age is therefore
  harness admission, the stage's hold, the transit, the delivery to the page's subscriber and the
  bridge into the runtime together.
- **The age spans two clocks.** Each end is `Date.now()` in whole milliseconds on that agent's own
  clock; a delivery within the same millisecond reads 0. On one machine the clocks are one. Between
  machines every age also holds their offset, which nothing measures: a hosted rung needs it measured
  before its ages read as latency. A subscriber whose clock is behind the stamp gives a negative age,
  which is counted as unrecorded and fails that subscriber's gate.
- **The age covers survivors.** Only delivered messages have one, so read it beside `observed`.
- **`observed` is a snapshot.** The count returns as soon as `minExpectedInboundMessages` are on the
  log, and a later arrival is not in it. The publisher's pause before the `complete` barrier makes
  the snapshot near-final. A page's one inbound store delivers a message once whichever carriers
  brought it, so on a fresh page `observed` is never more than the frames of the room's publishers
  together. The frame type is fixed, so a page that already ran a point counts that point's messages
  too.
- **A delivery level of several publishers is over their frames together.** A subscriber's count
  and its `observed` do not tell one publisher's frames from another's, so neither does a level read
  from them.
- **Nothing counts the publishers' share of the fan-out.** `logicalFanoutMessages` takes every other
  member of a room as a receiver, publishers included: a publisher's page opens the frame's channel
  and hears the room's other publishers. Only a subscriber counts, and only a subscriber has a gate.
  With more than one publisher, `measured.delivered.observed` therefore cannot reach
  `logicalFanoutMessages`, and no assert covers the difference. For 5 publishers among 15 agents
  over 600 frames, the fan-out is 600 x 5 x 14 = 42,000, the 10 subscribers can observe
  600 x 5 x 10 = 30,000, and the other 600 x 5 x 4 = 12,000 are deliveries to publishers' pages. In
  the `two-rooms` local point the three numbers are 240, 120 and 120.
- **A room that stalls takes the point's record with it.** All rooms share the four barriers, and a
  barrier's timeout is sized for one room. An agent that fails before a barrier fails every room's
  agents there. An agent that only stalls holds every room until the barrier times out, and they
  fail then. After either, the point has no figures record at all: an agent that failed at a barrier
  ran none of its later commands, and the record needs the results of every agent of every room. It
  gives none for the rooms that ran well.
- **The plan takes every frame to be admitted.** `expectedAdmissions` is `frameCount`, whatever
  `publication.drain.bytes` is, and on the RTC carriers it takes every admitted frame to arrive. A fitting `payloadBytes` does not make that true, since the stage
  charges the envelope against the budget.
- **A percentile is a bucket.** `p50`, `p95` and `p99` are `{ atLeast, atMost }`: the bucket of the
  nearest-rank sample on `AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS`, narrowed by `min` and `max`. They
  compare bucket by bucket with the stage's `selectionAgeMs`, and are not exact values.
- **A delivered age is one histogram.** `delivered.sampleAgeMs` reads the subscribers' histograms
  merged by `computeBoundedHistogramMerged`, so its percentiles rank every recorded age; it is no
  mean of the subscribers' percentiles. Where no subscriber recorded an age it is `no-samples`, never
  a zero age. It weighs a subscriber by the samples it recorded, so one that received little hardly
  moves it: read it beside each subscriber's own figures.
- **There is no delivery ratio.** A ratio needs a denominator, and a run has three: the planned
  frames, the submitted sends, and the stage's `admitted`. The record states all three and divides by
  none.
- **Every delivered frame is also harness load.** Each inbound event carries the whole payload and is
  forwarded to the control server: `logicalFanoutMessages x payloadBytes` bytes, since a publisher's
  page hears the other publishers too. That is trivial at 256 bytes and a load of its own at large
  payloads.
  `RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS` and `RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS` bound the
  control server's memory, not the page's history.

## Reading a figure under loss

The family runs one purpose and one receipt mode: every frame is `purpose: 'live'`, so its send is
`best-effort`, unreceipted and unordered, latest-wins on its stream. Nothing in it asks for a
receipt, a gap request or a retransmission. What the product does with a frame the loss drops
depends on the carrier:

| Carrier                | What a dropped frame meets                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws`                   | Nothing. The socket never writes the frame, so it never reaches the server and no recipient gets it, the room's other publishers included. No receipt, no track, no gap request.                                                            |
| `rtc`                  | The first hop's own resubmission, 50 ms after each refusal, until the frame passes, its deadline ends it, or a newer value of its stream supersedes it. Each next hop has its own work, so one subscriber can get a frame another does not. |
| `rtc-with-ws-fallback` | The same, and after three refusals in a row the message is handed to WS, where the loss does not stand. A page's one inbound store hands a message to the application once.                                                                 |

Read the delivered age under loss with these rules:

- **Over `ws` a lost frame has no sample.** The histogram holds the survivors and reads as the
  carrier's histogram without loss; only `observed` beside `published` shows the loss.
- **Over `rtc`, at a ratio that loses nothing, no sample is missing.** A refused send's sample is in
  the histogram at its late age, 50 ms a refusal. Nothing marks it: a late sample and a repaired
  sample are one thing in the record. The median does not see it; the 95th percentile does.
- **Over `rtc`, at a ratio that loses frames, a survivor's age is under about one
  `publishIntervalMs`**, because the next value of the stream ends a frame that is still refused;
  the stream's last frame, which has no successor, can be as old as `ttlMs`.

And with these limits:

- **One seed for every publisher.** Every publisher's page arms the same ratio and seed, so over
  `ws` every publisher of a point loses the same frame positions. A subscriber's count is over all
  its room's publishers together, so no gate depends on it, but a reader of one publisher's loss
  reads a loss correlated with every other publisher's.
- **The loss is on publishers' pages only**, on their own frames of the family's type. No
  subscriber arms one, and no inbound frame and no control frame is touched.
- **A relay's forward is not lossy.** It is another page's send. In a room of three no page
  forwards: each publisher sends straight to both other members.
- **Under `rtc-with-ws-fallback` the WS leg is not lossy.**
- **`droppedSends` counts sends, not frames, over `rtc`.** One frame refused at two next hops, or
  twice at one, is two. How many there are depends on the layout and the pace, so it is reported,
  not asserted.
- **Nothing on a publisher's page counts a frame its carrier ended.** A frame still refused when its
  stream's next value is admitted, or at its `ttlMs`, is never delivered, and neither the stage's
  `superseded` nor any other counter of the page names it. Only `published.admittedFrames` beside a
  subscriber's `observed` shows it.
- **Over `ws` which frames are lost is the seed's only while the stage hands on every frame in
  order**: the socket's k-th written frame meets the seed's k-th draw. The family refuses a rate
  above the cadence, so that holds; the `ws` point's test compares two measured counts, which hold
  even where it does not.
- **The loss stands for the whole window.** It is armed before the first send and released after the
  drain, when no frame of the window is still resubmitted, so the release's counts are final.

## Not built

- A rate above the publication cadence: a `publishIntervalMs` below `publication.cadenceMs` is
  refused (`publish-interval-below-cadence`). The stage's boundary follows the previous opportunity,
  so what a point above cadence should admit depends on measured lateness, and the family has no
  such measurement yet.
- Membership churn, then subscription churn, as parameters: the family's next two pull requests, in
  that order. A member that leaves and returns must be held only to the frames sent while it was
  present, which needs a count split by sequence number or by time that the harness does not have.
- A clean part of the window after the loss. A live frame is never repaired after the fault ends,
  so it would measure what the points without loss already measure.
- Loss on a relay's forwards, and on the WS leg of `rtc-with-ws-fallback`.
- A browser run of a loss point on `rtc-with-ws-fallback` or with two publishers, and a hosted loss
  point.
- Seeded delay.
- Hosted manifests, and the clock offset a hosted age needs.
- One histogram across runs: a record covers one run.
- The bound on a frame's size in the stage: `payloadBytes` is not the envelope.
