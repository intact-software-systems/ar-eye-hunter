import path from 'node:path';

import { findingMagnitude } from './finding-magnitude.mjs';
import { reviewedBrowserDispositions } from './reviewed-browser-dispositions.mjs';
import { reviewedScenarioDispositions } from './reviewed-scenario-dispositions.mjs';

export const reviewedDispositions = Object.freeze([
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
    // Task64 callback review accepted the current runtime at magnitude106.
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
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control/control-rtc-capture-evidence.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 89
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
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 106
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
        maximumMagnitude: 23
    }),
    Object.freeze({
        path: 'packages/shared/api',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:state',
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
    // The addressed-receipt test decodes raw control frames through the strict
    // payload decoders; its values reach an assertion or a production decoder only.
    Object.freeze({
        path: 'packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readControlPayloads'
    }),
    // This predicate checks typeof, null and property presence before comparing
    // kind. Only a boolean leaves the boundary; its unknown values stay local.
    // The checker reports the boolean signature as a manual-review signal.
    Object.freeze({
        path: 'tests/playwright/relic-hunters/web.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'isCommandKind'
    }),
    // This caught-value boundary immediately normalizes arbitrary thrown values
    // to Error, exactly as required by the code standard. No unknown value
    // propagates to callers; the textual checker cannot distinguish that case.
    Object.freeze({
        path: 'packages/shared/resilience/to-error.ts',
        rule: 'boundary.unknown',
        symbol: 'toError'
    }),
    // These exact JSON readers reject malformed input at the external boundary.
    // The live reader recursively produces only RtcBaselineJson; the typecheck
    // fixture reader returns only a validated string array. No unknown values
    // propagate into their callers or domain decisions.
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
    Object.freeze({
        path: 'packages/tests/repo/tests-typecheck-external-unit.test.ts',
        rule: 'boundary.unknown',
        symbol: 'readTestProjectIncludes'
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
    // Group mutation operation-input validation narrows raw request fields at
    // the HTTP/WS boundary. Both listed owners validate their unknown input
    // before any domain use, mirroring the persisted-JSON decoder entries below.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/' +
            'validate-group-mutation-operation-input.ts',
        rule: 'boundary.unknown',
        symbol: 'validateActivateGroupInput'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/' +
            'validate-group-mutation-operation-input.ts',
        rule: 'boundary.unknown',
        symbol: 'isUnitIntervalNumber'
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
        maximumMagnitude: 267
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
    // Human-approved length-only exceptions: docs/repo-code-style-exceptions.md.
    // Exact effective lengths preserve original peer/service lifecycle ownership;
    // no cognitive, function, other-path or future-growth exception is implied.
    Object.freeze({
        path: 'packages/shared/webrtc/qrtc-peer-connection.ts',
        rule: 'file.length',
        symbol: undefined,
        maximumMagnitude: 1620
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
    ...reviewedScenarioDispositions,
    ...reviewedBrowserDispositions
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
