import path from 'node:path';

import { findingMagnitude } from './finding-magnitude.mjs';

export const reviewedDispositions = Object.freeze([
    // This caught-value boundary immediately normalizes arbitrary thrown values
    // to Error, exactly as required by the code standard. No unknown value
    // propagates to callers; the textual checker cannot distinguish that case.
    Object.freeze({
        path: 'packages/shared/resilience/to-error.ts',
        rule: 'boundary.unknown',
        symbol: 'toError'
    }),
    // JSON comparison accepts native input at its facade and decoder only.
    // Descriptor-built snapshots remove accessors, prototypes, and caller-owned
    // mutation before the JsonValue core runs. The private worklist is raw input
    // inside that decoder; the test deliberately exercises the native boundary.
    // Semantic tests cover invalid values, cycles, hidden hooks, shared graphs,
    // immutable diagnostics, and the existing comparison policies.
    Object.freeze({
        path: 'packages/shared-test/json-compare/compare-json-values.ts',
        rule: 'boundary.unknown',
        symbol: 'compareJson'
    }),
    Object.freeze({
        path: 'packages/shared-test/json-compare/json-compare.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/json-compare/json-comparison-input.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/json-compare/json-comparison-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeJsonComparisonInput'
    }),
    Object.freeze({
        path: 'packages/shared-test/json-compare/json-comparison-input.ts',
        rule: 'boundary.unknown',
        symbol: 'captureJsonComparisonValue'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/compare-json.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Scalar, object, and array branches form one recursive comparison policy.
    // Keep them together after extracting native-input decoding. This bounds the
    // reviewed warning; it does not permit growth into an exception tier.
    Object.freeze({
        path: 'packages/shared-test/json-compare/compare-json-values.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 63
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
    // AL admission owns raw persisted values until a caller-supplied decoder
    // validates them. These exact owners either hold the opaque storage value,
    // validate a record before decoding every field, or preserve deliberately
    // corrupt test input. The checker cannot prove that local data flow without
    // weakening detection for unknown values that really reach domain logic.
    Object.freeze({
        path: 'packages/shared/alm/al-admission-backend.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/alm/al-admission-resource-entry-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeResourceEntryRecord'
    }),
    Object.freeze({
        path: 'packages/shared/alm/indexed-db-admission-backend.ts',
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
    // These runtime capability modules intentionally use noun-based filenames:
    // each contains the cohesive helpers needed to construct that capability,
    // while the checker sees only the exported factory as the primary symbol.
    Object.freeze({
        path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-acceptance.ts',
        rule: 'layout.primary-export-name',
        symbol: 'createRtcBaselineDenoAcceptance'
    }),
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
    // These exact raw-input and opaque application-payload owners were reviewed
    // through user-requested AI review. Decoders validate before domain use; opaque
    // app data stays at the application boundary without infrastructure casts.
    // An owner match is not proof that future uses of unknown remain valid:
    // touched-file semantic review still applies within every listed owner.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-controller.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
        rule: 'boundary.unknown',
        symbol: 'consoleWarningPart'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
        rule: 'boundary.unknown',
        symbol: 'classifyConsoleWarning'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
        rule: 'boundary.unknown',
        symbol: 'ensurePatch'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'isBlackBoxCommandRecord'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxCommandString'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxCommandNumber'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxCommandScope'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxCommandRoomRef'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodePeerIds'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeAck'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeMessageFields'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'isRealtimeSendEnvelope'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarSendInput'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarWsSendInput'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'configRecord'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'optionalString'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'optionalNumber'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'optionalBoolean'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'stringList'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'registration'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'messageSelector'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'dataChannelInit'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'flowControl'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'commandRecord'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'optionalString'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'optionalNumber'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'optionalBoolean'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'stringList'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'numberList'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'isCrdtJsonValue'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'optionalJsonValue'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'transport'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'scope'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'registration'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'connection'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'operationKind'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'pathKind'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'pathSchema'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'validation'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'encryptionKey'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'encryption'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarCrdtHandle'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarCrdtOpenInput'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarCrdtApplyInput'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarCrdtUndoRedoInput'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'syncOptions'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarCrdtSyncInput'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'waitCondition'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarCrdtWaitInput'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging-controller.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/webrtc/decode-rtc-signaling-message.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeRtcSignalingPayload'
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
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-browser-runtime/director.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-browser-runtime/director.test.ts',
        rule: 'boundary.unknown',
        symbol: 'configureDirectorRelayScenario'
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
        path: 'scripts/perf/api-v1-state-write-group-receipt-evidence.ts',
        rule: 'boundary.unknown',
        symbol: undefined
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
        symbol: 'computeALMessageEnvelopeSize'
    }),
    Object.freeze({
        path: 'packages/shared/alm/outbound/al-outbound-work-entry.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/alm/outbound/validate-al-outbound-dispatch.ts',
        rule: 'boundary.unknown',
        symbol: 'validateALOutboundPlannedMessage'
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
    // its parsed value never leaves the nested payload boundary. The scanner
    // assigns the three methods to their module owner, not the class name.
    Object.freeze({
        path: 'packages/shared/alm/inbound/al-inbound-message-runtime.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
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
    // Each ALM owner below keeps one policy, consistency, or lifecycle boundary
    // visible. Concrete stores delegate canonical facts and effects; runtime
    // shells delegate computation and repair. Full-file and navigation review
    // found that further metric-only splits would obscure original observations,
    // atomic decisions, work ownership, and settlement. Caps are exact reviewed
    // magnitudes, not permission to grow or retain a standards violation.
    Object.freeze({
        path: 'packages/shared/al-contracts/normalize-al-qos-policy.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 79
    }),
    Object.freeze({
        path: 'packages/shared/alm/inbound/al-inbound-admission-store.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 54
    }),
    Object.freeze({
        path: 'packages/shared/alm/inbound/al-inbound-work-handler.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 51
    }),
    Object.freeze({
        path: 'packages/shared/alm/inbound/compute-al-inbound-admission.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 65
    }),
    Object.freeze({
        path: 'packages/shared/alm/inbound/prepare-al-inbound-commit-bundle.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 50
    }),
    Object.freeze({
        path: 'packages/shared/alm/inbound/validate-al-inbound-commit-bundle.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 51
    }),
    Object.freeze({
        path: 'packages/shared/alm/outbound/al-outbound-admission-effect-store.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 68
    }),
    Object.freeze({
        path: 'packages/shared/alm/outbound/al-outbound-admission-store.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 124
    }),
    Object.freeze({
        path: 'packages/shared/alm/outbound/al-outbound-message-runtime.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 55
    }),
    Object.freeze({
        path: 'packages/shared/alm/outbound/al-outbound-repair-admission.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 60
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
    // This persisted scalar guard rejects non-booleans immediately. Algorithm
    // fields in its containing decoder use strict literal checks independently.
    Object.freeze({
        path: 'packages/shared/alm/outbound/al-outbound-admission-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'requireEnabled'
    }),
    // The named default resource factory is already the composition root. It
    // resolves optional resources once before constructing the runtime; another
    // default wrapper would not expose a new responsibility.
    Object.freeze({
        path: 'packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts',
        rule: 'factory.defaults',
        symbol: undefined
    }),
    // One native channel lifecycle binds receive callbacks, pressure, queued
    // settlement, cancellation and reset. Pure queue policy has its own owner.
    // The test's raw/decoded captures observe that native boundary for assertions.
    Object.freeze({
        path: 'packages/shared/webrtc/qrtc-data-channel.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 118
    }),
    Object.freeze({
        path: 'packages/tests/shared/qrtc-data-channel.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Performance artifacts enter these raw validators before any arithmetic,
    // string operation, linking, or aggregate derivation. Rejected shapes keep
    // their field diagnostics through both comparison roles; guarded derivation
    // still reports semantic mismatches. The benchmark's sole unknown is an
    // opaque rejected promise reason rethrown after its existing drain settles.
    Object.freeze({
        path: 'scripts/perf/api-v1-state-write-artifact-validation.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'scripts/perf/compare-api-v1-state-write-results.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'scripts/perf/validate-state-write-attempt-evidence.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'scripts/perf/validate-state-write-durable-evidence.mjs',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'scripts/perf/api-v1-state-write-concurrency-bench.ts',
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
    // The inbound and outbound directories already separate the two admission
    // lifecycles. Their READMEs trace ingress/registration, read/compute/validate,
    // guarded writes, and settlement in five direct landmarks. The shared AL
    // prefix names that capability; another nesting level would scatter these
    // adjacent owners without exposing an independent responsibility.
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
    Object.freeze({
        path: 'packages/shared/alm/outbound',
        rule: 'layout.directory-density',
        symbol: 'outbound',
        maximumMagnitude: 23
    }),
    Object.freeze({
        path: 'packages/shared/alm/outbound',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:al',
        maximumMagnitude: 22
    }),
    // Cohesion review kept these lifecycle/decoder owners and their directory
    // together. Bounds describe only the reviewed signal and never change the
    // global thresholds or authorize a refactor-or-register tier exception.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-controller.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 117
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 89
    }),
    Object.freeze({
        path: 'packages/shared/services/web-rtc-connection-service.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 105
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime',
        rule: 'layout.directory-density',
        symbol: 'rallar-browser-runtime',
        maximumMagnitude: 21
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:black',
        maximumMagnitude: 12
    })
]);

export function readReviewedDispositionContext(repoRoot, candidateHead, dependencies = {}) {
    const index = dependencies.readGovernanceDecisionIndex?.(repoRoot) ?? {
        decisions: [],
        duplicateDecisionIds: new Set(),
        issues: []
    };
    const resolved = dependencies.resolveGovernanceExceptions?.(index, candidateHead) ?? [];
    const decisions = resolved.filter(isCodeStyleDecision);
    return {
        candidateHead,
        decisions,
        issues: [
            ...index.issues,
            ...(resolved.length === decisions.length
                ? []
                : ['governance exception resolver returned malformed repository code style evidence'])
        ]
    };
}

export function isReviewedDisposition(repoRoot, finding, context = {}) {
    const findingPath = path.relative(repoRoot, finding.file).split(path.sep).join('/');
    const staticallyReviewed = reviewedDispositions.some(
        (disposition) =>
            disposition.path === findingPath &&
            disposition.rule === finding.ruleId &&
            disposition.symbol === finding.symbol &&
            matchesReviewedMagnitude(disposition, finding)
    );
    if (staticallyReviewed) {
        return true;
    }
    if (!Array.isArray(context.decisions) || typeof context.candidateHead !== 'string') {
        return false;
    }
    return context.decisions.some(
        (decision) =>
            decision?.projection?.path === findingPath &&
            decision.projection.rule === finding.ruleId &&
            (decision.projection.symbol ?? undefined) === finding.symbol &&
            decision.projection.magnitude === findingMagnitude(finding) &&
            decision.projection.candidateHead === context.candidateHead
    );
}

function isCodeStyleDecision(decision) {
    const projection = decision?.projection;
    return (
        projection !== null &&
        typeof projection === 'object' &&
        !Array.isArray(projection) &&
        typeof projection.rule === 'string' &&
        typeof projection.path === 'string' &&
        (projection.symbol === null || typeof projection.symbol === 'string') &&
        Number.isSafeInteger(projection.magnitude) &&
        typeof projection.candidateHead === 'string'
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
