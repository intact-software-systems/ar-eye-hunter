# Client-State Server Navigation

This directory is the canonical owner map for client-state server code. The
map follows executable imports and declarations; it is navigation evidence,
not a second runtime contract. PR A currently owns command construction and
validation here. The unchanged compute, result, persistence, service, and inbox
owners remain at their legacy paths until their named cohorts move them.

## Command and validation owners

- [`ClientMutationRejectedError` and generic validation primitives](./client-state-validation-primitives.ts)
- [`ClientMutationCommand` and the exact mutation contracts](./mutation/client-mutation-contracts.ts)
- [`toClientMutationCommand` and request-to-command projection](./mutation/client-mutation-command.ts)
- [`toClientMutationIssuedSessionAuthority`](./mutation/client-mutation-authority.ts)
- [`validateClientExpiredSessionAuthority`](./mutation/validate-client-expired-session-authority.ts)
- [`validateClientMutationCommand`](./mutation/command-validation/validate-client-mutation-command.ts)
- [`validateClientMutationOperationInput`](./mutation/command-validation/validate-client-mutation-operation-input.ts)
- [`validateClientMutationRequest`](./mutation/command-validation/validate-client-mutation-request.ts)

Compatibility callers can continue using the existing named exports from
`services/client-state-service.ts`, `services/client-state-mutations.ts`,
`services/client-mutation-authority.ts`, and
`services/client-expired-state-authority.ts`. Canonical owners never import
those compatibility paths.

## Current runtime timeline

```text
HTTP, authorized WebSocket, or expiry producer
  -> AppInboxService reserves the durable mutation
  -> AppClientInboxService projects the enqueue payload
  -> toClientMutationCommand validates and hashes the command
  -> client-state-service read -> compute -> validate
  -> transaction-bound write persists state, receipt, event, and outbox
  -> AppInboxService commits, records the durable result, and wakes observers
```

AppInbox remains the only incoming database-mutation entry. This cohort does
not move or change its transaction, retry, result, or observation ownership.

## PR A command and validation timeline

```text
raw request
  -> validateClientMutationRequest
  -> operation-specific projection in client-mutation-command.ts
  -> issued-session or system authority projection
  -> canonical hash over exact command input + authority
  -> persisted facts added
  -> validateClientMutationCommand
       -> command root, aggregate, facts, and authority
       -> validateClientMutationOperationInput
  -> immutable ClientMutationCommand
```

Validation order, error instances and messages, optional-versus-null fields,
collection cloning, defaults, deterministic expiry IDs, and the command hash
boundary are unchanged. Compute/result and semantic-equality ownership are
deliberately outside this command/validation cohort.

## Cohort boundary and next owners

- Pure compute and result validation remain in
  `services/client-state-mutations.ts` for the next PR A cohort.
- Persistence contracts, codecs, repositories, and storage keys remain for PR
  B. `ClientMutationIdempotencyRecord` is temporarily re-exported with the
  mutation contracts so existing signatures compile; PR B owns its final move
  to `client-state-persistence-contracts.ts`.
- Service composition, AppInbox handling, reads, writes, timing, snapshots, and
  cache ownership remain for PR B.
- Compatibility-only source removal and mechanical warning alignment remain
  for PR C.
