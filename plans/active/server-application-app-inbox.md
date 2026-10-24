# AppInbox for Rallar server applications

## Goal and boundary

Server applications must be able to register and submit their own durable mutations through the public Rallar Server API. Rallar owns reservation, replay storage, QueueBox retries, transactions and durable completion. Applications own their command names, schemas, logical identity and business decisions. No application name or game policy belongs in the shared product.

The current public owner is `packages/shared-server/rallar-server/rallar-server-application.ts`. It exposes `ws` and `appData`, but AppInbox consumers currently assemble internal client and handler runtimes directly. Relic is the concrete consumer for the first public API; it must not determine generic product command names or rules.

## Current slice: complete archived-room deletion

Finish seven-day deletion, including the Relic save writer fence and human-clickable game acceptance. Remove the Relic operation from the product enum and its logical-command special case. Keep only the narrow generic command-extension support needed by the existing AppInbox owner. Relic owns proposal-independent replay comparison and validates retained command, authority and queue binding. Do not build the public application facade in this slice.

Acceptance remains exact-deadline deletion, no resurrection by stale writers, immutable replay results, optimistic CAS with fresh outer retry, and working browser flows. Existing required functional, PostgreSQL, performance and release gates remain in force.

## Next slice: public server application AppInbox

After the current PR merges, implement one independently reviewable PR:

1. Trace the current client, reservation, handler and transaction owners and expose one explicit application AppInbox capability through `RallarServerApplication` and the supported shared-server exports. Reuse those owners; do not introduce a second queue, transaction loop or mutation algorithm.
2. Support namespaced application commands with exact scope/key binding. Registration supplies the app-owned decoder, result encoder and logical-command policy. The trusted registration owns identity projection; a caller cannot declare a matching identity to bypass validation. Unknown handlers, mismatched envelopes and corrupt durable rows fail closed.
3. Keep `read -> compute -> validate -> write(transaction, computed)` visible. One delivery performs one attempt; CAS conflicts return to QueueBox for a fresh full attempt. Store the exact durable result and final outbox intents in the same transaction. Run wakes or other allowed effects only after commit. No direct-mutation fallback, locks or inner retries.
4. Preserve winner facts across replay and retry. Logical identity binds caller semantics before server time, randomness or external proposals are captured. Matching replay returns the durable winner; conflicting reuse cannot recapture volatile facts or write state.
5. Register handlers before workers start, on every process that can claim their rows. Keep construction and invocation boundaries explicit and verify shutdown/failure behavior through the existing runtime lifecycle.
6. Move Relic onto this public capability and remove its direct assembly of internal AppInbox machinery. Retain its game authorization, proposal validation, group fence, save CAS and publication policy in the Relic owner. Add one small non-game server application example that demonstrates the public API without internal imports.

## Validation and completion

Start with semantic tests for a non-game application using public exports: registration, successful mutation and exact result, matching replay, conflicting request identity, unknown operation, malformed stored binding, same-key concurrency, rollback and after-commit effects. Force a real CAS conflict and prove fresh read/compute/validate on outer redelivery; prove retry exhaustion has no partial state or outbox publication.

Run focused shared-server and Relic tests, applicable package and API/server native type checks, public export and browser-boundary checks, the Relic browser workflow, the unweakened PostgreSQL medium-scale gate, and the state-write comparison when the mutation path changes. Require the Branch Release Gate. Perform independent code/legacy review and the 5/5 IDE mutation navigation probe.

Review and remediate every changed human-authored file in full, including support files changed by remediation; independent untouched code stays outside closure. Preserve existing supported product behavior without a parallel legacy path or migration shim. The PR that finishes this plan deletes it before merge. The live PR remains the delivery record.
