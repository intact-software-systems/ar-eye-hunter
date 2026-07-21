# RTC Signaling Boundary Diagnostics Design

## Purpose

The 15-agent `rtc-messages-all-peer-multicast` run fails before any RTC lane
opens. Existing logs prove topology churn and late signaling, but they do not
separate sender queue delay, server relay delay, target queue delay, and RTC
dispatch delay. This change adds the smallest reusable evidence needed to
locate that boundary without changing topology selection, peer admission,
timeouts, TURN policy, or recipe expectations.

## Constraints

- Run from an isolated `codex/rtc-signaling-boundary-diagnostics` branch.
- Preserve the failed manifest and workflow inputs for the remote comparison.
- Do not fix the star/tree overlay precedence in this branch.
- Do not log SDP, ICE credentials, candidate bodies, auth values, or message
  payload resources in the new diagnostic records.
- Correlate records with the existing AL message ID and RTC sender/target IDs.
- Keep diagnostics bounded and optional so non-RTC AL traffic is unchanged.
- Put reusable black-box analysis in `packages/shared-test`; keep the app CLI
  as a thin filesystem adapter.

## Architecture

### Wire timing

`ALDiagnostics` gains an optional `wsRelayTiming` record with two mandatory
timestamps: when the server WebSocket service accepted an RTC signaling
message and when the RTC signaling topic forwarded it. The raw server receive
path initially sets both values to the receive timestamp. The topic handler
then preserves the receive value and replaces the forward value immediately
before `server.send`.

Only RTC signaling messages receive this record. It is carried in the existing
optional diagnostics envelope and does not alter message identity, routing,
payload, QoS, ordering, or deduplication.

### Compact boundary events

A pure helper recognizes RTC signaling AL messages and produces a versioned,
payload-free event with:

- AL message ID and creation timestamp;
- trace stage and event timestamp;
- RTC signal type, sender ID, and target ID;
- elapsed time since AL message creation;
- server receive/forward timestamps when available.

The helper emits a stable `RTC signaling trace: ` JSON log prefix at these
stages:

1. `client-outbox-enqueued` after the signaling AL message is committed;
2. `client-outbox-sent` immediately before the sender WebSocket send;
3. `client-inbox-received` when the target WebSocket receives the message;
4. `rtc-dispatched` when the target signaling transport invokes RTC handling.

The server paths also emit compact `server-inbox-received` and
`server-forwarded` records for environments that retain API logs. The target
events remain sufficient to recover both server timestamps when server logs
are unavailable.

### Analysis

`packages/shared-test/rallar-bb-test/rtc-signaling-trace-analysis.ts` parses
the stable log prefix, deduplicates GitHub Actions log repetitions, groups
records by AL message ID, and calculates:

- enqueue-to-outbox-send;
- outbox-send-to-server-receive;
- server receive-to-forward;
- server-forward-to-target-inbox;
- target-inbox-to-RTC-dispatch;
- end-to-end creation-to-RTC-dispatch.

It reports counts and p50/p95/max latency for offers, answers, ICE candidates,
and the combined population, plus missing-stage counts. A thin CLI recursively
reads extracted GitHub Actions job logs and writes JSON and Markdown summaries.

## Testing

- Pure trace tests prove RTC detection, payload exclusion, relay timing
  preservation, and non-RTC no-op behavior.
- WebSocket/RTC tests prove enqueue, sender dispatch, target receive, and RTC
  dispatch stages are emitted in order with the same message ID.
- Analyzer tests prove deduplication, boundary arithmetic, percentiles,
  per-signal grouping, and missing-stage reporting.
- Focused shared/shared-server/shared-test suites and TypeScript checks verify
  package compatibility.
- The pushed branch is deployed through the same GitHub Free distributed
  recipe workflow and the new analyzer is run over the downloaded job logs.

## Remote Success Criteria

The diagnostic implementation succeeds when the rerun produces correlated
stage records for delivered RTC signals and the analysis can identify which
boundary accounts for the observed 10–35 second delay. The recipe itself may
still fail; this branch intentionally preserves the suspected topology defect
so the failure remains diagnostically comparable.
