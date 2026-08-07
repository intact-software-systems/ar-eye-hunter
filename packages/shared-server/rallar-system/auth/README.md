# Auth server navigation

This directory owns authenticated server commands from queue routing through
stable reads, pure decisions, validation, transactional writes, and public
result reconstruction. New auth implementation and mirrored auth tests import
these canonical owners. Compatibility paths exist only for the listed callers.

## Read these files first

1. Start at the canonical
   [`AppAuthInboxService`](./inbox/app-auth-inbox-service.ts) for public enqueue
   methods and construction-time registration.
2. Follow a later dequeue into
   [`AuthInboxHandler`](./inbox/auth-inbox-handler.ts), which exposes the phase
   sequence and transaction boundary in one method.
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

The API-v1 composition root remains
[`middleware.ts`](../../../../apps/api-v1/src/middleware.ts). The prose traces
below are supplementary navigation. Repository governance derives and checks
an exact file, symbol, and direct import edge for every stage in all five
families. The approved timing waiver remains in force: no human timing sample
was repeated, and these traces make no productivity or statistical claim.

## Login and credential issuance

### Construction and registration

- **Registration owner/time:** API-v1
  [`config-route.init`](../../../../apps/api-v1/src/routes/config-route.ts)
  registers `/api/auth/login` at application construction. Its resolved
  dependencies defer reading the already-constructed `AppAuthInboxService`
  until a request reaches the route.
- **Compatibility-only paths:** API-v1 login composition currently reaches
  canonical login behavior through `services/auth-login-service.ts`, and its
  repositories through `repositories/AuthUserRepository.ts`. Those wrappers
  contain named re-exports only.

### Later invocation trace

1. **Later invocation/retry:** the route applies IP and username rate limits,
   decodes the request, and calls `login-repository.login`; a later successful
   proof invokes `AppAuthInboxService.issueSession`. Queue conflicts retry the
   whole AppInbox attempt, not credential proof.
2. **First guard:**
   [`authenticateAuthUser`](./login/authenticate-auth-user.ts) normalizes the
   username, rejects disabled or bad-password users before reading later
   authority fields, and falls back to configured static clients only under
   the established mode.
3. **Transaction or query boundary:** credential proof is a read-only
   [`AuthUserRepository`](./persistence/auth-user-repository.ts) query. Session
   issuance then enters the authenticated AppInbox transaction trace below.
4. **Durable writes:**
   [`createHmacAuthCredentialIssuer`](./credentials/auth-credential-issuer.ts)
   creates plaintext only at the caller boundary;
   [`hashAuthSecret`](./credentials/hash-auth-secret.ts) supplies the digest in
   the queued command, session indexes, and durable result.
5. **Commit/after-commit:** after both session indexes, durable result, receipt,
   and queue completion commit, the waiting service reconstructs the same
   access token from the command identity.
6. **Normal result:** registered and permitted static-client proofs produce a
   session proposal; the route returns the committed public login response.
7. **Early exits:** rate limits, malformed input, unknown users, disabled users,
   and wrong passwords return before session enqueue or durable writes.
8. **Terminal failure/cleanup:** terminal AppInbox failure stays an
   `AppInboxFailure`; a failed transaction exposes no successful session or
   completion result.
9. **Caller result:** the API route maps a missing proof to 401 and a completed
   `Either.right` to the established login JSON shape.

Registration follows the sibling
[`prepareAuthUserRegistration`](./login/prepare-auth-user-registration.ts)
path, then enters the same durable mutation pipeline through `registerUser`.

## Authenticated AppInbox mutation

### Construction and registration

- **Registration owner/time:** the `AppAuthInboxService` constructor creates one
  complete `AuthInboxHandler`, including its transaction-writer port, then
  registers all seven auth message types in fixed order. Registration stores
  callbacks only; it performs no read, compute, validation, or write.
- **Compatibility-only paths:** existing service consumers may import
  `services/AppAuthInboxService.ts` and `services/auth-state-mutations.ts`.
  Package auth inbox exports already point directly at canonical owners.

### Later invocation trace

1. **Later invocation/retry:** a public service method uses
   [`decodeAuthMutationCommand`](./mutation/decode-auth-mutation-command.ts) and
   [`toAuthAppInboxType`](./inbox/auth-app-inbox-routing.ts) to enqueue one
   durable command. A later accepted dequeue invokes the callback; conditional
   conflicts escape to the base AppInbox whole-attempt retry owner.
2. **First guard:** `AuthInboxHandler.processAuthMutation` decodes again and
   rejects type, resource, or context identity mismatch before any state read.
   Sender is intentionally not part of this established auth-specific check.
3. **Transaction or query boundary:** stable reads, facts, pure compute, and
   validation finish before `transactionWriter.writeMutation` opens the write
   transaction. Session reads use canonical-then-legacy order in
   [`readAuthSessionEntries`](./mutation/read/read-auth-session-entries.ts).
4. **Durable writes:** the transaction calls `writeAuthMutation`, then owns the
   authoritative state changes, durable result, receipt, queue completion, and
   any final outbox intent as one unit.
5. **Commit/after-commit:** only a committed transaction releases the durable
   result. There is no auth-specific after-commit side effect; the caller only
   decodes the stored result and reconstructs its public response.
6. **Normal result:** one of the seven
   [`AuthMutationCommand`](./mutation/auth-mutation-contracts.ts) variants
   produces its matching durable discriminant and public result.
7. **Early exits:** decode, queue identity, read, compute, or validation failure
   exits before writes. Domain rejections use
   [`AuthMutationRejectedError`](./mutation/auth-mutation-rejected-error.ts).
8. **Terminal failure/cleanup:** rollback commits none of the authoritative
   state, result, receipt, completion, or outbox writes. Terminal retry failure
   never publishes a successful completion.
9. **Caller result:**
   `processAuthCommandUntilCompletion` preserves typed queue failures on the
   left and returns reconstructed plaintext only on the right.

## Session lifecycle, logout, expiry, and revocation

### Construction and registration

- **Registration owner/time:** API-v1 registers login and logout routes during
  `config-route.init`; the auth service constructor registers the session issue
  and logout queue callbacks before any later queue invocation.
- **Compatibility-only paths:** API-v1 and cross-domain callers still use the
  AppAuth service and `repositories/AuthSessionRepository.ts` wrappers listed
  in the compatibility inventory below.

### Later invocation trace

1. **Later invocation/retry:** login invokes `issueSession`; authenticated
   logout invokes `logoutSession`. Both become durable AppInbox commands and
   retry as complete queue attempts on conditional conflict.
2. **First guard:**
   [`requireIssueSessionLifecycle`](./sessions/require-issue-session-lifecycle.ts)
   rejects malformed issue timestamps. Logout compute requires the expected
   session identity and treats already-absent or superseded state as the
   established no-op.
3. **Transaction or query boundary:**
   [`computeAuthSessionMutation`](./mutation/compute/compute-auth-session-mutation.ts)
   and
   [`validateAuthSessionMutation`](./mutation/validate/validate-auth-session-mutation.ts)
   finish before the transaction. Expired and legacy observations remain
   separate from authoritative decisions.
4. **Durable writes:**
   [`writeAuthSession`](./mutation/write/write-auth-session.ts) writes the token
   digest index before the session index. Logout deletes the session index,
   deletes the observed token key by revision, and writes the exact
   [`toAuthLogoutOutbox`](./mutation/compute/to-auth-logout-outbox.ts) intent.
5. **Commit/after-commit:** both indexes or both guarded deletions commit with
   the result and receipt. The final logout outbox is transaction-owned; no
   intermediate auth intent is published after commit.
6. **Normal result:** issuance returns the established public session; logout
   returns `{ loggedOut: true }`, including the established absent-state no-op.
7. **Early exits:** invalid lifecycle, disabled registered authority, corrupt
   index pairs, or mismatched expected session fail before a successful commit.
8. **Terminal failure/cleanup:** rollback removes partial indexes and outbox
   writes. A released retry rereads user policy and may terminate as forbidden.
9. **Caller result:** the route receives only the committed public result or a
   typed failure; plaintext access tokens never enter durable commands/results.

[`AuthSessionRepository`](./persistence/auth-session-repository.ts) composes
[`AuthSessionPersistence`](./persistence/auth-session-persistence.ts) with
ticket persistence. Persisted and issued shapes remain distinct in
[`auth-persistence-contracts.ts`](./persistence/auth-persistence-contracts.ts)
and [`auth-session-types.ts`](./persistence/auth-session-types.ts).

## Ticket issue and consume

### Construction and registration

- **Registration owner/time:** `config-route.init` registers WebSocket and agent
  ticket endpoints; the auth service constructor registers all four ticket
  issue/consume message callbacks before queue work starts.
- **Compatibility-only paths:** API-v1 uses the AppAuth and session-repository
  wrappers. Shared HTTP WebSocket proof uses the AppAuth wrapper until its
  listed callers migrate.

### Later invocation trace

1. **Later invocation/retry:** authenticated routes call the issue methods;
   WebSocket and agent handshakes call the consume methods later. Each command
   retries as a whole AppInbox attempt after a conditional conflict.
2. **First guard:** queue identity is checked first. Then
   [`computeAuthTicketMutation`](./mutation/compute/compute-auth-ticket-mutation.ts)
   or
   [`computeAuthAgentTicketMutation`](./mutation/compute/compute-auth-agent-ticket-mutation.ts)
   checks parent authority, ticket identity, expiry, batch shape, and one-use
   state before validation.
3. **Transaction or query boundary:**
   [`validateAuthTicketMutation`](./mutation/validate/validate-auth-ticket-mutation.ts)
   and
   [`validateAuthAgentTicketMutation`](./mutation/validate/validate-auth-agent-ticket-mutation.ts)
   complete before transactional ticket writes.
4. **Durable writes:**
   [`writeAuthTicketMutation`](./mutation/write/write-auth-ticket-mutation.ts)
   inserts digest-key ticket records or deletes the exact observed ticket key
   by revision. Agent issuance writes each child session before its ticket.
5. **Commit/after-commit:** ticket/session writes, result, receipt, and queue
   completion commit together. A successful consume returns the session only
   after the one-use delete commits.
6. **Normal result:** issue returns plaintext credentials reconstructed at the
   caller boundary; consume returns the authorized issued session.
7. **Early exits:** absent, expired, already-consumed, corrupt, mismatched-token,
   unauthorized-parent, and duplicate-agent cases exit without a success row.
8. **Terminal failure/cleanup:** rollback preserves a consumable ticket and
   removes partial child sessions. Terminal retry failure cannot publish a
   success or leak plaintext.
9. **Caller result:** API-v1 maps the committed `Either`; WebSocket proof maps a
   missing/failed consume to unauthorized.

[`AuthTicketPersistence`](./persistence/auth-ticket-persistence.ts) owns
canonical ticket records. Bounded plaintext reads and their fixed deadline live
only in
[`auth-legacy-compatibility.ts`](./persistence/auth-legacy-compatibility.ts).

## Authentication and authorization proof/query

### Construction and registration

- **Registration owner/time:** API-v1 request-auth composition creates the
  session repository for HTTP proof and reads the already-constructed auth
  inbox service for WebSocket proof. Routes install those functions during
  application construction; no proof query runs then.
- **Compatibility-only paths:** API-v1 request auth and shared HTTP currently
  type/import `repositories/AuthSessionRepository.ts`; shared HTTP also types
  `services/AppAuthInboxService.ts` for ticket consumption.

### Later invocation trace

1. **Later invocation/retry:** `requireApiAuthSession` runs on each protected
   HTTP request. `requireWsAuthSession` later consumes the presented ticket
   through AppInbox, inheriting its whole-attempt conflict retry.
2. **First guard:** HTTP proof rejects a missing/malformed bearer token and
   missing client header before repository access. WebSocket proof rejects a
   missing ticket before enqueue.
3. **Transaction or query boundary:** HTTP proof calls
   `AuthSessionRepository.findByAccessToken` as a read-only query and checks the
   returned client identity. WebSocket proof crosses the ticket-consume
   transaction described above.
4. **Durable writes:** HTTP proof writes nothing. WebSocket proof conditionally
   deletes the observed ticket key with its result/receipt/completion.
5. **Commit/after-commit:** HTTP proof has no commit or after-commit work.
   WebSocket proof returns a session only after the consume transaction commits.
6. **Normal result:** both paths return an `IssuedAuthSession`;
   [`authSessionProofSecret`](./sessions/auth-session-proof-secret.ts) derives
   the existing digest proof without mutating the session.
7. **Early exits:** missing headers/tickets, unknown/expired sessions, client
   mismatch, and failed ticket consume become unauthorized without plaintext
   disclosure.
8. **Terminal failure/cleanup:** query failure produces no write; consume
   rollback leaves no partial result and retains the ticket unless its delete
   committed.
9. **Caller result:** protected HTTP/WS owners receive the issued session or the
   established unauthorized error; this boundary does not absorb group,
   client-state, topology, CRDT, or admin policy.

The concrete request-auth owners are
[`apps/api-v1/src/services/request-auth-service.ts`](../../../../apps/api-v1/src/services/request-auth-service.ts)
and
[`packages/shared-server/http/request-auth-service.ts`](../../http/request-auth-service.ts).

## Canonical auth owners

The traces above are supplemented by these phase owners:

- [`computeAuthUserRegistration`](./mutation/compute/compute-auth-user-registration.ts)
- shared exact-kind and JSON rules in
  [`requireMatchingAuthKind`](./mutation/validate/auth-mutation-validation.ts)
- [`validateAuthUserMutation`](./mutation/validate/validate-auth-user-mutation.ts)

## Supported compatibility entry

All six retained compatibility modules are direct named re-export-only owners.
The machine-checked exact path inventory is
[`auth-server-compatibility-consumer-inventory.ts`](../../../tests/repo/auth-server-compatibility-consumer-inventory.ts).

| Compatibility owner                     | Current consumers                                                                  | Removal condition                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `services/AppAuthInboxService.ts`       | API-v1 composition/routes/DB tests, shared HTTP/middleware, one shared-server test | Migrate every listed caller to canonical inbox owners, then retire the supported path. |
| `services/auth-state-mutations.ts`      | API-v1 composition/DB tests, package root, shared tests                            | Move the package export and every listed caller to canonical mutation owners first.    |
| `services/auth-login-service.ts`        | API-v1 login repository                                                            | Move that repository to canonical login owners first.                                  |
| `services/auth-credential-issuer.ts`    | API-v1 composition/DB tests, shared HTTP hardening, one shared-server test         | Move every issuer and secret-validation caller to canonical credentials first.         |
| `repositories/AuthSessionRepository.ts` | API-v1, shared HTTP/Postgres/domain code, fixtures/tests, performance harnesses    | Migrate every listed consumer to canonical persistence.                                |
| `repositories/AuthUserRepository.ts`    | API-v1 and Postgres repository composition/tests                                   | Migrate every listed consumer to canonical persistence.                                |

The former private routing, read, and write service files have no compatibility
wrapper. Canonical auth code and mirrored auth tests must not import the six
supported wrappers. Repository governance alone owns runtime-identity checks.
