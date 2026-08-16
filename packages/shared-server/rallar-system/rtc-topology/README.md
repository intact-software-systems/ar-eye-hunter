# RTC RTT server navigation

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "packages/shared-server/rallar-system/rtc-topology/topic/init-rtc-rtt-topic.ts",
    "symbol": "initRtcRttTopic"
  },
  "results": [
    {
      "path": "packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-result.ts",
      "symbol": "toRtcRttAppInboxResult"
    },
    {
      "path": "packages/shared-server/rallar-system/services/rtc-topology-outbox-entry.ts",
      "symbol": "writeRtcTopologyOutbox"
    }
  ],
  "failures": [
    {
      "path": "packages/shared-server/rallar-system/group-state/group-mutation-authority.ts",
      "symbol": "GroupMutationAuthorizationError"
    },
    {
      "path": "packages/shared-server/rallar-system/rtc-topology-errors.ts",
      "symbol": "RtcTopologyRepositoryInvariantCorruptionError"
    },
    {
      "path": "packages/shared-server/rallar-system/rtc-topology/mutation/compute-rtc-rtt-mutation.ts",
      "symbol": "RtcRttMutationIdempotencyConflictError"
    }
  ]
}
```

[topic/init-rtc-rtt-topic.ts#initRtcRttTopic](topic/init-rtc-rtt-topic.ts#initRtcRttTopic)
is the canonical RTT ingress entry. The feature owns RTT message validation,
reporting-edge policy, refinement damping, durable AppInbox protocol, and the
handoff to RTC topology AppOutbox work. General topology planning and delivery
replay remain in `../topology/` because RTT is an input to those capabilities,
not their owner.

## Construction and registration

API composition creates the RTC topology service, one refinement gate, and one
refinement service. `initRallarSystemWsTopics` registers `initRtcRttTopic` for
the RTT websocket topic. A persistent runtime also registers
`RtcRttAppInboxHandler` and supplies durable enqueue, mutation, transaction,
and AppOutbox dependencies. Process-local mode supplies the cache-backed RTT
repository and schedules only its existing global graph refresh.

Durable RTT storage is owned by `persistence/`: the repository owns exact
reads and conditional writes, while the cleanup owner validates an expired
receipt before entering one guarded delete transaction. Active persistence
uses only the canonical latest-measurement, endpoint-admission, and receipt
namespaces.

## Runtime invocation

An RTT websocket message first validates its route and sender. Persistent mode
enqueues an authenticated AppInbox command and returns; each durable attempt
rereads authority and lifecycle state, evaluates the same RTT policy, commits
the mutation and receipt, and emits canonical `rtt-refresh` AppOutbox work.
The work handler asks `RtcRttRefinementService` for one stable decision per
work identity before topology planning. Process-local mode evaluates policy,
updates the cache, observes Vivaldi movement, applies the same per-group
refinement gate, and publishes work through the configured compatibility path.

Authority rejection, invalid lifecycle or reporting policy, repository
corruption, and idempotency conflict remain explicit exits at their owning
boundaries. Retry identity and refinement observations remain stable until the
durable work expiry time; no moved private-path forwarding module participates
in runtime execution.
