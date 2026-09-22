# Test structure-coupling exception registry

`npm run check:test-structure-coupling` is a full-tree advisory review aid. It detects
tests coupled to production source text, file topology, ASTs, symbol spelling,
source hashes or snapshots, line counts, call/import order, mock invocation
counts or order, hidden browser call logs, browser primitive probes, generated
asset identity, and migration or compatibility topology. A clean report does
not prove that every test is semantic; a candidate is a prompt for human
review, not an automatic failure.

Production code remains the primary design artifact. Delete or replace an
incidental structural test with semantic coverage when production design
improves. Retain one only when it protects an independently stated durable
public, security, compatibility, or interaction boundary, or when it is a
temporary ratchet with a named owner and removal condition. An `interaction`
contract additionally states why its count, absence, or order is independently
observable and required, such as exactly-once payment, idempotency, retry,
cache-suppression, or protocol-order behavior. Do not use this registry as a
blanket baseline or automatic grandfathering mechanism.

The `contracts` section states each independently meaningful domain contract
in human language and links it to the exact executable assertion that proves
the boundary. The assertion may share a file with a candidate only when it
executes the named behavior and the candidate is a concrete input to that
behavior; merely naming the same structural file is not coverage. Each entry
links one exact occurrence to one contract. Its `id`, `path`, and `kind` must
match the checker report exactly, while its rationale explains why that
occurrence is needed by that assertion. Related occurrences share a contract;
distinct executable assertions remain separately reviewable.

An entry's `id` is derived from the occurrence's path, kind, whitespace-normalized
source text, and its occurrence order within the file. It deliberately excludes
line and column so that reformatting cannot re-key a registered review; a change
in what an occurrence _asserts_ re-keys it, a change in where it _sits_ does not.
The checker report still prints the live `path:line:column` for navigation.

Every entry has a named `owner`. A `durable-boundary` entry additionally
declares `boundary` as `public`, `security`, `compatibility`, or `interaction`.
The linked contract for an `interaction` boundary additionally declares a
structured `interactionRequirement` with `interactionKind` (`count`, `absence`,
or `order`), `ownedPort`, `observableEffect`, `requiredConstraint`, and
`failureRationale`. A
`temporary-ratchet` entry additionally
declares an assertion-specific `removalCondition`. Placeholder, escaped
control-only, or vague values such as
`TODO`, `none`, `later`, `...`, `-`, `semantic coverage`, or bracketed
placeholders are not valid evidence. A contract with no current candidates is
also invalid, so this document cannot accumulate orphan approvals.

## Reviewed boundaries

Every retained entry is reviewed through its linked domain contract and exact
executable assertion. The registry metadata below is the sole current inventory;
it is not duplicated in a hand-maintained count or category table that can drift
when tests move or a boundary is removed.

The full current candidate tree validates this registry even when the command
reports a selected file set or a Git range. Filtered modes change the report,
not which registrations must remain current. The detector associates source
structure assertions with production-source values in the same bounded test
block; unrelated JSON, artifact, filesystem, or compatibility text is not a
candidate. The checker rejects duplicate, stale, or incomplete registrations,
while unregistered full-tree candidates remain advisory until they are reviewed
individually. The `--changed <base> <head>` mode fails closed for every current
changed occurrence without an individual disposition; deleted occurrences stay
neutral evidence.

Candidate IDs are intentionally location-specific so every occurrence receives
its own review and an edited assertion cannot silently inherit another
assertion's exception. In a changed range, the checker compares a rename or
modification's old and new occurrences by kind and normalized syntax detail:
unmatched old occurrences are neutral `change=deleted` evidence, never a
semantic replacement. Copies report `origin=copy`. A file move can therefore
require an explicit registry update after its new candidate IDs are reviewed;
range matching is reporting evidence only and never transfers approval to a
moved or changed test.

```test-structure-coupling-registry-v1
{
  "version": 1,
  "contracts": [
    {
      "id": "agent-reload-result-precedes-page-reload",
      "domain": "Black-box agent reload ordering",
      "owner": "Shared Test maintainers",
      "summary": "An agent.reload command answers the control server on the socket before the page reload is requested, and requests exactly one reload. Executable assertion: “sends the agent.reload result before reloading and persists the resume record”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts#sends the agent.reload result before reloading and persists the resume record",
      "coverageRelation": "The test delivers an agent.reload command over a fake control socket and lets the injected reload port record what the socket had already sent when it fired.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Injected window location reload port",
        "observableEffect": "One agent.reload command produces exactly one reload request, raised after the result envelope is on the socket.",
        "requiredConstraint": "The result must be sent before the page is torn down, and a single command must never request more than one reload.",
        "failureRationale": "A reload raised before the result loses the only answer the control server will ever get for that command, and a repeated reload turns one command into a page-reload loop."
      }
    },
    {
      "id": "alm-inbound-conflict-one-admission-attempt",
      "domain": "ALM incoming optimistic admission recovery",
      "owner": "Rallar shared maintainers",
      "summary": "An initial incoming delivery makes one admission commit attempt; a lost conditional write retains pending work for fresh worker admission after restart.",
      "semanticCoverage": "packages/tests/shared/al-inbound-message-runtime.test.ts#retains a stale optimistic write for fresh admission after runtime restart",
      "coverageRelation": "The fixture commits an actual competing owner observation through the bound real store method, then lets the original bundle lose CAS. It checks one outer runtime call, pending NEW work and no premature effects, then recreates the runtime and proves ordered delivery, forwarding and duplicate handling.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ALInboundAdmissionStore.commitBundle called by ALInboundMessageAdmission.attempt",
        "observableEffect": "Each runtime call submits a separately computed admission candidate to the authoritative conditional persistence boundary.",
        "requiredConstraint": "The initial runtime delivery invokes commitBundle exactly once; its conflict must be handed to retained QueueBox work rather than an inner admission retry.",
        "failureRationale": "Eventual delivery and a pending row do not exclude an extra hidden commit attempt before retention. The count guards the one-attempt-per-delivery retry contract. The competing write performed inside the fixture is not counted as an outer runtime call."
      }
    },
    {
      "id": "alm-invalid-queue-candidate-no-transaction",
      "domain": "ALM atomic IndexedDB admission",
      "owner": "Rallar shared maintainers",
      "summary": "Malformed computed queue mutations are rejected before opening the joint native persistence transaction.",
      "semanticCoverage": "packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts#rejects invalid queue values before opening the joint write transaction",
      "coverageRelation": "The test sends a mismatching keyString and ResourceEntry to the real writer, asserts its validation error, observes the native transaction port, then verifies the queue contains no row.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "IDBDatabase.transaction in writeIndexedDbAdmissionMutations",
        "observableEffect": "Opening the native joint transaction begins the persistence attempt and acquires its database transaction scope.",
        "requiredConstraint": "A queue candidate whose keyString differs from its ResourceEntry key must cause zero native transaction openings.",
        "failureRationale": "Rollback or empty storage alone would still allow invalid persistence values to enter a transaction; this assertion protects the independently required validate-before-transaction boundary."
      }
    },
    {
      "id": "alm-work-release-batch-one-transaction",
      "domain": "ALM work release batching on PostgreSQL",
      "owner": "Rallar shared maintainers",
      "summary": "One batch of work releases, each entry carrying its own disposition, commits inside exactly one PostgreSQL transaction. Executable assertion: “commits one mixed release batch in one transaction, each entry on its own disposition”.",
      "semanticCoverage": "packages/tests/shared-server/al-runtime/postgres/p-sql-admission-work-transactions.test.ts#commits one mixed release batch in one transaction, each entry on its own disposition",
      "coverageRelation": "The test reserves three real rows through the PGlite-backed work queue, releases them in one call as completed, retry and not-ready, then reads each released row's own status and retry delay from the returned map.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "PSqlSql.begin, opened by PSqlQueueBox.releaseEntries through PSqlResourceInboxRepository.transaction",
        "observableEffect": "Every release of one work batch reaches the database inside a single transaction, so the batch's rows move together or not at all.",
        "requiredConstraint": "A three-entry batch must open exactly one transaction; per-entry transactions are the cost this slice removes and would also let one lost reservation leave the batch half written.",
        "failureRationale": "The final row statuses are identical whether the batch committed once or three times, so only the transaction count distinguishes an atomic batch release from a per-entry loop."
      }
    },
    {
      "id": "alm-outbound-control-conflict-single-write",
      "domain": "ALM outbound control admission conflict retention",
      "owner": "Rallar shared maintainers",
      "summary": "A control admission that loses its conditional write spends one backend attempt and retains replayable admit-control work instead of retrying inside the owner. Executable assertion: “answers pending-control for a backend conflict without an inner retry”.",
      "semanticCoverage": "packages/tests/shared/alm/al-outbound-control-admission.test.ts#answers pending-control for a backend conflict without an inner retry",
      "coverageRelation": "The test drives the real control owner over an in-memory admission backend whose write raises the typed conflict, then decodes the work row the owner retained through its queue port.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ALAdmissionWorkBackend.write called by ALOutboundControlAdmission.admit",
        "observableEffect": "Each write submits one conditional control-history commit to the authoritative admission backend.",
        "requiredConstraint": "One admit call spends exactly one backend write; a lost conditional write becomes retained admit-control work rather than an inner retry.",
        "failureRationale": "The pending-control answer and the retained row are produced identically by an owner that silently retried its write first, so only the count excludes a hidden inner retry that would re-apply an accepted control under a stale fence."
      }
    },
    {
      "id": "alm-outbound-control-write-free-no-batch",
      "domain": "ALM outbound control admission work wake",
      "owner": "Rallar shared maintainers",
      "summary": "A control message the outbound owner did not handle writes nothing, so it owes no work batch; a committed one does. Executable assertion: “starts a work batch only for a control admission that wrote”.",
      "semanticCoverage": "packages/tests/shared/alm/al-outbound-control-admission.test.ts#starts a work batch only for a control admission that wrote",
      "coverageRelation": "The test drives the real outbound runtime over an engine it does not own, so the only claim the queue can see is the one the runtime's own post-commit wake started.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "QueueBoxResourceEntryRepository.reserveEntries called by the outbound work batch",
        "observableEffect": "Every batch reserves rows, which spends the queue's reservation budget and each row's attempt.",
        "requiredConstraint": "A not-handled or rejected control starts no batch; a committed control starts one.",
        "failureRationale": "Both controls end with the same queue contents and the same admission result, so only the reservation call distinguishes the batch a write-free control must not start from the batch a commit owes."
      }
    },
    {
      "id": "alm-outbound-expiry-during-receipt-read",
      "domain": "ALM outbound deadline eligibility",
      "owner": "Rallar shared maintainers",
      "summary": "A prepared outbound attempt cannot send after its original deadline elapses during an awaited receipt-state read.",
      "semanticCoverage": "packages/tests/shared/al-outbound-durable-effects.test.ts#does not send when the deadline passes during the receipt read",
      "coverageRelation": "The real runtime owns one prepared send. Its receipt read advances the clock exactly to D; the test checks the external send port is untouched and no ready effect remains.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "ALOutboundMessageRuntime.Dependencies.sendPreparedMessage",
        "observableEffect": "The prepared send port starts externally observable carrier delivery.",
        "requiredConstraint": "No prepared send may start when the post-read clock has reached the admitted deadline.",
        "failureRationale": "Terminal or absent queue work can also follow an illegal late send, so work-state readback alone cannot prove deadline enforcement at the external send boundary."
      }
    },
    {
      "id": "alm-outbound-held-claim-quiescence",
      "domain": "ALM outbound held-claim test fixture",
      "owner": "Rallar shared maintainers",
      "summary": "The held-claim fixture restores real queue reservations only once no owner batch is still asking for work, so a disposed runtime cannot strand rows in a reservation nobody releases. Executable assertion: “lets only one runtime claim the same committed send effect”.",
      "semanticCoverage": "packages/tests/shared/al-outbound-durable-effects.test.ts#lets only one runtime claim the same committed send effect",
      "coverageRelation": "The named test holds every claim while a first runtime commits send work, disposes that runtime, releases the hold, and proves a second runtime claims and sends the row exactly once; the fixture wait is the precondition that the release never lands inside a batch."
    },
    {
      "id": "alm-outbound-runtime-control-conflict-retention",
      "domain": "ALM outbound runtime control admission recovery",
      "owner": "Rallar shared maintainers",
      "summary": "A control message accepted through the runtime whose admission loses its conditional write spends one backend attempt and leaves replayable admit-control work for the outbound worker. Executable assertion: “retains a control admission conflict as replayable work without an inner retry”.",
      "semanticCoverage": "packages/tests/shared/al-outbound-durable-effects.test.ts#retains a control admission conflict as replayable work without an inner retry",
      "coverageRelation": "The test admits a real message through the outbound runtime, fails the next backend write with the typed conflict, and reads the pending-control answer together with the runtime's own retained work kinds.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ALAdmissionWorkBackend.write reached through ALOutboundMessageRuntime.acceptControlMessage",
        "observableEffect": "Each write submits one conditional control-history commit for the accepted control message.",
        "requiredConstraint": "One acceptControlMessage call spends exactly one backend write; the conflict is handed to retained queue work rather than retried in place.",
        "failureRationale": "A runtime that retried the write internally would still answer pending-control and still leave the retained row, so the state readback alone cannot exclude the duplicate commit attempt the one-attempt retry contract forbids."
      }
    },
    {
      "id": "api-v1-medium-scale-routing",
      "domain": "API-v1 medium-scale recipe routing",
      "owner": "Rallar server maintainers",
      "summary": "Each group poll targets the API node whose clustered convergence it proves. Executable assertion: “names every group poll for the API node that executes it”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts#names every group poll for the API node that executes it",
      "coverageRelation": "The recipe semantics suite executes the clustered profile and verifies tertiary service requirements; this fixture read ties each named poll to the API node whose convergence it proves."
    },
    {
      "id": "api-v1-recipe-fixture-interface",
      "domain": "API-v1 recipe fixture loading",
      "owner": "Rallar server maintainers",
      "summary": "Shared recipe tests load executable YAML fixtures through one repository-root-aware interface. Executable assertion: “defines a no-browser three-server topology convergence recipe”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe",
      "coverageRelation": "The three-server recipe suite executes parsed YAML through the shared fixture loader; these reads are the repository-root and fixture-text inputs to that public test interface."
    },
    {
      "id": "api-v1-runner-plan-interface",
      "domain": "API-v1 runner plan interface",
      "owner": "Rallar server maintainers",
      "summary": "Managed Postgres commands expose three API nodes and select complete recipe plans without hidden side effects. Executable assertion: “starts three API servers for every managed Postgres cluster command”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts#starts three API servers for every managed Postgres cluster command",
      "coverageRelation": "The runner-plan suite executes managed Postgres planning and asserts all three server processes; this manifest read supplies the actual package command selected by that plan."
    },
    {
      "id": "ar-arena-clipboard-json-content",
      "domain": "AR Eye Hunter browser lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Copy JSON exports the current director-attempt value as JSON while rejecting clipboard errors visibly and ignoring completion after close.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts#reports a rejected clipboard write and releases a pending copy when the drawer closes",
      "coverageRelation": "The assertion operates the real arena hook or App and observes the named external port alongside resulting visible or public state."
    },
    {
      "id": "ar-arena-create-and-switch-boundary",
      "domain": "AR Eye Hunter arena room switching",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Creating an arena uses atomic create-and-switch rather than create-only. Executable assertion: “creates a new arena by switching rooms and clearing stale remote players”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#creates a new arena by switching rooms and clearing stale remote players",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar room create-only port",
        "observableEffect": "The room switches and stale remote state clears without create-only.",
        "requiredConstraint": "The create-only port remains unused for create-and-switch.",
        "failureRationale": "Create-only would leave switching and old-room cleanup outside the owning workflow."
      }
    },
    {
      "id": "ar-arena-diagnostics-network-polling",
      "domain": "AR Eye Hunter browser lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "A mounted diagnostics drawer refreshes immediately and every four seconds only while the arena network is enabled.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts#stops diagnostics polling when the arena network is disabled",
      "coverageRelation": "The assertion operates the real arena hook or App and observes the named external port alongside resulting visible or public state.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ArenaConnection.refreshDiagnostics",
        "observableEffect": "Opening the drawer requests one refresh, an enabled interval requests the next, and disabling the network stops future refreshes.",
        "requiredConstraint": "Exactly one refresh on open, one on the next four-second interval, and no additional refresh after disabling the network.",
        "failureRationale": "Duplicate polling wastes network work; missing polling leaves visible diagnostics stale; continued polling violates signed-out quiescence."
      }
    },
    {
      "id": "ar-arena-expired-auth-transition",
      "domain": "AR Eye Hunter expired-auth lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "An auth expiry clears arena state without issuing a manual logout request. Executable assertion: “clears arena state when auth expires outside manual logout”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#clears arena state when auth expires outside manual logout",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar auth logout port",
        "observableEffect": "The hook becomes signed out from the auth event without invoking explicit logout.",
        "requiredConstraint": "Auth expiry does not call the manual logout port.",
        "failureRationale": "A second logout duplicates revocation and confuses event versus user-action ownership."
      }
    },
    {
      "id": "ar-arena-manual-logout-network-fence",
      "domain": "AR Eye Hunter manual logout network fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Manual logout stops networking immediately while one remote revoke remains pending. Executable assertion: “disables network immediately while manual logout revoke is pending”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#disables network immediately while manual logout revoke is pending",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Rallar auth logout and Rallar Game stop ports",
        "observableEffect": "The match stops before the logout promise resolves while only one revoke is in flight.",
        "requiredConstraint": "One logout request is issued and match networking stops before it settles.",
        "failureRationale": "Waiting leaves gameplay egress active; duplicate revocation repeats the remote mutation."
      }
    },
    {
      "id": "ar-arena-manual-logout-rejection",
      "domain": "AR Eye Hunter manual logout failure handling",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Manual logout invokes revocation once and leaves local state signed out even when revocation rejects. Executable assertion: “catches manual logout rejection and leaves the arena signed out”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#catches manual logout rejection and leaves the arena signed out",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Rallar auth logout port",
        "observableEffect": "One user action produces one revocation attempt and a signed-out local state.",
        "requiredConstraint": "The logout port is invoked exactly once for the user action.",
        "failureRationale": "No call skips revocation; repeated calls duplicate a remote side effect."
      }
    },
    {
      "id": "ar-arena-pending-logout-egress-fence",
      "domain": "AR Eye Hunter pending-logout egress fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Canvas callbacks captured before logout cannot publish while revocation is pending. Executable assertion: “blocks stale canvas callbacks while manual logout revoke is pending”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game event, snapshot, intent, input, presence, and raw realtime egress ports",
        "observableEffect": "Invoking stale gameplay callbacks during pending logout produces no network egress.",
        "requiredConstraint": "Every game and raw realtime egress port remains unused until pending logout finishes.",
        "failureRationale": "Any call would transmit gameplay state after the user initiated logout."
      }
    },
    {
      "id": "ar-arena-pending-snapshot-generation-cancellation",
      "domain": "AR Eye Hunter network-generation snapshot fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "A network-generation reset cancels a queued reliable snapshot before transport. Executable assertion: “cancels pending reliable director snapshots when the network generation resets”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#cancels pending reliable director snapshots when the network generation resets",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game reliable snapshot publication port",
        "observableEffect": "The immediate snapshot remains the only publication after logout and timer expiry.",
        "requiredConstraint": "No queued second snapshot publishes after the network generation resets.",
        "failureRationale": "A late publication would leak state from a signed-out or superseded connection generation."
      }
    },
    {
      "id": "ar-arena-rallar-game-presence-boundary",
      "domain": "AR Eye Hunter pose transport ownership",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Director poses use Rallar Game presence and never bypass it through raw realtime JSON. Executable assertion: “still publishes the local director pose through Rallar Game presence”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#still publishes the local director pose through Rallar Game presence",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Raw Rallar realtime JSON port",
        "observableEffect": "The pose reaches game input and presence while raw motion send stays unused.",
        "requiredConstraint": "No raw realtime JSON motion send occurs for game-owned presence.",
        "failureRationale": "A raw send duplicates policy and bypasses the game-owned presence lifecycle."
      }
    },
    {
      "id": "ar-arena-reliable-snapshot-coalescing",
      "domain": "AR Eye Hunter reliable snapshot coalescing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Rapid reliable snapshots publish the first revision immediately and the latest once after the coalescing interval. Executable assertion: “coalesces rapid reliable director snapshots to the latest revision”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#coalesces rapid reliable director snapshots to the latest revision",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Rallar Game reliable snapshot publication port",
        "observableEffect": "Revision 20 publishes immediately, no intermediate publication occurs, and revision 22 publishes reliably at the deadline.",
        "requiredConstraint": "The sequence is exactly the first revision followed by the latest after 1,000 milliseconds, with no superseded revision.",
        "failureRationale": "Publishing every revision floods reliable transport; publishing the wrong delayed revision exposes stale state."
      }
    },
    {
      "id": "ar-arena-reliable-snapshot-deduplication",
      "domain": "AR Eye Hunter reliable snapshot deduplication",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Repeated publication of one revision produces one reliable write. Executable assertion: “deduplicates reliable director snapshots by revision”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#deduplicates reliable director snapshots by revision",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Rallar Game reliable snapshot publication port",
        "observableEffect": "Two local requests for revision 10 produce one reliable publication.",
        "requiredConstraint": "A snapshot revision publishes at most once.",
        "failureRationale": "Duplicate reliable writes waste bandwidth and repeat downstream processing."
      }
    },
    {
      "id": "ar-arena-replaced-report-appointment-fence",
      "domain": "AR Eye Hunter browser lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "A late capability report cannot invoke director appointment after a newer attempt replaces the pending report within the same generation and timestamp.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts#fences replaced reports and releases delivery listeners on replacement and network end",
      "coverageRelation": "The assertion operates the real arena hook or App and observes the named external port alongside resulting visible or public state.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game match appointIfElected",
        "observableEffect": "Resolving the stale report produces no new appointment side effect while the latest attempt or signed-out state remains unchanged.",
        "requiredConstraint": "No appointment invocation occurs after a newer attempt replaces the pending report within the same generation and timestamp.",
        "failureRationale": "A stale invocation could appoint authority for an abandoned attempt even if a later UI state guard discarded its result."
      }
    },
    {
      "id": "ar-arena-signed-out-combat-fence",
      "domain": "AR Eye Hunter signed-out combat fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Combat callbacks captured before logout cannot publish after logout. Executable assertion: “blocks stale canvas combat callbacks after logout”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game event, snapshot, intent, input, presence, and raw realtime egress ports",
        "observableEffect": "Stale shot, hit, and pickup callbacks produce no network egress.",
        "requiredConstraint": "Every game and raw realtime egress port remains unused after logout.",
        "failureRationale": "Any call would transmit gameplay state from a signed-out session."
      }
    },
    {
      "id": "ar-arena-signed-out-diagnostics-fence",
      "domain": "AR Eye Hunter signed-out diagnostics fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Diagnostics refresh remains local after logout. Executable assertion: “does not probe diagnostics transports after logout”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "API configuration, ICE candidate, RTC diagnostics, and RTC lane-readiness ports",
        "observableEffect": "Refreshing diagnostics while signed out performs no network or transport probes.",
        "requiredConstraint": "All diagnostics transport ports remain unused after logout.",
        "failureRationale": "Signed-out probes can disclose or recreate connection state after teardown."
      }
    },
    {
      "id": "ar-arena-signed-out-report-appointment-fence",
      "domain": "AR Eye Hunter browser lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "A late capability report cannot invoke director appointment after logout ends the report attempt before it resolves.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts#does not appoint after an old capability report resolves across logout",
      "coverageRelation": "The assertion operates the real arena hook or App and observes the named external port alongside resulting visible or public state.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game match appointIfElected",
        "observableEffect": "Resolving the stale report produces no new appointment side effect while the latest attempt or signed-out state remains unchanged.",
        "requiredConstraint": "No appointment invocation occurs after logout ends the report attempt before it resolves.",
        "failureRationale": "A stale invocation could appoint authority for an abandoned attempt even if a later UI state guard discarded its result."
      }
    },
    {
      "id": "ar-arena-signed-out-snapshot-fence",
      "domain": "AR Eye Hunter signed-out snapshot fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "A snapshot callback captured before logout cannot publish after logout. Executable assertion: “blocks stale canvas snapshot publication after logout”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas snapshot publication after logout",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game snapshot publication port",
        "observableEffect": "The stale callback leaves snapshot state empty and produces no publication.",
        "requiredConstraint": "The snapshot publication port remains unused after logout.",
        "failureRationale": "Publishing after logout leaks stale authoritative state from a retired session."
      }
    },
    {
      "id": "ar-browser-ai-explicit-provider-selection",
      "domain": "AR Eye Hunter browser AI provider selection",
      "owner": "AR Eye Hunter maintainers",
      "summary": "WebLLM failures stay visible and never silently switch an explicitly selected provider mode. Executable assertion: “keeps WebLLM generation failures visible without switching providers”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-browser-ai-provider.test.ts#keeps WebLLM generation failures visible without switching providers",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "AR Eye Hunter mock-provider factory",
        "observableEffect": "A failed WebLLM generation rejects without constructing the mock provider.",
        "requiredConstraint": "The mock-provider factory remains unused after a WebLLM generation failure.",
        "failureRationale": "Constructing the mock provider would hide the selected provider failure and violate explicit mode governance."
      }
    },
    {
      "id": "ar-webllm-engine-lifecycle",
      "domain": "AR Eye Hunter WebLLM engine lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "One lazily loaded WebLLM engine serves every request while each request reaches completion. Executable assertion: “loads one engine, requests JSON mode, and parses JSON results”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts#loads one engine, requests JSON mode, and parses JSON results",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebLLM engine loader and chat-completion port",
        "observableEffect": "Two provider requests initialize one engine and produce two completions.",
        "requiredConstraint": "Engine creation occurs exactly once and completion occurs exactly once per request.",
        "failureRationale": "Extra engine loads repeat an expensive cold start; missing or duplicate completions lose or repeat AI work."
      }
    },
    {
      "id": "black-box-schema-public-interface--keeps-schema-compatibility-guide-json-examples-validating",
      "domain": "Shared black-box schema interface",
      "owner": "Shared Test maintainers",
      "summary": "Recipe fixtures, examples, compatibility corpus, and application RTC examples validate against the published schema. Executable assertion: “keeps schema compatibility guide JSON examples validating”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps schema compatibility guide JSON examples validating",
      "coverageRelation": "The named schema test parses and validates the exact published fixture, application example, compatibility corpus, or guide example represented by this filesystem occurrence."
    },
    {
      "id": "black-box-schema-public-interface--keeps-the-app-local-rtc-example-self-contained-for-headless-brow",
      "domain": "Shared black-box schema interface",
      "owner": "Shared Test maintainers",
      "summary": "Recipe fixtures, examples, compatibility corpus, and application RTC examples validate against the published schema. Executable assertion: “keeps the app-local RTC example self-contained for headless browser agents”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps the app-local RTC example self-contained for headless browser agents",
      "coverageRelation": "The named schema test parses and validates the exact published fixture, application example, compatibility corpus, or guide example represented by this filesystem occurrence."
    },
    {
      "id": "black-box-schema-public-interface--validates-recipe-fixtures-examples-flow-exports-manual-snippets-",
      "domain": "Shared black-box schema interface",
      "owner": "Shared Test maintainers",
      "summary": "Recipe fixtures, examples, compatibility corpus, and application RTC examples validate against the published schema. Executable assertion: “validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets",
      "coverageRelation": "The named schema test parses and validates the exact published fixture, application example, compatibility corpus, or guide example represented by this filesystem occurrence."
    },
    {
      "id": "browser-bridge-invalid-config-admission",
      "domain": "Browser runtime configuration admission",
      "owner": "Shared Test maintainers",
      "summary": "Valid connection input reaches the installed runtime; malformed configuration is rejected before that side-effect boundary.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts#validates connection configuration before calling the native runtime",
      "coverageRelation": "One valid request and six invalid requests execute the bridge decoder; the forwarded sparse options and only one native connect call prove the boundary.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Installed browser Rallar runtime connect capability",
        "observableEffect": "Only the valid request reaches native runtime connection; all malformed requests reject beforehand.",
        "requiredConstraint": "Exactly one connect call occurs across the valid request and all rejected configuration cases.",
        "failureRationale": "Rejecting after native connection would still trigger authentication, room membership, or transport allocation with invalid options."
      }
    },
    {
      "id": "browser-ws-subscription-resource-ownership",
      "domain": "Browser WebSocket subscription resource ownership",
      "owner": "Shared Test maintainers",
      "summary": "Repeated requests for one WS subscription share one resource, whose cleanup invokes its disposer once.",
      "semanticCoverage": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts#deduplicates and disposes WS subscriptions while fencing stale leases",
      "coverageRelation": "The resource controller receives the same subscription key twice, fences a stale lease, and is observed at subscription acquisition and disposal ports.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket subscription acquisition and unsubscribe disposer",
        "observableEffect": "Two ensure requests acquire one subscription, and cleanup releases that subscription once.",
        "requiredConstraint": "The subscribe callback and its returned unsubscribe callback each run exactly once.",
        "failureRationale": "Duplicate subscription delivers duplicate messages; skipped or duplicate disposal leaks listeners or repeats teardown side effects."
      }
    },
    {
      "id": "control-protocol-browser-boundary",
      "domain": "Distributed monitor production ownership",
      "owner": "Shared Test maintainers",
      "summary": "The SPA delegates distributed monitor, analysis, and verdict derivation to shared-test. Executable assertion: “keeps distributed run monitor derivation in shared-test instead of the SPA app”.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app",
      "coverageRelation": "This approved package-boundary assertion inspects the SPA integration module for its canonical shared-test import and absence of three local derivations. Rendered monitor behavior cannot distinguish delegation from a behaviorally identical app-local duplicate."
    },
    {
      "id": "control-protocol-server-import-direction",
      "domain": "Control-server protocol import direction",
      "owner": "Shared Test maintainers",
      "summary": "The control server cannot import the SPA-owned protocol module. Executable assertion: “does not import control protocol from the SPA app into the control server”.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server",
      "coverageRelation": "This approved architecture assertion enumerates the control-server source and rejects the forbidden SPA protocol import. Runtime protocol behavior cannot reveal an app-local fork or a reversed server-to-SPA dependency when both copies still behave alike."
    },
    {
      "id": "execute-resolution-refresh-is-passive",
      "domain": "Recipe Console execute targeting",
      "owner": "Rallar Black Box maintainers",
      "summary": "Refreshing a resolution that yields an equal row count re-renders the evidence without toggling any target. Executable assertion: \"keeps late resolution evidence browseable across equal-row refreshed resolutions\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts#keeps late resolution evidence browseable across equal-row refreshed resolutions",
      "coverageRelation": "The test replaces the resolution with an equal-row one and keeps browsing; the absent toggle call is what proves the refresh did not re-select.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Execute target toggle callback port",
        "observableEffect": "No toggle call raised by an equal-row resolution refresh.",
        "requiredConstraint": "An equal-row refresh raises no toggle call.",
        "failureRationale": "An equal-row refresh that re-toggled would produce an identical list while silently changing which agents the next run targets."
      }
    },
    {
      "id": "execute-target-toggle-scope",
      "domain": "Recipe Console execute targeting",
      "owner": "Rallar Black Box maintainers",
      "summary": "Activating a windowed target row toggles exactly that agent once and never selects a control run. Executable assertion: \"keeps 250 control runs searchable, rejects ambiguous identities, and windows 240 target rows\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts#keeps 250 control runs searchable, rejects ambiguous identities, and windows 240 target rows",
      "coverageRelation": "The test windows 240 target rows and clicks the last one while a 250-run searchable list is mounted; the two callbacks separate target selection from run selection.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Execute target toggle and control-run selection callback ports",
        "observableEffect": "Exactly one toggle call for the clicked agent id and no control-run selection call.",
        "requiredConstraint": "One toggle per activation, addressed by agent id, with the control-run selection port untouched.",
        "failureRationale": "Both lists render the same rows whether the click toggled a target or re-selected the control run, so only the call counts separate the two ports."
      }
    },
    {
      "id": "group-http-mutation-contract--rejects-a-conditional-private-owner-call-in-the-exported-family-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a conditional private-owner call in the exported family registrar”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a conditional private-owner call in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-after-the-handler-return",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only after the handler return”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only after the handler return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-a-literal-false-handler-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only in a literal-false handler branch”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in a literal-false handler branch",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-an-uninvoked-nested-hand",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only in an uninvoked nested handler function”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in an uninvoked nested handler function",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-duplicate-private-owner-call-in-the-exported-family-re",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a duplicate private-owner call in the exported family registrar”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a duplicate private-owner call in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-private-owner-call-after-a-family-registrar-return",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a private-owner call after a family-registrar return”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a private-owner call after a family-registrar return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-removed-private-owner-call-from-the-exported-family-re",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a removed private-owner call from the exported family registrar”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a removed private-owner call from the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-second-exact-registration-in-the-exported-family-regis",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a second exact registration in the exported family registrar”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a second exact registration in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-separately-bound-command-declared-after-its-submission",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a separately bound command declared after its submission”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a separately bound command declared after its submission",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-computed-result-object-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an AppInbox type overridden by a computed result-object property”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a computed result-object property",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-later-result-object-spr",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an AppInbox type overridden by a later result-object spread”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a later result-object spread",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-exact-registration-after-an-unconditional-owner-retur",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an exact registration after an unconditional owner return”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration after an unconditional owner return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-exact-registration-inside-a-literal-false-owner-branc",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an exact registration inside a literal-false owner branch”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration inside a literal-false owner branch",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-computed-command-object-pro",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an operation overridden by a computed command-object property”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a computed command-object property",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-later-command-object-spread",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an operation overridden by a later command-object spread”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a later command-object spread",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-duplicate-direct-appinbox-type-properties-in-the-result-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects duplicate direct AppInbox type properties in the result object”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct AppInbox type properties in the result object",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-duplicate-direct-operation-properties-in-the-command-obj",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects duplicate direct operation properties in the command object”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct operation properties in the command object",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-translator-guard-reachability",
      "domain": "Authoritative group mutation route ownership",
      "owner": "Rallar server maintainers",
      "summary": "Input rejection guards and statically unreachable throws preserve a reachable authenticated AppInbox command translator; unconditional throws do not.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#accepts legitimate input rejection guards and an unreachable throwing branch",
      "coverageRelation": "The named test executes the actual route inventory analyzer on the shipped translator and a source mutation adding a false throwing branch. Both must retain the operation connection. Its neighboring parameterized negative executes unconditional throwing guards and requires loss of that connection. Source reads and mutation non-vacuity are inputs to these executable security assertions, not private-name or statement-order requirements."
    },
    {
      "id": "group-mutation-construction--rejects-a-canonical-family-name-rebound-to-a-different-imported-",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a canonical family name rebound to a different imported family”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a canonical family name rebound to a different imported family",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-conditional-family-call-in-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a conditional family call in the exported root”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a conditional family call in the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-different-app-passed-from-a-family-to-its-private-owne",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a different app passed from a family to its private owner”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a different app passed from a family to its private owner",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-duplicate-family-call-in-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a duplicate family call in the exported root”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a duplicate family call in the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-call-after-an-exported-root-return",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family call after an exported-root return”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family call after an exported-root return",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-call-before-authorization-exists",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family call before authorization exists”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family call before authorization exists",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-removed-from-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family removed from the exported root”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family removed from the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a missing family-to-private-owner argument”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a missing family-to-private-owner argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an extra family-to-private-owner argument”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-extra-root-to-family-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an extra root-to-family argument”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra root-to-family argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-uninventoryed-live-private-owner-and-route-in-a-famil",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an uninventoryed live private owner and route in a family”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an uninventoryed live private owner and route in a family",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-reordered-family-to-private-owner-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects reordered family-to-private-owner arguments”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects reordered family-to-private-owner arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-reordered-root-to-family-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects reordered root-to-family arguments”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects reordered root-to-family arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-wrong-root-to-family-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects wrong root-to-family arguments”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects wrong root-to-family arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "headless-worker-abandoned-response-body-disposal",
      "domain": "Rallar black-box headless worker polling",
      "owner": "Rallar Black Box maintainers",
      "summary": "A polling wait that abandons an HTTP response cancels that response body exactly once and never reads or awaits it. Executable assertion: \"observes late response disposal failures after an aborted fetch\".",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch",
      "coverageRelation": "The wait returns or rejects identically whether or not it disposes of the body, so the disposal call is the only observable witness. The behavioural assertions in the same file cover what the wait returns; these pin what it leaves behind on the socket.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Control server HTTP polling response bodies",
        "observableEffect": "Exactly one cancel() per abandoned response body, and no json() read of a body the wait has already rejected.",
        "requiredConstraint": "Every abandoned response is cancelled exactly once; a rejected response is never read, and a cancellation is never awaited.",
        "failureRationale": "A body left uncancelled holds the connection open for the life of the worker, and a second cancel or an awaited one blocks the wait behind a response that never settles."
      }
    },
    {
      "id": "headless-worker-no-polling-after-deadline-or-shutdown",
      "domain": "Rallar black-box headless worker polling",
      "owner": "Rallar Black Box maintainers",
      "summary": "Once a polling wait's deadline or its shutdown signal has won, the wait neither sleeps nor fetches again. Executable assertion: \"hard-times out a never-settling registration fetch with detailed state\".",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#hard-times out a never-settling registration fetch with detailed state",
      "coverageRelation": "The rejection the caller sees is the same whether or not the wait sleeps once more first, so the sleep and fetch counts are the only witness that the deadline actually stopped the loop rather than merely naming the failure.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Control server snapshot polling loop",
        "observableEffect": "No sleep and no further snapshot fetch after the deadline or shutdown has won.",
        "requiredConstraint": "A wait that has timed out or been shut down performs zero further sleeps and issues no further fetch.",
        "failureRationale": "A sleep or fetch after the deadline pushes the worker past the run budget the deadline exists to hold, and keeps polling a control server the run has abandoned."
      }
    },
    {
      "id": "hetzner-control-deno-runtime",
      "domain": "Hetzner control-server Deno runtime",
      "owner": "Rallar operations maintainers",
      "summary": "Deployment cache warming and systemd startup use the control server owned Deno configuration. Executable assertion: “uses the control-server Deno config for Hetzner cache warming and systemd start”.",
      "semanticCoverage": "packages/tests/hetzner/spa-env-script.test.ts#uses the control-server Deno config for Hetzner cache warming and systemd start",
      "coverageRelation": "The named deployment test executes the SPA environment script and verifies that cache warming and service startup resolve the control server configuration actually shipped to Hetzner."
    },
    {
      "id": "hetzner-distributed-workflow--keeps-playwright-packages-aligned-past-the-node-24-browser-insta",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “keeps Playwright packages aligned past the Node 24 browser-install hang regression”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#keeps Playwright packages aligned past the Node 24 browser-install hang regression",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--materializes-a-deterministic-isolated-group-throughout-executabl",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “materializes a deterministic isolated group throughout executable manifest data”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--persists-control-server-snapshots-with-an-atomic-temp-file-renam",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “persists control-server snapshots with an atomic temp-file rename”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#persists control-server snapshots with an atomic temp-file rename",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--prepares-the-supported-commit-once-before-running-the-serial-man",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “prepares the supported commit once before running the serial manifest matrix”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#prepares the supported commit once before running the serial manifest matrix",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--preserves-a-parallel-label-that-happens-to-equal-the-source-room",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “preserves a parallel label that happens to equal the source room”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#preserves a parallel label that happens to equal the source room",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--rejects-an-executable-command-scoped-outside-the-source-manifest",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “rejects an executable command scoped outside the source manifest group”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#rejects an executable command scoped outside the source manifest group",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--repairs-known-deno-lockfile-drift-before-the-controlled-rollout-",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “repairs known Deno lockfile drift before the controlled rollout dirty checkout guard”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#repairs known Deno lockfile drift before the controlled rollout dirty checkout guard",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "indexeddb-invalid-schema-no-open",
      "domain": "IndexedDB schema admission",
      "owner": "Rallar shared maintainers",
      "summary": "Duplicate store definitions are rejected before any native database open or version upgrade begins.",
      "semanticCoverage": "packages/tests/shared/open-indexed-db.test.ts#rejects duplicate store definitions before opening IndexedDB",
      "coverageRelation": "The test calls openIndexedDbWithStores with duplicate store names using a real fake-indexeddb factory, asserts the schema rejection, and spies on the native open boundary.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "IDBFactory.open called by openIndexedDbWithStores",
        "observableEffect": "The native open operation can create a database, begin a schema upgrade or contend with active connections.",
        "requiredConstraint": "A schema containing duplicate store names must cause zero IDBFactory.open calls.",
        "failureRationale": "An eventual validation error does not prove that schema creation, upgrade or lock acquisition was avoided. Opening then aborting would violate the validate-before-native-effect contract."
      }
    },
    {
      "id": "json-size-unknown-shape-no-user-hooks",
      "domain": "Native JSON frame size validation",
      "owner": "Shared realtime maintainers",
      "summary": "Unknown object shapes must be rejected without invoking caller-controlled JSON serialization or string conversion hooks. Executable assertion: “rejects unknown shapes without invoking JSON hooks”.",
      "semanticCoverage": "packages/tests/shared/json-message-validation.test.ts#rejects unknown shapes without invoking JSON hooks",
      "coverageRelation": "The test passes a raw object containing both hooks through validateJsonMessageSize and checks the typed rejection plus hook absence.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Caller-controlled toJSON and toString conversion hooks",
        "observableEffect": "The validator returns malformed while neither supplied conversion function executes.",
        "requiredConstraint": "Unknown object shapes must be rejected without invoking caller-controlled JSON serialization or string conversion hooks.",
        "failureRationale": "Invoking caller hooks can execute arbitrary side effects or allocate unbounded content before size validation can reject the object."
      }
    },
    {
      "id": "json-ws-client-before-parse-byte-limit",
      "domain": "WebSocket client frame resource admission",
      "owner": "Shared realtime maintainers",
      "summary": "An oversized frame must be rejected before any JSON parsing for the bounded subscription. Executable assertion: “rejects oversized client frames before parsing and keeps accepting bounded traffic”.",
      "semanticCoverage": "packages/tests/shared/websocket/json-message-limits.test.ts#rejects oversized client frames before parsing and keeps accepting bounded traffic",
      "coverageRelation": "The test delivers oversized native text through the simulated WebSocket, observes parser absence and rejection, then delivers bounded text successfully.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Native JSON text decoding at JsonWebSocketClient ingress",
        "observableEffect": "Oversized text causes a typed rejection without parser allocation; later bounded text remains deliverable.",
        "requiredConstraint": "An oversized frame must be rejected before any JSON parsing for the bounded subscription.",
        "failureRationale": "Parse-then-reject still spends CPU and memory on an oversized frame and can exhaust the client before admission rejects it."
      }
    },
    {
      "id": "json-ws-native-binary-preconversion-limit",
      "domain": "WebSocket native binary resource admission",
      "owner": "Shared realtime maintainers",
      "summary": "Oversized Blob, ArrayBuffer, and typed-array frames must be rejected using native byte size without Blob text conversion or JSON coercion. Executable assertion: “checks native binary sizes without Blob conversion or JSON coercion”.",
      "semanticCoverage": "packages/tests/shared/websocket/json-message-limits.test.ts#checks native binary sizes without Blob conversion or JSON coercion",
      "coverageRelation": "The test emits all three native binary representations through a bounded server subscription and observes rejection plus untouched conversion ports.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Blob.text conversion and native JSON decoding at server ingress",
        "observableEffect": "Three typed rejections occur with no delivered message and no binary materialization or JSON parse.",
        "requiredConstraint": "Oversized Blob, ArrayBuffer, and typed-array frames must be rejected using native byte size without Blob text conversion or JSON coercion.",
        "failureRationale": "Converting rejected binary data first allocates the payload and may invoke coercion before the size boundary can protect the receiver."
      }
    },
    {
      "id": "json-ws-server-subscription-before-parse-limit",
      "domain": "WebSocket server subscription resource admission",
      "owner": "Shared realtime maintainers",
      "summary": "With only a capped subscription, an oversized UTF-8 frame must be rejected without JSON parsing; generic subscriptions retain their existing unbounded behavior. Executable assertion: “limits server ALM subscriptions without limiting generic JSON subscribers”.",
      "semanticCoverage": "packages/tests/shared/websocket/json-message-limits.test.ts#limits server ALM subscriptions without limiting generic JSON subscribers",
      "coverageRelation": "The same test executes capped-only, mixed capped/generic, and bounded input cases through the native server event path.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Native JSON text decoding for capped JsonWebSocketServer subscriptions",
        "observableEffect": "The ALM subscription rejects the frame without parser work; a separately installed generic subscription can still accept it.",
        "requiredConstraint": "With only a capped subscription, an oversized UTF-8 frame must be rejected without JSON parsing; generic subscriptions retain their existing unbounded behavior.",
        "failureRationale": "A shared parse before the bounded gate defeats its resource limit, while moving the cap globally breaks the generic subscription contract."
      }
    },
    {
      "id": "legacy-agent-session-ticket-consume-dedupe",
      "domain": "Legacy agent-session ticket consumption",
      "owner": "Rallar Black Box maintainers",
      "summary": "Concurrent consumes of one agent-session ticket share a single in-flight request, and a consume after settlement issues a new request to its own API base. Executable assertion: \"deduplicates an in-flight consume and clears the cache after settlement\".",
      "semanticCoverage": "packages/tests/rallar-black-box/legacy-shell-models.test.ts#deduplicates an in-flight consume and clears the cache after settlement",
      "coverageRelation": "The test starts two consumes of the same ticket before the first settles, then consumes again at another API base; the ticket consume HTTP port is where the one-time ticket is spent.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Agent-session ticket consume HTTP port",
        "observableEffect": "One consume request while the first is in flight, and a second request to the new API base only after settlement.",
        "requiredConstraint": "A duplicate consume of an in-flight ticket reuses the pending request; a consume after settlement issues a new request.",
        "failureRationale": "Both callers receive the same session either way, but a second in-flight request would spend a one-time ticket twice and fail the agent bootstrap on a real server."
      }
    },
    {
      "id": "legacy-agent-session-ticket-consume-retry-identity",
      "domain": "Legacy agent-session ticket consumption",
      "owner": "Rallar Black Box maintainers",
      "summary": "A consume retried after a rejected response reuses the request id of the rejected attempt. Executable assertion: \"reuses the request ID after a rejected consume response\".",
      "semanticCoverage": "packages/tests/rallar-black-box/legacy-shell-models.test.ts#reuses the request ID after a rejected consume response",
      "coverageRelation": "The test rejects the first consume and resolves the second; the request ids recorded at the ticket consume HTTP port are the idempotency keys the server deduplicates on.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Agent-session ticket consume HTTP port",
        "observableEffect": "Two consume requests that carry one request id.",
        "requiredConstraint": "The retry after a rejection issues a second request with the request id of the first attempt.",
        "failureRationale": "The caller sees the same rejection and session either way; only the two recorded requests show that the retry kept its idempotency key."
      }
    },
    {
      "id": "local-ws-alm-before-decode-resource-admission",
      "domain": "Local black-box WS ALM observation",
      "owner": "Shared Test maintainers",
      "summary": "Scoped ALM observation rejects oversized text before JSON parsing and rejects binary ALM input without Blob text conversion. Executable assertion: “rejects oversized ALM text before parsing and binary input without converting it”.",
      "semanticCoverage": "packages/tests/shared-test/local-websocket-session.test.ts#rejects oversized ALM text before parsing and binary input without converting it",
      "coverageRelation": "The test feeds actual socket frames to LocalWsConnection with snapshot scope and inspects its public retained rejection observations.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Native JSON decoding and Blob.text conversion in LocalWsConnection frame admission",
        "observableEffect": "Rejected observations remain typed and bounded without allocating decoded oversized data or accepting converted binary ALM.",
        "requiredConstraint": "Scoped ALM observation rejects oversized text before JSON parsing and rejects binary ALM input without Blob text conversion.",
        "failureRationale": "Parsing oversized text or materializing unsupported binary before rejection defeats the observation resource boundary even if no accepted message is retained."
      }
    },
    {
      "id": "monitor-budget-mount-is-passive",
      "domain": "Recipe Console monitor windowing",
      "owner": "Rallar Black Box maintainers",
      "summary": "Mounting the exact agent, recipe, readiness, and diagnostic row budgets raises no inspect or filter callback. Executable assertion: \"mounts exact agent, recipe, readiness, and diagnostic budgets with ordinal keys\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#mounts exact agent, recipe, readiness, and diagnostic budgets with ordinal keys",
      "coverageRelation": "The test mounts each section at its exact budget and asserts the ordinal keys; the callbacks are the only way a mount could reach the workspace.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Monitor section inspect and filter callback ports",
        "observableEffect": "No inspect or filter call raised by mounting rows at the budget.",
        "requiredConstraint": "Mounting rows must not raise an inspect or filter call; both stay uncalled.",
        "failureRationale": "A section that filtered on mount would render the same budgeted rows while silently narrowing the operator view."
      }
    },
    {
      "id": "monitor-closed-disclosure-mounts-nothing",
      "domain": "Recipe Console monitor windowing",
      "owner": "Rallar Black Box maintainers",
      "summary": "A closed disclosure keeps its cursor and mounts no rows, so no inspect callback can be raised from it. Executable assertion: \"keeps disclosure cursors alive while closed and mounts no closed rows\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#keeps disclosure cursors alive while closed and mounts no closed rows",
      "coverageRelation": "The test closes a disclosure, drives the surrounding sections, and reopens it; the absent inspect call is what proves no hidden row stayed live.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Monitor disclosure inspect callback port",
        "observableEffect": "No inspect call while the disclosure is closed.",
        "requiredConstraint": "A closed disclosure raises no inspect call even though its cursor is retained.",
        "failureRationale": "A retained cursor that still mounted its rows would be invisible in the DOM assertions but would report selections from a hidden list."
      }
    },
    {
      "id": "monitor-diagnostics-cursor-reset-is-local",
      "domain": "Recipe Console monitor windowing",
      "owner": "Rallar Black Box maintainers",
      "summary": "Changing the active diagnostics filters resets that section cursor without raising an inspect or filter callback of its own. Executable assertion: \"resets only the diagnostics cursor when its active filters change\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#resets only the diagnostics cursor when its active filters change",
      "coverageRelation": "The test changes the diagnostics filters and asserts the other section cursors survive; the callbacks are the boundary the reset must not cross.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Monitor diagnostics inspect and filter callback ports",
        "observableEffect": "No inspect or filter call raised by the cursor reset that follows a filter change.",
        "requiredConstraint": "The cursor reset must stay local; neither callback fires as a consequence of it.",
        "failureRationale": "A reset that re-raised the filter callback would loop the workspace filter state, and the rendered rows would not show it."
      }
    },
    {
      "id": "monitor-failure-window-action-authority",
      "domain": "Recipe Console monitor windowing",
      "owner": "Rallar Black Box maintainers",
      "summary": "Paging the failure ledger is browsing, not inspecting: moving the window raises no inspect callback. Executable assertion: “windows failures without changing selection or action authority”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#windows failures without changing selection or action authority",
      "coverageRelation": "The test drives real Next clicks across a 121-row failure ledger whose only operator callback is onInspect; the selected row is rendered from the selected prop, not from an inspect call.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Monitor failure ledger inspect callback port",
        "observableEffect": "No inspect call while only the failure window cursor moves.",
        "requiredConstraint": "Window navigation raises no inspect call; only activating a failure row may.",
        "failureRationale": "The ledger renders the same windowed rows and the same selected row whether or not a Next click also fired an inspect, so only the absent call proves window movement does not open evidence."
      }
    },
    {
      "id": "monitor-inspector-destination-patch",
      "domain": "Recipe Console monitor inspector selection",
      "owner": "Rallar Black Box maintainers",
      "summary": "Activating a windowed correlated-failure destination raises the selection callback with both the destination identity and its agent/recipe/command patch. Executable assertion: \"windows 46 correlated failure destinations at 40 and preserves destination patches\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts#windows 46 correlated failure destinations at 40 and preserves destination patches",
      "coverageRelation": "The test windows 46 destinations at a 40-row budget and clicks the late row; the second callback argument is the patch the Monitor workspace merges into its selection.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Monitor inspector selection callback port",
        "observableEffect": "One selection call carrying the destination identity and its separate patch argument.",
        "requiredConstraint": "The patch argument must accompany the identity on the same call; a windowed destination may not lose its agent, recipe, or command context.",
        "failureRationale": "Without the call assertion a destination that silently drops its patch still renders identically, and the inspector would filter by the previous selection."
      }
    },
    {
      "id": "monitor-inspector-event-activation",
      "domain": "Recipe Console monitor inspector selection",
      "owner": "Rallar Black Box maintainers",
      "summary": "Activating a windowed command-evidence row raises the inspector selection callback with the exact event identity that was clicked, not a windowed ordinal. Executable assertion: \"browses command evidence failure-first in 16-row windows and activates the exact late item\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts#browses command evidence failure-first in 16-row windows and activates the exact late item",
      "coverageRelation": "The test renders the inspector over a large evidence set and drives a real click; the last-call payload is the selection contract the Monitor workspace decodes into URL state.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Monitor inspector selection callback port",
        "observableEffect": "One selection call carrying the clicked event identity verbatim, including its bidirectional control characters.",
        "requiredConstraint": "The last selection call must carry the exact clicked identity; windowing must not substitute an index or a truncated identity.",
        "failureRationale": "Rendered text alone passes when the callback reports a neighbouring row, which would open the wrong evidence in the inspector."
      }
    },
    {
      "id": "monitor-inspector-recipe-choice-reset",
      "domain": "Recipe Console monitor inspector selection",
      "owner": "Rallar Black Box maintainers",
      "summary": "Choosing a role-scoped recipe beyond the window budget raises the selection callback with the composed recipe selection identity. Executable assertion: \"browses 65 role-scoped recipe choices at 60 and resets for another recipe\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts#browses 65 role-scoped recipe choices at 60 and resets for another recipe",
      "coverageRelation": "The test browses 65 role-scoped choices at a 60-row budget and activates the late one; the composed identity is what the Monitor workspace round-trips through URL state.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Monitor inspector selection callback port",
        "observableEffect": "One selection call carrying the composed recipe selection identity for the activated choice.",
        "requiredConstraint": "The selection identity must be composed from the activated recipe and role, not from the window cursor.",
        "failureRationale": "A reset that kept the previous cursor would render the same list while reporting the earlier recipe to the workspace."
      }
    },
    {
      "id": "mutation-boundary-analysis-interface",
      "domain": "Mutation boundary analysis interface",
      "owner": "Rallar server maintainers",
      "summary": "The routing audit follows imports and exported capabilities through one deterministic analysis model. Executable assertion: “exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions",
      "coverageRelation": "The analyzer test executes import traversal and inventory checks across the authoritative mutation surface; this file enumeration is the fail-closed production input to that security audit."
    },
    {
      "id": "mutation-capability-export-interface",
      "domain": "Mutation capability export analysis",
      "owner": "Rallar server maintainers",
      "summary": "Exported mutation capabilities resolve to their canonical implementation owner before routing assertions run. Executable assertion: “resolves mutable repository capabilities through the shared-server barrel”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-boundary-traversal.test.ts#resolves mutable repository capabilities through the shared-server barrel",
      "coverageRelation": "The capability traversal test executes barrel and re-export resolution; this AST parse is the mechanism that follows a mutable capability to its canonical owner."
    },
    {
      "id": "mutation-capability-type-interface",
      "domain": "Mutation capability type analysis",
      "owner": "Rallar server maintainers",
      "summary": "Capability declarations remain distinguishable from executable authoritative mutation owners. Executable assertion: “maps all 56 entrypoints and 52 types to real registrations and owners”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#maps all 56 entrypoints and 52 types to real registrations and owners",
      "coverageRelation": "The route-owner suite executes type-to-owner mapping over the complete inventory; this AST parse distinguishes type declarations from executable mutation owners."
    },
    {
      "id": "mutation-registration-collections--binds-direct-client-registrations-to-their-live-types",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “binds direct client registrations to their live types”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#binds direct client registrations to their live types",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-a-missing-direct-crdt-registration",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects a missing direct CRDT registration”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct CRDT registration",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-a-missing-direct-group-registration",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects a missing direct group registration”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct group registration",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-a-missing-direct-topology-registration",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects a missing direct topology registration”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct topology registration",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-an-auth-registration-loop-replaced-with-an-empty-iterabl",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects an auth registration loop replaced with an empty iterable”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects an auth registration loop replaced with an empty iterable",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-predicates--evaluates-safe-logical-includes-and-identity-map-chains-exactly",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “evaluates safe logical includes and identity map chains exactly”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#evaluates safe logical includes and identity map chains exactly",
      "coverageRelation": "The named test mutates the live auth registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--fails-closed-for-an-opaque-registration-predicate",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “fails closed for an opaque registration predicate”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#fails closed for an opaque registration predicate",
      "coverageRelation": "The named test mutates the live group registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--narrows-the-auth-registration-array-with-an-exact-equality-filte",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “narrows the auth registration array with an exact equality filter”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#narrows the auth registration array with an exact equality filter",
      "coverageRelation": "The named test mutates the live auth registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--rejects-an-auth-registration-filter-that-is-always-false",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “rejects an auth registration filter that is always false”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#rejects an auth registration filter that is always false",
      "coverageRelation": "The named test mutates the live auth registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "domain": "Authoritative mutation route ownership",
      "owner": "Rallar server maintainers",
      "summary": "Every authoritative route resolves to one AppInbox transaction owner without a persistence bypass. Executable assertion: “uses one named readonly input object for each authorised websocket enqueue helper”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper",
      "coverageRelation": "The named analyzer test executes a concrete route, type, owner, or fallback mutation and requires the security audit to reject it; each source access supplies the exact mutated module or canonical comparison for that scenario."
    },
    {
      "id": "mutation-route-owner-crdt-reservation-materialization",
      "domain": "CRDT administrative mutation routing",
      "owner": "Rallar repository maintainers",
      "summary": "CRDT reservation construction remains connected to canonical durable AppInbox command materialization. Executable assertion: “rejects a CRDT reservation builder disconnected from command materialization”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#rejects a CRDT reservation builder disconnected from command materialization",
      "coverageRelation": "The test replaces the actual CRDT administrative route command-materialization call and executes the mutation-route inventory validator; reading that production route is the executable input that proves reservation construction cannot bypass canonical durable AppInbox command materialization."
    },
    {
      "id": "package-dependency-direction-import-map",
      "domain": "Package dependency direction",
      "owner": "Rallar platform maintainers",
      "summary": "The api-v1 Deno import map advertises no browser or test-only package to application source. Executable assertion: “keeps the api-v1 Deno import map free of browser and test-only packages”.",
      "semanticCoverage": "packages/tests/repo/package-dependency-direction.test.ts#keeps the api-v1 Deno import map free of browser and test-only packages",
      "coverageRelation": "The import-direction suite executes the layering rule over every package source file; this config read covers the one surface that grants resolution before any import exists."
    },
    {
      "id": "queue-pubsub-corrupt-identity-no-effects",
      "domain": "Server canonical queue and replay admission",
      "owner": "Rallar server maintainers",
      "summary": "Missing or corrupt live provenance rejects with ALAdmissionCorruptionError and produces no topology wake or delivery. Executable assertion: “rejects a %s live identity fact before topology wake or delivery”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects a %s live identity fact before topology wake or delivery",
      "coverageRelation": "The parameterized test supplies three distinct corrupt identity cases at real canonical storage and checks the wake port after the actual callback rejects. The exception alone would permit an effect emitted before rejection.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Validated outbox-key wake callback and QueueBoxPubSubWsService.sendToTargetsWithResult",
        "observableEffect": "Missing or corrupt live provenance rejects with ALAdmissionCorruptionError and produces no topology wake or delivery.",
        "requiredConstraint": "Both outward ports remain unused for each missing, malformed-JSON or malformed-provenance identity variant.",
        "failureRationale": "Sending or waking before authoritative identity validation allows advisory data to cause effects despite corruption."
      }
    },
    {
      "id": "queue-pubsub-expired-identity-no-effects",
      "domain": "Server canonical queue and replay admission",
      "owner": "Rallar server maintainers",
      "summary": "Crossing the original claimed deadline during identity lookup emits neither a topology wake nor a live send. Executable assertion: “does not wake topology or send when loading the identity fact crosses the claimed deadline”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#does not wake topology or send when loading the identity fact crosses the claimed deadline",
      "coverageRelation": "This exact wake assertion observes one independently outward-facing port after the held identity lookup advances the owned clock to the deadline. Both assertions share this same executable test, not a broad expiry registry contract.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Validated outbox-key wake callback and QueueBoxPubSubWsService.sendToTargetsWithResult",
        "observableEffect": "Crossing the original claimed deadline during identity lookup emits neither a topology wake nor a live send.",
        "requiredConstraint": "Both outward ports remain unused at or after the claimed deadline.",
        "failureRationale": "A stale notification must not trigger topology work or deliver an expired message; a void result does not prove either absence."
      }
    },
    {
      "id": "queue-pubsub-key-mismatch-no-send",
      "domain": "Server canonical queue and replay admission",
      "owner": "Rallar server maintainers",
      "summary": "A durable row returned under a mismatched physical identity rejects before delivery. Executable assertion: “drops a durable key load whose identity differs from its envelope”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#drops a durable key load whose identity differs from its envelope",
      "coverageRelation": "The repository port returns a row with a different resource ID; the real subscriber rejects and the external send port must remain unused.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "QueueBoxPubSubWsService.sendToTargetsWithResult",
        "observableEffect": "A durable row returned under a mismatched physical identity rejects before delivery.",
        "requiredConstraint": "Zero sends when loaded key identity differs from the notice.",
        "failureRationale": "Delivering a mismatched record would route a different message under the advisory key even if corruption is subsequently reported."
      }
    },
    {
      "id": "queue-pubsub-malformed-notice-no-storage",
      "domain": "Server canonical queue and replay admission",
      "owner": "Rallar server maintainers",
      "summary": "Malformed physical keys, oversized publisher identity and fractional deadlines are rejected without canonical storage access. Executable assertion: “rejects malformed and oversized notices before loading canonical storage”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects malformed and oversized notices before loading canonical storage",
      "coverageRelation": "The real subscription callback receives five invalid wire notices; the owned repository read port proves decoding rejects them before an external storage lookup, rather than merely returning no delivery after I/O.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "QueueBoxResourceEntryRepository.getItem",
        "observableEffect": "Malformed physical keys, oversized publisher identity and fractional deadlines are rejected without canonical storage access.",
        "requiredConstraint": "Zero canonical reads for each syntactically invalid advisory notice.",
        "failureRationale": "Allowing malformed untrusted notices to reach storage creates avoidable I/O amplification and bypasses the bounded advisory input boundary."
      }
    },
    {
      "id": "queue-pubsub-malformed-payload-no-send",
      "domain": "Server canonical queue and replay admission",
      "owner": "Rallar server maintainers",
      "summary": "A retained non-AL payload rejects without live delivery. Executable assertion: “rejects durable outbox work whose retained payload is not an AL message”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects durable outbox work whose retained payload is not an AL message",
      "coverageRelation": "The test persists invalid payload bytes and invokes the valid notice through the subscriber; observing the sender distinguishes fail-before-send from send-then-throw.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "QueueBoxPubSubWsService.sendToTargetsWithResult",
        "observableEffect": "A retained non-AL payload rejects without live delivery.",
        "requiredConstraint": "Zero sends when the durable message fails canonical AL decoding.",
        "failureRationale": "Unvalidated retained data must not become a transport payload, and a later rejection cannot retract a send."
      }
    },
    {
      "id": "queue-pubsub-missing-canonical-no-send",
      "domain": "Server canonical queue and replay admission",
      "owner": "Rallar server maintainers",
      "summary": "A missing live canonical message raises corruption and never reaches the live sender. Executable assertion: “rejects missing live durable key-only messages with timing details”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects missing live durable key-only messages with timing details",
      "coverageRelation": "The actual subscribed callback loads an absent canonical record; send absence proves no live effect can precede the reported missing-message error.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "QueueBoxPubSubWsService.sendToTargetsWithResult",
        "observableEffect": "A missing live canonical message raises corruption and never reaches the live sender.",
        "requiredConstraint": "Zero sends when a valid live advisory key has no durable message.",
        "failureRationale": "A notification carries no authoritative payload; synthesizing or sending before its durable message exists would violate canonical ownership."
      }
    },
    {
      "id": "queuebox-mixed-outcome-adaptive-feedback",
      "domain": "QueueBox readiness and adaptive processing feedback",
      "owner": "Rallar shared maintainers",
      "summary": "A dequeue batch with readiness deferral, actual failure and completed work emits one failure and one success feedback signal while readiness consumes neither.",
      "semanticCoverage": "packages/tests/shared/queuebox-utilities.test.ts#retains actual failure accounting alongside neutral readiness and successful work",
      "coverageRelation": "The real dequeue owner processes a NotReady item, a throwing item and a completed item; spies call the actual resilience methods, and persisted row readback separately verifies attempts 0/1 and COMPLETED.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ResourceInboxResilience.failure and ResourceInboxResilience.success",
        "observableEffect": "These ports feed the circuit breaker and rate adjuster: failure reduces or resets adaptation while success advances recovery and the success window.",
        "requiredConstraint": "This mixed result batch emits exactly one failure signal and exactly one completion signal. The waiting item adds no adaptive feedback.",
        "failureRationale": "Final queue statuses and attempts do not expose duplicate or omitted adaptive signals. A later success can reset prior breaker failure state, so final adaptive state also need not reveal erroneous readiness/failure accounting. This contract concerns the result batch, not a universal per-message callback count."
      }
    },
    {
      "id": "queuebox-pubsub-requeue-announces-external-write",
      "domain": "QueueBox pub/sub outbox requeue",
      "owner": "Rallar server maintainers",
      "summary": "A row the bridge requeues after a failed remote delivery is announced to the engine as an external write, because the requeue runs outside every ALM runtime. Executable assertion: “announces a requeued row as an external write, because the requeue runs outside every runtime”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#announces a requeued row as an external write, because the requeue runs outside every runtime",
      "coverageRelation": "The named test drives a failed remote delivery through the bridge and observes both the requeued row in the outbox and the engine-wake port the bridge owns; the row state alone says nothing about whether an owner was told.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Engine external-write wake port supplied to the bridge",
        "observableEffect": "One announcement for the one row the requeue put back in the queue.",
        "requiredConstraint": "A requeue that replaced the row announces exactly once; one that wrote nothing announces not at all.",
        "failureRationale": "Without the announcement the requeued row waits out the owner idle ceiling instead of being claimed, and a second announcement per row would make every owner on the engine drop its remembered readiness twice for one write."
      }
    },
    {
      "id": "recipe-console-artifact-bytes-off-main-thread",
      "domain": "Recipe Console artifact export transfer",
      "owner": "Rallar Black Box maintainers",
      "summary": "Exporting run artifact bytes hands the response body to the caller as bytes and never parses the success body as text on the main thread. Executable assertion: \"returns bounded artifact response bytes without parsing the success body on the main thread\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-control-api.test.ts#returns bounded artifact response bytes without parsing the success body on the main thread",
      "coverageRelation": "The test executes exportRunArtifactBytes against a response whose text reader throws; the returned bytes are the transfer the analyze worker decodes off the main thread.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Control API artifact response text reader",
        "observableEffect": "No call to the response text reader while the bytes are returned.",
        "requiredConstraint": "A successful artifact export must read the body only as bytes.",
        "failureRationale": "The returned bytes are identical when the body is also parsed as text, so only the absent text call shows the main thread skipped a multi-megabyte parse."
      }
    },
    {
      "id": "recipe-console-artifact-oversize-before-body",
      "domain": "Recipe Console artifact export transfer",
      "owner": "Rallar Black Box maintainers",
      "summary": "An artifact response that declares a length over the transfer limit is rejected before its body is read. Executable assertion: \"rejects an oversized declared raw artifact response before reading its body\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-control-api.test.ts#rejects an oversized declared raw artifact response before reading its body",
      "coverageRelation": "The test executes exportRunArtifactBytes against a response declaring 65 MiB; the protocol rejection and the unread body are the transfer-limit contract the Monitor and Analyze workspaces rely on.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Control API artifact response byte reader",
        "observableEffect": "No call to the response byte reader when the declared length exceeds the limit.",
        "requiredConstraint": "The transfer limit is enforced from the declared length before any body bytes are buffered.",
        "failureRationale": "The rejection message is the same whether or not the body was buffered first; only the absent byte-reader call shows the oversized body never entered memory."
      }
    },
    {
      "id": "recipe-console-fleet-deep-link-selection-label",
      "domain": "Recipe Console fleet workspace",
      "owner": "Rallar Black Box maintainers",
      "summary": "Restoring the evidence inspector for a unique control-run-only deep link announces the fleet run selection as the latest selection label. Executable assertion: \"restores the evidence inspector for a unique control-run-only deep link\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts#restores the evidence inspector for a unique control-run-only deep link",
      "coverageRelation": "The test renders FleetWorkspace from a control-run-only deep link; the inspector element passed out and the selection label callback are the only views of what the shell shows and announces.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Fleet workspace selection label callback",
        "observableEffect": "The last selection label announced after the deep link restores is 'Fleet run selected'.",
        "requiredConstraint": "A restored deep link must leave the shell announcing the restored fleet run selection, not an earlier interim label.",
        "failureRationale": "The inspector detail is the same whichever label was announced last, so only the last callback value shows the operator hears the restored selection."
      }
    },
    {
      "id": "recipe-console-fleet-render-without-actions",
      "domain": "Recipe Console fleet workspace",
      "owner": "Rallar Black Box maintainers",
      "summary": "Composing the Fleet workspace from root query truth renders its sections without navigating, replacing the URL, opening an inspection or refreshing the control connection. Executable assertion: \"composes the lazy workspace from root query truth without actions during render\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts#composes the lazy workspace from root query truth without actions during render",
      "coverageRelation": "The test renders FleetWorkspace with spied navigation, URL, inspection and refresh ports; the rendered headings are the composed view and the untouched ports are the render purity the workspace owns.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Fleet workspace navigation, URL replacement, inspection and control refresh callbacks",
        "observableEffect": "No call to any of the four callbacks while the workspace renders.",
        "requiredConstraint": "Rendering the workspace from query truth must not start an operator action.",
        "failureRationale": "The rendered sections are identical when render also navigates or refreshes, so only the absent callback calls show that render triggered no URL change or extra control request."
      }
    },
    {
      "id": "recipe-console-monitor-derives-once",
      "domain": "Recipe Console monitor derivation",
      "owner": "Rallar Black Box maintainers",
      "summary": "One coherent monitor snapshot derives the shared monitor and its analysis report exactly once, and the report reuses that monitor. Executable assertion: \"projects complete current truth and derives bounded monitor/report/verdict once\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts#projects complete current truth and derives bounded monitor/report/verdict once",
      "coverageRelation": "The test reconciles a live snapshot and derives the workspace model; the spied shared derivations and one read of each queued command are the reuse contract that keeps large runs responsive.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Shared distributed run monitor and analysis report derivation",
        "observableEffect": "One monitor derivation and one report derivation per coherent snapshot.",
        "requiredConstraint": "The workspace model must not re-derive the monitor or the report for the same snapshot.",
        "failureRationale": "A second derivation yields an equal model, so only the call counts show the workspace did not repeat a derivation that scales with every command, result and event."
      }
    },
    {
      "id": "recipe-console-single-poll-timer",
      "domain": "Recipe Console control polling",
      "owner": "Rallar Black Box maintainers",
      "summary": "Recipe Console owns one control poll timer across its views and clears it when it unmounts. Executable assertion: \"owns one poll timer across views and clears it when Recipe Console unmounts\".",
      "semanticCoverage": "tests/playwright/rallar-black-box/recipe-console-control.spec.ts#owns one poll timer across views and clears it when Recipe Console unmounts",
      "coverageRelation": "The browser test drives view changes and unmount in the real application; the instrumented timer registry is the only view of the scheduling port the control connection owns.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Browser timer scheduling used by the control connection poll",
        "observableEffect": "One active poll timer while mounted across views, and none after unmount.",
        "requiredConstraint": "Switching views must not start a second poll loop, and unmount must clear the loop.",
        "failureRationale": "Rendered control state looks the same with duplicate or leaked poll loops; only the active timer registry shows the extra control-server traffic and the leak."
      }
    },
    {
      "id": "recipe-console-tune-validates-once",
      "domain": "Recipe Console tune run catalog",
      "owner": "Rallar Black Box maintainers",
      "summary": "Building the tune run catalog validates each selected control manifest and the retained facade manifest once, and deriving the workspace source reuses those validations. Executable assertion: \"validates two selected control manifests and one retained facade exactly once\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-tune-facade-authority.test.ts#validates two selected control manifests and one retained facade exactly once",
      "coverageRelation": "The test builds the catalog and derives the workspace source from it; the spied manifest validation and the catalog work counts are the reuse contract between catalog and source model.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Shared distributed run manifest validation",
        "observableEffect": "Three manifest validations after building the catalog, and still three after deriving the source model.",
        "requiredConstraint": "Deriving the source model must reuse the catalog's validations instead of validating again.",
        "failureRationale": "Repeated validation produces the same catalog and source, so only the call count shows schema validation of large manifests was not repeated."
      }
    },
    {
      "id": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "domain": "Supported recipe matrix",
      "owner": "Shared Test maintainers",
      "summary": "Every example and test recipe is uniquely catalogued with explicit profile, execution mode, and compatibility. Executable assertion: “advertises the API-v1 profile in recipe-matrix CLI usage”.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage",
      "coverageRelation": "The named matrix test loads the published catalog or referenced recipe and asserts the exact uniqueness, coverage, compatibility, or CLI promise represented by this occurrence."
    },
    {
      "id": "recipe-matrix-public-interface--labels-every-api-v1-entry-with-an-honest-evidence-tier",
      "domain": "Supported recipe matrix",
      "owner": "Shared Test maintainers",
      "summary": "Every API-v1 recipe declares whether it is a Tier 1 public-interface test or a Tier 2 durability proof that reads SQL evidence. Executable assertion: “labels every api-v1 entry with an honest evidence tier”.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#labels every api-v1 entry with an honest evidence tier",
      "coverageRelation": "The named matrix test compares each published tier with the concrete SQL-evidence operator used by its shipped recipe. Executing the recipe can prove its assertions but cannot reveal whether the evidence came from the public API or the database, so the static operator classification is part of the operator-facing catalog contract."
    },
    {
      "id": "recipe-matrix-public-interface--points-every-entry-at-a-catalog-recipe-file",
      "domain": "Supported recipe matrix",
      "owner": "Shared Test maintainers",
      "summary": "Every example and test recipe is uniquely catalogued with explicit profile, execution mode, and compatibility. Executable assertion: “points every entry at a catalog recipe file”.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#points every entry at a catalog recipe file",
      "coverageRelation": "The named matrix test loads the published catalog or referenced recipe and asserts the exact uniqueness, coverage, compatibility, or CLI promise represented by this occurrence."
    },
    {
      "id": "repo-style-checker-interface",
      "domain": "Repository style checker interface",
      "owner": "Rallar repository maintainers",
      "summary": "Every governed Deno configuration inherits the canonical TypeScript formatter settings. Executable assertion: “keeps TypeScript formatter settings aligned with the canonical baseline”.",
      "semanticCoverage": "packages/tests/repo/repo-code-style-checker-integrity.test.ts#keeps TypeScript formatter settings aligned with the canonical baseline",
      "coverageRelation": "The assertion reads each governed Deno config and compares its formatter object with the canonical baseline. Formatting one sample file cannot prove that every repository formatter entrypoint uses the same settings."
    },
    {
      "id": "resource-inbox-reservation-bounded-indexed-read",
      "domain": "IndexedDB queue box bounded reservation reads",
      "owner": "Rallar shared maintainers",
      "summary": "A per-type reservation read is a bounded index query, never a whole-store scan. Executable assertion: “reserveEntries for one type never returns another type and stays within the requested bound”.",
      "semanticCoverage": "packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts#reserveEntries for one type never returns another type and stays within the requested bound",
      "coverageRelation": "The test reserves one type through the public reserveEntries API and inspects the IDBIndex.getAll calls that read produced; the spy is the only way to observe whether the read touched a bounded index range instead of the whole object store.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "IDBIndex.prototype.getAll",
        "observableEffect": "Every getAll call the reservation read issues carries an explicit count no larger than the caller's maxToReserve.",
        "requiredConstraint": "A reservation for one type must read through a bounded index range; it must never fall back to an unbounded whole-store scan.",
        "failureRationale": "An unbounded or over-large getAll call defeats the purpose of the indexed rewrite: it would silently degrade back into the whole-store scan this task replaced, reintroducing the cost the index exists to avoid."
      }
    },
    {
      "id": "resource-inbox-terminal-sweep-page-budget",
      "domain": "IndexedDB queue box terminal-sweep page budget",
      "owner": "Rallar shared maintainers",
      "summary": "One opportunistic cleanup run reads a fixed number of terminal-index pages, so a queue crowded with retained rows keeps the sweep bounded instead of paging forever. Executable assertion: “bounds one cleanup run by its page budget”.",
      "semanticCoverage": "packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts#bounds one cleanup run by its page budget",
      "coverageRelation": "The test seeds one row more than the run's page budget can reach, runs cleanupAsync through the public API, and counts the IDBIndex.getAll calls that run issued; the surviving row proves the run stopped early and the call count proves how much reading it did before stopping.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "IDBIndex.prototype.getAll",
        "observableEffect": "One cleanup run issues at most one expiry read plus eight terminal-sweep page reads, whatever the store holds.",
        "requiredConstraint": "Paging past retained rows must stay bounded per run: an opportunistic sweep may not read the whole terminal range in one pass.",
        "failureRationale": "Without the page cap a store holding a large retained backlog would make every cleanup pass walk the entire terminal index, turning an opportunistic background sweep into an unbounded read on the browser's main storage path."
      }
    },
    {
      "id": "room-send-membership-admission",
      "domain": "Room realtime membership admission before allocation",
      "owner": "Rallar realtime maintainers",
      "summary": "A session outside a room cannot open its peer lanes even when a ready peer is visible.",
      "semanticCoverage": "packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts#does not open or send for a room the current session has not joined",
      "coverageRelation": "The room facade reads scoped membership, returns no targets, and is observed at both the lane-opening port and native data-channel send boundary.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebRtcConnectionService.ensurePeerLaneOpen",
        "observableEffect": "An unauthorized room send creates no lane-opening attempt and emits no native frame.",
        "requiredConstraint": "The connection service lane-opening port remains unused when current membership excludes the session.",
        "failureRationale": "Returning no targets after opening a lane would still allocate unauthorized transport and consume establishment work."
      }
    },
    {
      "id": "rtc-connected-observer-delivery",
      "domain": "Native RTC connection observer delivery",
      "owner": "Rallar realtime maintainers",
      "summary": "A native connected transition delivers one established notification while leaving the peer open.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#negotiates offers, forwards ICE candidates, and dispatches remote events",
      "coverageRelation": "The test drives the native connection event and observes the registered establishment callback together with open state and actual signaling outputs.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "QRtcPeerConnection establishment observer",
        "observableEffect": "One native connected transition produces one establishment notification.",
        "requiredConstraint": "The registered onConnected observer runs exactly once for the single connected transition.",
        "failureRationale": "Duplicate registration or dispatch repeats subscriber connection effects even though the peer open state remains identical."
      }
    },
    {
      "id": "rtc-error-settlement-attempted-versus-untouched",
      "domain": "RTC queued send settlement",
      "owner": "Shared realtime maintainers",
      "summary": "When the first queued native send synchronously fails the channel and throws, only that item is attempted; the queued sibling is cleared without native submission. Executable assertion: “distinguishes an uncertain attempted send from untouched siblings cleared by its channel error”.",
      "semanticCoverage": "packages/tests/shared/qrtc-data-channel.test.ts#distinguishes an uncertain attempted send from untouched siblings cleared by its channel error",
      "coverageRelation": "The test queues two keyed messages under pressure, triggers native failure on the first drain call, and checks both settlement identities and native attempt count.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "RTCDataChannel.send during queued drain",
        "observableEffect": "One native call accompanies an attempted=true failed settlement for the selected key and attempted=false settlement for its untouched sibling.",
        "requiredConstraint": "When the first queued native send synchronously fails the channel and throws, only that item is attempted; the queued sibling is cleared without native submission.",
        "failureRationale": "Attempting the sibling while reporting it untouched would incorrectly preserve its retry budget and conceal an uncertain duplicate-capable submission."
      }
    },
    {
      "id": "rtc-group-refresh-coalesces-concurrent-requests",
      "domain": "Browser RTC group authority recovery",
      "owner": "Shared Web maintainers",
      "summary": "Concurrent not-yet-in-sync messages for one group share one active authoritative refresh. Executable assertion: “coalesces repeated recovery requests for the same group and snapshot floor”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts#coalesces repeated recovery requests for the same group and snapshot floor",
      "coverageRelation": "The test holds the first injected group-refresh request open, reports the same recovery condition again, and observes one request through completion.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "RtcGroupSnapshotRefresh authoritative group-refresh port",
        "observableEffect": "Two concurrent recovery reports for one scoped group issue one authoritative refresh.",
        "requiredConstraint": "At most one authoritative group refresh is active per scoped group.",
        "failureRationale": "Duplicate point reads can race cache adoption, multiply server load during a stale-layout burst, and issue redundant QueueBox wakes."
      }
    },
    {
      "id": "rtc-group-refresh-reads-the-code-not-the-detail",
      "domain": "Browser RTC group authority recovery",
      "owner": "Shared Web maintainers",
      "summary": "The recovery reads the drop code at the head of an inbound denial's reason, so a denial carrying another code requests nothing however its detail reads. Executable assertion: “does not read authority after a denial the refresh cannot repair”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts#does not read authority after a denial the refresh cannot repair",
      "coverageRelation": "The test reports an unauthorized denial through the public recovery callback and observes the injected authoritative group-refresh port remain unused, beside the sibling test that reports a not-yet-in-sync denial whose reason names the branch after the code.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "RtcGroupSnapshotRefresh authoritative group-refresh port",
        "observableEffect": "A denial that is not not-yet-in-sync produces no authoritative point read, cache adoption, or QueueBox wake.",
        "requiredConstraint": "Only the not-yet-in-sync code may request current group authority; the detail after it never widens that set.",
        "failureRationale": "The reason is matched by its head rather than compared whole, so a match that is too loose would send every unauthorized RTC drop to the authority endpoint, and no returned value distinguishes that from the drop itself."
      }
    },
    {
      "id": "rtc-group-refresh-retries-after-failure",
      "domain": "Browser RTC group authority recovery",
      "owner": "Shared Web maintainers",
      "summary": "A failed authoritative refresh releases its coalescing slot so the retained QueueBox retry can request authority again. Executable assertion: “leaves failed refreshes to the retained QueueBox retry”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts#leaves failed refreshes to the retained QueueBox retry",
      "coverageRelation": "The test rejects the first injected group-refresh request, reports the retained recovery condition again, and observes a second request succeed.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "RtcGroupSnapshotRefresh authoritative group-refresh port",
        "observableEffect": "Two sequential recovery reports separated by a failed refresh issue two authoritative refresh attempts.",
        "requiredConstraint": "A settled failed refresh must not leave the scoped group permanently marked active.",
        "failureRationale": "A retained failed task would suppress every later QueueBox recovery attempt and strand messages behind stale room authority."
      }
    },
    {
      "id": "rtc-group-refresh-skips-admitted-messages",
      "domain": "Browser RTC group authority recovery",
      "owner": "Shared Web maintainers",
      "summary": "An RTC message that completed admission does not request an authoritative group refresh. Executable assertion: “does not read authority after successful admission”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts#does not read authority after successful admission",
      "coverageRelation": "The test reports successful admission through the public recovery callback and observes the injected authoritative group-refresh port remain unused.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "RtcGroupSnapshotRefresh authoritative group-refresh port",
        "observableEffect": "A successfully admitted RTC message produces no authoritative point read, cache adoption, or QueueBox wake.",
        "requiredConstraint": "Only a not-yet-in-sync admission result may request current group authority.",
        "failureRationale": "Refreshing after ordinary successful delivery would add an HTTP read and cache reconciliation to every room message and wake QueueBox without retained work to recover."
      }
    },
    {
      "id": "rtc-ice-restart-backoff-budget",
      "domain": "Native RTC restart retry budget",
      "owner": "Rallar realtime maintainers",
      "summary": "Concurrent reconnect requests share one timer, and exhausted retries stop allocating native ICE restarts.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#ignores offer collisions when impolite and retries with ICE restart on failure",
      "coverageRelation": "The test advances the retry deadlines, observes the real native restartIce port, and verifies the peer is closed after the configured attempts.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "RTCPeerConnection.restartIce",
        "observableEffect": "The first shared timer produces one restart and the complete retry sequence produces five before reset.",
        "requiredConstraint": "Two concurrent retry requests produce one restart at the first deadline, with five total restarts before exhaustion.",
        "failureRationale": "Extra native restarts exceed the retry budget and duplicate negotiation traffic; missing attempts abandon recovery early."
      }
    },
    {
      "id": "rtc-signaling-failure-report-not-a-log",
      "domain": "RTC peer signaling failure reporting",
      "owner": "Rallar realtime maintainers",
      "summary": "A terminal signaling admission is reported to the session as a typed failure per lost hop instead of being written to the console and dropped. Executable assertion: “reports the hop a terminal signaling failure lost, instead of logging and dropping it”.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#reports the hop a terminal signaling failure lost, instead of logging and dropping it",
      "coverageRelation": "The named test drives both outbound hops through a rejecting signaler and observes the failure callback the peer owns; the console absence is what separates a reported hop from the log-and-drop behaviour it replaced.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Console error port of the outbound signaling chain",
        "observableEffect": "No console record for a hop that was reported through onSignalingFailed.",
        "requiredConstraint": "An outbound hop lost to a terminal admission produces the typed failure and nothing on the console port.",
        "failureRationale": "A console line beside the report would mean the outbound chain still swallows the hop into a log, which is precisely the behaviour the typed failure exists to replace, and no failure value distinguishes the two."
      }
    },
    {
      "id": "rtc-topology-replay-corruption-suppressed-send",
      "domain": "RTC topology replay live delivery",
      "owner": "Rallar server maintainers",
      "summary": "A corrupt delivery-log entry sends nothing: corruption propagates to the replay consumer without reaching the socket. Executable assertion: “propagates corruption for a missing unexpired durable reference”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#propagates corruption for a missing unexpired durable reference",
      "coverageRelation": "The named assertion executes the replay entry handler on a corrupt entry and observes the owned live-send port; the absence of a send is the constraint that invalid history never reaches members.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WS queue-box live sender (sendToTargetsWithResult)",
        "observableEffect": "A corrupt entry throws to the consumer with zero live sends.",
        "requiredConstraint": "The live sender remains unused for corrupt delivery-log entries.",
        "failureRationale": "Sending invalid history would deliver corrupt topology to members instead of surfacing the corruption to the replay consumer."
      }
    },
    {
      "id": "rtc-topology-replay-missing-page-no-send",
      "domain": "Server canonical queue and replay admission",
      "owner": "Rallar server maintainers",
      "summary": "A publication missing its final durable page rejects as corruption before any page reaches the sender. Executable assertion: “rejects a missing final durable page before sending any part of the publication”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#rejects a missing final durable page before sending any part of the publication",
      "coverageRelation": "The test removes the final persisted page from a multi-page publication, calls the real handler and checks the owned send port remained empty. This differs from the existing missing-whole-reference test by catching streaming before complete-page validation.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "RtcTopologyReplayLiveSender.sendToTargetsWithResult",
        "observableEffect": "A publication missing its final durable page rejects as corruption before any page reaches the sender.",
        "requiredConstraint": "Zero live sends when any required durable page is missing.",
        "failureRationale": "Sending a prefix before discovering corruption leaks an incomplete publication to recipients; the later error alone cannot undo it."
      }
    },
    {
      "id": "rtc-topology-replay-single-live-send",
      "domain": "RTC topology replay live delivery",
      "owner": "Rallar server maintainers",
      "summary": "One handler invocation for the current single-page publication sends its immutable durable outbox message once. Executable assertion: “delivers the exact immutable outbox message when the publication is current”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#delivers the exact immutable outbox message when the publication is current",
      "coverageRelation": "The named assertion invokes the real replay handler once with a current single-page publication and observes its owned live-send port. The count requires delivery without duplicate submission within this handler attempt; it does not constrain multi-page publications or later retry attempts.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WS queue-box live sender (sendToTargetsWithResult)",
        "observableEffect": "The single-page fixture produces one live sender invocation carrying the immutable durable outbox message during this handler attempt.",
        "requiredConstraint": "Exactly one live send in this invocation for this single-page publication. Multi-page publications send their required pages, and later handler retries may resend.",
        "failureRationale": "Zero sends would silently omit the current page while reporting delivery; duplicate submission within the same successful handler attempt would emit redundant live traffic. This assertion makes no exactly-once or at-most-once delivery claim across retries."
      }
    },
    {
      "id": "rtc-topology-replay-stop-after-page-failure",
      "domain": "RTC topology replay live delivery",
      "owner": "Rallar server maintainers",
      "summary": "A later page failure ends this replay send attempt and returns send-failed without further page sends.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#does not advance the replay predecessor when a later page send fails",
      "coverageRelation": "The owned sender succeeds once then refuses the next page; exactly two calls together with send-failed proves no subsequent page escaped after refusal.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "RtcTopologyReplayLiveSender.sendToTargetsWithResult",
        "observableEffect": "The failed second send is the final external send in this attempt.",
        "requiredConstraint": "Exactly two sender invocations for the first-success/second-failure input, with no third call.",
        "failureRationale": "Continuing sends after failure would leak additional partial publication traffic despite reporting the attempt failed."
      }
    },
    {
      "id": "rtc-topology-replay-suppressed-send",
      "domain": "RTC topology replay live delivery",
      "owner": "Rallar server maintainers",
      "summary": "An expired delivery-log entry sends nothing: a retention gap is a typed result the consumer handles, never a stale delivery. Executable assertion: “returns a typed retention gap without attempting a send”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#returns a typed retention gap without attempting a send",
      "coverageRelation": "The named assertion executes the replay entry handler on an expired entry and observes the owned live-send port; the absence of a send is the constraint that expired history never reaches members.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WS queue-box live sender (sendToTargetsWithResult)",
        "observableEffect": "An expired entry resolves to a typed gap with zero live sends.",
        "requiredConstraint": "The live sender remains unused for expired delivery-log entries.",
        "failureRationale": "Sending expired history would deliver stale topology to members instead of surfacing the gap to the replay consumer."
      }
    },
    {
      "id": "shared-control-client-final-report-upload-once",
      "domain": "Shared control client final report upload",
      "owner": "Shared Test maintainers",
      "summary": "Disconnecting the shared control client uploads its redacted final report to the run's agent report endpoint exactly once. Executable assertion: “sends and uploads a redacted final report”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-client.test.ts#sends and uploads a redacted final report",
      "coverageRelation": "The test configures the shared client with a secret, disconnects it, and observes the injected upload port receive one authorized request whose decoded body is the redacted report envelope.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Shared RallarBlackBoxControlClient injected fetch upload port for finalReportUploadUrl",
        "observableEffect": "One disconnect produces one authorized request to the run's agent report endpoint.",
        "requiredConstraint": "Disconnect uploads the final report once, so the recorded upload is the only report the control server stores for that agent.",
        "failureRationale": "A repeated upload overwrites the stored run artifact with a duplicate envelope and doubles operator report traffic, while a missing upload loses the agent's only report."
      }
    },
    {
      "id": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "domain": "Shared RTC benchmark package navigation",
      "owner": "Shared RTC benchmark maintainers",
      "summary": "The private benchmark package publishes one durable navigation row per executable, names exact command, setup, measured-operation, and timing facts, and participates in root test discovery. Executable assertion: “documents each executable exactly once and discovers package tests”.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests",
      "coverageRelation": "The architecture assertion compares the approved executable inventory with the shipped package README, locks the exact baseline grammar and code-derived setup, measured-operation, and timing claims, and independently verifies root Vitest discovery for the package test tree."
    },
    {
      "id": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "domain": "Shared RTC benchmark diagnostic navigation",
      "owner": "Shared RTC benchmark maintainers",
      "summary": "Maintained diagnostics remain outside accepted baseline evidence while every diagnostic participates in package Deno checking. Executable assertion: “keeps diagnostics outside accepted baseline catalog and checked by Deno”.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno",
      "coverageRelation": "The architecture assertion reads the accepted workload catalog and package check command, then proves each maintained diagnostic is excluded from accepted evidence and included in Deno checking."
    },
    {
      "id": "shared-web-app-import-boundary",
      "domain": "Shared-web application import boundary",
      "owner": "Shared Web maintainers",
      "summary": "Reusable browser modules never import application-owned code or reverse the intended package direction. Executable assertion: “keeps Relic on its runtime adapter boundary without the broad shared-web barrel”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel",
      "coverageRelation": "The named application-boundary test parses the consumer imports and proves that application code depends on the intended narrow package surface without reversing ownership."
    },
    {
      "id": "shared-web-browser-bundle-boundary",
      "domain": "Shared-web browser bundle boundary",
      "owner": "Shared Web maintainers",
      "summary": "Browser entrypoints remain free of server-only dependencies when bundled for application consumers. Executable assertion: “keeps shared-web from declaring graphology directly”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts#keeps shared-web from declaring graphology directly",
      "coverageRelation": "The browser bundle suite builds the narrow entrypoints and checks their dependency graph and size; this manifest read establishes the package dependency declaration used by that executable bundle check."
    },
    {
      "id": "shared-web-create-room-failure-atomicity",
      "domain": "Shared-web create-and-switch room workflow",
      "owner": "Shared Web maintainers",
      "summary": "Failed room creation leaves the current room and never starts leave. Executable assertion: “does not leave when create fails”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/create-and-join-room.test.ts#does not leave when create fails",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Room workflow leave-state-group port",
        "observableEffect": "Create rejects while the old room stays current and no leave occurs.",
        "requiredConstraint": "The leave port remains unused when create fails.",
        "failureRationale": "Leaving after failed creation strands the caller without either room."
      }
    },
    {
      "id": "shared-web-delta-causal-gap-recovery",
      "domain": "Shared-web state-cache delta recovery",
      "owner": "Shared Web maintainers",
      "summary": "A causal gap triggers one durable floored snapshot read. Executable assertion: “pulls the floored group snapshot when a delta envelope arrives over a causal gap”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-delta-recovery.test.ts#pulls the floored group snapshot when a delta envelope arrives over a causal gap",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "One read installs the returned server-canonical snapshot.",
        "requiredConstraint": "Exactly one floored read occurs for the causal-gap envelope.",
        "failureRationale": "No read leaves the gap unresolved; duplicate reads race cache application."
      }
    },
    {
      "id": "shared-web-directory-only-rtc-reconciliation",
      "domain": "Shared-web directory-only RTC reconciliation",
      "owner": "Shared Web maintainers",
      "summary": "A directory-only snapshot triggers one global RTC reconciliation without per-group mutation. Executable assertion: “reconciles RTC peers when an active directory snapshot excludes the current session”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#reconciles RTC peers when an active directory snapshot excludes the current session",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebRTC group-manager update, delete, and global reconciliation ports",
        "observableEffect": "Active update and delete are skipped while global reconciliation runs once.",
        "requiredConstraint": "Update and delete remain unused while global reconciliation runs exactly once.",
        "failureRationale": "Per-group mutation misstates membership; skipped or duplicate reconciliation leaves or repeats peer work."
      }
    },
    {
      "id": "shared-web-hydration-incomparable-recovery",
      "domain": "Shared-web initialized incomparable recovery",
      "owner": "Shared Web maintainers",
      "summary": "Initialized lifecycle rereads and recomputes once without applying divergent input. Executable assertion: “retains durable incomparable recovery across initialise and hydrate”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#retains durable incomparable recovery across initialise and hydrate",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group snapshot reread, RTC recomputation, and active-update ports",
        "observableEffect": "Recovered state replaces divergence and drives one recomputation.",
        "requiredConstraint": "Recovery performs one reread and one recomputation while divergent input never reaches active update.",
        "failureRationale": "Missing recovery preserves divergence; duplicates race; active update bypasses the oracle."
      }
    },
    {
      "id": "shared-web-incomparable-state-recovery",
      "domain": "Shared-web incomparable state recovery",
      "owner": "Shared Web maintainers",
      "summary": "An incomparable tuple performs one durable reread before RTC application. Executable assertion: “recovers incomparable group tuples through a durable reread before RTC recomputation”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#recovers incomparable group tuples through a durable reread before RTC recomputation",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group snapshot durable reread port",
        "observableEffect": "One reread supplies the recovered snapshot applied to RTC and repository.",
        "requiredConstraint": "Exactly one durable reread occurs for the incomparable tuple.",
        "failureRationale": "No reread guesses across histories; duplicates waste and reorder recovery."
      }
    },
    {
      "id": "shared-web-join-room-failure-atomicity",
      "domain": "Shared-web join room workflow",
      "owner": "Shared Web maintainers",
      "summary": "Failed room join leaves the current room and never starts leave. Executable assertion: “does not leave when joining the next room fails”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/join-room.test.ts#does not leave when joining the next room fails",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Room workflow leave-state-group port",
        "observableEffect": "Join rejects while the old room stays current and no leave occurs.",
        "requiredConstraint": "The leave port remains unused when join fails.",
        "failureRationale": "Leaving after failed join strands the caller outside both rooms."
      }
    },
    {
      "id": "shared-web-leave-without-current-room",
      "domain": "Shared-web leave room resolution",
      "owner": "Shared Web maintainers",
      "summary": "Leaving without a resolvable room performs no mutation or hydration. Executable assertion: “returns undefined without a workflow when no room can be resolved”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/leave-room.test.ts#returns undefined without a workflow when no room can be resolved",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Room workflow leave-state-group and cache hydration ports",
        "observableEffect": "The request completes as a no-op with an empty workflow log.",
        "requiredConstraint": "Neither leave nor hydration runs when no room is resolved.",
        "failureRationale": "Invoking either port would fabricate identity or do unrelated cache work."
      }
    },
    {
      "id": "shared-web-left-session-overlay-removal",
      "domain": "Shared-web state-cache local-session departure",
      "owner": "Shared Web maintainers",
      "summary": "A snapshot dropping the current session uses retention-aware delete, not active update. Executable assertion: “removes overlays but retains RTC connections when an active snapshot no longer includes the current session”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#removes overlays but retains RTC connections when an active snapshot no longer includes the current session",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebRTC group-manager active-update port",
        "observableEffect": "The overlay disappears and delete retains connections without accepting active state.",
        "requiredConstraint": "Active update remains unused for a snapshot excluding the current session.",
        "failureRationale": "Accepting it as active recreates local membership."
      }
    },
    {
      "id": "shared-web-overlay-topology-notification",
      "domain": "Shared-web overlay topology delivery",
      "owner": "Shared Web maintainers",
      "summary": "Every topology envelope notifies RTC while causal rules own cache state. Executable assertion: “applies overlay topology websocket snapshots to the local overlay cache”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#applies overlay topology websocket snapshots to the local overlay cache",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebRTC group-manager topology notification port",
        "observableEffect": "Initial, removal, and stale envelopes each notify; stale cannot restore removed state.",
        "requiredConstraint": "Notification occurs once per envelope: once after the first and three times after all three.",
        "failureRationale": "Missing notifications leave RTC stale; duplicates repeat repair."
      }
    },
    {
      "id": "shared-web-removed-group-cleanup",
      "domain": "Shared-web removed-group cleanup",
      "owner": "Shared Web maintainers",
      "summary": "Removing a cached group deletes RTC tracking without reapplying it. Executable assertion: “cleans up RTC group tracking and notifies listeners when a group snapshot is removed”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#cleans up RTC group tracking and notifies listeners when a group snapshot is removed",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebRTC group-manager active-update port",
        "observableEffect": "Removal deletes tracking and notifies listeners with no active update.",
        "requiredConstraint": "Active update remains unused during group removal.",
        "failureRationale": "Reapplying a removed group races deletion and resurrects stale tracking."
      }
    },
    {
      "id": "shared-web-room-formation-command-request",
      "domain": "Shared-web room formation commands",
      "owner": "Shared Web maintainers",
      "summary": "A formation command issues exactly one lifecycle POST under one fresh request id whose body carries the reason and nothing the route's schema does not declare. Executable assertion: “plans through the bound room and accepts the receipt into the cache”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#plans through the bound room and accepts the receipt into the cache",
      "coverageRelation": "The handle test executes plan through the facade and observes the HTTP port the handle owns; the request-id path and first-call body assertions are the wire contract the api-v1 lifecycle route decodes.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Room formation HTTP command port",
        "observableEffect": "One POST per command under one fresh request id, carrying the reason as its only audit field.",
        "requiredConstraint": "Exactly one POST per command; a retry after a typed conflict is a new call with a new request id.",
        "failureRationale": "A second POST under a fresh id would submit the transition twice, and reusing a spent id replays the very denial the retry meant to escape."
      }
    },
    {
      "id": "shared-web-room-formation-connect-fence",
      "domain": "Shared-web room formation connect",
      "owner": "Shared Web maintainers",
      "summary": "A connect with no explicit layout names the cached formation epoch and the planned-slot identity in its one lifecycle POST. Executable assertion: “connects the current planned layout with the cached epoch”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#connects the current planned layout with the cached epoch",
      "coverageRelation": "The handle test seeds the snapshot and the planned slot, executes connect through the facade, and observes the single POST on the HTTP port the handle owns; the body is the fence the server compares.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Room formation HTTP command port",
        "observableEffect": "One connect POST whose body carries the cached epoch and the planned-slot identity.",
        "requiredConstraint": "Exactly one POST carries the fence; a superseded identity is answered by the server, never retried under the same request id.",
        "failureRationale": "Two POSTs would race the fence against itself, and a fence read from anywhere but the cached snapshot and slot could dial a layout the caller never saw."
      }
    },
    {
      "id": "shared-web-room-formation-connect-lagging-snapshot-order",
      "domain": "Shared-web room formation connect read-through",
      "owner": "Shared Web maintainers",
      "summary": "A connect whose planned slot was published past the cached snapshot reads the group point snapshot and then the topology view before its one lifecycle POST names the refreshed epoch. Executable assertion: “reads the room through before connecting when the cached snapshot lags the planned layout”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#reads the room through before connecting when the cached snapshot lags the planned layout",
      "coverageRelation": "The handle test seeds a snapshot behind the planned slot's causal revision, executes connect through the facade, and observes the ordered HTTP calls of the room refresh and the lifecycle port the handle owns; the fence in the POST body is the refreshed epoch.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Room refresh read-through port",
        "observableEffect": "The group point read precedes the topology read, and exactly one connect POST follows carrying the refreshed epoch with the planned-slot identity.",
        "requiredConstraint": "A planned identity newer than the cached snapshot is never posted with the stale epoch; the read-through runs first and the single POST names what it returned.",
        "failureRationale": "Posting the cached epoch with a newer identity earns the stale-epoch 409 instead of a connect, and a second POST would race the fence against itself."
      }
    },
    {
      "id": "shared-web-room-formation-connect-read-through-order",
      "domain": "Shared-web room formation connect read-through",
      "owner": "Shared Web maintainers",
      "summary": "A connect with no planned layout in the slot reads the group point snapshot before the topology view and spends no lifecycle request. Executable assertion: “refuses to connect locally when no planned layout exists after a read-through”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#refuses to connect locally when no planned layout exists after a read-through",
      "coverageRelation": "The handle test executes connect against an empty planned slot and observes the ordered HTTP calls of the room refresh the handle owns; no lifecycle POST follows the two reads.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Room refresh read-through port",
        "observableEffect": "The group point read precedes the topology read, and no lifecycle POST follows when the slot stays empty.",
        "requiredConstraint": "Topology hydration compares against the group snapshot read immediately before it, and a connect with nothing to name never reaches the server.",
        "failureRationale": "Reading topology first would hydrate against a stale group and could adopt a superseded layout; posting anyway would spend a request id on a guaranteed no-planned-layout conflict."
      }
    },
    {
      "id": "shared-web-room-reference-validation",
      "domain": "Shared-web room identity validation",
      "owner": "Shared Web maintainers",
      "summary": "Conflicting roomId and roomRef fail before mutation. Executable assertion: “rejects mismatched roomId and roomRef before the workflow”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/join-room.test.ts#rejects mismatched roomId and roomRef before the workflow",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Room workflow join-state-group port",
        "observableEffect": "The facade rejects mismatched identity without invoking join.",
        "requiredConstraint": "The join port remains unused for mismatched room identifiers.",
        "failureRationale": "Starting with conflicting identity can join the wrong scoped group."
      }
    },
    {
      "id": "shared-web-state-delta-conflict-recovery",
      "domain": "Shared-web revision-conflict recovery",
      "owner": "Shared Web maintainers",
      "summary": "A revision conflict self-heals with one floored read. Executable assertion: “counts a revision conflict from the divergence oracle and self-heals with the floored pull”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#counts a revision conflict from the divergence oracle and self-heals with the floored pull",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "The conflict produces one recovery request and durable state.",
        "requiredConstraint": "Exactly one floored recovery fetch occurs for the conflict.",
        "failureRationale": "No read leaves divergence unresolved; duplicates race self-healing."
      }
    },
    {
      "id": "shared-web-state-delta-missing-session-recovery",
      "domain": "Shared-web missing-session delta recovery",
      "owner": "Shared Web maintainers",
      "summary": "Missing active-session material triggers one floored read. Executable assertion: “pulls at the floor when an active session record is missing from the delta and the cache”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#pulls at the floor when an active session record is missing from the delta and the cache",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "One recovery request supplies canonical session state.",
        "requiredConstraint": "Exactly one floored recovery fetch occurs for the missing session.",
        "failureRationale": "Applying without recovery creates incomplete membership; duplicates waste work."
      }
    },
    {
      "id": "shared-web-state-delta-out-of-order-noop",
      "domain": "Shared-web out-of-order delta handling",
      "owner": "Shared Web maintainers",
      "summary": "A delta older than cache resolves without a durable read. Executable assertion: “resolves an out-of-order envelope after a newer snapshot as a no-op”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#resolves an out-of-order envelope after a newer snapshot as a no-op",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "Newer cache state remains authoritative and no fetch occurs.",
        "requiredConstraint": "Recovery fetch remains unused for an envelope dominated by cache.",
        "failureRationale": "Fetching for stale input adds latency and risks replacing newer state."
      }
    },
    {
      "id": "shared-web-state-delta-predecessor-apply",
      "domain": "Shared-web predecessor-matched delta application",
      "owner": "Shared Web maintainers",
      "summary": "A predecessor-matched delta applies locally without a durable read. Executable assertion: “applies a delta at the cached predecessor and materializes the server-canonical snapshot”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#applies a delta at the cached predecessor and materializes the server-canonical snapshot",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "The delta materializes canonical state and no fetch occurs.",
        "requiredConstraint": "Recovery fetch remains unused when cache matches the delta predecessor.",
        "failureRationale": "Fetching defeats the valid delta fast path and adds latency."
      }
    },
    {
      "id": "shared-web-state-delta-resulting-floor",
      "domain": "Shared-web group-state resulting-floor recovery",
      "owner": "Shared Web maintainers",
      "summary": "A dominated cache not matching the predecessor triggers one floored read. Executable assertion: “pulls at the resulting floor when the cached snapshot is dominated but not the predecessor”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#pulls at the resulting floor when the cached snapshot is dominated but not the predecessor",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "One request at the resulting floor returns canonical state.",
        "requiredConstraint": "Exactly one floored recovery fetch occurs.",
        "failureRationale": "Applying crosses an unproven predecessor; duplicates race reconciliation."
      }
    },
    {
      "id": "shared-web-state-delta-resulting-noop",
      "domain": "Shared-web group-state delta no-op resolution",
      "owner": "Shared Web maintainers",
      "summary": "Equal-resulting and summary no-op deltas resolve without a durable read. Executable assertion: “resolves equal-resulting and summary no-op envelopes as typed no-ops before the apply rule”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#resolves equal-resulting and summary no-op envelopes as typed no-ops before the apply rule",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "Typed no-op results return before apply and no fetch occurs.",
        "requiredConstraint": "Recovery fetch remains unused for equal-resulting and summary no-ops.",
        "failureRationale": "Fetching adds latency and can replace equally current state."
      }
    },
    {
      "id": "shared-web-ticket-429-circuit-isolation",
      "domain": "Shared-web WebSocket ticket failure classification",
      "owner": "Shared Web maintainers",
      "summary": "Server rate limiting uses cooldown without opening the failure circuit. Executable assertion: “does not trip the circuit breaker for server 429 cooldown responses”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#does not trip the circuit breaker for server 429 cooldown responses",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "A 429 is followed by a successful fetch after cooldown.",
        "requiredConstraint": "The post-cooldown retry reaches fetch as the second request.",
        "failureRationale": "Treating 429 as circuit failure suppresses valid recovery."
      }
    },
    {
      "id": "shared-web-ticket-429-cooldown",
      "domain": "Shared-web WebSocket ticket cooldown",
      "owner": "Shared Web maintainers",
      "summary": "A 429 suppresses another ticket request until Retry-After expires. Executable assertion: “suppresses repeated ws ticket requests after a 429 response”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#suppresses repeated ws ticket requests after a 429 response",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "Fetch stays at one before expiry and reaches two after recovery.",
        "requiredConstraint": "No second fetch occurs during cooldown and one additional fetch occurs after expiry.",
        "failureRationale": "An early call violates backoff; a missing later call prevents recovery."
      }
    },
    {
      "id": "shared-web-ticket-circuit-breaker",
      "domain": "Shared-web WebSocket ticket circuit breaker",
      "owner": "Shared Web maintainers",
      "summary": "A server failure opens the circuit and suppresses the next request before fetch. Executable assertion: “opens a local circuit after server failures and suppresses the next ticket request”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#opens a local circuit after server failures and suppresses the next ticket request",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "One 503 reaches fetch and the next request fails locally.",
        "requiredConstraint": "Only the first request reaches fetch while the circuit is open.",
        "failureRationale": "A second fetch bypasses the circuit and loads an unavailable server."
      }
    },
    {
      "id": "shared-web-ticket-circuit-diagnostic-precedence",
      "domain": "Shared-web WebSocket ticket suppression precedence",
      "owner": "Shared Web maintainers",
      "summary": "An open circuit remains the suppression reason after repeated calls. Executable assertion: “keeps circuit-open diagnostics ahead of the local rate limiter while open”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#keeps circuit-open diagnostics ahead of the local rate limiter while open",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "One failure opens the circuit and later calls make no network request.",
        "requiredConstraint": "Fetch remains at one while subsequent requests report circuit-open.",
        "failureRationale": "Extra fetches bypass the circuit; rate-limit diagnostics obscure active policy."
      }
    },
    {
      "id": "shared-web-ticket-local-rate-limit",
      "domain": "Shared-web WebSocket ticket local rate limiting",
      "owner": "Shared Web maintainers",
      "summary": "The local limiter suppresses a ticket storm before a second API request. Executable assertion: “locally suppresses ticket storms before hitting the API”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#locally suppresses ticket storms before hitting the API",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "The first request reaches fetch and the next rejects locally.",
        "requiredConstraint": "Only one fetch occurs when the one-request window is exhausted.",
        "failureRationale": "A second fetch bypasses the client storm guard."
      }
    },
    {
      "id": "shared-web-ticket-request-id-retry",
      "domain": "Shared-web WebSocket ticket idempotent retry",
      "owner": "Shared Web maintainers",
      "summary": "A retry after a lost response reuses caller-owned request identity. Executable assertion: “reuses a caller-owned request ID when a ws ticket response is lost”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#reuses a caller-owned request ID when a ws ticket response is lost",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "WebSocket ticket HTTP request URL",
        "observableEffect": "The failed attempt and retry target the same request-ID URL in sequence.",
        "requiredConstraint": "Both ordered attempts use the identical caller-provided request ID.",
        "failureRationale": "Changing the ID defeats server idempotency and can mint duplicate tickets."
      }
    },
    {
      "id": "shared-web-webllm-runtime-lifecycle",
      "domain": "Shared-web WebLLM runtime lifecycle",
      "owner": "Shared Web maintainers",
      "summary": "One lazily loaded WebLLM runtime serves all requests while each request generates an envelope. Executable assertion: “loads one runtime and validates each generated envelope”.",
      "semanticCoverage": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts#loads one runtime and validates each generated envelope",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Shared-web WebLLM runtime loader and generation port",
        "observableEffect": "Two provider requests load one runtime and invoke generation twice.",
        "requiredConstraint": "Runtime loading occurs exactly once and generation occurs once per request.",
        "failureRationale": "Repeated loading repeats cold-start cost; missing or duplicate generations lose or repeat work."
      }
    },
    {
      "id": "source-analysis-test-interface",
      "domain": "Repository source-analysis test interface",
      "owner": "Rallar repository maintainers",
      "summary": "Test suites parse tracked TypeScript through one deterministic, path-aware analysis interface. Executable assertion: “normalizes TypeScript and TSX module syntax without exposing parser nodes”.",
      "semanticCoverage": "packages/tests/helpers/source-analysis.test.ts#normalizes TypeScript and TSX module syntax without exposing parser nodes",
      "coverageRelation": "The helper unit suite executes parsing, normalization, resolution, graph traversal, and path-aware failures; this AST access is the implementation input for that repository test interface."
    },
    {
      "id": "state-read-convergence-recipe--defines-run-scoped-identifiers-as-interpolated-string-values",
      "domain": "Clustered state-read convergence recipe",
      "owner": "Rallar server maintainers",
      "summary": "The recipe proves tertiary scalar and causal floors with source headers and run-scoped identities. Executable assertion: “defines run-scoped identifiers as interpolated string values”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#defines run-scoped identifiers as interpolated string values",
      "coverageRelation": "The named recipe test executes the parsed convergence fixture and asserts the run-scoped identity or tertiary causal evidence represented by this read."
    },
    {
      "id": "state-read-convergence-recipe--proves-tertiary-scalar-and-causal-floors-with-revision-and-sourc",
      "domain": "Clustered state-read convergence recipe",
      "owner": "Rallar server maintainers",
      "summary": "The recipe proves tertiary scalar and causal floors with source headers and run-scoped identities. Executable assertion: “proves tertiary scalar and causal floors with revision and source headers”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#proves tertiary scalar and causal floors with revision and source headers",
      "coverageRelation": "The named recipe test executes the parsed convergence fixture and asserts the run-scoped identity or tertiary causal evidence represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--executes-the-topology-exact-revision-assertions-before-every-cle",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “executes the topology exact-revision assertions before every cleanup step”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#executes the topology exact-revision assertions before every cleanup step",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--forbids-literal-set-values-from-claiming-durable-state-write-evi",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “forbids literal SET values from claiming durable state-write evidence”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#forbids literal SET values from claiming durable state-write evidence",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--isolates-crdt-appinbox-evidence-by-command-prefixes",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "CRDT AppInbox evidence selects only the commands owned by its recipe even when another recipe uses a containing update ID. Executable assertion: “isolates CRDT AppInbox evidence by recipe command prefixes”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#isolates CRDT AppInbox evidence by recipe command prefixes",
      "coverageRelation": "The named recipe test reads the executable CRDT fixture and verifies that its broad durable selector is narrowed by the two exact command-ID prefixes owned by that recipe."
    },
    {
      "id": "state-write-recipe-evidence--observes-committed-socket-authorization-before-clustered-ws-effe",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “observes committed socket authorization before clustered WS effects”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#observes committed socket authorization before clustered WS effects",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--selects-auth-ticket-races-by-the-redacted-secret-and-exact-durab",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “selects auth ticket races by the redacted secret and exact durable digest”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects auth ticket races by the redacted secret and exact durable digest",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--selects-strict-group-evidence-by-scoped-command-id",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "Strict group evidence follows the scoped internal command identity while retaining operation-specific topology selectors.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects strict group evidence by its scoped internal command identity",
      "coverageRelation": "The named recipe test reads all three executable group state-write fixtures and verifies that their durable selectors use the scoped group AppInbox command prefix."
    },
    {
      "id": "state-write-recipe-evidence--uses-one-bounded-execution-identity-for-the-command-and-its-evid",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “uses one bounded execution identity for the command and its evidence”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#uses one bounded execution identity for the command and its evidence",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "tests-project-module-alias-parity",
      "domain": "Tests-project module alias declaration parity",
      "owner": "Rallar repository maintainers",
      "summary": "The tests project declares every module alias the root project and the Vitest runner declare. Executable assertion: “declares every module alias the root project and the vitest runner declare”.",
      "semanticCoverage": "packages/tests/repo/tests-typecheck-gate.test.ts#declares every module alias the root project and the vitest runner declare",
      "coverageRelation": "The same assertion compares the three alias declaration sites against one another; this read supplies the tests-project side of that comparison, which cannot be observed by resolving a module at runtime."
    },
    {
      "id": "tests-typecheck-debt-ledger-shape",
      "domain": "Tests typecheck debt ratchet",
      "owner": "Rallar repository maintainers",
      "summary": "The recorded typecheck debt stays well-formed so the allowlist can only shrink. Executable assertion: “keeps the recorded debt well-formed so the allowlist can only shrink”.",
      "semanticCoverage": "packages/tests/repo/tests-typecheck-gate.test.ts#keeps the recorded debt well-formed so the allowlist can only shrink",
      "coverageRelation": "The assertion recomputes the ledger totals from its own entries and rejects non-positive counts; the ledger file is the only place that state exists, so the read is the assertion's subject rather than an incidental input."
    },
    {
      "id": "typescript-seven-release-boundary",
      "domain": "TypeScript 7 release boundary",
      "owner": "Rallar repository maintainers",
      "summary": "Release automation checks pinned TypeScript workspaces separately from Deno-owned applications. Executable assertion: “keeps TypeScript and Deno checking as separate release gates”.",
      "semanticCoverage": "packages/tests/repo/typescript-7-boundaries.test.ts#keeps TypeScript and Deno checking as separate release gates",
      "coverageRelation": "The release-boundary test executes the manifest/workflow inspection that keeps npm TypeScript checking separate from Deno checking; this workflow read is its exact release interface."
    },
    {
      "id": "workbench-collection-served-paths",
      "domain": "Rallar server workbench collection addressing",
      "owner": "Shared Test maintainers",
      "summary": "Every workbench REST collection step addresses a path and method the API actually serves. Executable assertion: “addresses paths the API actually serves”.",
      "semanticCoverage": "packages/tests/rallar-black-box/rallar-server-workbench.test.ts#addresses paths the API actually serves",
      "coverageRelation": "The collections are hand-written HTTP paths that nothing executes in CI, so a wrong one is invisible until an operator clicks it and receives a 404. This assertion reads the shipped OpenAPI document — the published contract, not an internal structure — and requires a served path and method for every step. No behavioural test can substitute: the collections are operator inputs, never executed by the suite."
    },
    {
      "id": "ws-invalid-application-command-skips-authorization",
      "domain": "WS server typed ingress admission",
      "owner": "Shared realtime maintainers",
      "summary": "An application validator rejection must return the typed failure before invoking authorization or writing admission state. Executable assertion: “runs a typed application validator before authorization or admission”.",
      "semanticCoverage": "packages/tests/shared/services/ws-queue-box-server-ingress.test.ts#runs a typed application validator before authorization or admission",
      "coverageRelation": "The test installs an application validator that rejects and an authority port, then calls public acceptIncomingMessage against a valid live authenticated connection.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Installed WsServerInboundAuthorizer.authorize capability",
        "observableEffect": "The malformed command produces no authority-provider call and leaves admission metadata empty.",
        "requiredConstraint": "An application validator rejection must return the typed failure before invoking authorization or writing admission state.",
        "failureRationale": "Authorization can perform asynchronous authoritative reads or side effects and must not receive application commands already rejected by the typed ingress validator."
      }
    },
    {
      "id": "ws-native-failure-one-attempt-accounting",
      "domain": "WS outbound native attempt accounting",
      "owner": "Shared realtime maintainers",
      "summary": "One failed physical dispatch invokes native send exactly once and records one QueueBox processing attempt. Executable assertion: “retains native-send failure accounting when an open socket throws”.",
      "semanticCoverage": "packages/tests/shared/ws-server-readiness.test.ts#retains native-send failure accounting when an open socket throws",
      "coverageRelation": "The test enqueues through the real WS AL runtime and checks both the native write port and the resulting public work row.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket.send on an open selected connection",
        "observableEffect": "The open native socket throws, and the existing work row becomes RETRY with attempts equal to one.",
        "requiredConstraint": "One failed physical dispatch invokes native send exactly once and records one QueueBox processing attempt.",
        "failureRationale": "An inner resend may duplicate a message after an uncertain native failure and would misrepresent multiple submissions as one QueueBox attempt."
      }
    }
,
    {
      "id": "agent-launch-unavailable-clipboard-mints-no-links",
      "domain": "Recipe Console browser-agent launch authority",
      "owner": "Rallar Black Box maintainers",
      "summary": "When the browser offers no clipboard, copying launch links mints none. Executable assertion: \"names an unavailable clipboard instead of minting links it cannot copy\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#names an unavailable clipboard instead of minting links it cannot copy",
      "coverageRelation": "The named test reads the operator message the panel shows; that message alone cannot say whether the links behind it were already minted, so the absence of a prepare call is the only witness that no credential was spent.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Control server browser-agent launch preparation endpoint",
        "observableEffect": "No prepare call when the clipboard is unavailable.",
        "requiredConstraint": "The copy action checks the clipboard before it asks the control server for fresh launch links.",
        "failureRationale": "Links minted for a clipboard that cannot receive them leave short-lived agent credentials live on the control server with no operator holding them."
      }
    },
{
      "id": "agent-launch-one-control-token-per-simulated-agent",
      "domain": "Recipe Console browser-agent launch authority",
      "owner": "Rallar Black Box maintainers",
      "summary": "Preparing simulated agents mints exactly one run-scoped control token per agent, so no agent shares or reuses another agent's authority. Executable assertion: \"prepares exact simulated identities with distinct least-privilege control tokens\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#prepares exact simulated identities with distinct least-privilege control tokens",
      "coverageRelation": "The named test prepares three agents and reads the distinct token each launch URL carries; the mint count is what separates three least-privilege tokens from one token copied three times, which the launch URLs alone cannot show.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Control server run-scoped token endpoint",
        "observableEffect": "One issueRunToken call per prepared agent, three for three agents.",
        "requiredConstraint": "Every prepared agent causes exactly one token mint; none is minted twice and none is skipped.",
        "failureRationale": "A skipped mint silently reuses another agent's authority, and a repeated mint leaves a live unused token on the control server for the run's lifetime."
      }
    },
    {
      "id": "agent-launch-legacy-compatibility-mints-no-agent-ticket",
      "domain": "Recipe Console browser-agent launch authority",
      "owner": "Rallar Black Box maintainers",
      "summary": "The explicit anonymous and interactive-login legacy launch path issues no browser-rallar agent ticket at all. Executable assertion: \"keeps explicit anonymous and interactive-login compatibility at the legacy boundary\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#keeps explicit anonymous and interactive-login compatibility at the legacy boundary",
      "coverageRelation": "The named test drives the legacy launch and reads the launch URL it produces; an unused ticket would not appear in that URL, so the absence of any ticket request is the only witness that the legacy path stayed credential-free.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar server browser-agent ticket endpoint",
        "observableEffect": "No issueAgentTickets call for a legacy anonymous or interactive-login launch.",
        "requiredConstraint": "The legacy compatibility path requests no agent ticket, whatever the launch URL ends up carrying.",
        "failureRationale": "A ticket minted and then discarded spends a real session credential the operator never sees and never revokes."
      }
    },
    {
      "id": "agent-launch-links-copied-in-one-clipboard-write",
      "domain": "Recipe Console browser-agent launch authority",
      "owner": "Rallar Black Box maintainers",
      "summary": "Copying agent links writes the operator's clipboard exactly once, with every link in that single write. Executable assertion: \"copies multiple secured agent links that share the legacy run token\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#copies multiple secured agent links that share the legacy run token",
      "coverageRelation": "The named test reads the copied text and its two links out of the write call; a per-link write would leave the same final clipboard content, so the write count is the only witness that both links were offered together.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Operator clipboard write port",
        "observableEffect": "One clipboard write carrying every prepared agent link.",
        "requiredConstraint": "A copy action writes the clipboard once, never once per agent.",
        "failureRationale": "A write per agent leaves the operator holding only the last link while the panel reports that every link was copied."
      }
    },
    {
      "id": "agent-launch-popup-reserved-once-per-requested-agent",
      "domain": "Recipe Console browser-agent popup reservation",
      "owner": "Rallar Black Box maintainers",
      "summary": "Reserving browser-agent popups opens exactly one window per requested agent, including the agents the browser blocks. Executable assertion: \"reserves synchronously, reports blocked IDs, and navigates only prepared windows with replace\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#reserves synchronously, reports blocked IDs, and navigates only prepared windows with replace",
      "coverageRelation": "The named test reads the reserved and blocked agent ids the reservation reports; those lists are the same whether the blocked agent was attempted once or not at all, so the open count is the only witness that each agent got its own synchronous attempt.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Browser window.open popup port",
        "observableEffect": "One window.open call per requested agent id, three for three agents.",
        "requiredConstraint": "Every requested agent is attempted exactly once, inside the operator gesture that authorises the popups.",
        "failureRationale": "A retry outside the gesture is blocked by the browser, and a skipped attempt reports an agent as blocked that was never offered a window."
      }
    },
    {
      "id": "agent-launch-released-popups-closed-exactly-once",
      "domain": "Recipe Console browser-agent popup reservation",
      "owner": "Rallar Black Box maintainers",
      "summary": "Releasing a reservation closes every window it holds exactly once, after writing the operator's reason into it. Executable assertion: \"closes every unused blank window after preparation failure or invalidation\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#closes every unused blank window after preparation failure or invalidation",
      "coverageRelation": "The named test reads the reason text each released window shows; a window closed twice, or closed before the reason was written, shows the same text, so the close count is the only witness that each window was disposed of once and in that order.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Reserved browser-agent popup windows",
        "observableEffect": "Exactly one close() per reserved window after its reason is written.",
        "requiredConstraint": "Each released window is closed once; none is left open and none is closed twice.",
        "failureRationale": "A window left open keeps a blank popup on the operator's screen for the session, and a second close on an already-closed window throws out of the release path and strands the rest."
      }
    },
    {
      "id": "agent-launch-closed-popup-never-navigated",
      "domain": "Recipe Console browser-agent popup reservation",
      "owner": "Rallar Black Box maintainers",
      "summary": "Navigating prepared links replaces the location of every still-open reserved window exactly once and never navigates one the operator already closed. Executable assertion: \"reports a reserved popup closed before prepared links are navigated\".",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#reports a reserved popup closed before prepared links are navigated",
      "coverageRelation": "The named test reads the navigated and closed agent ids the navigation reports; those lists are computed before the windows are touched, so only the replace counts show that the open window was actually navigated and the closed one was actually left alone.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Reserved browser-agent popup location",
        "observableEffect": "One location.replace on the still-open window, and none on the window the operator closed.",
        "requiredConstraint": "A prepared link navigates its own open window once, and a closed window is never navigated.",
        "failureRationale": "Navigating a closed window raises a cross-origin error that aborts the remaining launches, and a second replace loses the agent's one-time launch link from history."
      }
    },
    {
      "id": "analyze-window-pending-pager-issues-no-second-request",
      "sharedCoverageGroup": "analyze-evidence-window-pending-and-failure-controls",
      "domain": "Recipe Console Analyze evidence window pagination",
      "owner": "Rallar Black Box maintainers",
      "summary": "While an evidence-window request is in flight the pager controls stay mounted and disabled, and clicking one issues no second window request. Executable assertion: \u201ckeeps pending controls mounted, blocks repeat cursor requests, and reports failure\u201d.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-window-ui.test.ts#keeps pending controls mounted, blocks repeat cursor requests, and reports failure",
      "coverageRelation": "The test renders the pending window, reads that both pager buttons are still mounted with aria-disabled=true, clicks each of them, and reads the window-request count; the rendered rows are identical whether the click was refused or served, so the absent request is the only witness that it was refused.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "requestWindow on the Analyze workspace controller, which posts a window request to the accepted Analyze worker",
        "observableEffect": "Each call posts a window request and advances the client's window generation.",
        "requiredConstraint": "A click on a disabled pager control while a window request is pending issues zero window requests.",
        "failureRationale": "A second request advances the window generation, so the reply to the in-flight request is discarded as stale and the operator's page never arrives while the rendered rows stay unchanged."
      }
    },
    {
      "id": "analyze-window-failure-retry-searches-exactly-once",
      "sharedCoverageGroup": "analyze-evidence-window-pending-and-failure-controls",
      "domain": "Recipe Console Analyze evidence window failure recovery",
      "owner": "Rallar Black Box maintainers",
      "summary": "The evidence-window failure banner's retry control reissues the evidence search exactly once per click. Executable assertion: \u201ckeeps pending controls mounted, blocks repeat cursor requests, and reports failure\u201d.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-window-ui.test.ts#keeps pending controls mounted, blocks repeat cursor requests, and reports failure",
      "coverageRelation": "The test renders the failed window, reads the operator failure sentence, clicks the retry control once and reads the search count; the controller is a test double that re-renders nothing, so the call count is the only witness that one search left the view.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "retryEvidenceSearch on the Analyze workspace controller, which reissues the current query as a search on the accepted Analyze worker",
        "observableEffect": "Each call posts a search request and advances the client's query generation, resetting its window generation.",
        "requiredConstraint": "One click on the retry control issues exactly one evidence search.",
        "failureRationale": "A retry that issues nothing strands the operator on the failure banner, and a retry that issues twice advances the query generation under its own first reply, so that reply is discarded as stale and the window stays empty."
      }
    },
    {
      "id": "analyze-worker-crashed-candidate-keeps-accepted-worker",
      "domain": "Recipe Console Analyze worker replacement safety",
      "owner": "Rallar Black Box maintainers",
      "summary": "A replacement Analyze worker that crashes before it completes never terminates the accepted worker that still owns the current analysis and export. Executable assertion: “keeps the accepted worker and export when a replacement candidate crashes”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#keeps the accepted worker and export when a replacement candidate crashes",
      "coverageRelation": "The test drives the real client over two fake Worker ports, completes the first, offers a replacement, raises the candidate’s error event, and reads the retained export together with the accepted port’s termination.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "AnalyzeWorkerPort.terminate called by createAnalyzeWorkerClient",
        "observableEffect": "Terminating a worker port permanently stops its thread and discards the parsed artifact model it holds.",
        "requiredConstraint": "A candidate crash must terminate zero accepted workers; the accepted worker keeps serving searches from its retained model.",
        "failureRationale": "The retained export object is a UI-thread value that survives a terminated worker, so export identity alone cannot prove the accepted thread is still alive to answer the next search."
      }
    },
    {
      "id": "analyze-worker-identity-mismatch-terminates-only-the-candidate",
      "domain": "Recipe Console Analyze worker identity rejection",
      "owner": "Rallar Black Box maintainers",
      "summary": "An Analyze candidate whose Control identity fails validation is terminated exactly once and the accepted worker is left running. Executable assertion: “rejects an identity-invalid candidate without replacing the accepted worker or export”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#rejects an identity-invalid candidate without replacing the accepted worker or export",
      "coverageRelation": "The test accepts a first worker, offers a second with a mismatching Control identity digest, lets it complete, and reads the identity-mismatch failure beside each port’s termination.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "AnalyzeWorkerPort.terminate called by createAnalyzeWorkerClient",
        "observableEffect": "Terminating a worker port permanently stops its thread and releases the artifact bytes it was transferred.",
        "requiredConstraint": "A rejected candidate is terminated exactly once, and the accepted worker is terminated zero times.",
        "failureRationale": "A rejected candidate that is never terminated leaks a thread holding the artifact bytes it was handed, and a terminated accepted worker silently ends the analysis the operator is still reading; neither is visible in the completion or export state."
      }
    },
    {
      "id": "analyze-worker-oversized-request-constructs-no-replacement",
      "domain": "Recipe Console Analyze outbound request bounds",
      "owner": "Rallar Black Box maintainers",
      "summary": "An Analyze request or offer that exceeds its outbound byte bounds is refused before any worker is constructed or terminated. Executable assertion: “rejects oversized outbound metadata and RPC text without posting or replacing authority”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#rejects oversized outbound metadata and RPC text without posting or replacing authority",
      "coverageRelation": "The test accepts one worker, then issues oversized search, window, select, tune and offer requests through the real client and reads the accepted port’s post list, the factory’s construction count and the accepted port’s termination.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "AnalyzeWorkerClient.Input.createWorker and AnalyzeWorkerPort.terminate",
        "observableEffect": "Each construction spawns a worker thread and each termination ends one; both are resource effects the client owns.",
        "requiredConstraint": "The whole rejected sequence constructs exactly one worker in total and terminates none, so a refused offer never spends or replaces worker authority.",
        "failureRationale": "The returned undefined request ids and the unchanged post list are identical whether or not the client first spawned and discarded a candidate thread, so only the construction count excludes that hidden cost."
      }
    },
    {
      "id": "analyze-worker-failed-transfer-post-terminates-its-candidate",
      "domain": "Recipe Console Analyze candidate cleanup on a failed transfer",
      "owner": "Rallar Black Box maintainers",
      "summary": "A candidate whose first transfer post throws is terminated exactly once, synchronously, before the throw reaches the caller. Executable assertion: “cleans candidate authority synchronously when the initial transfer post throws”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#cleans candidate authority synchronously when the initial transfer post throws",
      "coverageRelation": "The test offers an artifact to a port whose postMessage throws, catches the rethrown error, and reads the port’s termination and the pending-timer set before offering a second artifact that succeeds.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "AnalyzeWorkerPort.terminate called by createAnalyzeWorkerClient",
        "observableEffect": "Terminating the failed candidate ends the thread that was spawned for a transfer that never landed.",
        "requiredConstraint": "A candidate whose initial post throws is terminated exactly once before the client returns control.",
        "failureRationale": "The next successful offer works either way, so only the termination count proves the failed candidate’s thread was not left running beside it."
      }
    },
    {
      "id": "analyze-worker-watchdog-terminates-only-its-own-candidate",
      "domain": "Recipe Console Analyze watchdog scope",
      "owner": "Rallar Black Box maintainers",
      "summary": "An Analyze watchdog timeout ends only the candidate or request that armed it, never the accepted worker. Executable assertion: “times out only the candidate or request that owns the watchdog and ignores late replies”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#times out only the candidate or request that owns the watchdog and ignores late replies",
      "coverageRelation": "The test fires the request watchdog and then the candidate watchdog against a real client holding an accepted worker, and reads the unavailability reasons beside each port’s termination and the retained export.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "AnalyzeWorkerPort.terminate called by createAnalyzeWorkerClient",
        "observableEffect": "Terminating a worker port ends its thread and the model it holds; the accepted worker still owns the analysis the operator is reading.",
        "requiredConstraint": "A timed-out request terminates no worker, a timed-out candidate terminates exactly its own, and the accepted worker is terminated zero times.",
        "failureRationale": "The unavailability reasons and the retained export are produced identically by a client that also tore down the accepted thread, so only the per-port termination counts separate a scoped watchdog from a global one."
      }
    },
    {
      "id": "analyze-worker-factory-constructs-nothing-until-invoked",
      "domain": "Recipe Console Analyze worker factory laziness",
      "owner": "Rallar Black Box maintainers",
      "summary": "The Analyze worker factory constructs no worker until the returned factory is called. Executable assertion: “creates no worker until the lazy factory is explicitly invoked”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#creates no worker until the lazy factory is explicitly invoked",
      "coverageRelation": "The test builds the real factory over an injected constructor, reads the construction count before invoking it, then invokes it once and reads the returned port and the count again.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "The worker constructor passed to createAnalyzeWorkerFactory",
        "observableEffect": "Each construction spawns and loads a worker thread with the Analyze module.",
        "requiredConstraint": "Building the factory constructs zero workers and one invocation constructs exactly one.",
        "failureRationale": "Laziness has no other witness: an eagerly constructed worker returns the same port from the same call, and the cost it imposes on every Recipe Console load is only visible as the construction that did not happen."
      }
    },
    {
      "id": "analyze-worker-factory-targets-the-module-worker-asset",
      "domain": "Recipe Console Analyze worker asset identity",
      "owner": "Rallar Black Box maintainers",
      "summary": "The default Analyze worker factory hands the platform constructor the Analyze artifact worker asset as a named module worker. Executable assertion: “targets the production Analyze artifact worker asset”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#targets the production Analyze artifact worker asset",
      "coverageRelation": "The test stubs the global Worker constructor, invokes the real default factory once, and reads the URL and options the factory passed to it.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "The global Worker constructor",
        "observableEffect": "The constructor call is the only place the app names which built asset runs as the Analyze worker and under which module type and name.",
        "requiredConstraint": "The single construction names the analyze-artifact worker asset with the module type and the Recipe Console worker name.",
        "failureRationale": "Nothing the returned port exposes carries the asset URL or the worker options, so a factory pointed at the wrong chunk or started as a classic worker would be invisible to any state assertion."
      }
    },
    {
      "id": "analyze-hook-failed-replacement-keeps-the-accepted-worker",
      "domain": "Recipe Console Analyze workspace hook replacement safety",
      "owner": "Rallar Black Box maintainers",
      "summary": "Across held replies, a Tune round trip and a failed replacement, the Analyze workspace hook terminates each failed worker exactly once and keeps the accepted worker running until it fails itself. Executable assertion: “keeps input, navigation, accepted analysis, and export usable across held replies, Tune, and a failed replacement”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#keeps input, navigation, accepted analysis, and export usable across held replies, Tune, and a failed replacement",
      "coverageRelation": "The test renders the real hook over controllable worker ports, fails a replacement, runs a Tune round trip on the accepted worker, then fails the accepted worker, reading the rendered workspace dataset beside each port’s termination.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "AnalyzeWorkerPort.terminate reached through useAnalyzeWorkspace",
        "observableEffect": "Terminating a worker port ends the thread that answers the workspace’s searches, windows and Tune requests.",
        "requiredConstraint": "A failed replacement terminates exactly its own worker and none of the accepted one; the accepted worker is terminated exactly once, when it fails.",
        "failureRationale": "The rendered dataset keeps its retained analysis and Tune facade whether or not the accepted thread is alive, so only the termination counts prove which worker still answers the next request and that no failed one was left running."
      }
    },
    {
      "id": "analyze-hook-off-view-retains-its-accepted-worker",
      "domain": "Recipe Console Analyze off-view work suppression",
      "owner": "Rallar Black Box maintainers",
      "summary": "Leaving and re-entering the Analyze view does no worker work off-view and never terminates the accepted worker that retains the artifact and Tune facade. Executable assertion: “does no Analyze option or search work off-view, retains the artifact and Tune facade, then searches the latest query once on entry”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#does no Analyze option or search work off-view, retains the artifact and Tune facade, then searches the latest query once on entry",
      "coverageRelation": "The test renders the real hook, navigates away and back through URL state, and reads the single search request, the retained artifact and Tune facade and the accepted port’s termination.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "AnalyzeWorkerPort.terminate reached through useAnalyzeWorkspace",
        "observableEffect": "Terminating the accepted worker discards the parsed model the retained artifact and Tune facade are projections of.",
        "requiredConstraint": "Leaving and re-entering the view terminates zero workers, so re-entry costs no reparse.",
        "failureRationale": "The retained artifact and facade are UI-thread values that outlive a terminated worker, so only the absent termination proves re-entry reuses the parsed model instead of silently rebuilding it."
      }
    },
    {
      "id": "analyze-hook-late-candidate-terminates-only-the-candidate",
      "domain": "Recipe Console Analyze late-candidate rejection",
      "owner": "Rallar Black Box maintainers",
      "summary": "A candidate that completes after a render-time context and execution change is terminated exactly once, and the accepted worker keeps its analysis. Executable assertion: “rejects a candidate completed after a render-time context and execution change before passive reconciliation”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#rejects a candidate completed after a render-time context and execution change before passive reconciliation",
      "coverageRelation": "The test emits the candidate’s completion during the commit that changes context and execution, then reads the rejected completion, the rendered dataset and each port’s termination.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "AnalyzeWorkerPort.terminate reached through useAnalyzeWorkspace",
        "observableEffect": "Terminating a worker port ends the thread and releases the artifact bytes the rejected candidate was transferred.",
        "requiredConstraint": "The rejected late candidate is terminated exactly once and the accepted worker is terminated zero times.",
        "failureRationale": "The rejected completion and the retained dataset look the same whether the candidate thread was torn down or left holding its transferred bytes, and whether or not the accepted thread survived to answer the next request."
      }
    },
    {
      "id": "retention-cleanup-mount-defers-the-retention-client",
      "sharedCoverageGroup": "retention-cleanup-preview-defers-then-requests-one-plan",
      "domain": "Recipe Console retention cleanup client acquisition",
      "owner": "Rallar Black Box maintainers",
      "summary": "Mounting the retention cleanup controller loads no retention client; the lazily imported client and its authorized control endpoint appear only when the operator asks for a preview. Executable assertion: “loads only on Preview and exposes exact frozen token-free consequences”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#loads only on Preview and exposes exact frozen token-free consequences",
      "coverageRelation": "The test renders the controller with a live capability and reads its idle state and enabled Preview affordance before anything is clicked. An idle controller renders identically whether or not its client was already acquired, so the unmade load call is the only witness that the mount deferred it.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "ControlLazyCapability.load for the retention API, which dynamically imports the retention client chunk and binds an authorized control endpoint",
        "observableEffect": "A load fetches the retention feature chunk over the network and binds a fresh authorized endpoint to the live control connection, and the capability caches that result for the connection’s lifetime.",
        "requiredConstraint": "Rendering the cleanup controller performs zero loads until the operator requests a preview.",
        "failureRationale": "A load on mount spends a chunk fetch and an authorization binding for every operator who never opens cleanup, and the cached result then belongs to a connection state the operator never asked about."
      }
    },
    {
      "id": "retention-cleanup-preview-loads-once-and-requests-one-plan",
      "sharedCoverageGroup": "retention-cleanup-preview-defers-then-requests-one-plan",
      "domain": "Recipe Console retention plan request",
      "owner": "Rallar Black Box maintainers",
      "summary": "One operator preview acquires the retention client exactly once and asks the control server for exactly one retention plan. Executable assertion: “loads only on Preview and exposes exact frozen token-free consequences”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#loads only on Preview and exposes exact frozen token-free consequences",
      "coverageRelation": "The test previews once and reads the frozen, token-free consequences the controller exposes. The same rows render for one plan request or for several, so the load and request counts are the only witnesses that one operator action produced one plan.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ControlLazyCapability.load and RecipeConsoleControlRetentionApi.preview, the dry-run retention plan request to the control server",
        "observableEffect": "Each preview issues a dry-run retention request and advances the client’s preview generation, superseding any plan issued before it.",
        "requiredConstraint": "One operator preview performs exactly one load and issues exactly one plan request.",
        "failureRationale": "A second plan request supersedes the first, so the plan token the operator later confirms is no longer the one the server holds, while the rendered consequences look identical either way."
      }
    },
    {
      "id": "retention-cleanup-strictmode-replay-issues-no-second-plan",
      "domain": "Recipe Console retention cleanup under StrictMode effect replay",
      "owner": "Rallar Black Box maintainers",
      "summary": "The StrictMode double-invoked context effect neither re-acquires the retention client nor reissues the operator’s plan request. Executable assertion: “remains operational after the StrictMode effect replay”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#remains operational after the StrictMode effect replay",
      "coverageRelation": "The test mounts the controller inside StrictMode, which runs its context effect twice, previews once and reads the preview-ready state with its enabled confirm affordance. That state is reached whether or not the replay reissued the work, so the counts are the only witnesses.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ControlLazyCapability.load and RecipeConsoleControlRetentionApi.preview reached through useRetentionCleanup",
        "observableEffect": "Each load fetches the retention chunk and binds an authorized endpoint; each preview issues a dry-run retention request and supersedes the previous plan.",
        "requiredConstraint": "A StrictMode effect replay leaves one operator preview at exactly one load and one plan request.",
        "failureRationale": "The replayed effect resets the controller’s context; if it also re-ran the operator’s work the plan on screen would already be superseded on the server and nothing rendered would say so."
      }
    },
    {
      "id": "retention-cleanup-concurrent-previews-issue-one-plan",
      "domain": "Recipe Console retention preview serialization",
      "owner": "Rallar Black Box maintainers",
      "summary": "Two previews raised in the same commit serialize into one client acquisition and one plan request, and the superseded result never reaches the operator. Executable assertion: “serializes double preview calls and suppresses a superseded result”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#serializes double preview calls and suppresses a superseded result",
      "coverageRelation": "The test starts two previews before the first resolves, reads the busy controller, then resolves the pending request and reads the single preview-ready state. A controller that issued both requests and dropped one reaches the same rendered state, so the counts are the only witnesses.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ControlLazyCapability.load and RecipeConsoleControlRetentionApi.preview, the dry-run retention plan request to the control server",
        "observableEffect": "Each preview issues a dry-run retention request to the control server and advances the client’s preview generation.",
        "requiredConstraint": "A preview raised while another is in flight performs zero additional loads and issues zero additional plan requests.",
        "failureRationale": "A concurrent second request supersedes the first inside the retention client, which aborts the operator’s own in-flight preview and leaves the panel waiting for a plan that will never arrive."
      }
    },
    {
      "id": "retention-cleanup-confirmation-deletes-once-and-reconciles-once",
      "domain": "Recipe Console retention deletion",
      "owner": "Rallar Black Box maintainers",
      "summary": "A confirmed cleanup sends exactly one destructive delete for the previewed plan and runs its reconciliation exactly once, even when the operator confirms twice. Executable assertion: “confirms only the exact private preview and awaits one callback before success”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#confirms only the exact private preview and awaits one callback before success",
      "coverageRelation": "The test confirms twice within one commit, holds the reconciliation callback open, then releases it and reads the succeeded state with its confirmation payload. That state and payload are identical whether one or two deletes reached the server, so the counts are the only witnesses.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ControlLazyCapability.load, RecipeConsoleControlRetentionApi.confirm (the destructive retention deletion request) and the caller’s afterConfirmed reconciliation callback",
        "observableEffect": "A confirm deletes the previewed control runs, their distributed runs and their fleet reports on the control server; a reconciliation re-reads the control snapshot and rewrites the console’s URL selection.",
        "requiredConstraint": "One operator confirmation reuses the already-loaded client, sends exactly one delete and runs exactly one reconciliation.",
        "failureRationale": "Retention deletion is irreversible and consumes its plan token, so a second delete either destroys a set the operator never reviewed or fails after the first already ran, and a repeated reconciliation rewrites operator state after the run set has already changed."
      }
    },
    {
      "id": "retention-cleanup-drifted-plan-sends-no-second-delete",
      "domain": "Recipe Console retention drift recovery",
      "owner": "Rallar Black Box maintainers",
      "summary": "A drifted deletion keeps only the stale consequences on screen and refuses every further confirmation until a new preview is taken. Executable assertion: “maps 409 to drift, preserves only stale consequences, and requires a new preview”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#maps 409 to drift, preserves only stale consequences, and requires a new preview",
      "coverageRelation": "The test confirms once into a 409, reads the drift state with its non-current preview, confirms again and reads the delete count. The drift state is unchanged by a refused or a repeated request, so the count is the only witness that the second confirmation never left the console.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "RecipeConsoleControlRetentionApi.confirm, the destructive retention deletion request",
        "observableEffect": "Each confirm asks the control server to delete the run set named by a plan token.",
        "requiredConstraint": "After a drift refusal, further confirmations leave the delete count at the single attempt that drifted.",
        "failureRationale": "The drifted plan token no longer names the run set the operator reviewed, so a retry would delete whatever the server now counts as excess without the operator ever seeing it."
      }
    },
    {
      "id": "retention-cleanup-replaced-connection-abandons-the-late-client",
      "domain": "Recipe Console retention capability replacement",
      "owner": "Rallar Black Box maintainers",
      "summary": "When the control connection is replaced while a retention client is still loading, the late client is never asked for a plan and the replacement acquires nothing on its own. Executable assertion: “invalidates synchronously on capability replacement and suppresses late load and preview”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates synchronously on capability replacement and suppresses late load and preview",
      "coverageRelation": "The test starts a preview whose load is still pending, replaces the capability, resolves the old load and reads the unavailable state. That state is reached whether or not the resolved client was used, so the two unmade calls are the only witnesses.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "RecipeConsoleControlRetentionApi.preview on the superseded connection’s client, and ControlLazyCapability.load on the replacement capability",
        "observableEffect": "A preview issues a dry-run retention request over the connection that owns the client; a load fetches the retention chunk and binds an authorized endpoint to that capability.",
        "requiredConstraint": "A capability replacement leaves the superseded client at zero plan requests and the replacement at zero loads until the operator asks again.",
        "failureRationale": "A plan request over the superseded connection reads a run set the operator is no longer looking at, and an eager load on replacement spends a chunk fetch and an authorization binding nobody requested."
      }
    },
    {
      "id": "retention-cleanup-identity-replacement-sends-no-stale-delete",
      "sharedCoverageGroup": "retention-cleanup-identity-replacement-rebinds-its-client",
      "domain": "Recipe Console retention plan invalidation",
      "owner": "Rallar Black Box maintainers",
      "summary": "Replacing the capability’s loader under the same generation and lifetime invalidates a completed plan, and no confirmation reaches either the previous or the replacement client. Executable assertion: “invalidates a completed preview on capability identity replacement”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates a completed preview on capability identity replacement",
      "coverageRelation": "The test completes a preview, swaps in a capability with the same generation and signal but a different loader, reads the unavailable state with its non-current preview and then confirms. The state already reports the plan as stale, so the two unmade deletes are the only witnesses that nothing was sent.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "RecipeConsoleControlRetentionApi.confirm on both the previous and the replacement retention client",
        "observableEffect": "Each confirm asks the control server to delete the run set named by a plan token.",
        "requiredConstraint": "A confirmation raised after the loader was replaced sends zero deletes to either client.",
        "failureRationale": "A completed plan token belongs to the client that issued it; sending it afterwards either deletes over a connection the console has abandoned or replays a plan the replacement never offered."
      }
    },
    {
      "id": "retention-cleanup-identity-replacement-previews-once-through-the-new-client",
      "sharedCoverageGroup": "retention-cleanup-identity-replacement-rebinds-its-client",
      "domain": "Recipe Console retention client rebinding",
      "owner": "Rallar Black Box maintainers",
      "summary": "After a loader replacement the next preview acquires the replacement client exactly once and asks it for exactly one plan. Executable assertion: “invalidates a completed preview on capability identity replacement”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates a completed preview on capability identity replacement",
      "coverageRelation": "The test previews again after the replacement and reads the confirmable controller. A confirmable controller follows from any successful plan, so the counts are the only witnesses that the plan came from one acquisition of the replacement client and one request over it.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "The replacement capability’s ControlLazyCapability.load and its RecipeConsoleControlRetentionApi.preview",
        "observableEffect": "The load fetches the retention chunk and binds an authorized endpoint for the replacement; the preview issues one dry-run retention request over it.",
        "requiredConstraint": "The first preview after a loader replacement performs exactly one load and one plan request on the replacement client.",
        "failureRationale": "Reusing the invalidated client would confirm over a connection the console has abandoned, and a repeated request would supersede the very plan the operator is about to confirm."
      }
    },
    {
      "id": "retention-cleanup-drifted-confirmation-reconciles-nothing",
      "domain": "Recipe Console retention reconciliation fencing",
      "owner": "Rallar Black Box maintainers",
      "summary": "A confirmation that completes after the control context changed never runs its reconciliation callback. Executable assertion: “aborts in-flight work on signal/context drift and never calls back after drift”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#aborts in-flight work on signal/context drift and never calls back after drift",
      "coverageRelation": "The test holds the confirmation open, replaces the capability, resolves the confirmation and reads the unavailable state. That state is reached whether or not the callback ran, so the unmade reconciliation is the only witness.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "The caller’s afterConfirmed reconciliation callback, which re-reads the control snapshot and rewrites the console’s URL selection",
        "observableEffect": "Running the reconciliation refreshes the control snapshot and replaces the operator’s URL selection with the post-cleanup one.",
        "requiredConstraint": "A confirmation resolved after a context change runs its reconciliation zero times.",
        "failureRationale": "The reconciliation would refresh and rewrite the selection of the control connection the operator moved to, using run ids deleted on the connection they left."
      }
    },
    {
      "id": "retention-cleanup-reconciliation-starts-once-per-confirmation",
      "sharedCoverageGroup": "retention-cleanup-reconciliation-aborts-on-context-drift",
      "domain": "Recipe Console retention reconciliation lifetime",
      "owner": "Rallar Black Box maintainers",
      "summary": "A confirmed cleanup starts its reconciliation exactly once and hands it the abort signal of that operation. Executable assertion: “aborts an in-progress reconciliation callback on context drift”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#aborts an in-progress reconciliation callback on context drift",
      "coverageRelation": "The test waits for the reconciliation to start so it can read the abort signal the controller handed it; that callback invocation is the only place the signal exists. The count both proves that one reconciliation began and names the call whose signal the rest of the assertion reads.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "The caller’s afterConfirmed reconciliation callback, invoked with the confirmation, the sanitized plan and the operation’s abort signal",
        "observableEffect": "Invoking the reconciliation begins the post-cleanup refresh and URL rewrite under the operation’s own abort signal.",
        "requiredConstraint": "One confirmation begins exactly one reconciliation, and the signal it carries is the one the controller aborts on context drift.",
        "failureRationale": "Without a single started call there is no signal to read at all, and a second reconciliation would refresh and rewrite the operator’s selection twice for one deletion."
      }
    },
    {
      "id": "retention-cleanup-aborted-reconciliation-performs-no-work",
      "sharedCoverageGroup": "retention-cleanup-reconciliation-aborts-on-context-drift",
      "domain": "Recipe Console retention reconciliation abort",
      "owner": "Rallar Black Box maintainers",
      "summary": "A reconciliation already running when the control context changes performs no further work once its signal aborts. Executable assertion: “aborts an in-progress reconciliation callback on context drift”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#aborts an in-progress reconciliation callback on context drift",
      "coverageRelation": "The test replaces the capability while the reconciliation awaits, then releases it and reads the unavailable state. The state is the same whether the callback’s remaining work ran or not, so the unmade side effect is the only witness.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "The post-cleanup work the reconciliation callback guards behind its abort signal",
        "observableEffect": "The guarded work rewrites the console’s selection from the run ids the cleanup deleted.",
        "requiredConstraint": "A reconciliation whose signal aborted performs the guarded work zero times.",
        "failureRationale": "The abort is the only thing standing between a completed deletion on the old connection and a selection rewrite on the new one, and the rendered state reports neither."
      }
    },
    {
      "id": "history-retention-panel-defers-the-retention-client",
      "sharedCoverageGroup": "history-retention-preview-defers-until-the-operator-asks",
      "domain": "Recipe Console History retention panel acquisition",
      "owner": "Rallar Black Box maintainers",
      "summary": "Rendering the History retention panel acquires no retention client; the client appears only when the operator presses Preview cleanup. Executable assertion: “previews, confirms, refreshes, then selectively replaces URL state”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#previews, confirms, refreshes, then selectively replaces URL state",
      "coverageRelation": "The test renders the History workspace with an authorized capability and reads the panel before any click. The panel renders the same whether or not its client was already acquired, so the unmade load is the only witness.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "ControlLazyCapability.load for the retention API, which dynamically imports the retention client chunk and binds an authorized control endpoint",
        "observableEffect": "A load fetches the retention feature chunk over the network and binds an authorized, deletion-capable endpoint to the live control connection.",
        "requiredConstraint": "Rendering the History workspace performs zero retention loads.",
        "failureRationale": "Opening History would then fetch the cleanup chunk and bind a deletion-capable endpoint for every operator who came only to read run history."
      }
    },
    {
      "id": "history-retention-preview-click-loads-the-client-once",
      "sharedCoverageGroup": "history-retention-preview-defers-until-the-operator-asks",
      "domain": "Recipe Console History retention preview",
      "owner": "Rallar Black Box maintainers",
      "summary": "Pressing Preview cleanup acquires the retention client exactly once for the connection. Executable assertion: “previews, confirms, refreshes, then selectively replaces URL state”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#previews, confirms, refreshes, then selectively replaces URL state",
      "coverageRelation": "The test clicks Preview cleanup and reads the rendered candidate rows and the absent plan token. Those rows render from any successful plan, so the load count is the only witness that one click acquired one client.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "ControlLazyCapability.load for the retention API, which dynamically imports the retention client chunk and binds an authorized control endpoint",
        "observableEffect": "Each load fetches the retention chunk and binds a fresh authorized endpoint, and the capability caches that result for the connection’s lifetime.",
        "requiredConstraint": "One Preview cleanup click performs exactly one load.",
        "failureRationale": "A second load binds a second authorized endpoint, and the plan the operator confirms then belongs to whichever client answered last."
      }
    },
    {
      "id": "history-retention-unauthorized-operator-loads-nothing",
      "domain": "Recipe Console History retention authorization gate",
      "owner": "Rallar Black Box maintainers",
      "summary": "While operator authorization is required, the disabled Preview cleanup control acquires no retention client. Executable assertion: “keeps preview unavailable when operator authorization is required”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#keeps preview unavailable when operator authorization is required",
      "coverageRelation": "The test renders with authorization required and reads the operator sentence and the disabled control. A disabled button renders identically whether or not the client behind it was acquired, so the unmade load is the only witness.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "ControlLazyCapability.load for the retention API, which dynamically imports the retention client chunk and binds an authorized control endpoint",
        "observableEffect": "A load fetches the retention chunk and binds an authorized control endpoint capable of the destructive confirmation.",
        "requiredConstraint": "An operator without authorization causes zero retention loads.",
        "failureRationale": "Binding a deletion-capable endpoint before the operator is authorized moves the authorization decision behind a disabled control, where nothing rendered would report it."
      }
    },
    {
      "id": "history-retention-untrusted-credentials-load-nothing",
      "domain": "Recipe Console History retention credential provenance gate",
      "owner": "Rallar Black Box maintainers",
      "summary": "When control credential provenance is withheld, the retention panel withholds cleanup and acquires no retention client. Executable assertion: “withholds cleanup when credential provenance is unsafe”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#withholds cleanup when credential provenance is unsafe",
      "coverageRelation": "The test renders with a credential-trust error and reads the withheld sentence and the disabled control. That rendering is identical whether or not the client was acquired, so the unmade load is the only witness.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "ControlLazyCapability.load for the retention API, which dynamically imports the retention client chunk and binds an authorized control endpoint",
        "observableEffect": "A load binds an authorized control endpoint using the very credentials the query reported as untrusted.",
        "requiredConstraint": "A withheld credential provenance causes zero retention loads.",
        "failureRationale": "Loading would spend the untrusted credential on a deletion-capable endpoint, which is exactly the use the withheld provenance exists to prevent."
      }
    },
    {
      "id": "history-retention-drifted-dialog-deletes-once",
      "domain": "Recipe Console History retention drift dialog",
      "owner": "Rallar Black Box maintainers",
      "summary": "A drifted deletion closes the confirm dialog, restores Preview focus and leaves exactly one delete attempt behind. Executable assertion: “closes a drifted dialog, restores Preview focus, and requires a new preview”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#closes a drifted dialog, restores Preview focus, and requires a new preview",
      "coverageRelation": "The test drives Preview, Review and Delete previewed runs into a 409, then reads the drift sentence, the closed dialog, the stale-preview label and the restored focus. None of those distinguishes one attempt from a silent retry, so the count is the only witness.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "RecipeConsoleControlRetentionApi.confirm, the destructive retention deletion request",
        "observableEffect": "Each confirm asks the control server to delete the runs named by the plan token.",
        "requiredConstraint": "The Delete previewed runs control sends exactly one delete, and the drift that follows adds none.",
        "failureRationale": "A retry after drift deletes whatever the server now counts as excess rather than the run set the operator reviewed, and the panel would show the same drift sentence either way."
      }
    },
    {
      "id": "history-retention-confirmed-cleanup-refreshes-once",
      "sharedCoverageGroup": "history-retention-reconciliation-under-context-change",
      "domain": "Recipe Console History post-cleanup refresh",
      "owner": "Rallar Black Box maintainers",
      "summary": "A confirmed cleanup re-reads the control snapshot exactly once before it reconciles the URL. Executable assertion: “suppresses URL reconciliation when context changes during refresh”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#suppresses URL reconciliation when context changes during refresh",
      "coverageRelation": "The test waits for the refresh to be in flight so it can change the control context underneath it. The refresh is held open by the test, and that single call is what places the reconciliation inside the window the assertion is about.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "The History workspace’s refreshAfterCurrent, which re-reads the control-server snapshot after the current poll",
        "observableEffect": "Each call re-reads the control snapshot and holds the URL reconciliation until it resolves.",
        "requiredConstraint": "One confirmed cleanup refreshes the snapshot exactly once, with the reconciliation waiting behind that one refresh.",
        "failureRationale": "Without a single in-flight refresh there is no window in which to change the context, and a second refresh would give the suppressed reconciliation another chance to run."
      }
    },
    {
      "id": "history-retention-context-change-during-refresh-rewrites-no-url",
      "sharedCoverageGroup": "history-retention-reconciliation-under-context-change",
      "domain": "Recipe Console History URL reconciliation fencing",
      "owner": "Rallar Black Box maintainers",
      "summary": "A control context change while the post-cleanup refresh is in flight suppresses the URL reconciliation entirely. Executable assertion: “suppresses URL reconciliation when context changes during refresh”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#suppresses URL reconciliation when context changes during refresh",
      "coverageRelation": "The test replaces the capability during the held refresh, releases it and reads the stale-preview label and the closed dialog. Neither reports the address bar, so the unmade replace is the only witness.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "The History workspace’s replace, which rewrites the console’s URL state in place",
        "observableEffect": "A replace removes the deleted run, distributed run, agent, recipe and command selection from the operator’s address bar.",
        "requiredConstraint": "A context change during the refresh leaves the URL untouched: zero replaces.",
        "failureRationale": "The patch was computed from run ids deleted on the previous control connection; applying it would clear the new connection’s selection for runs it never had."
      }
    },
    {
      "id": "history-retention-authorization-loss-refreshes-once",
      "sharedCoverageGroup": "history-retention-reconciliation-under-authorization-loss",
      "domain": "Recipe Console History post-cleanup refresh under authorization loss",
      "owner": "Rallar Black Box maintainers",
      "summary": "A confirmed cleanup re-reads the control snapshot exactly once even when operator authorization is withdrawn while the same retention client stays in place. Executable assertion: “aborts reconciliation when authorization is lost without API replacement”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#aborts reconciliation when authorization is lost without API replacement",
      "coverageRelation": "The test waits for the single refresh so it can withdraw operator authorization while that refresh is still in flight. The held call is what defines the window the rest of the assertion depends on.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "The History workspace’s refreshAfterCurrent, which re-reads the control-server snapshot after the current poll",
        "observableEffect": "Each call re-reads the control snapshot and holds the URL reconciliation until it resolves.",
        "requiredConstraint": "One confirmed cleanup refreshes exactly once, with the reconciliation waiting behind it.",
        "failureRationale": "Without one in-flight refresh the authorization loss cannot be placed inside the reconciliation window, and a second refresh would give the suppressed reconciliation another chance to run."
      }
    },
    {
      "id": "history-retention-authorization-loss-rewrites-no-url",
      "sharedCoverageGroup": "history-retention-reconciliation-under-authorization-loss",
      "domain": "Recipe Console History URL reconciliation under authorization loss",
      "owner": "Rallar Black Box maintainers",
      "summary": "Losing operator authorization during the post-cleanup refresh suppresses the URL reconciliation even though the retention client is unchanged. Executable assertion: “aborts reconciliation when authorization is lost without API replacement”.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#aborts reconciliation when authorization is lost without API replacement",
      "coverageRelation": "The test withdraws authorization during the held refresh, releases it and reads the authorization sentence and the closed dialog. Neither reports the address bar, so the unmade replace is the only witness.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "The History workspace’s replace, which rewrites the console’s URL state in place",
        "observableEffect": "A replace clears the deleted run selection from the operator’s address bar.",
        "requiredConstraint": "An authorization loss during the refresh leaves the URL untouched: zero replaces.",
        "failureRationale": "The reconciliation would rewrite the operator’s selection at the moment the console can no longer read the runs behind it, leaving an address bar that matches nothing the operator can see."
      }
    },
    {
      "id": "browser-session-shared-transport-acquisition",
      "domain": "Browser shared session transport",
      "owner": "Rallar browser maintainers",
      "summary": "Two public facades sharing an active auth session acquire one underlying transport while both message handles remain observable.",
      "semanticCoverage": "packages/tests/shared-web/composition/browser-runtime-construction.test.ts#shares one bounded session observation owner across facades",
      "coverageRelation": "Both facades send through the production composition; the initializer captures the settlement port and acknowledgements independently settle each handle.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "initialiseMiddleware transport, queue and heartbeat acquisition",
        "observableEffect": "Opening middleware acquires the browser session transport and starts its owned resources.",
        "requiredConstraint": "One active browser session acquires the middleware once even when two facades send.",
        "failureRationale": "Both handles could settle even if a second facade leaked duplicate transports, queues or heartbeats; handle state alone cannot prove shared resource acquisition."
      }
    },
    {
      "id": "browser-invalid-fallback-no-admission",
      "domain": "Typed message audience validation",
      "owner": "Rallar browser maintainers",
      "summary": "An unsupported all-scope fallback with membership fencing rejects before either carrier can publish.",
      "semanticCoverage": "packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts#reports every unsupported fallback constraint before connecting or queueing",
      "coverageRelation": "The public room channel rejects both independently specified validation issues and remains disconnected; both carrier admission ports are observed.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebSocketQueueBox and WebRtcRxStreamerService enqueueOutboxIfAbsent carrier admission ports",
        "observableEffect": "Carrier admission can retain or publish a message to its resolved audience.",
        "requiredConstraint": "Unsupported fallback scope or membership fencing must produce no WS or RTC admission.",
        "failureRationale": "An error response can follow an illicit send; validation errors and disconnected facade state alone do not prove absence of publication."
      }
    },
    {
      "id": "browser-explicit-ws-strategy-excludes-rtc",
      "domain": "Typed message carrier selection",
      "owner": "Rallar browser maintainers",
      "summary": "A typed channel send explicitly selecting WS publishes the requested WS envelope without RTC admission.",
      "semanticCoverage": "packages/tests/shared-web/messages/browser-typed-message-channels.test.ts#uses WS only for typed channel send when strategy is ws",
      "coverageRelation": "The public channel selects WS; the test checks admitted lifecycle state and captured message identity, route, payload and broadcast scope, then observes the excluded RTC port.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebRtcRxStreamerService.enqueueOutboxIfAbsent",
        "observableEffect": "An RTC admission creates an additional carrier publication attempt.",
        "requiredConstraint": "An explicit WS-only send must never enter RTC admission.",
        "failureRationale": "A correct WS envelope and queued handle can coexist with an erroneous extra RTC send; only exclusion of that carrier proves the selected strategy."
      }
    },
    {
      "id": "authoritative-group-cache-refresh-no-topology-work",
      "domain": "Browser authoritative room cache freshness",
      "owner": "Rallar shared-web maintainers",
      "summary": "An exact current authoritative observation renews local cache age without scheduling topology mutation or reconnection.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/authoritative-group-freshness.test.ts#emits only truthful Refreshed and preserves content without downstream topology work",
      "coverageRelation": "The test adopts an equal full snapshot through the real authoritative adoption and observed cache lifecycle, checks a truthful Refreshed event and unchanged content, and observes the group-manager topology ports.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebRtcGroupManager.acceptGroupUpdate and WebRtcGroupManager.ensureAllGroupsConnected",
        "observableEffect": "acceptGroupUpdate updates a group and requests reconciliation; ensureAllGroupsConnected independently requests reconciliation of connections.",
        "requiredConstraint": "A cache-age-only authoritative refresh must invoke neither topology-update nor connection-reconciliation port.",
        "failureRationale": "An unchanged snapshot and a Refreshed event do not exclude unnecessary reconciliation or reconnection work. These port absences protect cache-only renewal from triggering topology work."
      }
    },
    {
      "id": "state-write-evidence-invalid-input-no-sql",
      "domain": "API-v1 state-write evidence input validation",
      "owner": "Rallar shared-test maintainers",
      "summary": "Malformed raw evidence input is rejected before any query reaches the external database port.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-write-evidence-source.test.ts#keeps raw JSON evidence inputs untrusted until the SQL validator runs",
      "coverageRelation": "The test passes a raw JSON object with an empty match to the real SQL evidence collector, verifies its validation error, and observes that the SQL query port receives no invocation.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "ApiV1StateWriteEvidenceSql database query callable",
        "observableEffect": "A query invocation sends database work through the evidence collector's owned SQL port.",
        "requiredConstraint": "An invalid empty match must reject before invoking the SQL query port.",
        "failureRationale": "The final validation error alone permits an implementation to issue unintended database work before rejecting the raw input."
      }
    }
  ],
  "entries": [
    {
      "id": "test-structure-coupling-0ce4af5c7c62c033",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the accepted workload catalog so maintained diagnostics cannot silently become accepted baseline evidence producers.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    },
    {
      "id": "test-structure-coupling-0fae9273cf2213d7",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Keeps the published listener benchmark timing boundary explicit across construction, connection, and reset instead of implying a narrower interval.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-dfef48ce28b3a297",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-window-ui.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-window-pending-pager-issues-no-second-request",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade window request is the only witness that a disabled pager control refused the click instead of reissuing the same cursor under the pending request.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-window-ui.test.ts#keeps pending controls mounted, blocks repeat cursor requests, and reports failure"
    },
    {
      "id": "test-structure-coupling-13609ed5d3f1823f",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-window-ui.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-window-failure-retry-searches-exactly-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The controller is a test double, so the single search call is the only witness that the failure banner's retry control reissued the query once rather than never or twice.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-window-ui.test.ts#keeps pending controls mounted, blocks repeat cursor requests, and reports failure"
    },
    {
      "id": "test-structure-coupling-10af8255a405b3b0",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-unavailable-clipboard-mints-no-links",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade prepare call is the only witness that an unavailable clipboard stops the copy before the control server mints short-lived launch credentials.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#names an unavailable clipboard instead of minting links it cannot copy"
    },
{
      "id": "test-structure-coupling-2156428ddf7703a1",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the package navigation map to name the actual diagnostics dependency factory used during executable setup.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-31ba64718fc4f2d5",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the durable package map to expose every accepted-baseline command in the exact ten-command grammar owned by the command parser.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-a5d5fdeb1214727a",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the package README that developers use to find each shipped RTC benchmark executable and requires one unambiguous row for every approved entrypoint.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-a7aa023b12bd5a52",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires each named maintained diagnostic entrypoint to remain in the package Deno check command while remaining absent from accepted evidence.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    },
    {
      "id": "test-structure-coupling-d3a4973be65d4f48",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the data-channel catalog row to identify sendJson as the measured public production operation rather than an internal or nonexistent send surface.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-df5e57893203b500",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the package command contract that owns Deno checking for every maintained diagnostic entrypoint.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    },
    {
      "id": "test-structure-coupling-f9dbd26ba9313d16",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Rejects the former nonexistent diagnostics setup name so the published executable trace cannot direct developers to an owner that does not exist.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-344bf408f0d98067",
      "path": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-diagnostics-network-polling",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The second-call assertion proves the enabled four-second interval requests one further refresh.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts#stops diagnostics polling when the arena network is disabled"
    },
    {
      "id": "test-structure-coupling-4433546794accd4d",
      "path": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-diagnostics-network-polling",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The unchanged count after disabling the network proves the interval no longer crosses the refresh port.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts#stops diagnostics polling when the arena network is disabled"
    },
    {
      "id": "test-structure-coupling-9bc4de74853a4078",
      "path": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-diagnostics-network-polling",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The first-call assertion proves opening the mounted drawer starts one diagnostic refresh.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts#stops diagnostics polling when the arena network is disabled"
    },
    {
      "id": "test-structure-coupling-d7cb62e655648f54",
      "path": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-clipboard-json-content",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "This inspects the JSON payload at the browser clipboard writeText port; it does not constrain invocation count or order. Parsed directorAttempt proves copied content matches the visible diagnostic state.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts#reports a rejected clipboard write and releases a pending copy when the drawer closes"
    },
    {
      "id": "test-structure-coupling-69913dd14575b229",
      "path": "packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-report-appointment-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The unused appointment port proves the stale report is fenced before any authority mutation, which final UI state alone cannot establish.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts#does not appoint after an old capability report resolves across logout"
    },
    {
      "id": "test-structure-coupling-e11609c733133cce",
      "path": "packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-replaced-report-appointment-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The unused appointment port proves the stale report is fenced before any authority mutation, which final UI state alone cannot establish.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts#fences replaced reports and releases delivery listeners on replacement and network end"
    },
    {
      "id": "test-structure-coupling-03187bba1898faa6",
      "path": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-coalescing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The post-deadline two-publication count directly proves that the first revision publishes immediately and the latest publishes reliably after the interval without the superseded revision.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#coalesces rapid reliable director snapshots to the latest revision"
    },
    {
      "id": "test-structure-coupling-1f960b77a6335777",
      "path": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-coalescing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The delayed publication reliable-options assertion directly proves that the first revision publishes immediately and the latest publishes reliably after the interval without the superseded revision.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#coalesces rapid reliable director snapshots to the latest revision"
    },
    {
      "id": "test-structure-coupling-46026812f3ff7fcd",
      "path": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-rallar-game-presence-boundary",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw motion-lane send absence assertion directly proves that raw realtime motion send remains unused for game-owned presence.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#still publishes the local director pose through Rallar Game presence"
    },
    {
      "id": "test-structure-coupling-a11fa3d3637bdb5c",
      "path": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-deduplication",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The single-publication count directly proves that a repeated revision produces one reliable publication.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#deduplicates reliable director snapshots by revision"
    },
    {
      "id": "test-structure-coupling-a564ee6e182295f3",
      "path": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-snapshot-generation-cancellation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The unchanged count after reset and timer expiry directly proves that no queued second snapshot publishes after the generation resets.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#cancels pending reliable director snapshots when the network generation resets"
    },
    {
      "id": "test-structure-coupling-ccebff9c1bfa7b04",
      "path": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-coalescing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The unchanged pre-deadline publication count directly proves that the first revision publishes immediately and the latest publishes reliably after the interval without the superseded revision.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#coalesces rapid reliable director snapshots to the latest revision"
    },
    {
      "id": "test-structure-coupling-cd943707d2b8f889",
      "path": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-snapshot-generation-cancellation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The initial one-publication baseline directly proves that no queued second snapshot publishes after the generation resets.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#cancels pending reliable director snapshots when the network generation resets"
    },
    {
      "id": "test-structure-coupling-feb107391cef56d5",
      "path": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-coalescing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The immediate single-publication count directly proves that the first revision publishes immediately and the latest publishes reliably after the interval without the superseded revision.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts#coalesces rapid reliable director snapshots to the latest revision"
    },
    {
      "id": "test-structure-coupling-8fb3ab417bf784ac",
      "path": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-browser-ai-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-browser-ai-explicit-provider-selection",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The mock-provider factory absence assertion directly proves that the mock-provider factory remains unused after a WebLLM generation failure.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-browser-ai-provider.test.ts#keeps WebLLM generation failures visible without switching providers"
    },
    {
      "id": "test-structure-coupling-7bd8747ffd7352aa",
      "path": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-webllm-engine-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The two-request completion count directly proves that one engine is created and one completion runs per request.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts#loads one engine, requests JSON mode, and parses JSON results"
    },
    {
      "id": "test-structure-coupling-c8b54a0e15713a92",
      "path": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-webllm-engine-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The one-engine creation count directly proves that one engine is created and one completion runs per request.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts#loads one engine, requests JSON mode, and parses JSON results"
    },
    {
      "id": "test-structure-coupling-055c1e0ac2372b82",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The snapshot-publication absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-08fc7607c4037299",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The snapshot-publication absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-13076aa50d1ea217",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-manual-logout-network-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The exactly-one pending logout assertion directly proves that one logout is in flight and match networking stops before it settles.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#disables network immediately while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-3da6902b742cfa96",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw realtime room-port absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-49bd5bca406b4f70",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-intent absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-4bae375e2e93de59",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-diagnostics-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The room-lane wait absence assertion directly proves that all diagnostics transport ports remain unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout"
    },
    {
      "id": "test-structure-coupling-4f361679b46fee6d",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-diagnostics-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The API configuration read absence assertion directly proves that all diagnostics transport ports remain unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout"
    },
    {
      "id": "test-structure-coupling-56ec10185434a41c",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw realtime JSON-send absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-69f6c6dd1aaada67",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-create-and-switch-boundary",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The create-only port absence assertion directly proves that create-only remains unused during create-and-switch.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#creates a new arena by switching rooms and clearing stale remote players"
    },
    {
      "id": "test-structure-coupling-826d23c83753ba6a",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-input absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-83ad6138dc7baf89",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-presence absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-84f796b5286f7e78",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-expired-auth-transition",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The explicit-logout absence assertion directly proves that auth expiry does not invoke manual logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#clears arena state when auth expires outside manual logout"
    },
    {
      "id": "test-structure-coupling-9ffd9b32eeafe8a5",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-diagnostics-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The ICE candidate read absence assertion directly proves that all diagnostics transport ports remain unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout"
    },
    {
      "id": "test-structure-coupling-beb532cd752c825d",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-intent absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-c8cc6ca7cb852a53",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-manual-logout-rejection",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The exactly-once logout assertion directly proves that one user action invokes the logout port exactly once.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#catches manual logout rejection and leaves the arena signed out"
    },
    {
      "id": "test-structure-coupling-d1dd13ef89b32432",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-snapshot-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The signed-out snapshot-publication absence assertion directly proves that snapshot publication remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas snapshot publication after logout"
    },
    {
      "id": "test-structure-coupling-d3a4e20d284cf55d",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The event-publication absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-d67b0dbb22713a47",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-manual-logout-network-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The pre-settlement match-stop assertion directly proves that one logout is in flight and match networking stops before it settles.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#disables network immediately while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-d7e8e578c65502fe",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-presence absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-df15c9e78f685c1e",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-input absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-dfffce7877dc1c8e",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The event-publication absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-e4743fcd4966da2a",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw realtime room-port absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-edd22a871f21acc5",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw realtime JSON-send absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-f666b2b3080c639f",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-diagnostics-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The RTC diagnostics absence assertion directly proves that all diagnostics transport ports remain unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout"
    },
    {
      "id": "test-structure-coupling-51befb8881f0f6c4",
      "path": "packages/tests/helpers/source-analysis.ts",
      "kind": "ast-inspection",
      "contract": "source-analysis-test-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads source text at the shared helper boundary and immediately converts it into the normalized path-aware analysis model consumed by repository tests.",
      "semanticCoverage": "packages/tests/helpers/source-analysis.test.ts#normalizes TypeScript and TSX module syntax without exposing parser nodes"
    },
    {
      "id": "test-structure-coupling-3f87efb9ffdb8ee2",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--preserves-a-parallel-label-that-happens-to-equal-the-source-room",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Loads the manifest whose parallel label collides with its source room, letting the materializer prove labels and group identities are distinct fields.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#preserves a parallel label that happens to equal the source room"
    },
    {
      "id": "test-structure-coupling-4cd9007c14d9f597",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--prepares-the-supported-commit-once-before-running-the-serial-man",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the workflow job steps to establish that checkout preparation precedes, and is not repeated inside, each serial manifest execution.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#prepares the supported commit once before running the serial manifest matrix"
    },
    {
      "id": "test-structure-coupling-5a80cb6ccad17309",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--persists-control-server-snapshots-with-an-atomic-temp-file-renam",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Inspects the snapshot writer used in the executed control-server process and verifies persistence crosses the temp-file rename boundary atomically.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#persists control-server snapshots with an atomic temp-file rename"
    },
    {
      "id": "test-structure-coupling-8bee8864cd2dc720",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--keeps-playwright-packages-aligned-past-the-node-24-browser-insta",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the workflow package-install steps and verifies both Playwright packages advance together beyond the known Node 24 hang combination.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#keeps Playwright packages aligned past the Node 24 browser-install hang regression"
    },
    {
      "id": "test-structure-coupling-9a1ba98a66c78c07",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--materializes-a-deterministic-isolated-group-throughout-executabl",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Captures the source manifest before group materialization so the assertion can compare the generated execution copy without losing its immutable baseline.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data"
    },
    {
      "id": "test-structure-coupling-9d8dac3f600fee05",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--repairs-known-deno-lockfile-drift-before-the-controlled-rollout-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the rollout workflow order to verify the narrow lockfile repair occurs before the dirty-checkout guard evaluates operator changes.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#repairs known Deno lockfile drift before the controlled rollout dirty checkout guard"
    },
    {
      "id": "test-structure-coupling-d25b56efbb8aaefe",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--materializes-a-deterministic-isolated-group-throughout-executabl",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Re-reads the source manifest after execution and proves isolation was materialized in a copy rather than persisted back into the operator input.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data"
    },
    {
      "id": "test-structure-coupling-de62f83dc45c42c1",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--rejects-an-executable-command-scoped-outside-the-source-manifest",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the source manifest as the ownership baseline before injecting a command for another group; the validator must reject that executable scope escape.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#rejects an executable command scoped outside the source manifest group"
    },
    {
      "id": "test-structure-coupling-2fe7626b3fa35573",
      "path": "packages/tests/hetzner/spa-env-script.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-control-deno-runtime",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the deployed control-server Deno config that both cache warming and systemd execute, preventing the host script from validating a different runtime graph.",
      "semanticCoverage": "packages/tests/hetzner/spa-env-script.test.ts#uses the control-server Deno config for Hetzner cache warming and systemd start"
    },
    {
      "id": "test-structure-coupling-04d3f7b4b3e8b92c",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Opens the SPA distributed-recipes integration module, the single consumer in which a local monitor fork could otherwise hide.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-571d1d4deeab6f48",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-server-import-direction",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Reads each enumerated control-server module so the assertion covers the whole server import surface, including files added to the approved inventory.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server"
    },
    {
      "id": "test-structure-coupling-ac0caf39b66ad4f6",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "production-source-read",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Forbids a local deriveDistributedRunMonitor declaration, which is the primary duplicate implementation this boundary is intended to prevent.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-ba268a86d23e8e22",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Separately excludes a local deriveRunVerdictView declaration because verdict policy is another independently duplicable part of the same shared owner.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-c409a8b44247c577",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Requires the shared-test distributed-run-monitor import, establishing delegation to the package owner rather than copied analysis logic.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-cdb9ea9a75b32d90",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Separately excludes a local deriveDistributedRunAnalysisReport declaration so report derivation cannot fork while monitor derivation remains shared.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-d73a5e318b1dd940",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "production-source-read",
      "contract": "control-protocol-server-import-direction",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Checks the current server module against the forbidden SPA protocol specifier; this is the negative dependency edge that would expose reversed ownership.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server"
    },
    {
      "id": "test-structure-coupling-0c9a2607af0d65b9",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The one cancel proves the 404 body was disposed of exactly once, and the assertion sits beside the proof that the wait did not await that cancellation.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-0d24c8cc95a7addd",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-no-polling-after-deadline-or-shutdown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent sleep proves the retryable status did not restart the poll loop after the deadline had won.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#hard-times out a never-settling registration fetch with detailed state"
    },
    {
      "id": "test-structure-coupling-12a33fb22185bf7f",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-no-polling-after-deadline-or-shutdown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent sleep proves shutdown ended the loop immediately instead of costing the worker another poll interval.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#hard-times out a never-settling registration fetch with detailed state"
    },
    {
      "id": "test-structure-coupling-1d61181008c02174",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-no-polling-after-deadline-or-shutdown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single fetch proves the shutdown stopped further polling, so the late rejection belongs to the one request already in flight.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#hard-times out a never-settling registration fetch with detailed state"
    },
    {
      "id": "test-structure-coupling-243cac8e8238a3fa",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single json read proves the wait read the body once before the abort, so the cancel that follows is disposal rather than a second read.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-32b5b21ab3a55a05",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The one cancel is the only witness that an aborted JSON read still disposes of the response body it opened.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-3d8da3b9501414c2",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The one cancel proves the rejected 401 body was disposed of while the 401 still reached the caller.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-3f737d5b0125cee4",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The one cancel proves the late 200 body was disposed of rather than left open once the deadline had won.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-410ed2379e883103",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The one cancel proves the late 401 body was disposed of once the deadline had won.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-44d1f427a9662bd8",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single cancel is the only witness that the aborted fetch disposed of the body it abandoned; the rejection the caller sees is identical without it.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-62c5d3d72bdcf2e4",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent json read proves the wait rejected the late response instead of reading a body it had already given up on.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-707b0044e59f7b2a",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The one cancel proves the retryable response body was disposed of before the retry, without the retry waiting on it.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-904dfdf8ebc63b7a",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-abandoned-response-body-disposal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The one cancel proves the late 503 body was disposed of rather than left open for a retry that will not happen.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#observes late response disposal failures after an aborted fetch"
    },
    {
      "id": "test-structure-coupling-a0d2ab559e00440f",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-no-polling-after-deadline-or-shutdown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent sleep proves the hard timeout stopped the loop rather than letting it wait out one more poll interval past the deadline.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#hard-times out a never-settling registration fetch with detailed state"
    },
    {
      "id": "test-structure-coupling-c291b22b7ec6d07e",
      "path": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "headless-worker-no-polling-after-deadline-or-shutdown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent sleep proves the deadline, not a further poll, decided the outcome once a connected snapshot arrived too late.",
      "semanticCoverage": "packages/tests/rallar-black-box/headless-worker-runtime.test.ts#hard-times out a never-settling registration fetch with detailed state"
    },
    {
      "id": "test-structure-coupling-8657bc752452053f",
      "path": "packages/tests/rallar-black-box/legacy-shell-models.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "legacy-agent-session-ticket-consume-dedupe",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The post-settlement request must address the new API base; the resolved session is identical for either base.",
      "semanticCoverage": "packages/tests/rallar-black-box/legacy-shell-models.test.ts#deduplicates an in-flight consume and clears the cache after settlement"
    },
    {
      "id": "test-structure-coupling-877d74c2a30e2cf0",
      "path": "packages/tests/rallar-black-box/legacy-shell-models.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "legacy-agent-session-ticket-consume-dedupe",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The second recorded request after settlement proves the in-flight cache cleared instead of returning the settled consume again.",
      "semanticCoverage": "packages/tests/rallar-black-box/legacy-shell-models.test.ts#deduplicates an in-flight consume and clears the cache after settlement"
    },
    {
      "id": "test-structure-coupling-c9b8103d8663d2c1",
      "path": "packages/tests/rallar-black-box/legacy-shell-models.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "legacy-agent-session-ticket-consume-retry-identity",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Both attempts must reach the consume port for the recorded request ids to show that the retry reused one idempotency key.",
      "semanticCoverage": "packages/tests/rallar-black-box/legacy-shell-models.test.ts#reuses the request ID after a rejected consume response"
    },
    {
      "id": "test-structure-coupling-dab0ce1b761d4522",
      "path": "packages/tests/rallar-black-box/legacy-shell-models.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "legacy-agent-session-ticket-consume-dedupe",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single recorded request while the duplicate consume is pending is the only witness that the one-time ticket was spent once.",
      "semanticCoverage": "packages/tests/rallar-black-box/legacy-shell-models.test.ts#deduplicates an in-flight consume and clears the cache after settlement"
    },
    {
      "id": "test-structure-coupling-7f88b9c9cc3c1256",
      "path": "packages/tests/rallar-black-box/rallar-server-workbench.test.ts",
      "kind": "production-source-read",
      "contract": "workbench-collection-served-paths",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the shipped OpenAPI document so a workbench collection cannot ship a path the API does not serve; the collections are operator inputs that no suite executes.",
      "semanticCoverage": "packages/tests/rallar-black-box/rallar-server-workbench.test.ts#addresses paths the API actually serves"
    },
    {
      "id": "test-structure-coupling-bc36af60755443e2",
      "path": "packages/tests/rallar-black-box/recipe-console-control-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-artifact-bytes-off-main-thread",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent text-reader call is the only witness that the success body was not parsed on the main thread.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-control-api.test.ts#returns bounded artifact response bytes without parsing the success body on the main thread"
    },
    {
      "id": "test-structure-coupling-dfba052fa9aef8b5",
      "path": "packages/tests/rallar-black-box/recipe-console-control-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-artifact-oversize-before-body",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent byte-reader call is the only witness that the declared oversize was rejected before the body was buffered.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-control-api.test.ts#rejects an oversized declared raw artifact response before reading its body"
    },
    {
      "id": "test-structure-coupling-3d3a6d9722822c3c",
      "path": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "execute-target-toggle-scope",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absence after the searchable run list is opened and the targets re-render with an ambiguous duplicate run identity proves that neither browsing runs nor surfacing the identity error selects a control run.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts#keeps 250 control runs searchable, rejects ambiguous identities, and windows 240 target rows"
    },
    {
      "id": "test-structure-coupling-829365009ddb3992",
      "path": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "execute-target-toggle-scope",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The exactly-once toggle with the clicked agent id is the only witness that the windowed row addressed its own agent.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts#keeps 250 control runs searchable, rejects ambiguous identities, and windows 240 target rows"
    },
    {
      "id": "test-structure-coupling-8f5cc2cf641fee5d",
      "path": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "execute-resolution-refresh-is-passive",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent toggle call is the only witness that an equal-row resolution refresh left the selected targets alone.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts#keeps late resolution evidence browseable across equal-row refreshed resolutions"
    },
    {
      "id": "test-structure-coupling-9eb8c8a8207c8e18",
      "path": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "execute-target-toggle-scope",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent control-run selection is what separates the target port from the run port; both lists render the same rows either way.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-execute-windowing.test.ts#keeps 250 control runs searchable, rejects ambiguous identities, and windows 240 target rows"
    },
    {
      "id": "test-structure-coupling-16192f23a2cd8719",
      "path": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-fleet-render-without-actions",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent URL replacement call is the only witness that render rewrote no URL state.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts#composes the lazy workspace from root query truth without actions during render"
    },
    {
      "id": "test-structure-coupling-4b8b3124eb09a084",
      "path": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-fleet-render-without-actions",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent navigation call is the only witness that render changed no view.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts#composes the lazy workspace from root query truth without actions during render"
    },
    {
      "id": "test-structure-coupling-be8e9be7545b0431",
      "path": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-fleet-deep-link-selection-label",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The last selection label call is the only witness of what the shell announces after the deep link restores.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts#restores the evidence inspector for a unique control-run-only deep link"
    },
    {
      "id": "test-structure-coupling-d71bef5d358ad80d",
      "path": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-fleet-render-without-actions",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent refresh call is the only witness that render issued no control request.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts#composes the lazy workspace from root query truth without actions during render"
    },
    {
      "id": "test-structure-coupling-e4677baec59139eb",
      "path": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-fleet-render-without-actions",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent inspection call is the only witness that render opened no inspection.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts#composes the lazy workspace from root query truth without actions during render"
    },
    {
      "id": "test-structure-coupling-0eacc2fff330f742",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-inspector-event-activation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The last-call payload is the only witness that the activated late row reported its own exact event identity rather than a windowed neighbour.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts#browses command evidence failure-first in 16-row windows and activates the exact late item"
    },
    {
      "id": "test-structure-coupling-53cd21b61916ac6c",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-inspector-recipe-choice-reset",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The last-call identity is the only witness that the reset browse reported the newly activated recipe instead of the earlier one.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts#browses 65 role-scoped recipe choices at 60 and resets for another recipe"
    },
    {
      "id": "test-structure-coupling-5c80414eee60d1fb",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-inspector-destination-patch",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The two-argument last call is the only witness that the windowed destination kept its agent, recipe, and command patch.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts#windows 46 correlated failure destinations at 40 and preserves destination patches"
    },
    {
      "id": "test-structure-coupling-117d6babbcf4dc73",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-monitor-derives-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single report derivation call shows the report was derived once and, with the next assertion, from the same monitor.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts#projects complete current truth and derives bounded monitor/report/verdict once"
    },
    {
      "id": "test-structure-coupling-21ddfa56d2936820",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-monitor-derives-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single monitor derivation call shows the snapshot's monitor was derived once rather than per projection.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts#projects complete current truth and derives bounded monitor/report/verdict once"
    },
    {
      "id": "test-structure-coupling-167716832af67062",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-closed-disclosure-mounts-nothing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent inspect call is the only witness that the retained cursor mounted no live rows behind the closed disclosure.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#keeps disclosure cursors alive while closed and mounts no closed rows"
    },
    {
      "id": "test-structure-coupling-68cb0729901733e9",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-budget-mount-is-passive",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The paired absent filter call is what makes the preceding absence a statement about mounting rather than about a surface that never filters.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#mounts exact agent, recipe, readiness, and diagnostic budgets with ordinal keys"
    },
    {
      "id": "test-structure-coupling-927b1c2a56427793",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-diagnostics-cursor-reset-is-local",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent filter call is what forbids the reset from re-raising the filter change that caused it.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#resets only the diagnostics cursor when its active filters change"
    },
    {
      "id": "test-structure-coupling-a513b4ba22809411",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-diagnostics-cursor-reset-is-local",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent inspect call is the only witness that the diagnostics cursor reset stayed inside the section.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#resets only the diagnostics cursor when its active filters change"
    },
    {
      "id": "test-structure-coupling-a92258a2a0020b1c",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-budget-mount-is-passive",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent inspect call is the only witness that mounting the exact budgets did not open evidence by itself.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#mounts exact agent, recipe, readiness, and diagnostic budgets with ordinal keys"
    },
    {
      "id": "test-structure-coupling-d41a32b802533ed6",
      "path": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "monitor-failure-window-action-authority",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent inspect call is the only witness that paging the failure ledger opened no evidence; the windowed rows and the selected row render identically either way.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-monitor-windowing.test.ts#windows failures without changing selection or action authority"
    },
    {
      "id": "test-structure-coupling-09b5088d5dc1c6ea",
      "path": "packages/tests/rallar-black-box/recipe-console-tune-facade-authority.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-tune-validates-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "An unchanged count after deriving the source model shows the source model reused the catalog's validations.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-tune-facade-authority.test.ts#validates two selected control manifests and one retained facade exactly once"
    },
    {
      "id": "test-structure-coupling-67402626a48f5c2b",
      "path": "packages/tests/rallar-black-box/recipe-console-tune-facade-authority.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "recipe-console-tune-validates-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Three validation calls after building the catalog show each selected manifest and the retained facade were validated once.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-tune-facade-authority.test.ts#validates two selected control manifests and one retained facade exactly once"
    },
    {
      "id": "test-structure-coupling-f75b3422e50b6549",
      "path": "packages/tests/repo/mutation-route-ownership/boundary/capabilities/mutation-boundary-capability-exports.ts",
      "kind": "ast-inspection",
      "contract": "mutation-capability-export-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the shared-server barrel as the starting export graph, proving mutable capabilities remain traceable through the package public surface.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-boundary-traversal.test.ts#resolves mutable repository capabilities through the shared-server barrel"
    },
    {
      "id": "test-structure-coupling-78bf1368cf214172",
      "path": "packages/tests/repo/mutation-route-ownership/boundary/capabilities/mutation-boundary-capability-types.ts",
      "kind": "ast-inspection",
      "contract": "mutation-capability-type-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Inspects the canonical capability declarations so every inventoried mutation type can be joined to an actual registration and owner.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#maps all 56 entrypoints and 52 types to real registrations and owners"
    },
    {
      "id": "test-structure-coupling-70a87a1f1ea479cd",
      "path": "packages/tests/repo/mutation-route-ownership/boundary/mutation-boundary-analysis.ts",
      "kind": "exact-file-tree",
      "contract": "mutation-boundary-analysis-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the analyzer module itself to enumerate its exported syntax-aware entrypoint; consumers need this stable repository-test interface for every supported import form.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions"
    },
    {
      "id": "test-structure-coupling-0b58d02400285f7d",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds an unapproved argument at the family/private-owner handoff, catching widened construction that could conceal a second dependency source.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-227bc4333000c0c6",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-root-to-family-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds a root-owned value to a family invocation beyond its approved signature, testing the public composition tuple exactly.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra root-to-family argument"
    },
    {
      "id": "test-structure-coupling-29142dfe723974a7",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds an unapproved argument at the family/private-owner handoff, catching widened construction that could conceal a second dependency source.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-503ee8c186f47263",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-call-after-an-exported-root-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves a required family call below the root return; the occurrence proves syntactic presence is insufficient when the handoff is unreachable.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family call after an exported-root return"
    },
    {
      "id": "test-structure-coupling-56c975daa7221e46",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-wrong-root-to-family-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Substitutes a different resolved dependency at the root/family edge, testing provenance rather than just argument count.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects wrong root-to-family arguments"
    },
    {
      "id": "test-structure-coupling-755638c9349907da",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-canonical-family-name-rebound-to-a-different-imported-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the exported root before rebinding a canonical family identifier to another imported registrar, testing binding identity rather than call spelling.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a canonical family name rebound to a different imported family"
    },
    {
      "id": "test-structure-coupling-8a5a2d44c9bdcb60",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-uninventoryed-live-private-owner-and-route-in-a-famil",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Introduces a working private owner and route that are absent from the canonical inventory, ensuring live but unnamed mutation paths remain rejected.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an uninventoryed live private owner and route in a family"
    },
    {
      "id": "test-structure-coupling-8e81af49be0bf713",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes one private-owner argument from a family call, proving the boundary tracks the complete dependency tuple.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a missing family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-a953d677a6a4e37d",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-conditional-family-call-in-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Wraps one root family call in conditional control flow so construction is no longer guaranteed for every server startup.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a conditional family call in the exported root"
    },
    {
      "id": "test-structure-coupling-c7927fc092bac2c7",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-duplicate-family-call-in-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates one family registration in the exported root, exercising exactly-once construction rather than simple presence.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a duplicate family call in the exported root"
    },
    {
      "id": "test-structure-coupling-c91e07c5b311b838",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-reordered-root-to-family-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reorders the root arguments passed into one family registrar, preserving arity while violating ownership position.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects reordered root-to-family arguments"
    },
    {
      "id": "test-structure-coupling-cc694049a6a7199b",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes one private-owner argument from a family call, proving the boundary tracks the complete dependency tuple.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a missing family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-ce59f3bf64ba0cda",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-removed-from-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Deletes one canonical family invocation from the root fixture so the analyzer must report the missing owner family.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family removed from the exported root"
    },
    {
      "id": "test-structure-coupling-e0660606ecfc700b",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-reordered-family-to-private-owner-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Swaps two same-surface arguments at the private-owner call, a defect runtime smoke coverage may not distinguish until values diverge.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects reordered family-to-private-owner arguments"
    },
    {
      "id": "test-structure-coupling-ee9090eba9fc708c",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-call-before-authorization-exists",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves family construction ahead of authorization resolution, testing lifecycle order at the root composition boundary.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family call before authorization exists"
    },
    {
      "id": "test-structure-coupling-f2014ef62de286a9",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-different-app-passed-from-a-family-to-its-private-owne",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Mutates the family-to-owner call to pass a different app object, isolating instance continuity across the private ownership boundary.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a different app passed from a family to its private owner"
    },
    {
      "id": "test-structure-coupling-1345f6386ce086d7",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-exact-registration-after-an-unconditional-owner-retur",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves the exact route registration below an unconditional owner return, making it dead despite remaining in the source.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration after an unconditional owner return"
    },
    {
      "id": "test-structure-coupling-15bbcd32e40bf76d",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-removed-private-owner-call-from-the-exported-family-re",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes the family’s only private-owner call, directly testing the missing handoff that would leave routes unowned.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a removed private-owner call from the exported family registrar"
    },
    {
      "id": "test-structure-coupling-19d9204dd60e1bc8",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-later-command-object-spread",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Places an operation-changing spread after the approved command property, catching last-write-wins command drift.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a later command-object spread"
    },
    {
      "id": "test-structure-coupling-22dc15575e2a1e4c",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-private-owner-call-after-a-family-registrar-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Places private-owner installation after the family registrar returns, distinguishing reachable construction from token presence.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a private-owner call after a family-registrar return"
    },
    {
      "id": "test-structure-coupling-2587ac15f9ef4b7a",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-translator-guard-reachability",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the actual translator as executable analyzer input, preserving its real input-validation guards while testing an added statically unreachable throw. The test requires semantic route ownership to survive both inputs.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#accepts legitimate input rejection guards and an unreachable throwing branch"
    },
    {
      "id": "test-structure-coupling-2c9a715e8123397b",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-conditional-private-owner-call-in-the-exported-family-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Wraps the presence private-owner invocation in a condition, making the exported family registrar unable to guarantee owner installation.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a conditional private-owner call in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-2c9fc1d9749b84c8",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-a-literal-false-handler-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Compares the false-branch mutant with the original membership registrar so the assertion proves it tested unreachable rather than canonical source.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in a literal-false handler branch"
    },
    {
      "id": "test-structure-coupling-2fc0acf2d10f5d4e",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-second-exact-registration-in-the-exported-family-regis",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds another exact route registration to the same family, guarding against ambiguous competing handlers.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a second exact registration in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-4654f94f4e72070a",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-duplicate-private-owner-call-in-the-exported-family-re",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the private-owner setup inside the family registrar to enforce a single authoritative registration pass.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a duplicate private-owner call in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-5fc76df120a41839",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-exact-registration-inside-a-literal-false-owner-branc",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Nests exact registration under a literal-false owner branch, testing reachability of the public route installation.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration inside a literal-false owner branch"
    },
    {
      "id": "test-structure-coupling-66383e1835cf7c4e",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-duplicate-direct-operation-properties-in-the-command-obj",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the command operation key, making the final submitted operation ambiguous to a source-only first-match check.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct operation properties in the command object"
    },
    {
      "id": "test-structure-coupling-710b1ee889017354",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-computed-command-object-pro",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Overrides the command operation through a computed property, proving the audit evaluates the effective object value.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a computed command-object property"
    },
    {
      "id": "test-structure-coupling-72419b026769b6d0",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-after-the-handler-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Uses the canonical membership source as the comparison guard after relocating the correct handoff below the handler return.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only after the handler return"
    },
    {
      "id": "test-structure-coupling-b7043c39e11a7834",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-later-result-object-spr",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Appends a spread after the result type property so the effective AppInbox type can differ from the earlier literal.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a later result-object spread"
    },
    {
      "id": "test-structure-coupling-cc1a11e1ef4e42a1",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "symbol-assertion",
      "contract": "group-http-translator-guard-reachability",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Asserts only that the source mutation actually changed the analyzer input before the semantic acceptance assertion. This prevents a vacuous passing security regression; it does not require any private symbol spelling, file size, or order.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#accepts legitimate input rejection guards and an unreachable throwing branch"
    },
    {
      "id": "test-structure-coupling-d32ceadfc6f25479",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-computed-result-object-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds a computed result property that overwrites the approved AppInbox type, exercising final object semantics rather than the first visible key.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a computed result-object property"
    },
    {
      "id": "test-structure-coupling-d8cf0d32eadae715",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-an-uninvoked-nested-hand",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Confirms the nested-function mutant differs from the membership source before requiring rejection of the never-invoked handoff.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in an uninvoked nested handler function"
    },
    {
      "id": "test-structure-coupling-e341fd0365ad31ee",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-duplicate-direct-appinbox-type-properties-in-the-result-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the direct result type property, rejecting an object whose authoritative outcome depends on property order.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct AppInbox type properties in the result object"
    },
    {
      "id": "test-structure-coupling-f9b1590c42ac3d60",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-separately-bound-command-declared-after-its-submission",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves the separately bound command declaration below AppInbox submission, so the analyzer must reject use before authoritative construction.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a separately bound command declared after its submission"
    },
    {
      "id": "test-structure-coupling-52beab5de7d2f568",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Checks the second enqueue helper in the same module for its own named readonly input object.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-5ac40266b15fed40",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "ast-inspection",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Uses the parsed parameter nodes to distinguish one object contract from several positional parameters across both helpers.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-7c5aa61574c59a94",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Requires the authorised websocket helper to accept its first named readonly input object rather than a positional mutation tuple.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-9f3ecb4406f3911a",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads and parses that helper module so parameter declarations are evaluated as syntax, not brittle substring matches.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-c6c21e820b68b8eb",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-route-owner-crdt-reservation-materialization",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads the actual CRDT administrative mutation route as the mutated input to the real route validator, proving that disconnecting reservation construction from canonical AppInbox command materialization is rejected.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#rejects a CRDT reservation builder disconnected from command materialization"
    },
    {
      "id": "test-structure-coupling-339457838dde3151",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--binds-direct-client-registrations-to-their-live-types",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the direct client registration collection and resolves each handler to the live type it actually installs.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#binds direct client registrations to their live types"
    },
    {
      "id": "test-structure-coupling-87348c819775b5e0",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-missing-direct-group-registration",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Rebinds one group registration in the live owner and requires the audit to report that specific missing live route.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct group registration"
    },
    {
      "id": "test-structure-coupling-8daaa2a7222a3e9c",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-an-auth-registration-loop-replaced-with-an-empty-iterabl",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Replaces the auth registrar’s live collection with an empty iterable, testing that a syntactically valid loop cannot mask total registration loss.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects an auth registration loop replaced with an empty iterable"
    },
    {
      "id": "test-structure-coupling-ac677f8aefd31dcf",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-missing-direct-crdt-registration",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Rebinds one CRDT registration in the live owner and requires the audit to report the missing authoritative route.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct CRDT registration"
    },
    {
      "id": "test-structure-coupling-ec228fda47126f7e",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-missing-direct-topology-registration",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Rebinds one topology registration in the live owner and requires the audit to report the missing authoritative route.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct topology registration"
    },
    {
      "id": "test-structure-coupling-2e15caeb35eae4be",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--narrows-the-auth-registration-array-with-an-exact-equality-filte",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration loop that the test narrows before executing the analyzer and requiring an excluded auth command to lose its owner connection.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#narrows the auth registration array with an exact equality filter"
    },
    {
      "id": "test-structure-coupling-4f6cf14c31fc65a6",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--rejects-an-auth-registration-filter-that-is-always-false",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration expression that the test replaces with false before executing the analyzer and requiring all auth owner connections to disappear.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#rejects an auth registration filter that is always false"
    },
    {
      "id": "test-structure-coupling-560101002d0a8a81",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--evaluates-safe-logical-includes-and-identity-map-chains-exactly",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration loop that the test replaces with a transparent filter/map chain before executing exact owner-coverage assertions.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#evaluates safe logical includes and identity map chains exactly"
    },
    {
      "id": "test-structure-coupling-cbc161a2abbae5c6",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--fails-closed-for-an-opaque-registration-predicate",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration expression that the test makes opaque before executing the analyzer and requiring unknown registration semantics to fail closed.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#fails closed for an opaque registration predicate"
    },
    {
      "id": "test-structure-coupling-aae795e94c45930d",
      "path": "packages/tests/repo/package-dependency-direction.test.ts",
      "kind": "production-source-read",
      "contract": "package-dependency-direction-import-map",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar platform maintainers",
      "rationale": "Reads the api-v1 Deno import map so a browser or test-only mapping cannot be reintroduced ahead of any import that would use it.",
      "semanticCoverage": "packages/tests/repo/package-dependency-direction.test.ts#keeps the api-v1 Deno import map free of browser and test-only packages"
    },
    {
      "id": "test-structure-coupling-b7b21332a0365fdf",
      "path": "packages/tests/repo/repo-code-style-checker-integrity.test.ts",
      "kind": "production-source-read",
      "contract": "repo-style-checker-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads each enumerated Deno configuration and compares its fmt object with the canonical formatter object consumed by repository automation.",
      "semanticCoverage": "packages/tests/repo/repo-code-style-checker-integrity.test.ts#keeps TypeScript formatter settings aligned with the canonical baseline"
    },
    {
      "id": "test-structure-coupling-3b86bebc02da01e1",
      "path": "packages/tests/repo/tests-typecheck-gate.test.ts",
      "kind": "production-source-read",
      "contract": "tests-typecheck-debt-ledger-shape",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "The debt ledger is the ratchet's entire state. Its per-file counts, file count, and total must agree or the gate can be widened by editing one number, so the assertion has to read the recorded file rather than a value derived from it.",
      "semanticCoverage": "packages/tests/repo/tests-typecheck-gate.test.ts#keeps the recorded debt well-formed so the allowlist can only shrink"
    },
    {
      "id": "test-structure-coupling-75ff9356a64803f3",
      "path": "packages/tests/repo/tests-typecheck-gate.test.ts",
      "kind": "production-source-read",
      "contract": "tests-project-module-alias-parity",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "Alias parity is a property of the declaration files themselves. A resolved import proves one alias works in one runtime; only reading the tests project's own compiler configuration shows whether an alias was dropped from it, which is how @shared-test/* and @relic-hunters/* went missing before.",
      "semanticCoverage": "packages/tests/repo/tests-typecheck-gate.test.ts#declares every module alias the root project and the vitest runner declare"
    },
    {
      "id": "test-structure-coupling-425fdb5666c550b2",
      "path": "packages/tests/repo/typescript-7-boundaries.test.ts",
      "kind": "production-source-read",
      "contract": "typescript-seven-release-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads the shared-test manifest’s TypeScript check command and pairs it with the independently executed Deno workflow gate.",
      "semanticCoverage": "packages/tests/repo/typescript-7-boundaries.test.ts#keeps TypeScript and Deno checking as separate release gates"
    },
    {
      "id": "test-structure-coupling-009dd8ebc09f2356",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queue-pubsub-corrupt-identity-no-effects",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The parameterized test supplies three distinct corrupt identity cases at real canonical storage and checks the send port after the actual callback rejects. The exception alone would permit an effect emitted before rejection.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects a %s live identity fact before topology wake or delivery"
    },
    {
      "id": "test-structure-coupling-033b239694d0119f",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queue-pubsub-key-mismatch-no-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The repository port returns a row with a different resource ID; the real subscriber rejects and the external send port must remain unused.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#drops a durable key load whose identity differs from its envelope"
    },
    {
      "id": "test-structure-coupling-1ae3fa894e872390",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queuebox-pubsub-requeue-announces-external-write",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The requeued row is durable state either way; the wake count is the only witness that the owner which must claim it was actually told, and told once.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#announces a requeued row as an external write, because the requeue runs outside every runtime"
    },
    {
      "id": "test-structure-coupling-5875f278962ab3b1",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queue-pubsub-malformed-payload-no-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The test persists invalid payload bytes and invokes the valid notice through the subscriber; observing the sender distinguishes fail-before-send from send-then-throw.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects durable outbox work whose retained payload is not an AL message"
    },
    {
      "id": "test-structure-coupling-77c4477ec7d60e0b",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queue-pubsub-malformed-notice-no-storage",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The real subscription callback receives five invalid wire notices; the owned repository read port proves decoding rejects them before an external storage lookup, rather than merely returning no delivery after I/O.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects malformed and oversized notices before loading canonical storage"
    },
    {
      "id": "test-structure-coupling-a62cae58abfa7e98",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queue-pubsub-expired-identity-no-effects",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "This exact send assertion observes one independently outward-facing port after the held identity lookup advances the owned clock to the deadline. Both assertions share this same executable test, not a broad expiry registry contract.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#does not wake topology or send when loading the identity fact crosses the claimed deadline"
    },
    {
      "id": "test-structure-coupling-c0d53003a3b0c68a",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queue-pubsub-expired-identity-no-effects",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "This exact wake assertion observes one independently outward-facing port after the held identity lookup advances the owned clock to the deadline. Both assertions share this same executable test, not a broad expiry registry contract.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#does not wake topology or send when loading the identity fact crosses the claimed deadline"
    },
    {
      "id": "test-structure-coupling-eb1c72652d962c26",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queue-pubsub-missing-canonical-no-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The actual subscribed callback loads an absent canonical record; send absence proves no live effect can precede the reported missing-message error.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects missing live durable key-only messages with timing details"
    },
    {
      "id": "test-structure-coupling-ec46155ae3144e61",
      "path": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queue-pubsub-corrupt-identity-no-effects",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The parameterized test supplies three distinct corrupt identity cases at real canonical storage and checks the wake port after the actual callback rejects. The exception alone would permit an effect emitted before rejection.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts#rejects a %s live identity fact before topology wake or delivery"
    },
    {
      "id": "test-structure-coupling-3eb669e36287726d",
      "path": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-topology-replay-missing-page-no-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The test removes the final persisted page from a multi-page publication, calls the real handler and checks the owned send port remained empty. This differs from the existing missing-whole-reference test by catching streaming before complete-page validation.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#rejects a missing final durable page before sending any part of the publication"
    },
    {
      "id": "test-structure-coupling-5b530e925eb450cb",
      "path": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-topology-replay-single-live-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "This count observes the owned live sender during one handler invocation for the single-page fixture. It excludes omitted or duplicate submission within this successful attempt, without restricting multi-page publications or subsequent retries.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#delivers the exact immutable outbox message when the publication is current"
    },
    {
      "id": "test-structure-coupling-7694279a835a985d",
      "path": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-topology-replay-corruption-suppressed-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The send-absence assertion directly proves that corruption for a missing durable reference propagates without any live delivery.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#propagates corruption for a missing unexpired durable reference"
    },
    {
      "id": "test-structure-coupling-dcca6b53e9abe70a",
      "path": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-topology-replay-stop-after-page-failure",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The owned sender succeeds once then refuses the next page; exactly two calls together with send-failed proves no subsequent page escaped after refusal.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#does not advance the replay predecessor when a later page send fails"
    },
    {
      "id": "test-structure-coupling-f34d70bf4a6739c1",
      "path": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-topology-replay-suppressed-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The send-absence assertion directly proves that an expired entry resolves to a typed retention gap without any live delivery.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#returns a typed retention gap without attempting a send"
    },
    {
      "id": "test-structure-coupling-2d06815d8f4515a0",
      "path": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts",
      "kind": "production-source-read",
      "contract": "api-v1-medium-scale-routing",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the checked-in medium-scale recipe so each group poll’s service name can be compared with the API node that actually executes it.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts#names every group poll for the API node that executes it"
    },
    {
      "id": "test-structure-coupling-852b02185fa347a2",
      "path": "packages/tests/shared-test/api-v1-recipe-test-fixture.ts",
      "kind": "production-source-read",
      "contract": "api-v1-recipe-fixture-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Reads a caller-selected recipe path through the shared loader, providing the exact checked-in YAML/JSON fixture exercised by the topology semantics suite.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe"
    },
    {
      "id": "test-structure-coupling-910b6ad52b88c0f1",
      "path": "packages/tests/shared-test/api-v1-recipe-test-fixture.ts",
      "kind": "production-source-read",
      "contract": "api-v1-recipe-fixture-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Loads recipe-matrix.json through the same repository-root-aware fixture interface so catalog resolution is tested against the published matrix.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe"
    },
    {
      "id": "test-structure-coupling-a962763a7f5f7841",
      "path": "packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts",
      "kind": "production-source-read",
      "contract": "api-v1-runner-plan-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the shared-test package manifest and extracts the real managed Postgres commands whose process plans must contain all three API servers.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts#starts three API servers for every managed Postgres cluster command"
    },
    {
      "id": "test-structure-coupling-8a8f9cd497a4e870",
      "path": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts",
      "kind": "production-source-read",
      "contract": "state-read-convergence-recipe--proves-tertiary-scalar-and-causal-floors-with-revision-and-sourc",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Loads the convergence recipe section containing tertiary value, revision, and source-header assertions so those causal floors remain executable data.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#proves tertiary scalar and causal floors with revision and source headers"
    },
    {
      "id": "test-structure-coupling-9e59573d3730f889",
      "path": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts",
      "kind": "production-source-read",
      "contract": "state-read-convergence-recipe--defines-run-scoped-identifiers-as-interpolated-string-values",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the state-read convergence recipe and inspects its identifier values for run interpolation, rather than validating a copied fixture object.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#defines run-scoped identifiers as interpolated string values"
    },
    {
      "id": "test-structure-coupling-88e6a7ca47a24a20",
      "path": "packages/tests/shared-test/local-websocket-session.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "local-ws-alm-before-decode-resource-admission",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "No parser invocation proves rejection occurs before oversized text decoding, independently of the final rejection record.",
      "semanticCoverage": "packages/tests/shared-test/local-websocket-session.test.ts#rejects oversized ALM text before parsing and binary input without converting it"
    },
    {
      "id": "test-structure-coupling-ae4b804716187e8f",
      "path": "packages/tests/shared-test/local-websocket-session.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "local-ws-alm-before-decode-resource-admission",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "No Blob.text invocation preserves the text-only ALM wire boundary without materializing unsupported binary data.",
      "semanticCoverage": "packages/tests/shared-test/local-websocket-session.test.ts#rejects oversized ALM text before parsing and binary input without converting it"
    },
    {
      "id": "test-structure-coupling-5f2a49add4465c05",
      "path": "packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-reload-result-precedes-page-reload",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "Waiting for exactly one reload both anchors the ordering snapshot the port records and rejects a second reload; observing the persisted record alone would pass for an agent that reloaded twice.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts#sends the agent.reload result before reloading and persists the resume record"
    },
    {
      "id": "test-structure-coupling-7efeeba3a2a07e6e",
      "path": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-bridge-invalid-config-admission",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "The one allowed connect call distinguishes validation before side effects from a decoder that connects and then reports malformed input.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts#validates connection configuration before calling the native runtime"
    },
    {
      "id": "test-structure-coupling-50a2d1b9375dddda",
      "path": "packages/tests/shared-test/rallar-bb-test-control-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-control-client-final-report-upload-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "Counting the upload port proves disconnect uploads the final report once; reading the first recorded upload alone would also pass for a duplicated upload.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-client.test.ts#sends and uploads a redacted final report"
    },
    {
      "id": "test-structure-coupling-2650129d565f6673",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "kind": "exact-file-tree",
      "contract": "black-box-schema-public-interface--validates-recipe-fixtures-examples-flow-exports-manual-snippets-",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Enumerates every .recipe.json application example so newly published fixtures enter schema validation automatically.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets"
    },
    {
      "id": "test-structure-coupling-2e232a0de5fd337a",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--keeps-the-app-local-rtc-example-self-contained-for-headless-brow",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the shipped app-local RTC recipe and validates that exact example, including the fields a headless agent cannot obtain from app state.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps the app-local RTC example self-contained for headless browser agents"
    },
    {
      "id": "test-structure-coupling-408813ea83585094",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--keeps-schema-compatibility-guide-json-examples-validating",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Extracts JSON code blocks from the published compatibility guide and submits each example to the real recipe schema validator.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps schema compatibility guide JSON examples validating"
    },
    {
      "id": "test-structure-coupling-501b2d8c133e72a8",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--validates-recipe-fixtures-examples-flow-exports-manual-snippets-",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads each discovered application recipe example and validates its actual JSON against the published recipe schema.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets"
    },
    {
      "id": "test-structure-coupling-9260348f27fc2039",
      "path": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-ws-subscription-resource-ownership",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "One acquisition for the repeated WS subscription key prevents duplicate message listeners and duplicate delivery.",
      "semanticCoverage": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts#deduplicates and disposes WS subscriptions while fencing stale leases"
    },
    {
      "id": "test-structure-coupling-ab8f03afb1e7940b",
      "path": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-ws-subscription-resource-ownership",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "One invocation of the acquired unsubscribe disposer proves cleanup releases the shared subscription without repeating its side effect.",
      "semanticCoverage": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts#deduplicates and disposes WS subscriptions while fencing stale leases"
    },
    {
      "id": "test-structure-coupling-0f68df9519a8ce12",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--points-every-entry-at-a-catalog-recipe-file",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Opens the recipe file referenced by each matrix entry, proving catalog paths resolve to shipped executable fixtures.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#points every entry at a catalog recipe file"
    },
    {
      "id": "test-structure-coupling-9b899f9dd65c29c0",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--labels-every-api-v1-entry-with-an-honest-evidence-tier",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads each catalogued API-v1 recipe as shipped so its declared evidence tier is checked against the evidence source the runner will actually execute.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#labels every api-v1 entry with an honest evidence tier"
    },
    {
      "id": "test-structure-coupling-b31fa92c6a3d7af1",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "symbol-assertion",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Requires the recipe-matrix CLI source to name api-v1-black-box in its usage output, protecting the operator-visible profile selector.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage"
    },
    {
      "id": "test-structure-coupling-bed585f360e5499b",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the executable recipe-matrix CLI module whose advertised profile list is the published command-line interface under review; the module has no other surface that names its profiles.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage"
    },
    {
      "id": "test-structure-coupling-dae7a5d0729d2284",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "symbol-assertion",
      "contract": "recipe-matrix-public-interface--labels-every-api-v1-entry-with-an-honest-evidence-tier",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Uses the canonical state-write-evidence recipe operator as the exact Tier 2 discriminator; runtime success alone cannot distinguish a public-API assertion from direct SQL evidence.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#labels every api-v1 entry with an honest evidence tier"
    },
    {
      "id": "test-structure-coupling-fb9c9389cdd8634a",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the executable recipe-matrix CLI module whose help text is the published command-line interface under review.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage"
    },
    {
      "id": "test-structure-coupling-02a7c0341d254415",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--isolates-crdt-appinbox-evidence-by-command-prefixes",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the executable CRDT recipe and verifies that durable evidence is narrowed to the command prefixes owned by that recipe instead of a containing ID from another recipe.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#isolates CRDT AppInbox evidence by recipe command prefixes"
    },
    {
      "id": "test-structure-coupling-43c0aec131666232",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--uses-one-bounded-execution-identity-for-the-command-and-its-evid",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the bounded-execution recipe and compares the command identity with the evidence query identity in the same parsed fixture.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#uses one bounded execution identity for the command and its evidence"
    },
    {
      "id": "test-structure-coupling-59a8fed67f047251",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--observes-committed-socket-authorization-before-clustered-ws-effe",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Loads the socket-authorization recipe to verify its commit observation precedes the clustered websocket effect assertion.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#observes committed socket authorization before clustered WS effects"
    },
    {
      "id": "test-structure-coupling-6677491d43bcda4f",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--selects-auth-ticket-races-by-the-redacted-secret-and-exact-durab",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Parses the auth-ticket race recipe so candidate selection is tied to its redacted secret and computed durable digest together.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects auth ticket races by the redacted secret and exact durable digest"
    },
    {
      "id": "test-structure-coupling-95c57aee7329bbc5",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--forbids-literal-set-values-from-claiming-durable-state-write-evi",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads every state-write recipe selected by the evidence catalog and rejects literal SET payloads that bypass generated durable evidence.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#forbids literal SET values from claiming durable state-write evidence"
    },
    {
      "id": "test-structure-coupling-982b926666e23ad4",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--selects-strict-group-evidence-by-scoped-command-id",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the executable contract, convergence, and medium-scale recipes to keep durable evidence aligned with the opaque scoped group AppInbox identity.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects strict group evidence by its scoped internal command identity"
    },
    {
      "id": "test-structure-coupling-e59eda4bb5b12d9f",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--executes-the-topology-exact-revision-assertions-before-every-cle",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Parses the topology state-write recipe and compares exact-revision assertion positions with each cleanup command.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#executes the topology exact-revision assertions before every cleanup step"
    },
    {
      "id": "test-structure-coupling-1ad6c91810eec4cf",
      "path": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-webllm-runtime-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The one-runtime load count directly proves that one runtime loads and one generation occurs per request.",
      "semanticCoverage": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts#loads one runtime and validates each generated envelope"
    },
    {
      "id": "test-structure-coupling-82150a150dd9cdc9",
      "path": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-webllm-runtime-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The two-request generation count directly proves that one runtime loads and one generation occurs per request.",
      "semanticCoverage": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts#loads one runtime and validates each generated envelope"
    },
    {
      "id": "test-structure-coupling-199b77b998e88fb9",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-request-id-retry",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The ordered identical request-URL pair directly proves that both ordered attempts use the caller-provided request ID.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#reuses a caller-owned request ID when a ws ticket response is lost"
    },
    {
      "id": "test-structure-coupling-33d4b8eafdb3cd41",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-circuit-diagnostic-precedence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The unchanged one-fetch count directly proves that fetch remains at one across repeated circuit-open requests.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#keeps circuit-open diagnostics ahead of the local rate limiter while open"
    },
    {
      "id": "test-structure-coupling-3983fdfe47629f46",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-circuit-breaker",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The single-fetch count directly proves that only the first request reaches fetch while the circuit is open.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#opens a local circuit after server failures and suppresses the next ticket request"
    },
    {
      "id": "test-structure-coupling-754469ae55dc224e",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-429-cooldown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The one-fetch count during cooldown directly proves that no fetch occurs during cooldown and one occurs after expiry.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#suppresses repeated ws ticket requests after a 429 response"
    },
    {
      "id": "test-structure-coupling-ca6f4205c8df55db",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-local-rate-limit",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The single-fetch count directly proves that only one fetch occurs when the local window is exhausted.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#locally suppresses ticket storms before hitting the API"
    },
    {
      "id": "test-structure-coupling-d594acd0cc318bff",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-429-cooldown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The two-fetch count after recovery directly proves that no fetch occurs during cooldown and one occurs after expiry.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#suppresses repeated ws ticket requests after a 429 response"
    },
    {
      "id": "test-structure-coupling-dc78d510b5a27800",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-429-circuit-isolation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The two-fetch recovery count directly proves that the post-cooldown retry reaches fetch as the second request.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#does not trip the circuit breaker for server 429 cooldown responses"
    },
    {
      "id": "test-structure-coupling-298c5bb8d8655b3c",
      "path": "packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "room-send-membership-admission",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "Absence at the lane-opening port proves membership denial precedes transport work; the empty native send capture independently proves no frame escaped.",
      "semanticCoverage": "packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts#does not open or send for a room the current session has not joined"
    },
    {
      "id": "test-structure-coupling-b501ba3cfcd7af87",
      "path": "packages/tests/shared-web/rooms/create-and-join-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-create-room-failure-atomicity",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The leave-step absence assertion directly proves that leave remains unused after create failure.",
      "semanticCoverage": "packages/tests/shared-web/rooms/create-and-join-room.test.ts#does not leave when create fails"
    },
    {
      "id": "test-structure-coupling-00bec008d0fc81d3",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-connect-lagging-snapshot-order",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The ordered call list proves the point read and the topology read precede the single connect POST when the cached snapshot lags the planned slot.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#reads the room through before connecting when the cached snapshot lags the planned layout"
    },
    {
      "id": "test-structure-coupling-084da7565a82615e",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-command-request",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The call-count assertion proves the plan command spends exactly one request id; a second POST would submit the transition twice.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#plans through the bound room and accepts the receipt into the cache"
    },
    {
      "id": "test-structure-coupling-1b2a9025717e14f9",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-connect-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The call-count assertion proves exactly one POST carries the fence; a second would race the fence against itself.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#connects the current planned layout with the cached epoch"
    },
    {
      "id": "test-structure-coupling-1c06d83399d28d75",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-command-request",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The first-call body assertion proves the plan command posts the reason once under a fresh request id.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#plans through the bound room and accepts the receipt into the cache"
    },
    {
      "id": "test-structure-coupling-b4e8f6b00e0259a0",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-connect-read-through-order",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The ordered call list proves the point read precedes the topology read and that no lifecycle POST follows.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#refuses to connect locally when no planned layout exists after a read-through"
    },
    {
      "id": "test-structure-coupling-b604e54c823905c7",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-connect-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The first-call body assertion proves connect names the cached epoch and the planned-slot identity in its one POST.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#connects the current planned layout with the cached epoch"
    },
    {
      "id": "test-structure-coupling-6a8b145413d657dc",
      "path": "packages/tests/shared-web/rooms/join-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-reference-validation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The join-step absence assertion directly proves that join remains unused for mismatched identity.",
      "semanticCoverage": "packages/tests/shared-web/rooms/join-room.test.ts#rejects mismatched roomId and roomRef before the workflow"
    },
    {
      "id": "test-structure-coupling-c61c5f883b0852dc",
      "path": "packages/tests/shared-web/rooms/join-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-join-room-failure-atomicity",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The leave-step absence assertion directly proves that leave remains unused after join failure.",
      "semanticCoverage": "packages/tests/shared-web/rooms/join-room.test.ts#does not leave when joining the next room fails"
    },
    {
      "id": "test-structure-coupling-4e2fd8e52aed7476",
      "path": "packages/tests/shared-web/rooms/leave-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-leave-without-current-room",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The hydration-step absence assertion directly proves that neither leave nor hydration runs without a room.",
      "semanticCoverage": "packages/tests/shared-web/rooms/leave-room.test.ts#returns undefined without a workflow when no room can be resolved"
    },
    {
      "id": "test-structure-coupling-ba2c2e56b2ad2530",
      "path": "packages/tests/shared-web/rooms/leave-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-leave-without-current-room",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The leave-step absence assertion directly proves that neither leave nor hydration runs without a room.",
      "semanticCoverage": "packages/tests/shared-web/rooms/leave-room.test.ts#returns undefined without a workflow when no room can be resolved"
    },
    {
      "id": "test-structure-coupling-37cbfa5d1c998455",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Requires the adapter to expose RelicHuntersRuntimeDeps, the narrow type contract that replaces the broad shared-web barrel.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-5f69c532c1ad4ebf",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "kind": "production-source-read",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Reads the Relic runtime source that owns package imports, keeping the two positive assertions tied to the actual consumer module.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-c5144d99d1ea326b",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Requires the Relic runtime module to import its narrow browser adapter, recording the consumer-to-adapter dependency edge.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-1a8f6bf9501e1e11",
      "path": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts",
      "kind": "production-source-read",
      "contract": "shared-web-browser-bundle-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Reads the shared-web package manifest before bundling and confirms graphology is not declared as a direct browser-package dependency.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts#keeps shared-web from declaring graphology directly"
    },
    {
      "id": "test-structure-coupling-67f803ee1f1dfc75",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-delta-recovery.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-delta-causal-gap-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one recovery fetch assertion directly proves that exactly one floored recovery read occurs.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-delta-recovery.test.ts#pulls the floored group snapshot when a delta envelope arrives over a causal gap"
    },
    {
      "id": "test-structure-coupling-025be7ee49840bd9",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-left-session-overlay-removal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The active-update absence assertion directly proves that active update remains unused for local-session departure.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#removes overlays but retains RTC connections when an active snapshot no longer includes the current session"
    },
    {
      "id": "test-structure-coupling-1805f0024d06f752",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-hydration-incomparable-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one RTC recomputation assertion directly proves that one reread and recomputation occur while divergent input is not applied.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#retains durable incomparable recovery across initialise and hydrate"
    },
    {
      "id": "test-structure-coupling-497bb478e2668c0b",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-directory-only-rtc-reconciliation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The delete absence assertion directly proves that update and delete remain unused while global reconciliation runs once.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#reconciles RTC peers when an active directory snapshot excludes the current session"
    },
    {
      "id": "test-structure-coupling-62267828560f3742",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-overlay-topology-notification",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The three-notification count after all envelopes directly proves that notification occurs exactly once per topology envelope.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#applies overlay topology websocket snapshots to the local overlay cache"
    },
    {
      "id": "test-structure-coupling-938ac1b9663ee78e",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-overlay-topology-notification",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The one-notification count after the first envelope directly proves that notification occurs exactly once per topology envelope.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#applies overlay topology websocket snapshots to the local overlay cache"
    },
    {
      "id": "test-structure-coupling-a11ab393ae38189f",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-removed-group-cleanup",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The active-update absence assertion directly proves that active update remains unused during group removal.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#cleans up RTC group tracking and notifies listeners when a group snapshot is removed"
    },
    {
      "id": "test-structure-coupling-b916315de75a02bd",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-directory-only-rtc-reconciliation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one global reconciliation assertion directly proves that update and delete remain unused while global reconciliation runs once.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#reconciles RTC peers when an active directory snapshot excludes the current session"
    },
    {
      "id": "test-structure-coupling-cbe469634a266398",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-incomparable-state-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one reread assertion directly proves that exactly one durable reread occurs for the incomparable tuple.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#recovers incomparable group tuples through a durable reread before RTC recomputation"
    },
    {
      "id": "test-structure-coupling-d5f5da64d4239c75",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-hydration-incomparable-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one durable reread assertion directly proves that one reread and recomputation occur while divergent input is not applied.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#retains durable incomparable recovery across initialise and hydrate"
    },
    {
      "id": "test-structure-coupling-e1765609fc916748",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-directory-only-rtc-reconciliation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The active-update absence assertion directly proves that update and delete remain unused while global reconciliation runs once.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#reconciles RTC peers when an active directory snapshot excludes the current session"
    },
    {
      "id": "test-structure-coupling-f9d11d5598249f3f",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-hydration-incomparable-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The divergent active-update absence assertion directly proves that one reread and recomputation occur while divergent input is not applied.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#retains durable incomparable recovery across initialise and hydrate"
    },
    {
      "id": "test-structure-coupling-1b3d4d2848352f1b",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-conflict-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one recovery fetch assertion directly proves that exactly one conflict recovery fetch occurs.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#counts a revision conflict from the divergence oracle and self-heals with the floored pull"
    },
    {
      "id": "test-structure-coupling-505ac7ff6ccdc8a1",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-missing-session-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one recovery fetch assertion directly proves that exactly one missing-session recovery fetch occurs.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#pulls at the floor when an active session record is missing from the delta and the cache"
    },
    {
      "id": "test-structure-coupling-8339924aecbb8ee7",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-predecessor-apply",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The recovery-fetch absence assertion directly proves that recovery fetch remains unused for predecessor-matched application.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#applies a delta at the cached predecessor and materializes the server-canonical snapshot"
    },
    {
      "id": "test-structure-coupling-ad89c9ae9a021e02",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-resulting-floor",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one recovery fetch assertion directly proves that exactly one resulting-floor fetch occurs.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#pulls at the resulting floor when the cached snapshot is dominated but not the predecessor"
    },
    {
      "id": "test-structure-coupling-b2dd16cf6147955c",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-resulting-noop",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The recovery-fetch absence assertion directly proves that recovery fetch remains unused for typed no-ops.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#resolves equal-resulting and summary no-op envelopes as typed no-ops before the apply rule"
    },
    {
      "id": "test-structure-coupling-e73fb539a6935723",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-out-of-order-noop",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The recovery-fetch absence assertion directly proves that recovery fetch remains unused for stale input.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#resolves an out-of-order envelope after a newer snapshot as a no-op"
    },
    {
      "id": "test-structure-coupling-189d9f62c9fbd148",
      "path": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-group-refresh-reads-the-code-not-the-detail",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The refresh returns nothing either way; the untouched authority port is the only witness that a denial carrying another code did not reach it.",
      "semanticCoverage": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts#does not read authority after a denial the refresh cannot repair"
    },
    {
      "id": "test-structure-coupling-2aec3da56cd4fa42",
      "path": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-group-refresh-retries-after-failure",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The two-call assertion proves the failed first refresh released its group slot and the next retained recovery report reached the authority port.",
      "semanticCoverage": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts#leaves failed refreshes to the retained QueueBox retry"
    },
    {
      "id": "test-structure-coupling-8e9755e2fc1d5b45",
      "path": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-group-refresh-skips-admitted-messages",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The absent refresh call proves successful message admission does not add an authoritative read and QueueBox wake to the normal RTC delivery path.",
      "semanticCoverage": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts#does not read authority after successful admission"
    },
    {
      "id": "test-structure-coupling-c7847aaa460d293a",
      "path": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-group-refresh-coalesces-concurrent-requests",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The single-call assertion rejects a duplicate authoritative read while the same scoped group's first recovery is still active.",
      "semanticCoverage": "packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts#coalesces repeated recovery requests for the same group and snapshot floor"
    },
    {
      "id": "test-structure-coupling-3473aa2934492476",
      "path": "packages/tests/shared/al-inbound-message-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-inbound-conflict-one-admission-attempt",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "The one outer commit invocation forbids an inner optimistic retry. The same test separately proves durable pending ownership, restart replay and final delivery; the bound competing write is fixture input, not another runtime call.",
      "semanticCoverage": "packages/tests/shared/al-inbound-message-runtime.test.ts#retains a stale optimistic write for fresh admission after runtime restart"
    },
    {
      "id": "test-structure-coupling-3cf15c4dbe54dee4",
      "path": "packages/tests/shared/al-outbound-durable-effects.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-outbound-runtime-control-conflict-retention",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "One backend write per accepted control is the property under test at the runtime boundary; the retained admit-control row is the recovery it hands off, not evidence that no second commit was attempted.",
      "semanticCoverage": "packages/tests/shared/al-outbound-durable-effects.test.ts#retains a control admission conflict as replayable work without an inner retry"
    },
    {
      "id": "test-structure-coupling-5bd28d16b95e3de6",
      "path": "packages/tests/shared/al-outbound-durable-effects.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-outbound-expiry-during-receipt-read",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "This is the real prepared-send effect boundary and the fixture contains an eligible prepared attempt before the awaited read crosses D. No-send is the required deadline behavior.",
      "semanticCoverage": "packages/tests/shared/al-outbound-durable-effects.test.ts#does not send when the deadline passes during the receipt read"
    },
    {
      "id": "test-structure-coupling-275f65246bcd45da",
      "path": "packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-invalid-queue-candidate-no-transaction",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "The native transaction absence is required independently of the final empty queue: invalid computed persistence values must not enter transaction scope.",
      "semanticCoverage": "packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts#rejects invalid queue values before opening the joint write transaction"
    },
    {
      "id": "test-structure-coupling-715d3806644feb6a",
      "path": "packages/tests/shared/alm/al-outbound-control-admission.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-outbound-control-write-free-no-batch",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "The paired positive count is what makes the preceding absence a statement about this control rather than about a runtime that never batches at all.",
      "semanticCoverage": "packages/tests/shared/alm/al-outbound-control-admission.test.ts#starts a work batch only for a control admission that wrote"
    },
    {
      "id": "test-structure-coupling-8476c70422e7a937",
      "path": "packages/tests/shared/alm/al-outbound-control-admission.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-outbound-control-write-free-no-batch",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "The absent reservation is the only witness that a write-free control started no batch; the queue contents and the admission result are identical either way.",
      "semanticCoverage": "packages/tests/shared/alm/al-outbound-control-admission.test.ts#starts a work batch only for a control admission that wrote"
    },
    {
      "id": "test-structure-coupling-d58f46e97b581e00",
      "path": "packages/tests/shared/alm/al-outbound-control-admission.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-outbound-control-conflict-single-write",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "The single write invocation is what forbids an inner optimistic retry; the pending-control answer and the retained work row both hold either way.",
      "semanticCoverage": "packages/tests/shared/alm/al-outbound-control-admission.test.ts#answers pending-control for a backend conflict without an inner retry"
    },
    {
      "id": "test-structure-coupling-11102ca02776726f",
      "path": "packages/tests/shared/alm/outbound-runtime-test-fixture.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-outbound-held-claim-quiescence",
      "disposition": "temporary-ratchet",
      "owner": "Rallar shared maintainers",
      "rationale": "The spied claim count is the polled condition of a bounded wait rather than a product property: it is the only observable of “no batch is still asking for work” available to a fixture that receives stores and not a runtime, and the assertion is that wait's budget, failing loudly instead of restoring real claims inside a batch.",
      "removalCondition": "Remove once the outbound owner exposes batch quiescence to a fixture, so holdOutboundClaims awaits an owner-side idle signal instead of polling the queue spy's call count.",
      "semanticCoverage": "packages/tests/shared/al-outbound-durable-effects.test.ts#lets only one runtime claim the same committed send effect"
    },
    {
      "id": "test-structure-coupling-ba353a1cc01e52dc",
      "path": "packages/tests/shared/json-message-validation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "json-size-unknown-shape-no-user-hooks",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "The toJSON absence assertion protects the no-serialization-hook raw shape boundary.",
      "semanticCoverage": "packages/tests/shared/json-message-validation.test.ts#rejects unknown shapes without invoking JSON hooks"
    },
    {
      "id": "test-structure-coupling-fb4002dae3f5e354",
      "path": "packages/tests/shared/json-message-validation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "json-size-unknown-shape-no-user-hooks",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "The toString absence assertion protects the separate no-coercion-hook raw shape boundary.",
      "semanticCoverage": "packages/tests/shared/json-message-validation.test.ts#rejects unknown shapes without invoking JSON hooks"
    },
    {
      "id": "test-structure-coupling-edbec05f9e4a5443",
      "path": "packages/tests/shared/open-indexed-db.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "indexeddb-invalid-schema-no-open",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "Native database open is an observable effect even if a later error leaves no records. This invalid schema must be rejected before that operation.",
      "semanticCoverage": "packages/tests/shared/open-indexed-db.test.ts#rejects duplicate store definitions before opening IndexedDB"
    },
    {
      "id": "test-structure-coupling-4d92b01b59887820",
      "path": "packages/tests/shared/qrtc-data-channel.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-error-settlement-attempted-versus-untouched",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "The count independently verifies the truth of submissionAttempted on both keyed settlements; checking settlement values alone could accept incorrect transport accounting.",
      "semanticCoverage": "packages/tests/shared/qrtc-data-channel.test.ts#distinguishes an uncertain attempted send from untouched siblings cleared by its channel error"
    },
    {
      "id": "test-structure-coupling-036839b1702a8a0f",
      "path": "packages/tests/shared/qrtc-peer-connection.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-ice-restart-backoff-budget",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "The first retry deadline must produce one native ICE restart despite concurrent reconnect requests sharing that deadline.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#ignores offer collisions when impolite and retries with ICE restart on failure"
    },
    {
      "id": "test-structure-coupling-97e3c2ebcb7a5abc",
      "path": "packages/tests/shared/qrtc-peer-connection.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-ice-restart-backoff-budget",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "Five native restarts, followed by exhausted reset, proves the externally effective retry budget rather than only an internal attempt counter.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#ignores offer collisions when impolite and retries with ICE restart on failure"
    },
    {
      "id": "test-structure-coupling-b3fa661d1e9850cc",
      "path": "packages/tests/shared/qrtc-peer-connection.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-connected-observer-delivery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "One established callback is required for the one native connection transition; peer open state alone cannot detect duplicate observer effects.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#negotiates offers, forwards ICE candidates, and dispatches remote events"
    },
    {
      "id": "test-structure-coupling-f5fc95d6dae01a59",
      "path": "packages/tests/shared/qrtc-peer-connection.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-signaling-failure-report-not-a-log",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "The failure list alone cannot say the hop stopped being logged; only the untouched console port shows the report replaced the log rather than joining it.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#reports the hop a terminal signaling failure lost, instead of logging and dropping it"
    },
    {
      "id": "test-structure-coupling-aa4d70f0ba82e2ed",
      "path": "packages/tests/shared/queuebox-utilities.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queuebox-mixed-outcome-adaptive-feedback",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "Exactly one success feedback signal must represent the completed work in this mixed batch; readiness must neither become success nor suppress completed-work adaptation.",
      "semanticCoverage": "packages/tests/shared/queuebox-utilities.test.ts#retains actual failure accounting alongside neutral readiness and successful work"
    },
    {
      "id": "test-structure-coupling-dd069330ee143590",
      "path": "packages/tests/shared/queuebox-utilities.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "queuebox-mixed-outcome-adaptive-feedback",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "Exactly one failure feedback signal must represent the actual failure in this mixed batch; NotReady must not create an extra signal that changes breaker or rate-adapter state.",
      "semanticCoverage": "packages/tests/shared/queuebox-utilities.test.ts#retains actual failure accounting alongside neutral readiness and successful work"
    },
    {
      "id": "test-structure-coupling-0d8fac5ef56252fe",
      "path": "packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "resource-inbox-reservation-bounded-indexed-read",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "Absence at the object-store read port is the only witness that no whole-store scan happened at all; the bounded index-call assertions beside it constrain the index reads but say nothing about a second, unindexed read alongside them.",
      "semanticCoverage": "packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts#reserveEntries for one type never returns another type and stays within the requested bound"
    },
    {
      "id": "test-structure-coupling-368712d4f142c268",
      "path": "packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "resource-inbox-reservation-bounded-indexed-read",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "The call count and each call's bounded count argument are the only observable proof that reserveEntries reads through the bounded by-type-status-key index instead of falling back to a whole-store scan; the reserved-entry assertions above it prove correctness but not boundedness.",
      "semanticCoverage": "packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts#reserveEntries for one type never returns another type and stays within the requested bound"
    },
    {
      "id": "test-structure-coupling-493125af62d6381d",
      "path": "packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "resource-inbox-terminal-sweep-page-budget",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "The surviving unretained row proves the run stopped before reaching it, but only the index-read count separates a run that stopped on its page budget from one that stopped for any other reason, such as a mis-sized page or an exhausted range.",
      "semanticCoverage": "packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts#bounds one cleanup run by its page budget"
    },
    {
      "id": "test-structure-coupling-e057b89986e7f609",
      "path": "packages/tests/shared/services/ws-queue-box-server-ingress.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ws-invalid-application-command-skips-authorization",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "No authorization call proves validator failure short-circuits the owned external policy capability; empty admission state alone would allow unnecessary authority work.",
      "semanticCoverage": "packages/tests/shared/services/ws-queue-box-server-ingress.test.ts#runs a typed application validator before authorization or admission"
    },
    {
      "id": "test-structure-coupling-17044d7d640b79a9",
      "path": "packages/tests/shared/websocket/json-message-limits.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "json-ws-client-before-parse-byte-limit",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "The parser absence assertion distinguishes rejection before costly decoding from equally rejected but fully parsed oversized input.",
      "semanticCoverage": "packages/tests/shared/websocket/json-message-limits.test.ts#rejects oversized client frames before parsing and keeps accepting bounded traffic"
    },
    {
      "id": "test-structure-coupling-1d54cf58a5074f87",
      "path": "packages/tests/shared/websocket/json-message-limits.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "json-ws-native-binary-preconversion-limit",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "JSON.parse must remain untouched so binary rejection cannot coerce the oversized native frame.",
      "semanticCoverage": "packages/tests/shared/websocket/json-message-limits.test.ts#checks native binary sizes without Blob conversion or JSON coercion"
    },
    {
      "id": "test-structure-coupling-c0e8da26bc0a6216",
      "path": "packages/tests/shared/websocket/json-message-limits.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "json-ws-server-subscription-before-parse-limit",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "The absence assertion is taken before the generic subscriber is added, so it proves the capped-only path rejects before decoding without forbidding legitimate generic parsing.",
      "semanticCoverage": "packages/tests/shared/websocket/json-message-limits.test.ts#limits server ALM subscriptions without limiting generic JSON subscribers"
    },
    {
      "id": "test-structure-coupling-ce68ae67e8245a9d",
      "path": "packages/tests/shared/websocket/json-message-limits.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "json-ws-native-binary-preconversion-limit",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "Blob.text must remain untouched so rejection cannot materialize oversized Blob contents.",
      "semanticCoverage": "packages/tests/shared/websocket/json-message-limits.test.ts#checks native binary sizes without Blob conversion or JSON coercion"
    },
    {
      "id": "test-structure-coupling-3ceb07724df6bd80",
      "path": "packages/tests/shared/ws-server-readiness.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ws-native-failure-one-attempt-accounting",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared realtime maintainers",
      "rationale": "Exactly one native call binds the persisted attempts=1 evidence to actual transport submission rather than accepting hidden repeated sends.",
      "semanticCoverage": "packages/tests/shared/ws-server-readiness.test.ts#retains native-send failure accounting when an open socket throws"
    },
    {
      "id": "test-structure-coupling-35b58397e8dffb2c",
      "path": "tests/playwright/rallar-black-box/recipe-console-control.spec.ts",
      "kind": "platform-scheduling-or-history-probe",
      "contract": "recipe-console-single-poll-timer",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The instrumented setTimeout and clearTimeout registry is the only witness of how many poll timers are active before and after unmount.",
      "semanticCoverage": "tests/playwright/rallar-black-box/recipe-console-control.spec.ts#owns one poll timer across views and clears it when Recipe Console unmounts"
    },
    {
      "id": "test-structure-coupling-b4b5a27fe8e9e221",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-one-control-token-per-simulated-agent",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Three mints for three prepared agents is what separates three least-privilege tokens from one token reused, which the launch URLs the same test reads cannot show.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#prepares exact simulated identities with distinct least-privilege control tokens"
    },
    {
      "id": "test-structure-coupling-a3b0b6dc6867c9c7",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-legacy-compatibility-mints-no-agent-ticket",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent ticket request is the only place the legacy launch's credential-free promise is visible; the URL it builds looks identical either way.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#keeps explicit anonymous and interactive-login compatibility at the legacy boundary"
    },
    {
      "id": "test-structure-coupling-e1d9a39c0dfa1695",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-links-copied-in-one-clipboard-write",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single write is what the two links are read out of, so it pins both that the copy happened once and that it carried every link.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#copies multiple secured agent links that share the legacy run token"
    },
    {
      "id": "test-structure-coupling-9203a464a554aae2",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-popup-reserved-once-per-requested-agent",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Three opens for three agents shows the blocked agent was attempted inside the gesture rather than skipped before it.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#reserves synchronously, reports blocked IDs, and navigates only prepared windows with replace"
    },
    {
      "id": "test-structure-coupling-c6b265efab92e37c",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-released-popups-closed-exactly-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single close on the first window proves the release disposed of it once, beside the reason text the same case reads from it.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#closes every unused blank window after preparation failure or invalidation"
    },
    {
      "id": "test-structure-coupling-fe88e7f966516a87",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-released-popups-closed-exactly-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The second window carries the same once-only close, so the release is proven for every window it holds, not only the first.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#closes every unused blank window after preparation failure or invalidation"
    },
    {
      "id": "test-structure-coupling-881ce5733a3edef1",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-closed-popup-never-navigated",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single replace on the open window is the only witness that the prepared link reached it, since the reported navigated ids are computed beforehand.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#reports a reserved popup closed before prepared links are navigated"
    },
    {
      "id": "test-structure-coupling-56f501f8da9eb4b3",
      "path": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "agent-launch-closed-popup-never-navigated",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent replace on the operator-closed window is the only witness that navigation skipped it rather than raising on it.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts#reports a reserved popup closed before prepared links are navigated"
    },
    {
      "id": "test-structure-coupling-8e2ac7c015d184f8",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-crashed-candidate-keeps-accepted-worker",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that a crashed replacement left the accepted worker thread serving the current analysis.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#keeps the accepted worker and export when a replacement candidate crashes"
    },
    {
      "id": "test-structure-coupling-b6084e9b4526e9cb",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-identity-mismatch-terminates-only-the-candidate",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that rejecting a candidate never ended the accepted worker thread.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#rejects an identity-invalid candidate without replacing the accepted worker or export"
    },
    {
      "id": "test-structure-coupling-e042e92e3c70253f",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-identity-mismatch-terminates-only-the-candidate",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single terminate call is the only witness that the rejected candidate’s thread and transferred bytes were released.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#rejects an identity-invalid candidate without replacing the accepted worker or export"
    },
    {
      "id": "test-structure-coupling-61b62179919560c6",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-oversized-request-constructs-no-replacement",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single construction is the only witness that a refused oversized offer spawned no replacement worker thread.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#rejects oversized outbound metadata and RPC text without posting or replacing authority"
    },
    {
      "id": "test-structure-coupling-eeae664b4a52bc21",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-oversized-request-constructs-no-replacement",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that a refused request never spent the accepted worker’s authority.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#rejects oversized outbound metadata and RPC text without posting or replacing authority"
    },
    {
      "id": "test-structure-coupling-a126dbeb238ef49a",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-failed-transfer-post-terminates-its-candidate",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single terminate call is the only witness that a candidate whose first post threw was not left running.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#cleans candidate authority synchronously when the initial transfer post throws"
    },
    {
      "id": "test-structure-coupling-f2eec898236252a1",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-watchdog-terminates-only-its-own-candidate",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that a timed-out request did not tear down the accepted worker.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#times out only the candidate or request that owns the watchdog and ignores late replies"
    },
    {
      "id": "test-structure-coupling-d4cf2d45e2cca8c7",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-watchdog-terminates-only-its-own-candidate",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single terminate call is the only witness that the timed-out candidate’s own thread was ended.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#times out only the candidate or request that owns the watchdog and ignores late replies"
    },
    {
      "id": "test-structure-coupling-87a44beb1e55abca",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-watchdog-terminates-only-its-own-candidate",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that the candidate watchdog stayed scoped to its candidate.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#times out only the candidate or request that owns the watchdog and ignores late replies"
    },
    {
      "id": "test-structure-coupling-b736d0204512620b",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-factory-constructs-nothing-until-invoked",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The absent construction is the whole of the factory’s laziness contract.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#creates no worker until the lazy factory is explicitly invoked"
    },
    {
      "id": "test-structure-coupling-324e3a28fdae85ac",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-factory-constructs-nothing-until-invoked",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single construction is the only witness that one invocation spawns exactly one worker thread.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#creates no worker until the lazy factory is explicitly invoked"
    },
    {
      "id": "test-structure-coupling-c5c0707a56d6d488",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-worker-factory-targets-the-module-worker-asset",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The recorded constructor arguments are the only place the asset URL and module worker options are observable.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-worker-client.test.ts#targets the production Analyze artifact worker asset"
    },
    {
      "id": "test-structure-coupling-2671526eb9869d4f",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-hook-failed-replacement-keeps-the-accepted-worker",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that the failed replacement left the accepted worker answering requests.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#keeps input, navigation, accepted analysis, and export usable across held replies, Tune, and a failed replacement"
    },
    {
      "id": "test-structure-coupling-03154b510383238a",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-hook-failed-replacement-keeps-the-accepted-worker",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single terminate call is the only witness that the failed replacement’s thread was released.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#keeps input, navigation, accepted analysis, and export usable across held replies, Tune, and a failed replacement"
    },
    {
      "id": "test-structure-coupling-b67857e26992513c",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-hook-failed-replacement-keeps-the-accepted-worker",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that re-entering Analyze after Tune reused the accepted worker instead of replacing it.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#keeps input, navigation, accepted analysis, and export usable across held replies, Tune, and a failed replacement"
    },
    {
      "id": "test-structure-coupling-66ce1bef13e7ebbb",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-hook-failed-replacement-keeps-the-accepted-worker",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single terminate call is the only witness that the accepted worker was released exactly once when it failed.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#keeps input, navigation, accepted analysis, and export usable across held replies, Tune, and a failed replacement"
    },
    {
      "id": "test-structure-coupling-a6280abceb9f8959",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-hook-off-view-retains-its-accepted-worker",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that leaving and re-entering the view costs no worker reparse.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#does no Analyze option or search work off-view, retains the artifact and Tune facade, then searches the latest query once on entry"
    },
    {
      "id": "test-structure-coupling-90e780c5c8792d3f",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-hook-late-candidate-terminates-only-the-candidate",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single terminate call is the only witness that the rejected late candidate’s thread and transferred bytes were released.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#rejects a candidate completed after a render-time context and execution change before passive reconciliation"
    },
    {
      "id": "test-structure-coupling-87dbba6ad92e0ccb",
      "path": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "analyze-hook-late-candidate-terminates-only-the-candidate",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade terminate call is the only witness that the accepted worker survived the rejected late candidate.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts#rejects a candidate completed after a render-time context and execution change before passive reconciliation"
    },
    {
      "id": "test-structure-coupling-fcf32bd5c97d44c8",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-mount-defers-the-retention-client",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade load is the only witness that mounting the panel fetched no retention chunk and bound no authorized endpoint before the operator asked.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#loads only on Preview and exposes exact frozen token-free consequences"
    },
    {
      "id": "test-structure-coupling-7d3ba7fd24a6dba9",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-preview-loads-once-and-requests-one-plan",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single load witnesses that the operator’s first preview, and not the render, acquired the retention client.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#loads only on Preview and exposes exact frozen token-free consequences"
    },
    {
      "id": "test-structure-coupling-bc3234f3bfba5c13",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-preview-loads-once-and-requests-one-plan",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single plan request witnesses that one Preview action asked the control server for one plan instead of superseding its own.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#loads only on Preview and exposes exact frozen token-free consequences"
    },
    {
      "id": "test-structure-coupling-b4a24cf9b074895e",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-strictmode-replay-issues-no-second-plan",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single load witnesses that the replayed StrictMode mount effect did not re-acquire the retention client.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#remains operational after the StrictMode effect replay"
    },
    {
      "id": "test-structure-coupling-9ab6dedf56ed2673",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-strictmode-replay-issues-no-second-plan",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single plan request witnesses that the replayed effect did not supersede the operator’s own preview.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#remains operational after the StrictMode effect replay"
    },
    {
      "id": "test-structure-coupling-f589cffbfd80f60f",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-concurrent-previews-issue-one-plan",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single load witnesses that the second concurrent preview acquired no further client while the first was in flight.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#serializes double preview calls and suppresses a superseded result"
    },
    {
      "id": "test-structure-coupling-3cdb4577e62e6e84",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-concurrent-previews-issue-one-plan",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single plan request witnesses that the second concurrent preview never reached the control server to supersede the first.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#serializes double preview calls and suppresses a superseded result"
    },
    {
      "id": "test-structure-coupling-6933890207d86446",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-confirmation-deletes-once-and-reconciles-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single load witnesses that the confirmation reused the client the preview acquired rather than binding a second authorized endpoint.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#confirms only the exact private preview and awaits one callback before success"
    },
    {
      "id": "test-structure-coupling-db3215194d8dece3",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-confirmation-deletes-once-and-reconciles-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single delete witnesses that the second confirmation raised in the same commit never reached the control server.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#confirms only the exact private preview and awaits one callback before success"
    },
    {
      "id": "test-structure-coupling-11eee3563888c45b",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-confirmation-deletes-once-and-reconciles-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single reconciliation witnesses that one deletion refreshed and rewrote the operator’s view once, not once per confirm call.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#confirms only the exact private preview and awaits one callback before success"
    },
    {
      "id": "test-structure-coupling-fbf4ad9ca22b29e9",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-drifted-plan-sends-no-second-delete",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unchanged delete count is the only witness that the confirmation offered after the drift sent nothing.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#maps 409 to drift, preserves only stale consequences, and requires a new preview"
    },
    {
      "id": "test-structure-coupling-2109e9e00a87d73e",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-replaced-connection-abandons-the-late-client",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade plan request is the only witness that the late-resolving client of the superseded connection was abandoned.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates synchronously on capability replacement and suppresses late load and preview"
    },
    {
      "id": "test-structure-coupling-e48bc1257ab1f3f8",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-replaced-connection-abandons-the-late-client",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade load is the only witness that replacing the connection did not eagerly acquire a retention client of its own.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates synchronously on capability replacement and suppresses late load and preview"
    },
    {
      "id": "test-structure-coupling-1065fea0d6db556c",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-identity-replacement-sends-no-stale-delete",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade delete on the previous client witnesses that the invalidated plan was not sent back to the client that issued it.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates a completed preview on capability identity replacement"
    },
    {
      "id": "test-structure-coupling-a6d411cc6c04db35",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-identity-replacement-sends-no-stale-delete",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade delete on the replacement client witnesses that the invalidated plan was not replayed to the new loader.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates a completed preview on capability identity replacement"
    },
    {
      "id": "test-structure-coupling-91af7fd2e5d1d234",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-identity-replacement-previews-once-through-the-new-client",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single load witnesses that the preview taken after the replacement acquired the new client exactly once.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates a completed preview on capability identity replacement"
    },
    {
      "id": "test-structure-coupling-ebd88c566d01c3b6",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-identity-replacement-previews-once-through-the-new-client",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single plan request witnesses that the replacement client was asked for one plan rather than a superseding pair.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#invalidates a completed preview on capability identity replacement"
    },
    {
      "id": "test-structure-coupling-ec748a9447a192a0",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-drifted-confirmation-reconciles-nothing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade reconciliation is the only witness that a confirmation resolved after the context changed reconciled nothing.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#aborts in-flight work on signal/context drift and never calls back after drift"
    },
    {
      "id": "test-structure-coupling-7c5771f7c4785af6",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-reconciliation-starts-once-per-confirmation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Waiting for exactly one started reconciliation both proves that the confirmation began one and names the call whose abort signal the assertion then reads.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#aborts an in-progress reconciliation callback on context drift"
    },
    {
      "id": "test-structure-coupling-604f3ee475a608b0",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "retention-cleanup-aborted-reconciliation-performs-no-work",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade side effect is the only witness that the aborted reconciliation stopped instead of rewriting the new connection’s selection.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts#aborts an in-progress reconciliation callback on context drift"
    },
    {
      "id": "test-structure-coupling-bf67af6aea146bc4",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-panel-defers-the-retention-client",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade load is the only witness that rendering History fetched no cleanup chunk before the operator pressed Preview.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#previews, confirms, refreshes, then selectively replaces URL state"
    },
    {
      "id": "test-structure-coupling-b5d2c9f3353f0687",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-preview-click-loads-the-client-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single load witnesses that one Preview cleanup click acquired one retention client for the connection.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#previews, confirms, refreshes, then selectively replaces URL state"
    },
    {
      "id": "test-structure-coupling-32871347912c8ec0",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-unauthorized-operator-loads-nothing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade load is the only witness that the disabled control acquired no deletion-capable endpoint.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#keeps preview unavailable when operator authorization is required"
    },
    {
      "id": "test-structure-coupling-b03068e3657585db",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-untrusted-credentials-load-nothing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade load is the only witness that the withheld credential was never spent on a retention endpoint.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#withholds cleanup when credential provenance is unsafe"
    },
    {
      "id": "test-structure-coupling-3f1f9af6eccaf126",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-drifted-dialog-deletes-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single delete witnesses that the drifted dialog left one attempt behind rather than retrying under the stale plan.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#closes a drifted dialog, restores Preview focus, and requires a new preview"
    },
    {
      "id": "test-structure-coupling-aec7fd09fa87317b",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-confirmed-cleanup-refreshes-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single refresh is what holds the reconciliation open long enough for the control context to change underneath it.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#suppresses URL reconciliation when context changes during refresh"
    },
    {
      "id": "test-structure-coupling-644c5c778fce6cac",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-context-change-during-refresh-rewrites-no-url",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade replace is the only witness that the suppressed reconciliation left the new connection’s address bar alone.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#suppresses URL reconciliation when context changes during refresh"
    },
    {
      "id": "test-structure-coupling-3ab32c3886758f97",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-authorization-loss-refreshes-once",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The single refresh is what holds the reconciliation open while operator authorization is withdrawn underneath it.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#aborts reconciliation when authorization is lost without API replacement"
    },
    {
      "id": "test-structure-coupling-3da4231e5aa3606e",
      "path": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "history-retention-authorization-loss-rewrites-no-url",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar Black Box maintainers",
      "rationale": "The unmade replace is the only witness that the reconciliation stopped instead of rewriting the selection after authorization was lost.",
      "semanticCoverage": "packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts#aborts reconciliation when authorization is lost without API replacement"
    },
    {
      "id": "test-structure-coupling-facde9adb0f18552",
      "path": "packages/tests/shared-web/composition/browser-runtime-construction.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-session-shared-transport-acquisition",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar browser maintainers",
      "rationale": "The count observes shared external-resource acquisition by two facade consumers, independently corroborated by settlement of both handles.",
      "semanticCoverage": "packages/tests/shared-web/composition/browser-runtime-construction.test.ts#shares one bounded session observation owner across facades"
    },
    {
      "id": "test-structure-coupling-15952e596b786253",
      "path": "packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-invalid-fallback-no-admission",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar browser maintainers",
      "rationale": "The WS admission absence prevents fallback publication to an unsupported audience despite the public validation rejection.",
      "semanticCoverage": "packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts#reports every unsupported fallback constraint before connecting or queueing"
    },
    {
      "id": "test-structure-coupling-63fb37f78610c2ea",
      "path": "packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-invalid-fallback-no-admission",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar browser maintainers",
      "rationale": "The RTC admission absence prevents the preferred carrier from publishing despite the public validation rejection.",
      "semanticCoverage": "packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts#reports every unsupported fallback constraint before connecting or queueing"
    },
    {
      "id": "test-structure-coupling-a11dc68fc52eaed6",
      "path": "packages/tests/shared-web/messages/browser-typed-message-channels.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-explicit-ws-strategy-excludes-rtc",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar browser maintainers",
      "rationale": "Absence at the RTC admission port proves the explicit WS-only selection does not also publish over RTC.",
      "semanticCoverage": "packages/tests/shared-web/messages/browser-typed-message-channels.test.ts#uses WS only for typed channel send when strategy is ws"
    },
    {
      "id": "test-structure-coupling-18a0469ec2269441",
      "path": "packages/tests/shared-web/state-cache/authoritative-group-freshness.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "authoritative-group-cache-refresh-no-topology-work",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared-web maintainers",
      "rationale": "The acceptGroupUpdate absence directly guards the owned topology side-effect boundary during cache-only freshness renewal; content and event assertions alone cannot establish that absence.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/authoritative-group-freshness.test.ts#emits only truthful Refreshed and preserves content without downstream topology work"
    },
    {
      "id": "test-structure-coupling-149a0a0f09904b24",
      "path": "packages/tests/shared-web/state-cache/authoritative-group-freshness.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "authoritative-group-cache-refresh-no-topology-work",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared-web maintainers",
      "rationale": "The ensureAllGroupsConnected absence directly guards the owned topology side-effect boundary during cache-only freshness renewal; content and event assertions alone cannot establish that absence.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/authoritative-group-freshness.test.ts#emits only truthful Refreshed and preserves content without downstream topology work"
    },
    {
      "id": "test-structure-coupling-6725710d19e85de6",
      "path": "packages/tests/shared-test/api-v1-state-write-evidence-source.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "state-write-evidence-invalid-input-no-sql",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared-test maintainers",
      "rationale": "The absence assertion observes the external SQL port: invalid raw evidence input must not issue database work even if a later error is correct.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-write-evidence-source.test.ts#keeps raw JSON evidence inputs untrusted until the SQL validator runs"
    },
    {
      "id": "test-structure-coupling-3ec1adc4c7e8a4f2",
      "path": "packages/tests/shared-server/al-runtime/postgres/p-sql-admission-work-transactions.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "alm-work-release-batch-one-transaction",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar shared maintainers",
      "rationale": "The single transaction is required independently of the released statuses: a per-entry loop reaches the same end state while giving up the batch's atomicity and its one round trip.",
      "semanticCoverage": "packages/tests/shared-server/al-runtime/postgres/p-sql-admission-work-transactions.test.ts#commits one mixed release batch in one transaction, each entry on its own disposition"
    }
  ]
}
```
