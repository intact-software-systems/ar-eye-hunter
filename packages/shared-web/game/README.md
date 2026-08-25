# Shared-web game helpers

`mod.ts` is the package entrypoint. `match.ts`, `envelopes.ts`, and
`authority-match-support.ts` are intentional public boundaries whose names
match the capabilities callers construct or validate. Private collaborators
are grouped by the owner that makes each runtime decision:

- `authority/` adapts the shared authoritative-game protocol to browser clients
  and match standings.
- `director/` elects, appoints, and tracks the peer that currently directs a
  match. Its relay runtime forwards director-owned traffic.
- `match/` owns match lifecycle, public status, capability publication,
  diagnostics, and director-aware egress.
- `transport/` owns game envelopes, RTC lane policy, presence egress, and the
  canonical game send result.

## Match lifecycle

1. `createRallarGameMatch` constructs each completed owner in `match.ts`; the
   returned handle delegates directly to those owners.
2. `match/rallar-game-match-lifecycle-runtime.ts` starts the director relay and
   registers room, people, director, RTC, capability, input, and snapshot
   subscriptions.
3. `director/rallar-game-host-election-runtime.ts` records explicit capability
   reports and admitted remote reports. `election()` derives the current host
   from that owned state.
4. `appointIfElected()` passes that election to the completed appointment
   runtime, then refreshes status from the appointment result.
5. `stop` marks the status stopped, releases the subscription scope, and stops
   the relay once through the lifecycle owner.

## Message and egress routing

1. `envelopes.ts` defines and validates the public envelope contract.
   `match/rallar-game-match-routing-runtime.ts` owns sequence admission and
   routes accepted presence, input, snapshot, and relay envelopes.
2. `match/rallar-game-match-status-runtime.ts` owns lifecycle flags, director
   freshness recovery, egress state, and status observers.
3. Director-owned input is handled locally or relayed by
   `director/rallar-game-director-relay-runtime.ts`.
4. Match and presence egress select the required RTC lane, make any explicit
   recovery send, and return the canonical `RallarGameSendResult`.
5. `match/rallar-game-diagnostics-runtime.ts` reads the completed status,
   election, appointment, readiness, and transport owners to assemble the
   public diagnostics value.
