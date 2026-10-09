// Reviewed browser runtime and transport boundaries. Exact keys and caps remain local to each owner.
export const reviewedBrowserDispositions = Object.freeze([
    // Capture selections enter as raw values only here; the product parser and
    // page/control decoders validate before any connection or domain decision.
    Object.freeze({
        path: 'packages/shared-web/browser/rallar-operation-options.ts',
        rule: 'boundary.unknown',
        symbol: 'toRallarRtcCaptureContext'
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRallarBlackBoxTestCommand'
    }),
    // Auth reconciliation, expiry and the single connection reservation must
    // remain in one owner for both explicit intent and internal acquisition.
    // This measured cap recognizes that cohesion, not a broader size exception.
    Object.freeze({
        path: 'packages/shared-web/browser/session/session-auth-lifecycle.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 50
    }),
    // One captured delivery owns admission, settlement and carrier fallback. Its
    // post-diagnostic capture/epoch guard must remain beside the external callback;
    // splitting that lifecycle would obscure ownership. Only this reviewed score
    // is accepted; further growth and other owners still require a fresh review.
    Object.freeze({
        path: 'packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 51
    }),
    // Framework rejections are captured solely for exact error/identity
    // assertions. The checker supplies no function symbol for these callbacks:
    // these are module-owner reviews, not per-method immunity.
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-browser-runtime/recipe-rtc-capture-application.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-web/connection/browser-rtc-capture-acquisition.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Framework listener probes validate callable shape; rejected and unhandled values
    // are kept only for exact originating-identity or empty-unhandled assertions.
    // Converting the oracle to Error would conceal arbitrary thrown values.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-helper-boundaries.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-helper-boundaries.test.ts',
        rule: 'boundary.unknown',
        symbol: 'onUnhandled'
    }),
    // Browser HTTP JSON is validated/projected into finite ticket fields and
    // canonical API configuration before auth or URL use. Failed ticket replies
    // expose status only; raw browser values never become domain session data.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-auth-multi-session.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'readWsTicketResponse'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-auth-multi-session.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'createWsTicket'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-auth-multi-session.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'prepareApiWebSocket'
    }),
    // Outgoing join JSON is opaque request evidence for literal status and forbidden
    // requestId assertions. It never feeds execution or grants a domain type.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-rest-workbench.spec.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // The issued CDP crash rejection is joined and preserved unless independently
    // observed page crash/closure establishes its intended terminal outcome.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-same-context-run.ts',
        rule: 'boundary.unknown',
        symbol: 'endOwnerPage'
    }),
    // Request observations check/project mutation fields. Actual HTTP state and
    // event readers use canonical validators with scope/principal checks before
    // returning snapshots/events; opaque JSON does not leave as domain data.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'readJsonBody'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'getGroupSnapshot'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'getClientSnapshot'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'getClientEvents'
    }),
    // Canonical result/event payloads remain opaque assertion evidence. These probes
    // require traversed records and guard session text/peer arrays before literal
    // comparisons; they neither execute director commands nor claim a state DTO.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'requireRecord'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'stringValue'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'stringArrayValue'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'resultValue'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'directorStatusValue'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'eventPayload'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'runtimeEventPayload'
    }),
    // Storage JSON enters the canonical full-session decoder before auth use; the
    // connected-event predicate checks records/topic/ok and returns only boolean.
    // Acquisition failure keeps the framework rejection and cleanup cause in
    // native error accounting, never an unknown domain error DTO.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-helpers.ts',
        rule: 'boundary.unknown',
        symbol: 'readBrowserAuthSession'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-helpers.ts',
        rule: 'boundary.unknown',
        symbol: 'isConnectedEventPayload'
    }),
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-helpers.ts',
        rule: 'boundary.unknown',
        symbol: 'closeAfterAcquisitionFailure'
    }),
    // The configured-service probe owns this Promise<unknown> port; its consumer
    // immediately applies canonical API/control readiness validators. Parsing
    // failures are labeled without claiming a typed successful readiness body.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts',
        rule: 'boundary.unknown',
        symbol: 'configuredReadinessJson'
    }),
    // SDK rejection and logger values stay raw until Error/message/identity
    // assertions; normalizing the oracle would conceal a primitive Error leak.
    // Production catches normalize before domain use. Re-review this owner
    // whenever it changes; this classification does not certify future values.
    Object.freeze({
        path: 'packages/tests/shared-web/crdt/rallar-crdt-error-boundary.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Process rejection reasons have no required shape. These tests capture them
    // only to prove observer failures never escape into the process boundary.
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-runtime/observers.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-runtime/observers.test.ts',
        rule: 'boundary.unknown',
        symbol: 'recordUnhandled'
    }),
    // Adapter send values belong to the caller. Capture them unchanged to prove
    // cancellation and recipe continuation preserve the public opaque payload.
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-test-cancellation-lifetime.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/rallar-bb-test-recipe-format.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
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
    // A typed channel definition arrives from application code of any typing. The
    // policy validator reads its recovery owner as an untrusted value and admits
    // only an object whose onResyncRequired is callable; the typed contract starts
    // past this validation.
    Object.freeze({
        path: 'packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRallarChannelRecovery'
    }),
    // The conformance discriminator parses untrusted application JSON and narrows
    // its marker/specimen fields locally. Only a boolean leaves this boundary;
    // malformed or unrelated payloads retain the ordinary QoS policy.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/compute-alm-conformance-qos-defaults.ts',
        rule: 'boundary.unknown',
        symbol: 'isSupersedenceSpecimen'
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
        symbol: 'toConsoleWarningPart'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
        rule: 'boundary.unknown',
        symbol: 'toConsoleWarning'
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
    // The canonical finite parser accepts only Off, Signaling, Native or absence.
    // Its Left becomes a sanitized TypeError; only the parsed mode leaves this
    // decoder. The scanner's narrowing vocabulary omits the parse prefix.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeRtcCaptureMode'
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
    // The connection config arrives as recipe JSON; its lane decoder and the two
    // field decoders read each raw field once and hand on only decoded values.
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'dataChannelLanes'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarConfigFields'
    }),
    Object.freeze({
        path:
            'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeBlackBoxRallarConnectionConfig'
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
