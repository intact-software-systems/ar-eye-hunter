import path from 'node:path';

import { findingMagnitude } from './finding-magnitude.mjs';
import { reviewedBrowserDispositions } from './reviewed-browser-dispositions.mjs';
import { reviewedScenarioDispositions } from './reviewed-scenario-dispositions.mjs';

export const reviewedDispositions = Object.freeze([
    // Independent whole-owner review: One keyed remote-avatar lifecycle owns motion, health and shot presentation.
    // This warning-tier cap permits no growth and waives no other rule.
    Object.freeze({
        path: 'apps/ar-eye-hunter-v1/src/game/scene/arena-peer-view.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 79
    }),
    // Independent whole-owner review: One frame owner keeps input, prediction and accepted shot ordering visible.
    // This warning-tier cap permits no growth and waives no other rule.
    Object.freeze({
        path: 'apps/ar-eye-hunter-v1/src/game/scene/arena-scene-step.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 102
    }),
    // Independent whole-owner review: One keyed target/pickup visual lifecycle owns creation, attack cues and disposal.
    // This warning-tier cap permits no growth and waives no other rule.
    Object.freeze({
        path: 'apps/ar-eye-hunter-v1/src/game/scene/arena-target-view.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 96
    }),
    // Independent whole-owner review: One input adapter maps visible controls and finite key choices to the same input state.
    // This warning-tier cap permits no growth and waives no other rule.
    Object.freeze({
        path: 'apps/ar-eye-hunter-v1/src/game/scene/arena-touch-input.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 56
    }),
    // Independent whole-owner review: One scenery assembly owns arena meshes, materials and their labels.
    // This warning-tier cap permits no growth and waives no other rule.
    Object.freeze({
        path: 'apps/ar-eye-hunter-v1/src/game/scene/arena-world-view.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 74
    }),
    // Independent whole-owner review: One persisted game mutation owner keeps fresh authorization, decision and conditional write explicit.
    // This warning-tier cap permits no growth and waives no other rule.
    Object.freeze({
        path: 'packages/relic-hunters/server/relic-game-mutation-service.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 57
    }),
    // Independent whole-owner review: One summary work lifecycle keeps claim, read, expansion, conditional write and settlement together.
    // This warning-tier cap permits no growth and waives no other rule.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 59
    }),
    // Independent whole-owner review: One immutable producer proof contract owns scoped target decoding, digesting and validation.
    // This warning-tier cap permits no growth and waives no other rule.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 50
    }),
    // Independent boundary review: Raw stored-command fields are checked by requireString before the decoder returns domain data.
    Object.freeze({
        path: 'packages/relic-hunters/server/relic-game-move.ts',
        rule: 'boundary.unknown',
        symbol: 'requireNullableString',
        maximumMagnitude: 1
    }),
    // Independent boundary review: Untrusted AI proposal data is checked by blueprint and visual-fit validators; only issues leave.
    Object.freeze({
        path: 'apps/relic-hunter-server-v1/src/relic-expedition-ai.ts',
        rule: 'boundary.unknown',
        symbol: 'validateExpeditionEvaluationBlueprint',
        maximumMagnitude: 1
    }),
    // Independent boundary review: A caught unknown is immediately normalized to Error.message or String for reporting.
    Object.freeze({
        path: 'apps/relic-hunter-server-v1/src/relic-expedition-ai.ts',
        rule: 'boundary.unknown',
        symbol: 'toErrorMessage',
        maximumMagnitude: 1
    }),
    // Whole-owner retention review: canonical ingress mapping remains one closed
    // command translation; aggregate update keeps authorization, retained metadata
    // and the resulting candidate together. These exact warning-tier sums permit
    // no growth and no function-size or hard-tier exception.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/group-mutation-command.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 50
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-group-aggregate-mutation.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 52
    }),
    // One private object decoder owns raw retention JSON. Exact-key, mode,
    // bounded-integer and fingerprint checks finish before canonical state leaves
    // this module. Its three raw annotations never become trusted policy fields.
    Object.freeze({
        path: 'packages/shared/api/group-retention.ts',
        rule: 'boundary.unknown',
        symbol: 'requireRetentionRecord',
        maximumMagnitude: 3
    }),
    // These direct group contract owners serve reusable API consumers. Retention
    // sits beside the existing group contracts; a forwarding directory would add
    // a navigation hop without introducing a new feature or lifecycle boundary.
    Object.freeze({
        path: 'packages/shared/api',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:group',
        maximumMagnitude: 7
    }),
    // Task17 whole-file self-review: this fixed local module is admitted as an
    // object with the one named callable before invocation. Import errors remain
    // visible; the assertion narrows the validated entry, never production options.
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts',
        rule: 'boundary.unknown',
        symbol: 'runStateWriteBenchmarkMode',
        maximumMagnitude: 1
    }),
    // Optional driver fields stay raw in the private transaction result. The
    // post-return decoder admits bounded signed integer text only; malformed
    // evidence becomes unavailable without changing authoritative row handling.
    Object.freeze({
        path: 'packages/shared-server/queuebox/postgres/p-sql-resource-inbox-reservation-repository.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 2
    }),
    Object.freeze({
        path: 'packages/shared-server/queuebox/postgres/to-p-sql-reservation-observations.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 2
    }),
    Object.freeze({
        path: 'packages/shared-server/queuebox/postgres/to-p-sql-reservation-observations.ts',
        rule: 'boundary.unknown',
        symbol: 'toSignedSafeMicroseconds',
        maximumMagnitude: 1
    }),
    // One pure phase projection owns record admission, redaction, shared budgets
    // and completeness. Keeping those decisions together exposes how a rejected
    // or truncated release affects the same footer; no second lifecycle exists.
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/state-write/state-write-diagnostic-projection.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 66
    }),
    // One dequeue composition owns lane selection and mandatory release. Optional
    // observation association stays at the existing claimed-attempt translation;
    // splitting that conditional would hide the point where claimed work proceeds.
    Object.freeze({
        path: 'packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 54
    }),
    // Independent whole-owner review: parsed recorder JSON stays unknown until
    // number normalization and the object guard admit ApiJsonObject. The exact
    // parse boundary has one occurrence; no raw value reaches admission policy.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/read-recorder-jsonl-rows.ts',
        rule: 'boundary.unknown',
        symbol: 'toRecorderJsonlRow',
        maximumMagnitude: 1
    }),
    // Independent whole-owner review keeps EOF, exact Connect/recipe matching,
    // current Native scope and disposal refusal in one direct admission policy.
    // This exact warning-tier cap authorizes neither growth nor an exception.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/rtc-native-acquisition.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 63
    }),
    // Independently reviewed exception boundary: report immediately normalizes
    // the caught rejection through toError; no raw value reaches domain policy.
    // Class methods have the checker's exact module-owned undefined symbol.
    Object.freeze({
        path: 'packages/shared/cache/synchronous-notifications.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // Independent whole-owner review keeps queue state, indexes, conditional
    // batches and commit publication in one visible lifecycle. This exact
    // review-tier cap permits no growth and is below the hard tier of 330.
    Object.freeze({
        path: 'packages/shared/queuebox/in-memory-queue-box.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 110
    }),
    // Existing cache/subscription owners remain directly navigable here; the
    // reusable notification owner fits this boundary without a forwarding folder.
    Object.freeze({
        path: 'packages/shared/cache',
        rule: 'layout.directory-density',
        symbol: 'cache',
        maximumMagnitude: 27
    }),
    // One resilience primitive per file (atomic-long, atomic-reference, sliding-window-counter, rate-limiter,
    // circuit-breaker and the admission, timer and settle owners), each named for its export; the cache folder
    // precedent above holds 27.
    Object.freeze({
        path: 'packages/shared/resilience',
        rule: 'layout.directory-density',
        symbol: 'resilience',
        maximumMagnitude: 22
    }),
    // Caught-value boundaries: thrown values reach these callbacks, retry predicates and the abort helpers;
    // normalising with toError changes what callers receive, so that change is a backlog item, not a silent rewrite.
    Object.freeze({
        path: 'packages/shared/cache/Command.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 9
    }),
    Object.freeze({
        path: 'packages/shared/cache/PullPushCommand.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 5
    }),
    // The ICE route's error mapper receives the caught value and narrows it with instanceof Error before use; its
    // structural response writer accepts any JSON body. Normalising with toError is the same backlog item.
    Object.freeze({
        path: 'apps/api-v1/src/routes/ice-route.ts',
        rule: 'boundary.unknown',
        symbol: 'toIceRouteErrorResponse',
        maximumMagnitude: 2
    }),
    // Independent whole-owner integration review keeps inert-data admission and
    // exact projection comparison together with their shared atomic rules.
    // This module-only cap records that cohesive algorithm, not future growth.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/computed-data-validation.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 50
    }),
    // Independent whole-owner review: JavaScript construction/Configure input
    // is untrusted until mode, legal keys and the positive safe-integer limit
    // are checked; only issue strings leave this boundary, never raw policy.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/runtime/event-history.ts',
        rule: 'boundary.unknown',
        symbol: 'validateEventHistoryPolicy'
    }),
    // One engine lifecycle owns registration fences, scheduling and bounded
    // raw-completion observation. Keeping settlement beside shutdown makes the
    // exact failure owner visible; this warning-tier cap approves no growth.
    Object.freeze({
        path: 'packages/shared/services/inbox-outbox-engine.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 51
    }),
    // The exact promise rejection boundary immediately normalizes through
    // toError before calling the synchronous failure port. No raw value escapes.
    Object.freeze({
        path: 'packages/shared/services/inbox-outbox-engine.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // These three process rejection listeners normalize directly to Error for
    // independent absence assertions; they supply no production input or policy.
    Object.freeze({
        path: 'packages/tests/shared/engine.test.ts',
        rule: 'boundary.unknown',
        symbol: 'onUnhandled',
        maximumMagnitude: 3
    }),
    // The child captures console.error's untyped argument lists; the verifier narrows the first argument with
    // typeof and compares the second with the summary the dequeuer must log, so nothing unchecked is trusted.
    Object.freeze({
        path: 'apps/api-v1/test/db/websocket-ticket-rejection-binding-child.ts',
        rule: 'boundary.unknown',
        symbol: 'verifyTicketRejection',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'apps/api-v1/test/db/websocket-ticket-rejection-binding-child.ts',
        rule: 'boundary.unknown',
        symbol: 'verifyRejectedErrors',
        maximumMagnitude: 1
    }),
    // These two process rejection listeners take Node's unknown reason and normalize it directly to Error for
    // absence assertions on the lifecycle's retries; they supply no production input or policy.
    Object.freeze({
        path: 'packages/tests/shared-server/rallar-system/websocket/ws-lifecycle-real-server-retry.test.ts',
        rule: 'boundary.unknown',
        symbol: 'onUnhandled',
        maximumMagnitude: 2
    }),
    // The anonymous stop-result callback immediately normalizes its rejection
    // to Error before the test checks the exact AggregateError membership.
    Object.freeze({
        path: 'packages/tests/shared/engine.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // Babel parser fields remain raw until object/array/type and consumed scalar
    // checks normalize them. These are the five exact reviewed traversal owners;
    // undefined identifies the current AST index field, not named-owner immunity.
    // Every future touched use still needs validation and propagation review.
    Object.freeze({
        path: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-call-graph.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-call-graph.ts',
        rule: 'boundary.unknown',
        symbol: 'findAstNode'
    }),
    Object.freeze({
        path: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-call-graph.ts',
        rule: 'boundary.unknown',
        symbol: 'visitAll'
    }),
    Object.freeze({
        path: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-call-graph.ts',
        rule: 'boundary.unknown',
        symbol: 'asNode'
    }),
    Object.freeze({
        path: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-call-graph.ts',
        rule: 'boundary.unknown',
        symbol: 'asNodes'
    }),
    // Group registration reads Babel's untrusted fields only after object/array
    // and mandatory type-string guards. The AST record retains scalar checks at each
    // consumer; neither helper admits unchecked values as domain contracts.
    Object.freeze({
        path: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-group-registration.ts',
        rule: 'boundary.unknown',
        symbol: 'asNode',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-group-registration.ts',
        rule: 'boundary.unknown',
        symbol: 'asNodes',
        maximumMagnitude: 1
    }),
    // Canonical filesystem JSON must be a record with a record imports member;
    // every target is checked as a string before the import mapping leaves.
    Object.freeze({
        path: 'apps/api-v1/test/db/native-receiver-receipts.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readNativeReceiptDenoImports'
    }),
    // The caught boundary preserves an original Error's identity and otherwise
    // normalizes through String into Error; no raw exception feeds domain policy.
    Object.freeze({
        path: 'apps/api-v1/test/db/native-receiver-receipts.test.ts',
        rule: 'boundary.unknown',
        symbol: 'toNativeReceiptFailure'
    }),
    // This caught/framework boundary immediately normalizes Error.message or
    // String into response text and derives status only from RequestAuthFailure.
    // No raw exception reaches domain logic; only this exact owner is reviewed.
    Object.freeze({
        path: 'packages/shared-server/http/request-auth-service.ts',
        rule: 'boundary.unknown',
        symbol: 'toAuthErrorResponse'
    }),
    // The native scenarios now share this ticket HTTP owner. JSON is untrusted
    // until object, non-null, property and string checks admit the ticket;
    // only that checked string leaves the manually reviewed network boundary.
    Object.freeze({
        path: 'apps/api-v1/test/db/native-session-test-fixture.ts',
        rule: 'boundary.unknown',
        symbol: 'issueNativeWebSocketTicket'
    }),
    // Caught cleanup rejections are immediately narrowed to Error or normalized
    // through String. Only a stage-labelled Error with that cause leaves this owner.
    Object.freeze({
        path: 'apps/api-v1/test/db/native-admission-test-cleanup.ts',
        rule: 'boundary.unknown',
        symbol: 'toNativeAdmissionCleanupFailure'
    }),
    // Agent review: malformed JSON fixtures feed only the guarded readiness
    // admission above; the callback never interprets or trusts the raw value.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-api-server-mode.test.ts',
        rule: 'boundary.unknown',
        symbol: 'reachable'
    }),
    // Admission, target preflight, run phases and artifact export form one
    // no-spawn operation with direct named effect adapters and visible failures.
    // The cap records this reviewed warning-tier magnitude, not future growth.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 69
    }),
    // File JSON is raw until decodeDistributedRunManifest admits the complete
    // manifest; no field is consumed or request emitted before that admission.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts',
        rule: 'boundary.unknown',
        symbol: 'readWorldFleetManifest'
    }),
    // Successful HTTP JSON passes directly to the canonical target, snapshot
    // or artifact-envelope decoder before DTO consumption or the next effect.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts',
        rule: 'boundary.unknown',
        symbol: 'readWorldFleetHttpJson'
    }),
    // The anonymous CLI rejection is immediately normalized through toError
    // for printing and exit status only; it never supplies domain state.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Module-owned bodies observe outgoing HTTP JSON for independent equality;
    // adversarial responses feed the real decoders. Child rejection reasons are
    // checked as Errors only. No fixture unknown becomes trusted domain state.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/world-fleet-runner.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // This owned network serializer sends both valid and malformed response
    // fixtures through production HTTP admission without interpreting their DTOs.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/world-fleet-runner.test.ts',
        rule: 'boundary.unknown',
        symbol: 'jsonResponse'
    }),
    // The loopback fixture captures outbound request JSON solely for literal
    // body assertions; protocol state comes from the independently authored DTO.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/world-fleet-runner.test.ts',
        rule: 'boundary.unknown',
        symbol: 'createWorldFleetCliFixture'
    }),
    // Raw defaults JSON includes malformed topology input to the actual workflow
    // Bash boundary. Anonymous child refusals are asserted as Errors and checked
    // for absent outputs/source preservation, never used as trusted DTOs.
    Object.freeze({
        path: 'packages/tests/hetzner/distributed-recipe-workflow.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Actual attempted/replacement snapshot envelopes are record-guarded before
    // their snapshot values are emitted only as opaque assertion evidence. The
    // caller independently checks complete DTOs; no raw value feeds domain logic.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/test/support/run-control-snapshot-atomic-replacement-fixture.ts',
        rule: 'boundary.unknown',
        symbol: 'runControlSnapshotAtomicReplacementFixture'
    }),
    // The native execFile rejection is immediately narrowed for captured stdout;
    // every other rejection is normalized through canonical toError, preserving
    // Error identity. No rejected value becomes trusted state or process input.
    Object.freeze({
        path: 'packages/tests/hetzner/owned-test-process.test.ts',
        rule: 'boundary.unknown',
        symbol: 'runDeadlineFixture'
    }),
    // Real-child observation JSON supplies only guarded PID cleanup and opaque
    // independent lifecycle assertions. No raw observation escapes to a domain.
    Object.freeze({
        path: 'packages/tests/hetzner/owned-test-process.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Readiness JSON is guarded before exact independent assertions and the
    // deliberately invalid variant is sent only to the real refusal boundary.
    Object.freeze({
        path: 'packages/tests/hetzner/controller-deployment.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Loaded Actions YAML is raw until its complete consumed shape validates;
    // the selected step must have an executable body and a string env map.
    Object.freeze({
        path: 'packages/tests/hetzner/headless-worker-environment.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readHeadlessEnvironmentStep'
    }),
    // These exact Actions YAML boundaries validate every consumed field with
    // the shared schema validator before narrowing. No raw YAML reaches the
    // executable workflow assertions; one occurrence per named read owner.
    Object.freeze({
        path: 'packages/tests/hetzner/hosted-operator-inspect.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readControllerWorkflow',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/hetzner/public-settings-workflow.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readWorkflow',
        maximumMagnitude: 1
    }),
    // The owned Actions expression result is untrusted until typeof proves
    // boolean; only that boolean selects the real cleanup port in this test.
    Object.freeze({
        path: 'packages/tests/hetzner/public-settings-workflow.test.ts',
        rule: 'boundary.unknown',
        symbol: 'applyWorkflowCleanup',
        maximumMagnitude: 1
    }),
    // The exact rollout-binding expression result is admitted only as a
    // boolean or environment string; tests assert actual reusable booleans.
    Object.freeze({
        path: 'packages/tests/hetzner/public-settings-workflow.test.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveRolloutBinding',
        maximumMagnitude: 1
    }),
    // Owned process recorder JSON validates every consumed argument/env field
    // before typed assertion evidence leaves the read boundary.
    Object.freeze({
        path: 'packages/tests/hetzner/headless-worker-environment.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readNpmRecord'
    }),
    // Rename-port JSON validates paths, contents and finite temporary mode
    // before typed filesystem assertions consume the record.
    Object.freeze({
        path: 'packages/tests/hetzner/headless-worker-environment.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readRenameRecord'
    }),
    // The complete consumed workflow schema admits YAML before any typed
    // source-authority, planning or credential-protection assertions.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readWorkflow'
    }),
    // Planner stdout JSON remains raw inside the anonymous owned-process test
    // until its required IDs and every numeric matrix field validate.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // The emitted GroupRef is guarded before isolation assertions; the capture
    // caller independently validates the complete canonical output manifest.
    Object.freeze({
        path: 'packages/tests/hetzner/distributed-manifest-materialization.test.ts',
        rule: 'boundary.unknown',
        symbol: 'expectCaptureManifestIsolation'
    }),
    // Parsed outputs remain opaque assertion evidence for exact capture/data
    // preservation and hashes; executable manifests use the canonical decoder.
    Object.freeze({
        path: 'packages/tests/hetzner/distributed-manifest-materialization.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Incoming reports pass their complete canonical schema before the typed
    // consumed-field projection; malformed reports fail at this same boundary.
    Object.freeze({
        path: 'packages/tests/hetzner/distributed-operation-artifacts.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readOperationReport'
    }),
    // Checked child JSON is compared only with independent persistence oracles;
    // inline commands are accessed only after canonical manifest admission.
    Object.freeze({
        path: 'packages/tests/hetzner/distributed-operation-artifacts.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Each package path segment is record-guarded and only the checked final
    // string escapes; no raw package object becomes trusted domain metadata.
    Object.freeze({
        path: 'packages/tests/hetzner/playwright-browser-installation.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readPackageString'
    }),
    // Parsed package/lock data reaches the checked string reader before exact
    // independent version assertions; no opaque value supplies runtime state.
    Object.freeze({
        path: 'packages/tests/hetzner/playwright-browser-installation.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Loaded YAML remains raw until the complete consumed-document schema
    // validates it; sparse workflow fields preserve meaningful omission.
    Object.freeze({
        path: 'packages/tests/hetzner/distributed-recipe-workflow.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readWorkflow'
    }),
    // Authored readiness JSON stays raw inside this decoder until the canonical
    // rtc.connect command schema validates it; only the typed result escapes.
    Object.freeze({
        path: 'apps/rallar-black-box/src/manual-workbench/manual-command-fields.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeManualRtcReadinessText'
    }),
    // The anonymous Reset test compares parsed stored JSON directly with its
    // independent persistence oracle; it never supplies trusted runtime state.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/manual-workbench-actions.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // The anonymous negative-recipe test validates parsed JSON against the
    // canonical recipe schema before its cast and exact command assertions.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/manual-workbench.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Console Execute's outgoing HTTP fixture serializer keeps its body opaque:
    // JSON.stringify feeds route.fulfill without domain interpretation, and no
    // unknown result escapes. Typed responses stay with their fixture owners.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/recipe-console-execute-control-fixture.ts',
        rule: 'boundary.unknown',
        symbol: 'fulfillExecuteJsonResponse'
    }),
    // Exact reviewed RTC evidence/control owners (Task62/63 and Task64 round1).
    // Each numeric cap bounds the observed coherent capability/shell magnitude;
    // no function-size, other-path or future-growth exception is implied.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/control-evidence-compaction.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 79
    }),
    // One local runtime lifecycle owns bootstrap, command submission and visible
    // state; the optional run intent keeps omission explicit in that same shell.
    Object.freeze({
        path: 'apps/rallar-black-box/src/runtime-store.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 51
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/composite-results.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 73
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control-client.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 62
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control-protocol.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 54
    }),
    // Acknowledged recipe selection and returned capture attribution form one
    // stateless admission decision; returned identity cannot choose requirements.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control/control-rtc-capture-evidence.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 91
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/recipe/recipe-capture-requirements.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 76
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/recipe/snapshot-executable-recipe.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 71
    }),
    // One admitted assignment owns capture, recipe bodies, cached results,
    // events and cleanup. Ledger and congestion reads choose admitted/current
    // state and fence successor publication after both awaits in that same shell.
    // Synchronous clocks, IDs, listeners and external fallback also recheck that
    // same assignment before effects. This cap authorizes no other rule or growth.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 117
    }),
    // Workbench JSON.parse remains raw until its selected schema validates it.
    Object.freeze({
        path: 'apps/rallar-black-box/src/runtime-store.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Only the two changed CRDT transport ingress owners: raw selection fields
    // and parseCrdtTransport normalize to one finite transport before execution.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'parseCrdtTransport'
    }),
    // Snapshot traversal owns structured decision operands only; unknown stays
    // local before validation, and outgoing application payloads remain opaque.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/recipe/snapshot-executable-recipe.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Opaque wire payload and three actual finite decoding ingress owners.
    // Raw messages are narrowed before result/command domain admission.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control-protocol.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control-protocol.ts',
        rule: 'boundary.unknown',
        symbol: 'parseControlServerMessage'
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control-protocol.ts',
        rule: 'boundary.unknown',
        symbol: 'parseControlClientMessage'
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control-protocol.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeControlEnvelopeRecord'
    }),
    // Accepted malformed-fixture owners construct raw trees or join decoder
    // issues/limitations only for assertions; neither is trusted execution input.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/distributed-recipe-tuning-hardening.test.ts',
        rule: 'boundary.unknown',
        symbol: 'nested'
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/distributed-recipe-tuning-hardening.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Independent Task61 review: these anonymous native-test JSON boundaries
    // are exact module owners (symbol undefined), not named-function waivers.
    // HTTP records/files/strings are guarded before local assertions; snapshots
    // use public decoders/collection validation before restore. Serialized body
    // and manifest observations go directly to independent literal equality.
    // No unknown becomes trusted execution input. Every future touched use in
    // these owners needs full validation/equality and propagation review; this
    // inventory neither counts nor certifies future occurrences.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/test/control-distributed-api.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/test/control-distributed-service.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/test/distributed-run-request-codec.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // The existing browser facade entry exports the single intentional public
    // surface; concrete capabilities remain owned in their feature modules.
    // Its typed capture refusal adds the thirteenth value; further exports
    // remain outside this exact reviewed inventory.
    Object.freeze({
        path: 'packages/shared-web/browser/rallar.ts',
        rule: 'file.responsibility-count',
        symbol: undefined,
        maximumMagnitude: 13
    }),
    // This anonymous room-update test captures decoded HTTP request bodies only
    // for independent assertions. Its response uses a hand-derived fixture;
    // no captured unknown value supplies domain state or response construction.
    Object.freeze({
        path: 'packages/tests/shared-web/rooms/update-room.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // These SDK ingress boundaries validate untrusted selections or narrow
    // arbitrary framework rejection reasons through instanceof before policy.
    // Retry classification deliberately preserves its public no-coercion rule.
    Object.freeze({
        path: 'packages/shared/webrtc/rtc-capture-configuration.ts',
        rule: 'boundary.unknown',
        symbol: 'parseRtcCaptureMode'
    }),
    Object.freeze({
        path: 'packages/shared-web/browser/rallar-operation-options.ts',
        rule: 'boundary.unknown',
        symbol: 'shouldRetryRallarOperation'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/remote-browser-command-preparation.test.ts',
        rule: 'control.nested-callback-depth',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    // One proof socket owns native events, scoped assembly, causal observation
    // and wait cleanup. Its JSON identity decoder and rejected-promise test
    // capture are raw boundaries; emitted diagnostics use named contracts.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-proof-websocket.mts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 56
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-proof-websocket.mts',
        rule: 'boundary.unknown',
        symbol: 'readProofTopologyDeliveryKind'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/api-v1-rtc-topology-replay-proof.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Scenario composition, provider selection, recipe expansion, execution
    // and reporting have distinct linked owners beneath this public runner
    // root. Five navigation probes support retaining the current entry files.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner',
        rule: 'layout.directory-density',
        symbol: 'black-box-runner',
        maximumMagnitude: 22
    }),
    // The receipt validator accepts raw artifact input before narrowing its
    // fields. Its malformed-artifact test deliberately crosses that same
    // JSON boundary and checks exact validation/comparison diagnostics.
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/api-v1-state-write-result-binding.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-server/performance/state-write/state-write-malformed-evidence.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/execute-local-ws-interaction.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Pre-existing JSON-shaped harness contract; the typed closure is a separate slice.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/api-v1-websocket-scope-recipes.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/browser-diagnostics.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/browser-routing.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/browser-routing.test.ts',
        rule: 'boundary.unknown',
        symbol: 'evaluatePage'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/browser-routing.test.ts',
        rule: 'boundary.unknown',
        symbol: 'createPage'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/browser-session.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/client-contract.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/client-provider.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/data-channel.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/fake-rtc-client.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/fake-rtc-client.ts',
        rule: 'boundary.unknown',
        symbol: 'messageHandler'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/fake-rtc-client.ts',
        rule: 'boundary.unknown',
        symbol: 'closeHandler'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/fake-rtc-client.ts',
        rule: 'boundary.unknown',
        symbol: 'createFakeRtcClient'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc-client-provider/runtime-provider.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rtc/rtc-wait-expectations.test.ts',
        rule: 'boundary.unknown',
        symbol: 'createWaitInput'
    }),
    // API state files expose separate mutation, event-cursor, point-read and
    // paged-dissemination contracts. Their direct consumers and README recover
    // each owner without another folder or forwarding module.
    Object.freeze({
        path: 'packages/shared/api',
        rule: 'layout.directory-density',
        symbol: 'api',
        maximumMagnitude: 24
    }),
    Object.freeze({
        path: 'packages/shared/api',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:state',
        maximumMagnitude: 4
    }),
    // Independent whole-owner review retains PostgreSQL admission, reservation,
    // finalization, presence and index policy beside their backend. The queuebox
    // README maps entry, result and failure owners; prefixes name those owners.
    Object.freeze({
        path: 'packages/shared-server/queuebox/postgres',
        rule: 'layout.directory-density',
        symbol: 'postgres',
        maximumMagnitude: 21
    }),
    Object.freeze({
        path: 'packages/shared-server/queuebox/postgres',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:p',
        maximumMagnitude: 8
    }),
    Object.freeze({
        path: 'packages/shared-server/queuebox/postgres',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:resource',
        maximumMagnitude: 10
    }),
    // In-memory and IndexedDB implement the same queue contract. Their README
    // maps admission, selection, release and failure paths without forwarding
    // folders. Shared resource policy and codecs remain directly beside stores.
    Object.freeze({
        path: 'packages/shared/queuebox',
        rule: 'layout.directory-density',
        symbol: 'queuebox',
        maximumMagnitude: 22
    }),
    // The eighth IndexedDB owner performs fair eligible traversal; the store,
    // codec, entry, conflict and pure release/write owners keep their boundaries.
    // These exact reviewed counts approve neither new prefixes nor future growth.
    Object.freeze({
        path: 'packages/shared/queuebox',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:indexed',
        maximumMagnitude: 8
    }),
    Object.freeze({
        path: 'packages/shared/queuebox',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:resource',
        maximumMagnitude: 4
    }),
    // The inbound ALM directory is one feature: admission, ordered and admitted
    // delivery, the durable effect store, the work entries and the resynchronization
    // cursor, each a direct owner the README maps. Its files share the al-inbound
    // prefix because they are that feature's vocabulary, not a role split.
    Object.freeze({
        path: 'packages/shared/alm/inbound',
        rule: 'layout.directory-density',
        symbol: 'inbound',
        maximumMagnitude: 22
    }),
    Object.freeze({
        path: 'packages/shared/alm/inbound',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:al',
        maximumMagnitude: 19
    }),
    // The ALM conformance catalog is one feature: the scenario definitions, the
    // command builders by concern (message, receipt, receiver, session, fault,
    // ordering, diagnostic waits), the four identity assessments and the
    // observation regimes, each a direct owner the harness docs map. Its
    // scenarios sit beside it.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/conformance/alm',
        rule: 'layout.directory-density',
        symbol: 'alm',
        maximumMagnitude: 22
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/conformance/alm',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:assess',
        maximumMagnitude: 4
    }),
    // The outbound ALM directory is one feature: dispatch, repair admission and
    // retransmission, control admission, effect identities and the own-hop
    // predicate both repair owners share, each a direct owner the README maps.
    Object.freeze({
        path: 'packages/shared/alm/outbound',
        rule: 'layout.directory-density',
        symbol: 'outbound',
        maximumMagnitude: 22
    }),
    // These tests own deliberate malformed signaling/graph inputs and raw
    // decoded WebSocket captures. Values go straight to the production
    // boundary or an assertion; they do not supply unvalidated domain state.
    Object.freeze({
        path: 'packages/tests/shared-server/rallar-system/communication/decode-rtc-signaling-route.test.ts',
        rule: 'boundary.unknown',
        symbol: 'createSignal'
    }),
    Object.freeze({
        path: 'packages/tests/shared/al-message-resource-limits.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared/websocket/json-message-limits.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // This predicate checks typeof, null and property presence before comparing
    // kind. Only a boolean leaves the boundary; its unknown values stay local.
    // The checker reports the boolean signature as a manual-review signal.
    Object.freeze({
        path: 'tests/playwright/relic-hunters/web.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'isCommandKind'
    }),
    // The run-monitor spec mocks the control server and the API inside anonymous
    // test callbacks: route handlers receive raw request bodies, mock services take
    // raw configuration, and one window global is cast at the DOM boundary. Every
    // unknown stays inside its mock and feeds no domain decision; this cap
    // approves the ten existing occurrences and no growth.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/tabbed-navigation.spec.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 10
    }),
    // This caught-value boundary immediately normalizes arbitrary thrown values
    // to Error, exactly as required by the code standard. No unknown value
    // propagates to callers; the textual checker cannot distinguish that case.
    Object.freeze({
        path: 'packages/shared/resilience/to-error.ts',
        rule: 'boundary.unknown',
        symbol: 'toError'
    }),
    // An error summary carries the thrown error's own enumerable properties as the log line's data: any
    // throwable may set any property, so their values are untrusted by construction, and no caller reads them
    // as domain state. One contract field; a second use needs its own review.
    Object.freeze({
        path: 'packages/shared/resilience/to-error.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // These exact JSON readers reject malformed input at the external boundary
    // and recursively produce only RtcBaselineJson. No unknown values propagate
    // into their callers or domain decisions.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/live-rtc-evidence-json.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeJson'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/live-rtc-evidence-json.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeJsonValue'
    }),
    // Raw filesystem compiler options stay local to rejection checks: baseUrl
    // and ignoreDeprecations use key presence, skipLibCheck compares true, and
    // types uses Array.isArray. Only problem strings leave these four fields;
    // no raw value supplies execution config or trusted domain state.
    Object.freeze({
        path: 'packages/tests/repo/typescript-7-boundaries.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // erasableSyntaxOnly migration: converting parameter properties to explicit
    // fields duplicates each `unknown`-typed parameter annotation into a field
    // declaration (+1 textual occurrence per file, no new unknown values). These
    // two module-owner entries accept exactly that; remove them when the
    // affected classes gain precise persisted-value types or the boundary rule
    // moves to the metric-based checker.
    Object.freeze({
        path: 'packages/shared-web/browser/rallar-data.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/rallar-ai/rallar-ai-types.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeRtcBaselineJson'
    }),
    Object.freeze({
        path: 'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
        rule: 'layout.primary-export-name',
        symbol: 'parseRtcBaselineCommand'
    }),
    // This runtime capability module intentionally uses a noun-based filename:
    // it contains the cohesive helpers needed to construct that capability,
    // while the checker sees only the exported factory as the primary symbol.
    Object.freeze({
        path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-repeat-initializer.ts',
        rule: 'layout.primary-export-name',
        symbol: 'createRtcBaselineRepeatInitializer'
    }),
    // HTTP JSON remains opaque evidence compared with the real persisted result;
    // no response body becomes command input or authoritative group/member state.
    // Undefined is the checker's exact contract owner, not a named-function waiver.
    Object.freeze({
        path: 'apps/api-v1/test/db/pglite-concurrent-group-setup.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Caught values are narrowed through typed errors and guarded code extraction
    // before producing the finite AppInbox failure classification. Raw exceptions
    // never become mutation facts, authorization input or durable domain state.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts',
        rule: 'boundary.unknown',
        symbol: 'classifyAppInboxError'
    }),
    // Property presence/type and instanceof Error guard this caught-value read;
    // only a string code/name leaves the boundary for the owned failure policy.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts',
        rule: 'boundary.unknown',
        symbol: 'toAppInboxErrorCode'
    }),
    // Error.message or String converts the caught value into failure text only;
    // code/status come from the classifier's policy, never from raw domain input.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts',
        rule: 'boundary.unknown',
        symbol: 'toExplicitStatusFailure'
    }),
    // AppInbox accepts raw JSON only at this exact decoder. It immediately
    // validates the complete persisted command as JsonWireValue before any
    // identity, routing, hashing, or domain decision consumes it.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeAppInboxEnqueue'
    }),
    // Client-state record decoding is the single raw-object boundary for the
    // operation-specific command, persisted-state, and result validators. It
    // immediately rejects non-plain objects and returns the narrowed record
    // vocabulary consumed by every downstream scalar validator.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/client-state/validation/' +
            'client-record-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeClientValidationRecord'
    }),
    // Group-state record admission is the raw-object boundary that eight persisted,
    // command, fact and result validators share. It rejects non-objects and arrays before
    // returning the named record vocabulary; renaming it to a decoder would pull
    // every caller into closure, so its one unknown parameter stays reviewed here.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/group-state-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'requireRecord',
        maximumMagnitude: 1
    }),
    // JSON content equality and stable serialization accept any caller value, as JSON.stringify does: jsonEquals
    // narrows plain trees through isPlainJsonValue and serializes anything else, and the stable serializers hand any
    // caller value to the serializer's own conversion. The matcher keys on the owner function, so the one reviewed
    // boundary is these four rows; a new owner needs its own review.
    Object.freeze({
        path: 'packages/shared/repository/state-utils.ts',
        rule: 'boundary.unknown',
        symbol: 'jsonEquals',
        maximumMagnitude: 2
    }),
    Object.freeze({
        path: 'packages/shared/repository/state-utils.ts',
        rule: 'boundary.unknown',
        symbol: 'stableJsonStringify',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared/repository/state-utils.ts',
        rule: 'boundary.unknown',
        symbol: 'toStableJson',
        maximumMagnitude: 2
    }),
    Object.freeze({
        path: 'packages/shared/repository/state-utils.ts',
        rule: 'boundary.unknown',
        symbol: 'toOrderedJson',
        maximumMagnitude: 2
    }),
    // RTC RTT persistence decoders own the untrusted persisted-JSON boundary.
    // Each listed owner validates or narrows its unknown input before domain use;
    // keep these exact symbols reviewed while the checker treats all unknown
    // annotations as propagation, regardless of that immediate normalization.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'readRtcRttPersistedRecord'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'assertExactRtcRttPersistedKeys'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'assertNonEmptyRtcRttString'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'assertRtcRttSafeInteger'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRtcRttCommandHash'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRtcRttMutationReceipt'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRtcRttMeasurement'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRtcRttEndpointAdmission'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateCanonicalGroupRef'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateExpectedRevision'
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/decode-rtc-signaling-message.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeRtcSignal'
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/decode-rtc-signaling-message.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeIceCandidate'
    }),
    Object.freeze({
        path:
            'packages/tests/shared-server/rallar-system/group-state/presence/group-presence-summary-delta-emission.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readEventRowPayload'
    }),
    Object.freeze({
        path: 'packages/tests/shared-server/rallar-system/group-state/presence/group-state-delta-envelope.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readGroupStateEventRowEnvelope'
    }),
    // Group command and persisted-evidence readers narrow raw JSON before any
    // identity, policy, receipt, or benchmark decision consumes it.
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
        rule: 'boundary.unknown',
        symbol: 'isGroupInputRecord'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
        rule: 'boundary.unknown',
        symbol: 'validateGroupInputFields'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveGroupInputFieldIssue'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
        rule: 'boundary.unknown',
        symbol: 'validateGroupInputJson'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
        rule: 'boundary.unknown',
        symbol: 'validateGroupLifecyclePolicyInputShape'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
        rule: 'boundary.unknown',
        symbol: 'validatePolicyObject'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
        rule: 'boundary.unknown',
        symbol: 'validatePolicyField'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
        rule: 'boundary.unknown',
        symbol: 'validateTrigger'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
        rule: 'boundary.unknown',
        symbol: 'validateNumber'
    }),
    Object.freeze({
        path:
            'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-operation-input.ts',
        rule: 'boundary.unknown',
        symbol: 'validateExpectedLayout'
    }),
    // Raw state-write options stay inside this one validation/snapshot boundary.
    // Every consumed scalar, array, effect map and nested fixture field validates
    // before the named spec handoff; optional collections are then copied. The
    // warning-tier cap records this cohesive grammar, not future growth.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/to-api-v1-state-write-evidence-spec.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 55
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/to-api-v1-state-write-evidence-spec.ts',
        rule: 'boundary.unknown',
        symbol: 'toApiV1StateWriteEvidenceSpec',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/to-api-v1-state-write-evidence-spec.ts',
        rule: 'boundary.unknown',
        symbol: 'validateStateWriteEvidenceSpecShape',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/to-api-v1-state-write-evidence-spec.ts',
        rule: 'boundary.unknown',
        symbol: 'validateOverdueRecoveryFixtureShape',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/to-api-v1-state-write-evidence-spec.ts',
        rule: 'boundary.unknown',
        symbol: 'isRecord',
        maximumMagnitude: 1
    }),
    // These raw SQL options go directly to the complete spec boundary above,
    // before the first query. No unvalidated input feeds SQL or fixture policy.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/state-write-evidence/collect-api-v1-state-write-evidence-from-sql.ts',
        rule: 'boundary.unknown',
        symbol: 'collectApiV1StateWriteEvidenceFromSql',
        maximumMagnitude: 1
    }),
    // Raw options cross source selection and the PGlite process wire without
    // field consumption. PostgreSQL forwards directly to the SQL spec validator;
    // PGlite serializes to its reader, which invokes that same validator before
    // evidence queries or fixture policy. Preserve snapshot acquisition order.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts',
        rule: 'boundary.unknown',
        symbol: 'collectApiV1StateWriteEvidence',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts',
        rule: 'boundary.unknown',
        symbol: 'readPGliteStateWriteEvidenceSnapshot',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts',
        rule: 'boundary.unknown',
        symbol: 'runPGliteSnapshotReader',
        maximumMagnitude: 1
    }),
    // The parsed message envelope is narrowed by object, presence and string
    // checks; only the two checked identity strings leave this pure boundary.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-derivation.ts',
        rule: 'boundary.unknown',
        symbol: 'toEvidenceMessageIdentity',
        maximumMagnitude: 1
    }),
    // Both input and result contracts retain opaque intermediate SQL rows;
    // only their count and unchanged artifact retention inform evidence. The
    // gate aggregates both annotations for this exact module owner.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-derivation.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 2
    }),
    // JavaScript handlers may reject with any value. Six annotations retain
    // that identity in context, retry predicates/observers, exhausted causes
    // and periodic abort/failure rejection; no trusted domain fields are read.
    // The scanner assigns these class/callable facts to this module owner.
    Object.freeze({
        path: 'packages/shared/resilience/try-with-policy.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 6
    }),
    // Candidate event and snapshot are deliberately malformed test inputs.
    // Both serialize directly into durable result JSON for production derive
    // validation; authoritative receipt fields use the authored typed event.
    Object.freeze({
        path: 'packages/tests/shared-test/group-state-write-evidence-fixtures.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 2
    }),
    // Deliberately malformed JSON enters the real SQL option validator. The
    // test asserts refusal before any query; raw input never becomes authority.
    Object.freeze({
        path: 'packages/tests/shared-test/api-v1-state-write-evidence-source.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path:
            'packages/tests/shared-server/rallar-system/group-state/persistence/group-state-repository-identity.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/api-v1-state-write-group-receipt-evidence.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // The presence-summary work decoder and the activation-status clock decoder
    // narrow their persisted JSON before any group or clock decision reads it.
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'toGroupPresenceSummaryWork'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'requireRecord'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'requireExactKeys'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'requireNullableNonEmptyString'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'requireNonNegativeSafeInteger'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'requirePlainTime'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'requirePlainDateTime'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'requireInstant'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts',
        rule: 'boundary.unknown',
        symbol: 'requireOptionalInstant'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/activation-status-clock-outbox-entry.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeActivationStatusClockWork'
    }),
    // These reviewed AL/control/snapshot/queue decoders keep raw values inside
    // their validation boundary. Generic JSON sockets deliberately preserve
    // opaque application values until their protocol consumer decodes them.
    // Module-owner entries reflect the checker-owned scope, not approval for
    // future unknown propagation; every touched owner still needs full review.
    Object.freeze({
        path: 'packages/shared/al-contracts/al-control-value-codec.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-control-value-codec.ts',
        rule: 'boundary.unknown',
        symbol: 'readControlArrayEntries'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-control-value-codec.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeAckStatus'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-control-value-codec.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeNackReason'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-control-value-codec.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeRepairReason'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-control-value-codec.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeReceiptPhase'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-control-value-codec.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeALDeliveryCarrier'
    }),
    // The inbound runtime admits a raw carrier value: a WS frame or an RTC datum
    // whose only shape is what decodeALMessageValue proves before any planning.
    Object.freeze({
        path: 'packages/shared/alm/inbound/al-inbound-message-runtime.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // One heterogeneous admission row or checkpoint value stays raw in memory.
    // read/list and write-buffer reads decode it with the caller's canonical
    // decoder; the volatile sweep decodes it before any domain decision.
    Object.freeze({
        path: 'packages/shared/alm/al-admission-backend.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-control.ts',
        rule: 'boundary.unknown',
        symbol: 'parseControlPayload'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-message-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-message-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeALMessageEnvelope'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-message-resource-limits.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-message-resource-limits.ts',
        rule: 'boundary.unknown',
        symbol: 'validateALMessageResourceLimits'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-message-resource-limits.ts',
        rule: 'boundary.unknown',
        symbol: 'computeALMessageEnvelopeBytes'
    }),
    Object.freeze({
        path: 'packages/shared/al-contracts/al-message-resource-limits.ts',
        rule: 'boundary.unknown',
        symbol: 'computeALMessageEnvelopeSize'
    }),
    Object.freeze({
        path: 'packages/shared/api/state-snapshot-page.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeStateSnapshotPage'
    }),
    Object.freeze({
        path: 'packages/shared/api/state-snapshot-page.ts',
        rule: 'boundary.unknown',
        symbol: 'isSnapshotPage'
    }),
    Object.freeze({
        path: 'packages/shared/api/state-snapshot-page.ts',
        rule: 'boundary.unknown',
        symbol: 'validSnapshotScope'
    }),
    Object.freeze({
        path: 'packages/shared/api/state-snapshot-page.ts',
        rule: 'boundary.unknown',
        symbol: 'validPageInteger'
    }),
    Object.freeze({
        path: 'packages/shared/api/state-snapshot-page.ts',
        rule: 'boundary.unknown',
        symbol: 'matchesPageMessageId'
    }),
    Object.freeze({
        path: 'packages/shared/queuebox/rtc-topology-work-entry-contract.ts',
        rule: 'boundary.unknown',
        symbol: 'readRtcTopologyWorkMessage'
    }),
    Object.freeze({
        path: 'packages/shared/websocket/json-web-socket-client.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/websocket/json-web-socket-server.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // The bounded untrusted-value traversal and the snapshot page wire codec
    // each keep one coherent algorithm together. These caps cover the reviewed
    // warning magnitudes only and do not authorize exception-tier growth.
    Object.freeze({
        path: 'packages/shared/al-contracts/al-message-resource-limits.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 85
    }),
    Object.freeze({
        path: 'packages/shared/api/state-snapshot-page.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 80
    }),
    // These exact ingress owners decode socket/envelope values before admission
    // or any domain mutation. The snapshot discriminator returns only a boolean;
    // its parsed value never leaves the nested payload boundary.
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-client-service.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts',
        rule: 'boundary.unknown',
        symbol: 'isStateSnapshotPageResource'
    }),
    // QoS normalization resolves every aspect of one requested policy against
    // capabilities, authorization and live conditions in a single visible pass.
    // The cap is the exact reviewed magnitude, not permission to grow.
    Object.freeze({
        path: 'packages/shared/al-contracts/normalize-al-qos-policy.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 79
    }),
    // The transport shells preserve visible decode/identity/authority/admission
    // sequencing. Queue reservation/release, auth intent/replay, and topology
    // hydration likewise each share one owned operation and lifecycle. Their
    // clocks and ID generation are explicit dependencies at composition.
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-client-service.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 57
    }),
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 81
    }),
    Object.freeze({
        path: 'packages/shared-server/queuebox/postgres/p-sql-queue-box.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 56
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 53
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/topology/replay/hydration/rtc-topology-reconnect-hydration.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 56
    }),
    // One native channel lifecycle binds receive callbacks, pressure, queued
    // settlement, cancellation, exact-parent capture and reset. Pure queue
    // policy and finite native reads have their own stateless boundaries.
    // Raw and decoded test captures observe that native boundary for assertions.
    Object.freeze({
        path: 'packages/shared/webrtc/qrtc-data-channel.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 177
    }),
    Object.freeze({
        path: 'packages/tests/shared/qrtc-data-channel.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Performance artifacts enter these raw validators before any arithmetic,
    // string operation, linking, or aggregate derivation. Rejected shapes keep
    // their field diagnostics through both comparison roles; guarded derivation
    // still reports semantic mismatches. The benchmark retains an opaque
    // rejected promise reason rethrown after its existing drain settles.
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/api-v1-state-write-artifact-validation.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/compare-api-v1-state-write-results.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/validate-state-write-attempt-evidence.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/validate-state-write-durable-evidence.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // The corruption fixture deliberately writes malformed persisted fields so
    // the actual admission reader/worker can reject them. The snapshot fixture
    // decodes every captured wire value before the production bounded assembler.
    Object.freeze({
        path: 'packages/tests/shared/alm/al-outbound-admission-decoding.test.ts',
        rule: 'boundary.unknown',
        symbol: 'writeRawOutboundWork'
    }),
    Object.freeze({
        path: 'packages/tests/shared/state-snapshot-test-fixture.ts',
        rule: 'boundary.unknown',
        symbol: 'assembleStateSnapshotMessages'
    }),
    // Original entry/setup/watchdog/deletion and capture share one service
    // lifecycle; finite row translation already has its adjacent owner.
    Object.freeze({
        path: 'packages/shared/services/web-rtc-connection-service.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 142
    }),
    // Admission decoding keeps the stored identity and the captured dispatch
    // policy together. Retry, repair, supersedence and acknowledgement fields
    // each have a direct decoder; none owns another lifecycle or store.
    // This exact warning-tier cap records that cohesion review, not permission
    // to grow or to change the persisted contract.
    Object.freeze({
        path: 'packages/shared/alm/outbound/admission/al-outbound-admission-validation.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 56
    }),
    // Live delivery owns the synchronous admission-to-socket attempt and its
    // caller-visible result. Keeping generation capture, encoding, expiry,
    // final authority checks and per-recipient failure accounting here exposes
    // the one-attempt boundary without adding a transport facade or lifecycle.
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-server/ws-queue-box-server-live-delivery.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 51
    }),
    // These reviewed owners keep one optimistic admission lifecycle and one
    // peer receive lifecycle respectively. Storage and heartbeat have direct
    // named owners.
    Object.freeze({
        path: 'packages/shared/alm/outbound/al-outbound-dispatch-admission.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 59
    }),
    // The decision reads of one dispatch stay together: the one read that also asks
    // whether a repair attempt's sends are already committed keeps the budget charge
    // under the same sender fence as the plan it charges for.
    Object.freeze({
        path: 'packages/shared/alm/outbound/admission/al-outbound-admission-reads.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 50
    }),
    Object.freeze({
        path: 'packages/shared/services/web-rtc-rx-streamer-service.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 53
    }),
    // Promise rejection reasons are untrusted exception-boundary values. The
    // owner normalizes them through the canonical toError before returning
    // settlement evidence; no unknown reason is used as domain state.
    Object.freeze({
        path: 'packages/tests/shared/alm/outbound-control-handoff.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Origin, scope, protocol, application authority and connection currentness
    // are gates of one socket admission. Delivery remains with its own owner;
    // separating these gates would obscure the candidate-to-refusal path.
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-server/ws-queue-box-server-inbound-authority.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 53
    }),
    // One receipt sanitizer owns nine closed record kinds, including terminal
    // ACK identity, owner/stage and guard/deadline relations. Adjacent schema
    // decisions produce safe JSON without a transport or authority lifecycle;
    // this reviewed warning-tier cap does not authorize future growth.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 87
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeReceiptReturn'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeClosedReceiptFields'
    }),
    // Ordinary socket JSON is raw until closed identity/result fields and its
    // complete optional scope validate. Only safe JSON leaves these exact owners.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeBusinessSocketDecision'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeAuthenticatedScope'
    }),
    // The decoded claim's receipt projection narrows JSON bytes to a frozen,
    // closed fact contract. Raw identities become compact locators; no unknown
    // or application payload escapes into work policy or the observation DTO.
    Object.freeze({
        path: 'packages/shared/alm/outbound/lane/al-outbound-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toALOutboundReceiptFacts'
    }),
    Object.freeze({
        path: 'packages/shared/alm/outbound/lane/al-outbound-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'isReceiptFacts'
    }),
    // Selection, execution, release and readiness are one batch lifecycle. Its
    // private capture-enabled buffer drains only after that mandatory lifecycle;
    // the outbound README traces each real owner without a generic event layer.
    Object.freeze({
        path: 'packages/shared/alm/work/al-work-handler.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 52
    }),
    // Private receipt capture decodes raw stdout JSON into a closed safe JSON
    // projection. These exact decoder/field-retention symbols validate each raw
    // value before retaining it; no unknown reaches authority or count policy.
    // The socket ACK projection likewise checks only the private closed shape,
    // never authorization or receipt-count policy. Re-review touched symbols.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-timing-record.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeApiTimingRecord'
    }),
    // The promotion log record remains raw until its exact operation, scope,
    // timing, outcome and layout labels validate. Only those safe fields leave
    // this private projection; one reviewed occurrence permits no growth.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-timing-record.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeTopologyPromotionRecord',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-timing-record.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeTimingContext'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-timing-record.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeTimingDetails'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeApiWsReceiptObservation'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeSocketDecision'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeAckCount'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeAckRelay'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeReceiptOutbox'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeAck'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeAckIdentity'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeAggregate'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeReceipt'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toSafeOutboxVerdict'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'retainSafeIdentity'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'retainSafeNumber'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'retainSafeRejection'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'isApiTimingRecord'
    }),
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'toWsQueueBoxServerReceiptAckFacts'
    }),
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts',
        rule: 'boundary.unknown',
        symbol: 'isClosedAck'
    }),
    // Receipt aggregation is one bounded frozen-audience/count/deadline
    // lifecycle, including terminal ACK facts from its existing validator.
    // Count and immutable enqueue projections remain beside their effects;
    // the README exposes both callback timelines.
    // This exact warning-tier cap is a cohesion review, not a hard-tier exception.
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 66
    }),
    // This one WS feature has direct authority, delivery, relay, receipt and
    // scope owners. Its README maps construction and five runtime probes; no
    // pass-through folder improves the owner-to-result route at this density.
    Object.freeze({
        path: 'packages/shared/services/ws-queue-box-server',
        rule: 'layout.directory-density',
        symbol: 'ws-queue-box-server',
        maximumMagnitude: 21
    }),
    // Native wire input stays within this positive finite grammar: discriminants,
    // allowed keys, complete nested readouts and scalar bounds are validated before
    // JSON output. These are exact checker owners, including overflow owners; no
    // module-wide unknown disposition applies to this projection.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toRtcNativeObservationProjection'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toNativeBody'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toNativeControlBody'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toRtcNativeIdentity'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toNativeSnapshot'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toNativeState'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toNativeError'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toNativeErrorFacts'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toErrorReadout'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toErrorCoverage'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toCaptureStatus'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toCandidate'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toService'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toServiceStage'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toCompactChannel'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toPeerSetup'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toTimeoutReadout'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toReadout'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'toJsonObject'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'hasOnlyKeys'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'isOneOf'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'isIdentityText'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'isNonnegative'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'boundary.unknown',
        symbol: 'isInteger'
    }),
    // The queue error-read port and guarded reader translate an untrusted caught
    // value into canonical finite facts. A failed reader yields unavailable facts;
    // original FIFO, accounting and rejected-value identity remain business owned.
    Object.freeze({
        path: 'packages/shared/webrtc/flush-rtc-ice-candidate-queue.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/flush-rtc-ice-candidate-queue.ts',
        rule: 'boundary.unknown',
        symbol: 'readCandidateError'
    }),
    // The checker reports no symbol for class methods, generic finite readers
    // and anonymous test callbacks below. Undefined is an exact checker owner,
    // not per-method immunity: newly touched uses still require manual review.
    // The peer brackets synchronous original-binding reads and retains no raw error.
    Object.freeze({
        path: 'packages/shared/webrtc/qrtc-peer-connection.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Guarded native enum/integer/error/candidate/transport reads immediately
    // become finite readouts or bounded fragment comparison. No native value
    // escapes into wire output or a second lifecycle owner.
    Object.freeze({
        path: 'packages/shared/webrtc/rtc-native-observation-values.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/rtc-native-observation-values.ts',
        rule: 'boundary.unknown',
        symbol: 'readRtcInteger'
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/rtc-native-observation-values.ts',
        rule: 'boundary.unknown',
        symbol: 'readRtcNativeErrorFacts'
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/rtc-native-observation-values.ts',
        rule: 'boundary.unknown',
        symbol: 'readRtcCandidateFragments'
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/rtc-native-observation-values.ts',
        rule: 'boundary.unknown',
        symbol: 'readRtcDataIceFragmentComparison'
    }),
    // The anonymous test warning capture verifies the exact original caught Error
    // reference reaches the existing warning effect; normalization would erase
    // that assertion. The raw value never becomes production or wire state.
    Object.freeze({
        path: 'packages/tests/shared/webrtc/rtc-native-candidate-observation.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Reviewed cohesion: one complete positive wire grammar, the original native
    // peer lifecycle, and one stateless native-to-finite translation policy. The
    // 13 translator exports do not own unrelated state, storage or lifecycle.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 150
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/qrtc-peer-connection.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 270
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/rtc-native-observation-values.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 78
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/rtc-native-observation-values.ts',
        rule: 'file.responsibility-count',
        symbol: undefined,
        maximumMagnitude: 13
    }),
    // Peer separation review retains one PC lifetime for negotiation, ICE, native
    // observations and retirement; the diagnostic callback fence adds no owner.
    // Human-approved length-only exceptions: docs/repo-code-style-exceptions.md.
    // Exact effective lengths preserve original peer/service lifecycle ownership;
    // no cognitive, function, other-path or future-growth exception is implied.
    Object.freeze({
        path: 'packages/shared/webrtc/qrtc-peer-connection.ts',
        rule: 'file.length',
        symbol: undefined,
        maximumMagnitude: 1624
    }),
    Object.freeze({
        path: 'packages/shared/services/web-rtc-connection-service.ts',
        rule: 'file.length',
        symbol: undefined,
        maximumMagnitude: 1360
    }),
    // Direct service owners and their adjacent finite translator remain easier
    // to locate here than behind forwarding folders. Only the existing web and
    // webrtc clusters were reviewed; other prefixes and larger counts still fail.
    Object.freeze({
        path: 'packages/shared/services',
        rule: 'layout.directory-density',
        symbol: 'services',
        maximumMagnitude: 21
    }),
    Object.freeze({
        path: 'packages/shared/services',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:web',
        maximumMagnitude: 5
    }),
    Object.freeze({
        path: 'packages/shared/services',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:webrtc',
        maximumMagnitude: 5
    }),
    // The selected profile resource is checked as an object before mutation;
    // other valid JSON resources pass through to the canonical configuration decoder.
    Object.freeze({
        path: 'apps/api-v1/test/configuration/read-api-v1-configuration.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readIceOverrideConfigurationResource'
    }),
    // Config/command port observations terminate in independent literal assertions.
    // Exact named callbacks retain their scenario ownership and raw warning output.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-api-server-mode.test.ts',
        rule: 'boundary.unknown',
        symbol: 'assertSelectedFullStackApiCapture'
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-api-server-mode.test.ts',
        rule: 'boundary.unknown',
        symbol: 'assertIndependentCaptureConsumer'
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-api-server-mode.test.ts',
        rule: 'boundary.unknown',
        symbol: 'assertOrdinaryExhaustiveApiCommand'
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-api-server-mode.test.ts',
        rule: 'boundary.unknown',
        symbol: 'assertSelectedFullStackSpaCommand'
    }),
    // Recorder JSON must be a non-null object before its canonical typed handoff.
    // Checked artifact fields and independent lifecycle/receipt assertions follow.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-api-timing-capture.test.ts',
        rule: 'boundary.unknown',
        symbol: 'toTimingCaptureObject'
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-api-receipt-capture.test.ts',
        rule: 'boundary.unknown',
        symbol: 'toReceiptCaptureObject'
    }),
    // The recursive JSON Schema validator keeps raw schema values and candidate
    // instance values opaque until its type/record checks make each decision.
    // Six module-level declarations are schema literals or the node input type.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 6
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateJsonSchema',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'toDiscriminatedSchema',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'isExpectedType',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'isSameJsonValue',
        maximumMagnitude: 2
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'isJsonRecordValue',
        maximumMagnitude: 1
    }),
    // Filesystem and guide JSON enter the schema tests as raw values. The
    // corpus, manifest, example and OpenAPI traversals validate before typing;
    // anonymous unknowns describe only deliberately malformed corpus values.
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-test-schema.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readJsonFile',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-test-schema.test.ts',
        rule: 'boundary.unknown',
        symbol: 'expectValid',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-test-schema.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-test-schema.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readGoldenCompatibilityCorpus',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-test-schema.test.ts',
        rule: 'boundary.unknown',
        symbol: 'inlineRecipesInManifest',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-test-schema.test.ts',
        rule: 'boundary.unknown',
        symbol: 'jsonCodeBlocks',
        maximumMagnitude: 1
    }),
    ...reviewedScenarioDispositions,
    ...reviewedBrowserDispositions,
    // Recipe failure details and outputs are recipe-authored JSON the control server carries verbatim into the
    // artifact bundle; the consumer decodes them against the recipe's own contract. Three contract fields, no
    // owner function; a fourth use needs its own review.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control-snapshots.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    // A recorded control event payload is untrusted artifact JSON; decodeRecord narrows it before any field is read,
    // and only key=value identity text leaves the builder.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/distributed-run-observation/to-distributed-run-identity-summary.ts',
        rule: 'boundary.unknown',
        symbol: 'toDistributedRunIdentitySummary',
        maximumMagnitude: 1
    }),
    // Keep: the event, diagnostic, failure and progress row builders of one run observation and the helpers they share,
    // the identity summary among them; a subfolder would only group helpers by role.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/distributed-run-observation',
        rule: 'layout.directory-density',
        symbol: 'distributed-run-observation',
        maximumMagnitude: 21
    }),
    // The handoff classifier takes arbitrary monitor evidence by design (its tests feed null, malformed and frozen
    // input): fields and array items are read behind try/catch for hostile getters, then narrowed by decodeRecord,
    // Array.isArray, decodeBoundedText or decodeIdentity before any pattern runs. The two contract fields are the
    // public untyped input shape.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 2
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts',
        rule: 'boundary.unknown',
        symbol: 'deriveAdvancedDiagnosticHandoffTargets',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts',
        rule: 'boundary.unknown',
        symbol: 'diagnosticSignalsForFailure',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts',
        rule: 'boundary.unknown',
        symbol: 'hasCorrelatedFailureKey',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts',
        rule: 'boundary.unknown',
        symbol: 'read',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts',
        rule: 'boundary.unknown',
        symbol: 'readIndex',
        maximumMagnitude: 2
    }),
    // Walkers that measure the keys, arrays, strings and bytes of any projected value, and one deliberately
    // hostile model built past its contract to prove the projection bounds it.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-artifact-projection.test.ts',
        rule: 'boundary.unknown',
        symbol: 'hostileAnalyzeModel',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-artifact-projection.test.ts',
        rule: 'boundary.unknown',
        symbol: 'recursiveKeys',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-artifact-projection.test.ts',
        rule: 'boundary.unknown',
        symbol: 'maxArrayLength',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-artifact-projection.test.ts',
        rule: 'boundary.unknown',
        symbol: 'maxUtf8StringBytes',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-artifact-projection.test.ts',
        rule: 'boundary.unknown',
        symbol: 'serializedBytes',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-artifact-projection.test.ts',
        rule: 'boundary.unknown',
        symbol: 'oversizedStringPaths',
        maximumMagnitude: 1
    }),
    // Partial render-test doubles: each supplies only the members the component under test reads.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts',
        rule: 'boundary.unknown',
        symbol: 'createExecution',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-hook-lifetime.test.ts',
        rule: 'boundary.unknown',
        symbol: 'createSelection',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-analyze-worker-ui.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-monitor-diagnostic-handoff.test.ts',
        rule: 'boundary.unknown',
        symbol: 'monitorModel',
        maximumMagnitude: 1
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts',
        rule: 'boundary.unknown',
        symbol: 'model',
        maximumMagnitude: 1
    })
]);

export function isReviewedDisposition(repoRoot, finding) {
    const findingPath = path.relative(repoRoot, finding.file).split(path.sep).join('/');
    return reviewedDispositions.some(
        (disposition) =>
            disposition.path === findingPath &&
            disposition.rule === finding.ruleId &&
            disposition.symbol === finding.symbol &&
            matchesReviewedMagnitude(disposition, finding)
    );
}

function matchesReviewedMagnitude(disposition, finding) {
    if (disposition.maximumMagnitude === undefined) {
        return true;
    }
    const magnitude = findingMagnitude(finding);
    return Number.isSafeInteger(disposition.maximumMagnitude) &&
        disposition.maximumMagnitude > 0 &&
        Number.isSafeInteger(magnitude) &&
        magnitude > 0 &&
        magnitude <= disposition.maximumMagnitude;
}
