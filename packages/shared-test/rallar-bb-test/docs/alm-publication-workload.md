# ALM publication workload family

The family lives in `conformance/alm/publication-workload/`. One point of it is one room in which one
publisher sends paced `live` publications and every other agent subscribes. A run of a point gives a
figures record: what the point asked for, beside what the run observed, with the ages of the
delivered samples of each subscriber, of the room and of the point. The family builds recipes and
reads results. It starts no browser and holds no manifest; a caller puts the two recipes into a
distributed run.

## A point

`PublicationWorkloadParameters` has no default: a caller states every field.
`validatePublicationWorkloadParameters` returns every issue of a point, each under its `$.field` path.
A field reports the first bound it breaks; `group` and `publication` report every issue of their own
validators. A bound stated against another field is checked only when that field holds its own bound.

| Field                 | Bound                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `group`               | A valid group reference: the one room.                                                                                    |
| `participantCount`    | A whole number from 2 to 50: one publisher, the rest subscribers.                                                         |
| `carrier`             | `ws`, `rtc` or `rtc-with-ws-fallback`.                                                                                    |
| `publishIntervalMs`   | A positive whole number of milliseconds, at least `publication.cadenceMs`.                                                |
| `windowMs`            | A positive multiple of `publishIntervalMs`; the frame count `windowMs / publishIntervalMs` is at most 2,000.              |
| `publication`         | An `ALPublicationPolicy` that `validateALPublicationPolicy` passes.                                                       |
| `payloadBytes`        | A whole number of UTF-8 bytes: at least the payload with no filler, at most 65,536 and at most `publication.drain.bytes`. |
| `ttlMs`               | A positive whole number of milliseconds.                                                                                  |
| `minReceiveRatio`     | A share above 0 and at most 1.                                                                                            |
| `minSendSuccessRatio` | A share above 0 and at most 1: the share of the frames the publisher's publication stage must hand to a carrier.          |
| `readyTimeoutMs`      | A positive whole number of milliseconds: the setup's allowance.                                                           |

The rate is the integer interval, so `configuredRateHz` (`1000 / publishIntervalMs`) is never
rounded. A threshold is the smallest whole count whose share of the frames reaches its ratio: 57 of
60 frames at 0.95.

Each frame's payload is `{ seq, sentAtEpochMs, pad }`. `payloadBytes` is its serialised size at the
last sequence number; an earlier frame is smaller by the digits its sequence number lacks.
`payloadBytes <= publication.drain.bytes` is necessary, not sufficient: the stage charges the whole
message envelope against the drain budget. One run of the local point charged about 1.5 KiB for a
256-byte payload (`drainBytesPercent` of 2.27 on a 65,536-byte budget). That is an observation of
that run, not a contract: no test pins it.

## What a run does

`createPublicationWorkloadRecipes(parameters)` returns one recipe per role, or every validation issue
as its left (`RallarValidationIssue[]`). Which agent publishes is not the family's to say, since it
holds no manifest: the caller's role-map manifest gives the publisher's recipe to one agent. In the
local point's manifest that is the first agent of the run.

Both roles first run the cohort setup the scale family also uses (`conformance/alm/cohort/`): sign
in, the publisher's group, the connects, the audience wait, an accepted RTC layout that stays stable,
and the `setup-complete` barrier. The setup is the same for all three carriers. A `ws` point is
therefore WS sends in a room that has also formed its RTC layout; the conformance lane's `ws` cells
connect on `messages.ws` and open no RTC lane.

The publisher then runs:

1. A `loop` of one `messages.send` per frame, `publishIntervalMs` apart, with `purpose: 'live'`, the
   point's publication policy, carrier and `ttlMs`.
2. A pause of `publication.cadenceMs + ttlMs`. After it the stage holds no frame of the window, so
   its counters are final. A long lifetime lengthens every run by that much.
3. `stats`, then the `complete` barrier.
4. Its gate: the stage's `admitted` counter is at least `minAcceptedSends`.

A subscriber waits at the `complete` barrier and then runs:

1. `messages.received` for the frame type, with `count: minExpectedInboundMessages`,
   `ageFrom: 'sentAtEpochMs'` and a window of `ttlMs`.
2. Its gates: no message without an age, as many ages as messages, and no more messages than frames.
3. `stats`.

The subscriber's recipe asks for a `full` event history, because the count reads the page's whole
inbound log. A distributed manifest that names its own `eventHistory` replaces it, so a manifest of
the family names none. A barrier id is used once per control run, so each run needs a control run of
its own. A subscriber whose count fails stops there: its `received` value is recorded, its `stats`
is not. A publisher that fails before `complete` fails every subscriber at that barrier.

## The local point

```sh
npm run test:rallar:full-stack:memory:publication-workload
```

`tests/playwright/rallar-black-box/full-stack-publication-workload.spec.ts` runs one point as a
distributed run on three headless agents against the in-memory API: one publisher and two
subscribers, 60 frames 500 ms apart on `rtc`, 256-byte payloads, a 5 s lifetime, both ratios 0.95. It
takes about a minute. Playwright always starts the in-memory API itself and refuses to run while
its port already answers. It starts the headless SPA and the control server only when nothing
answers on their ports; with `CI` set it starts those two itself as well. The API must be new to the
run: every launch gives the same three users, `controller-01` to `controller-03`, a new password.
The control server keeps whole results only in recorder storage, which the script puts under
`tmp/publication-workload/recorder` unless `RALLAR_BLACK_BOX_STORAGE_DIR` names another directory.
The default directory is reused from run to run and grows with each.

The test asserts that the run passed and that the figures record could be read, then on the record:
the stage admitted at least `minAcceptedSends`; each subscriber observed at least
`minExpectedInboundMessages` and at most `frameCount`, left no sample unrecorded, and its oldest
sample is younger than the window; each page ran on a `full` event history with no evicted event and
no capture gap. It asserts no latency level, no percentile and no rate. The record is attached to the
test as `publication-workload-figures.json`, beside the operator's native evidence in `observation/`.

No CI lane runs the test. The app browser lane's `npm run test:rallar` lists the file, as it lists
every full-stack spec, and skips the test because it does not set the opt-in environment. Only the
`rtc` point has a test that runs it. A `ws` and an `rtc-with-ws-fallback` point are checked against
the recipe schema, the control validation and the distributed preflight only.

## The figures record

`toPublicationWorkloadFigures({ parameters, rooms: [{ publishers, subscribers }] })` reads the result
values of three commands: each publisher's `publication-workload-publisher-frames` (`loop`) and
`publication-workload-publisher-stats` (`stats`), and each subscriber's
`publication-workload-subscriber-received` (`received`), every one beside its `agentId`. `rooms`
holds one entry per room of the point, which is one; a room holds one entry per agent that left
results, and the record does not count them against the plan. Its left is `readonly string[]`: every
field it could not read, each starting with the field's path, which is `$.parameters...`, `$.rooms`
for another number of rooms than the point's, `$.rooms[r].publishers[p].loop...`,
`$.rooms[r].publishers[p].stats...` or `$.rooms[r].subscribers[s].received...`. The record keeps
`configured` and `measured` apart, no field mixes them, and it judges nothing: the recipes' asserts
are the gates.

`measured.rooms[]` holds one entry per room, each with its `group`. In the table, `room` is one of
them.

| Field                                     | Meaning                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configured.parameters`                   | The point as given.                                                                                                                                                              |
| `configured.plan`                         | `frameCount`, `configuredRateHz`, `subscriberCount`, `expectedInboundMessages` and `minExpectedInboundMessages` for one subscriber, `minAcceptedSends`, `logicalFanoutMessages`. |
| `room.publishers[].submittedSends`        | The loop's `passed`: the send commands the harness submitted. A live send returns once its value is staged or refused, so this is not what reached a carrier.                    |
| `room.publishers[].publicationStage`      | The publisher page's stage as its `stats` read it. `counters.admitted` is what the stage handed to a carrier, and the publisher's gate.                                          |
| `...publishers[].achievedIterationRateHz` | The loop's iteration rate, whether a send was admitted or not: the intervals between iterations over the loop's elapsed time. `null` where the loop states none.                 |
| `...publishers[].completedIterations`     | The iterations the loop ran, with `elapsedMs` their time.                                                                                                                        |
| `room.subscribers[].observed`             | The distinct messages of the frame type delivered to the application when the count settled.                                                                                     |
| `...subscribers[].unrecordedSamples`      | The observed messages that gave no age: no finite stamp, or a stamp later than the arrival. Never clamped into a bucket.                                                         |
| `...subscribers[].sampleAgeMs`            | `no-samples`, or `recorded` with `count`, `min`, `max` and `p50`, `p95`, `p99`.                                                                                                  |
| `room.delivered`                          | The room's subscriber results as one: `subscriberCount` of them, their `observed` and `unrecordedSamples` added, and one `sampleAgeMs` over every age they recorded.             |
| `measured.delivered`                      | The same over the subscriber results of every room.                                                                                                                              |

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
  brought it, so on a fresh page `observed` is never more than the frame count. The frame type is
  fixed, so a page that already ran a point counts that point's messages too.
- **A percentile is a bucket.** `p50`, `p95` and `p99` are `{ atLeast, atMost }`: the bucket of the
  nearest-rank sample on `AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS`, narrowed by `min` and `max`. They
  compare bucket by bucket with the stage's `selectionAgeMs`, and are not exact values.
- **A delivered age is one histogram.** `delivered.sampleAgeMs` reads the subscribers' histograms
  merged by `computeBoundedHistogramMerged`, so its percentiles rank every delivered sample; it is no
  mean of the subscribers' percentiles. With no subscriber result it is `no-samples` beside counts of
  0, never a zero age. It weighs a subscriber by the samples it recorded, so one that received little
  hardly moves it: read it beside each subscriber's own figures.
- **There is no delivery ratio.** A ratio needs a denominator, and a run has three: the planned
  frames, the submitted sends, and the stage's `admitted`. The record states all three and divides by
  none.
- **Every delivered frame is also harness load.** Each inbound event carries the whole payload and is
  forwarded to the control server: `frameCount x payloadBytes x subscriberCount` bytes. That is
  trivial at 256 bytes and a load of its own at large payloads.
  `RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS` and `RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS` bound the
  control server's memory, not the page's history.

## Not built

- More than one room, more than one publisher, and a rate above the publication cadence.
- Subscription churn, and seeded loss or delay.
- Hosted manifests, and the clock offset a hosted age needs.
- One histogram across runs: a record covers one run.
- The bound on a frame's size in the stage: `payloadBytes` is not the envelope.
