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
below are supplementary navigation; the auth behavior, security, and ownership
suites remain primary evidence. The auth child temporarily freezes the exact
reviewed source blobs and named owner regions behind all five families. The
later ledger may remove that snapshot only after PR C's resulting-main workflow
publishes equivalent semantic evidence. The approved timing waiver remains in
force: no human timing sample was repeated, and these traces make no
productivity or statistical claim.

## Login and credential issuance

### Construction and callback registration

- **Construction:** `config-route.init` resolves its route dependencies once at
  application construction; reading the already-constructed
  `AppAuthInboxService` remains deferred until a request reaches the route.
- **Callback registration:** API-v1
  [`config-route.init`](../../../../apps/api-v1/src/routes/config-route.ts)
  passes the `/api/auth/login` callback to `app.post`.

### Later handler invocation

1. **Later handler invocation:** the route applies IP and username rate limits,
   decodes the request, and calls `login-repository.login`; a later successful
   proof invokes `AppAuthInboxService.issueSession`. Queue conflicts retry the
   whole AppInbox attempt, not credential proof.
2. **First guard/validation:**
   [`authenticateAuthUser`](./login/authenticate-auth-user.ts) normalizes the
   username, rejects disabled or bad-password users before reading later
   authority fields, and falls back to configured static clients only under
   the established mode.
3. **Transaction/retry or query call:** credential proof calls the read-only
   [`AuthUserRepository`](./persistence/auth-user-repository.ts) query. Session
   issuance then enters the authenticated AppInbox transaction trace below.
4. **Durable write or query-only N/A:**
   [`createHmacAuthCredentialIssuer`](./credentials/auth-credential-issuer.ts)
   creates plaintext only at the caller boundary;
   [`hashAuthSecret`](./credentials/hash-auth-secret.ts) supplies the digest in
   the queued command, session indexes, and durable result.
5. **Commit/after-commit:** after both session indexes, durable result, receipt,
   and queue completion commit, the waiting service reconstructs the same
   access token from the command identity.
6. **Normal return:** registered and permitted static-client proofs produce a
   session proposal; the route returns the committed public login response.
7. **Early return/no-op:** rate limits, malformed input, unknown users, disabled users,
   and wrong passwords return before session enqueue or durable writes.
8. **Terminal throw/rejection:** a missing durable AppInbox result throws and
   terminal AppInbox failure stays an `AppInboxFailure`.
9. **Cleanup/finally/rollback:** `runInTransaction` owns rollback, so a failed
   transaction exposes no successful session or completion result.
10. **Caller propagation:** the API route maps a missing proof to 401 and a completed
    `Either.right` to the established login JSON shape.
11. **Compatibility path:** API-v1 login composition currently reaches canonical
    login behavior through `services/auth-login-service.ts`, and its repositories
    through `repositories/AuthUserRepository.ts`. Those wrappers contain named
    re-exports only.

Registration follows the sibling
[`prepareAuthUserRegistration`](./login/prepare-auth-user-registration.ts)
path, then enters the same durable mutation pipeline through `registerUser`.

## Authenticated AppInbox mutation

### Construction and callback registration

- **Construction:** the `AppAuthInboxService` constructor creates one complete
  `AuthInboxHandler`, including its transaction-writer port.
- **Callback registration:** that constructor passes one callback for each of
  the seven fixed auth message types to `onStateMessage`. Registration performs
  no read, compute, validation, or write.

### Later handler invocation

1. **Later handler invocation:** a public service method uses
   [`decodeAuthMutationCommand`](./mutation/decode-auth-mutation-command.ts) and
   [`toAuthAppInboxType`](./inbox/auth-app-inbox-routing.ts) to enqueue one
   durable command. A later accepted dequeue invokes the callback; conditional
   conflicts escape to the base AppInbox whole-attempt retry owner.
2. **First guard/validation:** `AuthInboxHandler.processAuthMutation` decodes again and
   rejects type, resource, or context identity mismatch before any state read.
   Sender is intentionally not part of this established auth-specific check.
3. **Transaction/retry or query call:** stable reads, facts, pure compute, and
   validation finish before `transactionWriter.writeMutation` opens the write
   transaction. Session reads use canonical-then-legacy order in
   [`readAuthSessionEntries`](./mutation/read/read-auth-session-entries.ts).
4. **Durable write or query-only N/A:** the transaction calls `writeAuthMutation`, then owns the
   authoritative state changes, durable result, receipt, queue completion, and
   any final outbox intent as one unit.
5. **Commit/after-commit:** only a committed transaction releases the durable
   result. There is no auth-specific after-commit side effect; the caller only
   decodes the stored result and reconstructs its public response.
6. **Normal return:** one of the seven
   [`AuthMutationCommand`](./mutation/auth-mutation-contracts.ts) variants
   produces its matching durable discriminant and public result.
7. **Early return/no-op:** replay and no-op outcomes return their computed result
   without a domain write; decode, queue identity, read, compute, or validation failure
   exits before writes. Domain rejections use
   [`AuthMutationRejectedError`](./mutation/auth-mutation-rejected-error.ts).
8. **Terminal throw/rejection:** queue identity mismatch throws before reads;
   terminal retry failure never publishes a successful completion.
9. **Cleanup/finally/rollback:** `runInTransaction` rollback commits none of the
   authoritative state, result, receipt, completion, or outbox writes.
10. **Caller propagation:**
    `processAuthCommandUntilCompletion` preserves typed queue failures on the
    left and returns reconstructed plaintext only on the right.
11. **Compatibility path:** existing service consumers may import
    `services/AppAuthInboxService.ts` and `services/auth-state-mutations.ts`.
    Package auth inbox exports already point directly at canonical owners.

## Session lifecycle, logout, expiry, and revocation

### Construction and callback registration

- **Construction:** the auth service constructor creates the canonical handler
  before any later session queue invocation.
- **Callback registration:** that constructor passes the session issue and
  logout callbacks to `onStateMessage`; API-v1 separately installs login and
  logout route callbacks during `config-route.init`.

### Later handler invocation

1. **Later handler invocation:** login invokes `issueSession`; authenticated
   logout invokes `logoutSession`. Both become durable AppInbox commands and
   retry as complete queue attempts on conditional conflict.
2. **First guard/validation:**
   [`requireIssueSessionLifecycle`](./sessions/require-issue-session-lifecycle.ts)
   rejects malformed issue timestamps. Logout compute requires the expected
   session identity and treats already-absent or superseded state as the
   established no-op.
3. **Transaction/retry or query call:**
   [`computeAuthSessionMutation`](./mutation/compute/compute-auth-session-mutation.ts)
   and
   [`validateAuthSessionMutation`](./mutation/validate/validate-auth-session-mutation.ts)
   finish before the transaction. Expired and legacy observations remain
   separate from authoritative decisions.
4. **Durable write or query-only N/A:**
   [`writeAuthSession`](./mutation/write/write-auth-session.ts) writes the token
   digest index before the session index. Logout deletes the session index,
   deletes the observed token key by revision, and writes the exact
   [`toAuthLogoutOutbox`](./mutation/compute/to-auth-logout-outbox.ts) intent.
5. **Commit/after-commit:** both indexes or both guarded deletions commit with
   the result and receipt. The final logout outbox is transaction-owned; no
   intermediate auth intent is published after commit.
6. **Normal return:** issuance returns the established public session; logout
   returns `{ loggedOut: true }`, including the established absent-state no-op.
7. **Early return/no-op:** absent logout state returns the established no-op;
   invalid lifecycle, disabled registered authority, corrupt
   index pairs, or mismatched expected session fail before a successful commit.
8. **Terminal throw/rejection:** invalid issue lifecycle throws, and a released
   retry may reread user policy and terminate as forbidden.
9. **Cleanup/finally/rollback:** `runInTransaction` rollback removes partial
   indexes and outbox writes.
10. **Caller propagation:** the route receives only the committed public result or a
    typed failure; plaintext access tokens never enter durable commands/results.
11. **Compatibility path:** API-v1 and cross-domain callers still use the
    AppAuth service and `repositories/AuthSessionRepository.ts` wrappers listed
    in the compatibility inventory below.

[`AuthSessionRepository`](./persistence/auth-session-repository.ts) composes
[`AuthSessionPersistence`](./persistence/auth-session-persistence.ts) with
ticket persistence. Persisted and issued shapes remain distinct in
[`auth-persistence-contracts.ts`](./persistence/auth-persistence-contracts.ts)
and [`auth-session-types.ts`](./persistence/auth-session-types.ts).

## Ticket issue and consume

### Construction and callback registration

- **Construction:** the auth service constructor creates the canonical handler
  before ticket queue work starts.
- **Callback registration:** that constructor passes all four ticket
  issue/consume callbacks to `onStateMessage`; `config-route.init` separately
  installs the WebSocket and agent ticket endpoint callbacks.

### Later handler invocation

1. **Later handler invocation:** authenticated routes call the issue methods;
   WebSocket and agent handshakes call the consume methods later. Each command
   retries as a whole AppInbox attempt after a conditional conflict.
2. **First guard/validation:** queue identity is checked first. Then
   [`computeAuthTicketMutation`](./mutation/compute/compute-auth-ticket-mutation.ts)
   or
   [`computeAuthAgentTicketMutation`](./mutation/compute/compute-auth-agent-ticket-mutation.ts)
   checks parent authority, ticket identity, expiry, batch shape, and one-use
   state before validation.
3. **Transaction/retry or query call:**
   [`validateAuthTicketMutation`](./mutation/validate/validate-auth-ticket-mutation.ts)
   and
   [`validateAuthAgentTicketMutation`](./mutation/validate/validate-auth-agent-ticket-mutation.ts)
   complete before transactional ticket writes.
4. **Durable write or query-only N/A:**
   [`writeAuthTicketMutation`](./mutation/write/write-auth-ticket-mutation.ts)
   inserts digest-key ticket records or deletes the exact observed ticket key
   by revision. Agent issuance writes each child session before its ticket.
5. **Commit/after-commit:** ticket/session writes, result, receipt, and queue
   completion commit together. A successful consume returns the session only
   after the one-use delete commits.
6. **Normal return:** issue returns plaintext credentials reconstructed at the
   caller boundary; consume returns the authorized issued session.
7. **Early return/no-op:** an exact replay returns its computed receipt without
   another ticket write; absent, expired, already-consumed, corrupt, mismatched-token,
   unauthorized-parent, and duplicate-agent cases exit without a success row.
8. **Terminal throw/rejection:** invalid ticket authority rejects before a
   successful write; terminal retry failure cannot publish success or plaintext.
9. **Cleanup/finally/rollback:** `runInTransaction` rollback preserves a
   consumable ticket and removes partial child sessions.
10. **Caller propagation:** API-v1 maps the committed `Either`; WebSocket proof maps a
    missing/failed consume to unauthorized.
11. **Compatibility path:** API-v1 uses the AppAuth and session-repository
    wrappers. Shared HTTP WebSocket proof uses the AppAuth wrapper until its
    listed callers migrate.

[`AuthTicketPersistence`](./persistence/auth-ticket-persistence.ts) owns
canonical ticket records. Bounded plaintext reads and their fixed deadline live
only in
[`auth-legacy-compatibility.ts`](./persistence/auth-legacy-compatibility.ts).

## Authentication and authorization proof/query

### Construction and callback registration

- **Construction:** API-v1 middleware composition creates the session
  repository for HTTP proof and reads the already-constructed auth inbox
  service for WebSocket proof; no proof query runs then.
- **Callback registration:** protected API-v1 routes install request-auth
  callbacks during application construction.

### Later handler invocation

1. **Later handler invocation:** `requireApiAuthSession` runs on each protected
   HTTP request. `requireWsAuthSession` later consumes the presented ticket
   through AppInbox, inheriting its whole-attempt conflict retry.
2. **First guard/validation:** HTTP proof rejects a missing/malformed bearer token and
   missing client header before repository access. WebSocket proof rejects a
   missing ticket before enqueue.
3. **Transaction/retry or query call:** HTTP proof calls
   `AuthSessionRepository.findByAccessToken` as a read-only query and checks the
   returned client identity. WebSocket proof crosses the ticket-consume
   transaction described above.
4. **Durable write or query-only N/A:** the HTTP owner is AST-proven query-only
   and writes nothing. WebSocket proof conditionally
   deletes the observed ticket key with its result/receipt/completion.
5. **Commit/after-commit:** HTTP proof has no commit or after-commit work.
   WebSocket proof returns a session only after the consume transaction commits.
6. **Normal return:** both paths return an `IssuedAuthSession`;
   [`authSessionProofSecret`](./sessions/auth-session-proof-secret.ts) derives
   the existing digest proof without mutating the session.
7. **Early return/no-op:** bearer parsing returns early for malformed input;
   missing headers/tickets, unknown/expired sessions, client
   mismatch, and failed ticket consume become unauthorized without plaintext
   disclosure.
8. **Terminal throw/rejection:** missing or mismatched proof throws the
   established unauthorized error.
9. **Cleanup/finally/rollback:** the query-only HTTP owner has no cleanup or
   rollback; WebSocket consume rollback leaves no partial result and retains the
   ticket unless its delete committed.
10. **Caller propagation:** protected HTTP/WS owners receive the issued session or the
    established unauthorized error; this boundary does not absorb group,
    client-state, topology, CRDT, or admin policy.
11. **Compatibility path:** API-v1 request auth and shared HTTP currently
    type/import `repositories/AuthSessionRepository.ts`; shared HTTP also types
    `services/AppAuthInboxService.ts` for ticket consumption.

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
