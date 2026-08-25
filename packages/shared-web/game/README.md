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

1. `createRallarGameMatch` constructs the match state and the director,
   egress, presence, and sequence owners.
2. `start` subscribes to room state and game messages, publishes this peer's
   capability, and evaluates director ownership.
3. Room state and capability messages update the election inputs. The director
   appointment runtime applies the resulting appointment when this peer is the
   eligible host.
4. `stop` releases subscriptions, timers, relay state, and the published
   capability through the match lifecycle owner.

## Message and egress routing

1. `envelopes.ts` validates incoming envelopes and rejects stale or
   duplicate sequence numbers.
2. The match routes presence, input, intent, snapshot, event, and sync-request
   envelopes to their configured handlers.
3. Director-owned input is handled locally or relayed by
   `director/rallar-game-director-relay-runtime.ts`.
4. Match and presence egress select the required RTC lane, wait for peer or
   director readiness, and return `RallarGameSendResult` without hiding a
   fallback transport.
