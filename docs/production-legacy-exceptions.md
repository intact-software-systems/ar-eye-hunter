# Production Legacy Exception Registry

This registry records rare production compatibility boundaries that an authorized maintainer has
chosen to retain. Ordinary pull-request work does not edit this file when legacy is removed,
resolved, or minimized.

A retained entry describes only the code and its maintenance policy. It does not copy pull-request
numbers, reviews, plan identifiers, candidate identifiers, commits, digests, or approval receipts.
The merge authority and review history remain in GitHub.

## Retained exceptions

### `packages/shared-server/rallar-system/topology/replay/rtc-topology-work-codec.ts`#`readRtcTopologyWorkEnvelope`

- Path: `packages/shared-server/rallar-system/topology/replay/rtc-topology-work-codec.ts`
- Symbol: `readRtcTopologyWorkEnvelope`
- Purpose: normalize in-flight RTC RTT work written before the canonical RTT-refresh envelope was
  deployed.
- Canonical owner: `rtc-topology-work-codec.ts` owns the only production compatibility decoder;
  every active writer emits canonical RTT-refresh work with the full measurement and refinement
  observation identity.
- Consumer dependency: in-flight final AppOutbox work written before this deployment.
- Why removal is unsafe: up to 24 hours of valid work may remain and must still receive one early
  refinement attempt.
- Minimization: accepts only an old coalesced RTT-refresh envelope or a group-revision envelope with
  the exact durable RTC RTT receipt, command-hash, and group resource identity. Arbitrary group work
  remains group work.
- Compatibility tests: `packages/tests/shared-server/rtc-topology-outbox-work.test.ts` and
  `packages/tests/shared-server/rtc-rtt-durable-refinement.test.ts`.
- Named owner: RTC topology replay maintainers.
- Review or removal condition: remove after all production writers have emitted the canonical
  RTT-refresh envelope for longer than the fixed 24-hour work retention.

When retention is necessary, add one section headed `path#symbol` with these maintenance facts:

- Path
- Symbol
- Purpose
- Canonical owner
- Consumer dependency
- Why removal is unsafe
- Minimization
- Compatibility tests
- Named owner
- Review or removal condition
