// Reviewed browser runtime and transport boundaries. Exact keys and caps remain local to each owner.
export const reviewedBrowserDispositions = Object.freeze([
    // Call signals arrive as untrusted WS values. The signal decoder checks every
    // known field before session/recipient filtering and typed listener delivery.
    Object.freeze({
        path: 'packages/shared-web/browser/calls/browser-call-signal-runtime.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-web/browser/calls/browser-call-signal-runtime.ts',
        rule: 'boundary.unknown',
        symbol: 'toSignalEvent'
    }),
    Object.freeze({
        path: 'packages/shared-web/browser/calls/browser-call-signal-runtime.ts',
        rule: 'boundary.unknown',
        symbol: 'isRecord'
    }),
    Object.freeze({
        path: 'packages/shared-web/browser/calls/browser-call-signal-runtime.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeRallarCallSignalPayload'
    }),
    // Serialization captures application-owned JSON before asynchronous connect.
    // Re-parsing that immutable capture does not confer an application schema.
    Object.freeze({
        path: 'packages/shared-web/browser/messages/browser-rallar-message-sender.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-web/browser/messages/browser-rallar-message-sender.ts',
        rule: 'boundary.unknown',
        symbol: 'parseCapturedPayload'
    }),
    // Native RTC frames are decoded before admission and the typed refresh port.
    Object.freeze({
        path: 'packages/shared/services/web-rtc-rx-streamer-service.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Test transport ports inject malformed signals and capture opaque outgoing
    // application payloads; only the production decoder grants a signal type.
    Object.freeze({
        path: 'packages/tests/shared-web/calls/browser-call-signal-runtime.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-web/calls/browser-call-signal-runtime.test.ts',
        rule: 'boundary.unknown',
        symbol: 'createMessages'
    }),
    // One concrete Hetzner catalog owns these deployment selections. The 16
    // named entries compose canonical recipe builders with deployment profiles;
    // splitting the declarative inventory would obscure its ordered catalog.
    Object.freeze({
        path: 'apps/rallar-black-box/src/hetzner/hetzner-rtc-manifest-entries.ts',
        rule: 'file.responsibility-count',
        symbol: undefined,
        maximumMagnitude: 16
    }),
    // Native WebSocket data and open expectations are validated at these
    // exact ingress owners. Completed scoped snapshots have named results;
    // unscoped application values remain opaque capture data.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/local-websocket-frame.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/local-websocket-frame.ts',
        rule: 'boundary.unknown',
        symbol: 'acceptLocalWsFrame'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/ws/ws-open-expectation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateWsOpenExpectation'
    }),
    // The reviewed black-box execution owners retain raw native errors, decoded
    // application payloads and deliberately malformed test inputs at their
    // transport/comparison boundaries. Generated control fields are decoded
    // before use. Session, adapter and observation-window responsibilities
    // remain cohesive at the exact measured caps; deferred RTC construction
    // runs only after module initialization. These entries do not waive timing
    // or pending-observation correctness: those defects have separate fixes.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-session.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 89
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-session.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-session.ts',
        rule: 'boundary.unknown',
        symbol: 'toBrowserErrorDetails'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-session.ts',
        rule: 'boundary.unknown',
        symbol: 'toBrowserError'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/create-rallar-stub-rtc-provider.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/rallar-browser-rtc-provider.ts',
        rule: 'construction.forward-capture',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/rallar-rtc-provider.ts',
        rule: 'file.responsibility-count',
        symbol: undefined,
        maximumMagnitude: 12
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/rtc-provider.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 74
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/rtc-provider.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/rtc/rtc-wait-expectations.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 127
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/rtc/rtc-wait-expectations.ts',
        rule: 'file.responsibility-count',
        symbol: undefined,
        maximumMagnitude: 15
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/rtc/rtc-wait-expectations.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/rtc/rtc-wait-expectations.ts',
        rule: 'boundary.unknown',
        symbol: 'consumeRtcObservations'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/ws/ws-interaction-statuses.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/ws/ws-interaction-statuses.ts',
        rule: 'boundary.unknown',
        symbol: 'toWsSuccessStatus'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/ws/ws-wait-expectations.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 70
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/ws/ws-wait-expectations.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/ws/ws-wait-expectations.ts',
        rule: 'boundary.unknown',
        symbol: 'matchesWsValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/ws/ws-wait-expectations.ts',
        rule: 'boundary.unknown',
        symbol: 'matchesWsMessage'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/ws/ws-wait-expectations.ts',
        rule: 'boundary.unknown',
        symbol: 'computeWsMessageMatches'
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
    // The provider port of the browser adapter: page runtime results and forwarded page event data
    // arrive untrusted, and each command owner decodes a result before reading or recording it.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/browser/browser-command-contracts.ts',
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
        path: 'packages/tests/shared-test/rallar-browser-runtime/director.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-browser-runtime/director.test.ts',
        rule: 'boundary.unknown',
        symbol: 'configureDirectorRelayScenario'
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
