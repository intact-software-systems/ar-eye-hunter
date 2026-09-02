# Client state

`createClientStateService` owns durable reads and conditional writes.
`AppClientInboxService` registers incoming commands and constructs
`ClientStateInboxHandler` only after the service and AppInbox writer exist.
The queue invokes one handler attempt per delivery; a conflict leaves retry
and fresh reads to queue redelivery.

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts",
    "symbol": "AppClientInboxService"
  },
  "results": [
    {
      "path": "packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts",
      "symbol": "commitComputed"
    }
  ],
  "failures": [
    {
      "path": "packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts",
      "symbol": "validateClientMutation"
    }
  ]
}
```

## Mutation families

- Plain principal, instance, connect, heartbeat, and disconnect commands enter
  `ClientStateInboxHandler.processCommand`. After command hashing and durable
  reads, `computeClientStateInboxMutation` computes canonical client candidates,
  durable completion, and private snapshot observations.
- Authorised WebSocket connect and disconnect enter their named handler
  methods. `client-ws-inbox-computation.ts` composes canonical client and static
  WebSocket generation computation. Closed connects remain inactive without
  client mutation reads; missing-session disconnects still validate authority
  and persist the generation close guard. Neither observes a client snapshot.
- Expiry enters `processExpiredSessionCommands`. All original reads and the
  completion clock are captured first. The shell times each pure
  `computeClientExpiryMutation` separately and retains the predicted predecessor
  for the next session of that principal. `computeClientExpiryInboxCompletion`
  completes the batch before validation starts. Validation checks original
  reads as well as predicted candidates; a late conditional-write loss rolls
  back the entire batch.

`client-state-service-timing.ts` owns the original service identity and sink.
The handler times pure calls from the shell; neither clocks nor timing ports
enter a computation or validation input. Legacy throwing validators keep their
existing contract. Native completion, WS, and exact-projection validators
return issues, which the handler rejects before transaction entry.
Exact projection uses the canonical AppInbox computed-data validator before
reading candidate fields; proxy or accessor candidates cannot reach writers.

## Commit and observation

`commitComputed` passes the exact validated completion to AppInbox. Its
transaction callback writes the computed WS generation guard when present,
then client writes. `writeClientMutation` guards the principal before dependent
state, receipt, event, and final outbox writes. AppInbox writes the durable
result and finishes the reservation in that same transaction.

`computeClientMutationResult` creates persistence-ready `outboxWrites` during
compute, including the entry snapshot and SQL timestamp strings. Validation
checks those exact values without invoking candidate accessors. Write only
iterates the computed inserts: any outbox collision, including identical
content, rolls back the client mutation and preceding outbox inserts. This
does not change the separate event store's identical-event replay policy.

Only after commit returns does `observeCommittedSnapshots` call the existing
observer. The cached service retains its durable-service spread and existing
observation behavior. Private observation data never enters the durable result.

The matching tests live under
`packages/tests/shared-server/rallar-system/client-state/`: operation-matrix,
authorised-ws, expiry, transaction-and-outbox, outbox, timing, and inbox-computation
tests cover these entries and boundaries.

