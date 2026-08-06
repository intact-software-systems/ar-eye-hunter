# Auth server navigation

This directory is the canonical PR A owner for auth mutation contracts, codecs,
credential derivation, login and registration decisions, mutation facts, pure
compute, pure validation, public-result reconstruction, and session proof rules.

PR A deliberately does **not** move the AppInbox shell, stable reads,
transaction writes, or persistence. Those remain at the predecessor paths named
below until PR B. This map describes the code that runs now; it does not present
future target paths as current owners.

## Read these files first

1. Start at the current runtime entry,
   [`AppAuthInboxService`](../services/AppAuthInboxService.ts), to see public
   enqueue methods, callback registration, queue identity, and the transaction
   boundary.
2. Follow the phase composition through
   [`AuthMutationService`](./auth-mutation-service.ts).
3. Read [`AuthMutationCommand`](./mutation/auth-mutation-contracts.ts) for the
   seven command variants and stage contracts.
4. Follow [`captureAuthMutationFacts`](./mutation/read/capture-auth-mutation-facts.ts),
   [`computeAuthMutation`](./mutation/compute/compute-auth-mutation.ts), and
   [`validateAuthMutation`](./mutation/validate/validate-auth-mutation.ts).
5. Finish at the current transaction owner,
   [`writeAuthMutation`](../services/auth-state-write.ts), then return through
   [`decodeAuthMutationResult`](./mutation/decode-auth-mutation-result.ts) and
   [`toAuthMutationPublicResult`](./mutation/to-auth-mutation-public-result.ts).

## Construction and registration timeline

1. API-v1 composition creates the runtime-state repositories, credential
   issuer, queue repositories, and database before constructing the auth
   service.
2. [`createAuthMutationService`](./auth-mutation-service.ts) constructs the
   still-current [`AuthUserRepository`](../repositories/AuthUserRepository.ts)
   and [`AuthSessionRepository`](../repositories/AuthSessionRepository.ts), then
   exposes direct read, compute, validate, and write operations.
3. API-v1 constructs
   [`AppAuthInboxService`](../services/AppAuthInboxService.ts) with that complete
   service and credential issuer.
4. The constructor registers one `onStateMessage` callback for each of the seven
   auth AppInbox types. Registration performs no mutation. The callback can run
   only after the queue reader delivers an accepted entry.

The API-v1 composition root is
[`middleware.ts`](../../../../apps/api-v1/src/middleware.ts). The temporary
API-v1 import of `services/auth-state-mutations.ts` is a supported direct
one-hop compatibility path; the canonical service implementation is here.

## Authenticated AppInbox mutation

### Request and enqueue

1. An API route calls a public method on
   [`AppAuthInboxService`](../services/AppAuthInboxService.ts).
2. [`decodeAuthMutationCommand`](./mutation/decode-auth-mutation-command.ts)
   applies the existing exact-field, lifecycle, and discriminant checks.
3. The current
   [`auth-app-inbox-routing.ts`](../services/auth-app-inbox-routing.ts) owner
   selects queue type, context, and sender identity.
4. `processEntryUntilCompletionResult` enqueues the durable command and waits
   for the queue-owned result. A terminal queue failure returns the existing
   typed `AppInboxFailure`.

### Later queue invocation and transaction exit

1. Queue delivery invokes the callback registered during construction exactly
   as governed by the base `AppInboxService` retry contract.
2. `processCommand` decodes again, verifies queue identity, and calls the
   current [`readAuthMutation`](../services/auth-state-read.ts) owner.
3. [`captureAuthMutationFacts`](./mutation/read/capture-auth-mutation-facts.ts)
   verifies deterministic credential facts before pure computation.
4. [`computeAuthMutation`](./mutation/compute/compute-auth-mutation.ts) selects
   one operation-family owner; [`validateAuthMutation`](./mutation/validate/validate-auth-mutation.ts)
   independently validates the complete read and computed result.
5. `AppInboxService.writeMutation` owns the transaction and retry boundary. Its
   callback invokes the current
   [`writeAuthMutation`](../services/auth-state-write.ts), whose first
   operation-specific conditional write guards the mutation.
6. The transaction writes authoritative rows, durable result, receipt, and any
   final outbox intent atomically. A conflict re-enters a complete queue attempt;
   a failure produces no successful durable completion.
7. After commit, the waiting caller decodes the durable result and
   [`toAuthMutationPublicResult`](./mutation/to-auth-mutation-public-result.ts)
   reconstructs only the existing caller-visible plaintext result.

## Login and credential issuance

- API-v1 registration uses
  [`prepareAuthUserRegistration`](./login/prepare-auth-user-registration.ts) to
  validate username, password, display name, and static-client collision before
  the register-user AppInbox flow.
- Login uses [`authenticateAuthUser`](./login/authenticate-auth-user.ts) for the
  registered-user lookup, disabled-user exit, PBKDF2 verification, constant-time
  comparison, and static-client fallback.
- [`createHmacAuthCredentialIssuer`](./credentials/auth-credential-issuer.ts)
  deterministically issues access tokens and tickets. Plaintext credentials
  cross only the established caller boundary.
- [`hashAuthSecret`](./credentials/hash-auth-secret.ts) owns the persisted digest
  representation. Digest mismatch exits through the existing error timing and
  messages.

Normal login exits with the existing authenticated identity; invalid or
disabled credentials return the existing unsuccessful result. Registration
continues through the authenticated AppInbox mutation timeline above.

## Session lifecycle, logout, expiry, and revocation

- [`requireIssueSessionLifecycle`](./sessions/require-auth-session-lifecycle.ts)
  preserves the issue-time and expiry invariant used by decode, compute,
  validate, and write.
- Logout computation uses
  [`computeAuthSessionMutation`](./mutation/compute/compute-auth-session-mutation.ts)
  and creates the exact final WS intent through
  [`toAuthLogoutOutbox`](./mutation/compute/auth-logout-outbox.ts).
- Canonical and legacy session reads, observational expiry, conditional delete,
  and public reconstruction remain in
  [`AuthSessionRepository`](../repositories/AuthSessionRepository.ts) and its
  current [`AuthSessionPersistence`](../repositories/auth-session-persistence.ts)
  owner.
- Already-absent or superseded logout state retains the existing typed no-op;
  conditional-write conflict returns to the AppInbox retry owner. Failed
  transactions produce neither a durable success nor logout outbox completion.

## Ticket issue and consume

- WebSocket ticket operations compute through
  [`computeAuthTicketMutation`](./mutation/compute/compute-auth-ticket-mutation.ts)
  and validate through
  [`validateAuthTicketMutation`](./mutation/validate/validate-auth-ticket-mutation.ts).
- Agent-ticket operations compute through
  [`computeAuthAgentTicketMutation`](./mutation/compute/compute-auth-agent-ticket-mutation.ts)
  and validate through
  [`validateAuthAgentTicketMutation`](./mutation/validate/validate-auth-agent-ticket-mutation.ts).
- User registration has its own pure owner,
  [`computeAuthUserRegistration`](./mutation/compute/compute-auth-user-registration.ts),
  and session commands retain their own owner above.
- One-use ticket reads, legacy cutoff and bounded scan, conditional insert or
  consume, and session reconstruction remain in the current
  [`AuthTicketPersistence`](../repositories/auth-ticket-persistence.ts),
  [`auth-legacy-compatibility.ts`](../repositories/auth-legacy-compatibility.ts),
  [`auth-persistence-contracts.ts`](../repositories/auth-persistence-contracts.ts),
  and [`auth-session-types.ts`](../repositories/auth-session-types.ts) owners.

Missing, expired, already-consumed, digest-mismatched, or corrupt tickets retain
their existing no-op or failure classification. Successful issue and consume
operations exit through the same AppInbox transaction and durable-result path.

## Authentication and authorization proof/query

- HTTP bearer authentication reads the current session repository through
  `packages/shared-server/http/request-auth-service.ts`; it does not enter a
  mutation transaction.
- [`authSessionProofSecret`](./sessions/auth-session-proof-secret.ts) returns the
  existing digest proof used by canonical group and topology authority owners.
- Queries and authorization checks remain read-only. Missing, expired, corrupt,
  or mismatched authority fails through the existing consumer-specific result.
  This feature does not absorb group, client-state, topology, CRDT, or admin
  authorization policy.

## Canonical PR A owners

The remaining canonical owners, in addition to the files linked in the traces,
are:

- [`AuthMutationRejectedError`](./mutation/auth-mutation-rejected-error.ts)
- [`computeAuthUserRegistration`](./mutation/compute/compute-auth-user-registration.ts)
- [`validateAuthUserMutation`](./mutation/validate/validate-auth-user-mutation.ts)
- [`validateAuthSessionMutation`](./mutation/validate/validate-auth-session-mutation.ts)
- shared exact-kind, ticket, and JSON rules in
  [`requireMatchingAuthKind`](./mutation/validate/auth-mutation-validation.ts)

These are implementation owners. The supported old service paths are direct
one-hop compatibility exports; canonical PR A code imports the files above.

## Current predecessor owners reserved for PR B

The following files still own executable runtime or persistence behavior in PR
A and must not be treated as compatibility-only yet:

- [`AppAuthInboxService`](../services/AppAuthInboxService.ts)
- [`toAuthAppInboxType`](../services/auth-app-inbox-routing.ts)
- [`readAuthMutation`](../services/auth-state-read.ts)
- [`writeAuthMutation`](../services/auth-state-write.ts)
- [`AuthSessionRepository`](../repositories/AuthSessionRepository.ts)
- [`AuthUserRepository`](../repositories/AuthUserRepository.ts)
- [`AuthSessionPersistence`](../repositories/auth-session-persistence.ts)
- [`AuthTicketPersistence`](../repositories/auth-ticket-persistence.ts)
- [`PersistedAuthSession`](../repositories/auth-persistence-contracts.ts)
- [`IssuedAuthSession`](../repositories/auth-session-types.ts)
- [`AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS`](../repositories/auth-legacy-compatibility.ts)

PR B may move these only under its separately reviewed authoritative-shell and
persistence scope. Until then, tests and consumers must use these current owners
rather than dead future paths.
