# Auth server navigation

This directory owns authenticated server commands from queue routing through
stable reads, pure decisions, validation, transactional writes, and public
result reconstruction. Package consumers may keep using the supported service
entry described below; new auth implementation code imports canonical owners.

## Read these files first

1. Start at the canonical
   [`AppAuthInboxService`](./inbox/app-auth-inbox-service.ts) for public enqueue
   methods and construction-time registration.
2. Follow a later dequeue into
   [`AuthInboxHandler`](./inbox/auth-inbox-handler.ts), which makes the mutation
   phases and transaction boundary visible in one method.
3. Read [`AuthMutationCommand`](./mutation/auth-mutation-contracts.ts), then
   [`AuthMutationService`](./auth-mutation-service.ts) for the seven command
   variants and phase interface.
4. Follow [`readAuthMutation`](./mutation/read/read-auth-mutation.ts),
   [`captureAuthMutationFacts`](./mutation/read/capture-auth-mutation-facts.ts),
   [`computeAuthMutation`](./mutation/compute/compute-auth-mutation.ts), and
   [`validateAuthMutation`](./mutation/validate/validate-auth-mutation.ts).
5. Finish at [`writeAuthMutation`](./mutation/write/write-auth-mutation.ts),
   then return through
   [`decodeAuthMutationResult`](./mutation/decode-auth-mutation-result.ts) and
   [`toAuthMutationPublicResult`](./mutation/to-auth-mutation-public-result.ts).

## Construction and registration timeline

1. API-v1 constructs the repositories, credential issuer, complete
   `AuthMutationService`, and queue dependencies.
2. The `AppAuthInboxService` constructor creates one complete
   `AuthInboxHandler`, including its transaction-writer port.
3. The service registers the seven auth message types in their fixed order.
   Registration only stores callbacks; it performs no reads or mutations.
4. A callback invokes the already-constructed handler only after the queue
   reader later delivers an accepted entry.

The API-v1 composition root remains
[`middleware.ts`](../../../../apps/api-v1/src/middleware.ts).

## Authenticated AppInbox mutation

### Request and enqueue

1. A public service method decodes a command with
   [`decodeAuthMutationCommand`](./mutation/decode-auth-mutation-command.ts).
2. [`toAuthAppInboxType`](./inbox/auth-app-inbox-routing.ts) and its sibling
   routing functions derive type, context, and sender identity.
3. The base AppInbox service durably enqueues the command and waits for the
   queue-owned result. Terminal queue failures retain their typed
   `AppInboxFailure` result.

### Later queue invocation and transaction exit

1. Queue delivery invokes `AuthInboxHandler.processAuthMutation`.
2. The handler decodes again and verifies type, resource, and context identity
   before any state read. Sender is intentionally not part of this established
   auth-specific rejection check.
3. [`readAuthMutation`](./mutation/read/read-auth-mutation.ts) performs stable
   command-family reads. Session commands share the explicit canonical-then-
   legacy order in
   [`readAuthSessionEntries`](./mutation/read/read-auth-session-entries.ts).
4. Facts, compute, and validation run before opening the write transaction.
5. The base AppInbox transaction writer invokes
   [`writeAuthMutation`](./mutation/write/write-auth-mutation.ts). Conditional
   conflicts escape to the existing whole-attempt retry owner.
6. One transaction writes authoritative state, durable result, receipt, and any
   final outbox intent. A failed transaction commits none of them; a terminal
   retry failure produces no successful completion.
7. After commit, the waiting caller decodes the durable result and reconstructs
   only the established public plaintext response.

## Login and credential issuance

- [`prepareAuthUserRegistration`](./login/prepare-auth-user-registration.ts)
  owns registration input preparation.
- [`authenticateAuthUser`](./login/authenticate-auth-user.ts) owns registered
  and static-client login decisions.
- [`createHmacAuthCredentialIssuer`](./credentials/auth-credential-issuer.ts)
  deterministically issues credentials, while
  [`hashAuthSecret`](./credentials/hash-auth-secret.ts) owns persisted digests.

Plaintext credentials cross only the existing caller boundary. Persisted
commands and results retain digest-only representations.

## Session lifecycle, logout, expiry, and revocation

- [`requireIssueSessionLifecycle`](./sessions/require-issue-session-lifecycle.ts)
  preserves issue/expiry invariants.
- [`computeAuthSessionMutation`](./mutation/compute/compute-auth-session-mutation.ts)
  owns session decisions, and
  [`toAuthLogoutOutbox`](./mutation/compute/to-auth-logout-outbox.ts) builds the
  exact final logout intent.
- [`writeAuthSession`](./mutation/write/write-auth-session.ts) writes the token
  index before the session index and owns guarded logout ordering.
- [`AuthSessionRepository`](./persistence/auth-session-repository.ts) composes
  [`AuthSessionPersistence`](./persistence/auth-session-persistence.ts) with
  ticket persistence.

Already-absent or superseded logout state remains an established no-op. Expired
and legacy observations remain separate from authoritative write decisions.

## Ticket issue and consume

- [`computeAuthTicketMutation`](./mutation/compute/compute-auth-ticket-mutation.ts)
  and [`validateAuthTicketMutation`](./mutation/validate/validate-auth-ticket-mutation.ts)
  own WebSocket ticket decisions.
- [`computeAuthAgentTicketMutation`](./mutation/compute/compute-auth-agent-ticket-mutation.ts)
  and [`validateAuthAgentTicketMutation`](./mutation/validate/validate-auth-agent-ticket-mutation.ts)
  own agent-ticket decisions.
- [`writeAuthTicketMutation`](./mutation/write/write-auth-ticket-mutation.ts)
  makes each ticket-family write order visible.
- [`AuthTicketPersistence`](./persistence/auth-ticket-persistence.ts),
  [`auth-legacy-compatibility.ts`](./persistence/auth-legacy-compatibility.ts),
  [`auth-persistence-contracts.ts`](./persistence/auth-persistence-contracts.ts),
  and [`auth-session-types.ts`](./persistence/auth-session-types.ts) own storage,
  bounded legacy reads, persisted shapes, and issued shapes.

One-use consumes remain conditional writes inside the same AppInbox transaction.

## Authentication and authorization proof/query

HTTP bearer authentication remains a read-only repository query.
[`authSessionProofSecret`](./sessions/auth-session-proof-secret.ts) returns the
existing digest proof used by authority consumers. This auth boundary does not
absorb group, client-state, topology, CRDT, or admin policy.

## Canonical auth owners

The owners linked above are supplemented by:

- [`AuthMutationRejectedError`](./mutation/auth-mutation-rejected-error.ts)
- [`AuthUserRepository`](./persistence/auth-user-repository.ts)
- [`computeAuthUserRegistration`](./mutation/compute/compute-auth-user-registration.ts)
- [`validateAuthUserMutation`](./mutation/validate/validate-auth-user-mutation.ts)
- [`validateAuthSessionMutation`](./mutation/validate/validate-auth-session-mutation.ts)
- shared exact-kind and JSON rules in
  [`requireMatchingAuthKind`](./mutation/validate/auth-mutation-validation.ts)

## Supported compatibility entry

[`services/AppAuthInboxService.ts`](../services/AppAuthInboxService.ts) is the
supported one-hop entry for existing service imports. It directly re-exports
the canonical class, topic constant, and type router. The package root also
exports those identities directly from canonical inbox modules.

The former private routing, read, and write service files have no compatibility
wrapper. Canonical auth code and moved tests must not import them.
