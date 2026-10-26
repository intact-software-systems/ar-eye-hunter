// Reviewed browser runtime and transport boundaries. Exact keys and caps remain local to each owner.
export const reviewedBrowserDispositions = Object.freeze([
    // One RTC carrier owner keeps admission protection, control-handoff translation
    // and route/native guards together. The explicit quota-clock admission guard
    // stays at that boundary. The separation review accepts this exact score;
    // other findings and further growth remain undispositioned.
    Object.freeze({
        path: 'packages/shared/multicast/web-rtc-overlay-multicast-manager.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 119
    }),
    // A workflow condition's VM result is untrusted until its boolean guard.
    // Only that checked decision leaves the manual-mode job selector.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveManualModeJobs',
        maximumMagnitude: 1
    }),
    // The named app composition boundary assembles defaults before the required
    // constructor. This module-owned prompt has no checker symbol, even though
    // its display message names the default factory.
    Object.freeze({
        path: 'apps/rallar-black-box/playwright-full-stack-api-server.ts',
        rule: 'factory.defaults',
        symbol: undefined
    }),
    // Readiness HTTP JSON is untrusted until the API/config and control/health
    // validators check its identities and shape. They return void; the probe's
    // module-owned readJson declaration and local guard expose that boundary.
    Object.freeze({
        path: 'apps/rallar-black-box/playwright-full-stack-api-server.ts',
        rule: 'boundary.unknown',
        symbol: 'assertFullStackApiConfigEvidence'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/playwright-full-stack-api-server.ts',
        rule: 'boundary.unknown',
        symbol: 'assertFullStackControlHealthEvidence'
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/playwright-full-stack-api-server.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'apps/rallar-black-box/playwright-full-stack-api-server.ts',
        rule: 'boundary.unknown',
        symbol: 'isRecord'
    }),
    // Distributed-run HTTP JSON is raw until decodeDistributedRunState narrows the
    // one consumed field; the response port's json() declares that boundary.
    Object.freeze({
        path: 'apps/rallar-black-box/src/headless-worker/headless-worker-runtime.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // One diagnostic capture lifetime owns stdout framing, safe persistence and
    // child/capture exit policy. Keep its local primitive projection beside that
    // lifetime at the reviewed warning-tier cap; no global threshold changes.
    Object.freeze({
        path: 'apps/rallar-black-box/scripts/run-full-stack-api-with-timing.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 62
    }),
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
    }),
    // Explicit durable result release: independently reviewed exact boundary and
    // lifecycle owners. Caps preserve current signals; touched owners need review.
    // One serialized durable evidence lifecycle owns artifact append/flush, receipt
    // publication/read and artifact response. Splitting the shared queue policy would obscure
    // ordering and failure ownership; the metric is a reviewed cohesion warning below the
    // mandatory refactor threshold.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/control-artifact-recorder.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 62
    }),
    // The exact current module-attributed occurrence is the class method's `JSON.parse` receipt
    // row. `isResultCaptureReceipt` guards it before selection or domain handoff. The checker
    // does not assign the class method name.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/control-artifact-recorder.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // Recursive persisted JSON discovery checks arrays/records, then the canonical result decoder
    // and receipt guard before producing typed capture receipts. Arbitrary nested user payloads
    // are not treated as domain results without these checks.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/control-artifact-recorder.ts',
        rule: 'boundary.unknown',
        symbol: 'collectCaptureReceipts',
        maximumMagnitude: 1
    }),
    // The current module-owned value is the transport OpenAPI document, whose embedded canonical
    // JsonSchema supports opaque enum/const/examples/default data. It is only served as
    // documentation, never consumed as application authority or receipt policy.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/routes/swagger-routes.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // A schema translation boundary accepts a schema record, clones it through the guarded
    // recursive owner, and preserves its record root. Its output remains an opaque transport-
    // document record; no application domain object is asserted.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/routes/swagger-routes.ts',
        rule: 'boundary.unknown',
        symbol: 'openApiJsonSchema',
        maximumMagnitude: 3
    }),
    // The schema walker preserves primitive/opaque leaves, checks object/array shape, tracks
    // actual ancestor identity and translates cycles into named schema references. The unknown
    // values stay within this schema representation boundary. Canonical JsonSchema intentionally
    // permits arbitrary enum/const/example/default values.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/routes/swagger-routes.ts',
        rule: 'boundary.unknown',
        symbol: 'cloneJsonSchema',
        maximumMagnitude: 4
    }),
    // The function projects the authored OpenAPI document and relative server URL into transport
    // output. It makes no business decision from opaque schema values.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/routes/swagger-routes.ts',
        rule: 'boundary.unknown',
        symbol: 'controlOpenApiSpec',
        maximumMagnitude: 1
    }),
    // The only consumed operation is JSON serialization to an HTTP response with fixed status and
    // owned CORS headers. The record's contents are not promoted into application domain state.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/routes/swagger-routes.ts',
        rule: 'boundary.unknown',
        symbol: 'jsonResponse',
        maximumMagnitude: 1
    }),
    // All three module-attributed occurrences describe partial observations of the served OpenAPI
    // output: enum items, path records and oneOf alternatives. They terminate in independent
    // assertions; no production input or policy is constructed from unchecked values.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/test/swagger-routes.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    // HTTP JSON is checked for response success, record shape, exact request identity, released
    // status, count and reason before constructing the typed outcome.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/result-release/release-control-results.ts',
        rule: 'boundary.unknown',
        symbol: 'releaseControlResults',
        maximumMagnitude: 1
    }),
    // Parsed socket JSON stays raw until protocol discriminant/version, identity strings, receipt
    // array and each receipt's fields are checked. The resulting envelope is explicitly
    // constructed from those checked fields.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/result-release/result-release-protocol.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeResultReleaseEnvelope',
        maximumMagnitude: 1
    }),
    // Required separation review keeps one concrete runtime owner for assignment/reset, active
    // execution and recipe leases, event/result commit and release fencing. Factory composition
    // and stateless release/reference policies already have meaningful separate owners. Further
    // method shuffling would hide shared race guards; discounted length is within 1200 and named
    // methods within 60.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/runtime/in-memory-rallar-black-box-test-runtime.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 142
    }),
    // Arbitrary retained payload traversal checks array/record shape before descending and uses
    // exact selected-result matching. Its output is only an ownership-presence boolean.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/runtime/release-runtime-results.ts',
        rule: 'boundary.unknown',
        symbol: 'containsReleasedResult',
        maximumMagnitude: 1
    }),
    // A raw payload record is a selected result only after capture-record narrowing and exact
    // canonical equality with a previously verified full result. Lookalikes do not gain result
    // identity.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/runtime/release-runtime-results.ts',
        rule: 'boundary.unknown',
        symbol: 'isSelectedResult',
        maximumMagnitude: 1
    }),
    // The opaque-payload rewrite preserves arrays/records/leaves and substitutes only exact
    // verified selected results. The caller first rejects any matching protected event and only
    // rewrites runtime-owned result evidence. Its output intentionally remains opaque event
    // payload data, never an asserted result DTO.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/runtime/release-runtime-results.ts',
        rule: 'boundary.unknown',
        symbol: 'toReleasedResultMarkers',
        maximumMagnitude: 2
    }),
    // Private entry owns one destination lifecycle: capture, authenticated admission, replacement,
    // cancellation, and persistence. The pure codecs remain next to that stateful owner, while
    // membership transport and server admission policy stay in their existing owners.
    Object.freeze({
        path: 'packages/shared-web/browser/rooms/entry/rallar-room-entry.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 107
    }),
    // Tab storage is untrusted JSON. The decoder narrows the record, principal, scoped reference,
    // and credential state before constructing a SavedEntry; unchecked values never reach join.
    Object.freeze({
        path: 'packages/shared-web/browser/rooms/entry/rallar-room-entry.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeSavedEntry',
        maximumMagnitude: 1
    }),
    // Error.cause is arbitrary data. The cycle-safe walk admits only Error instances and an exact
    // ApiHttpError 401 before ending the captured session; it constructs no unchecked domain DTO.
    Object.freeze({
        path: 'packages/shared-web/browser/session/session-auth-lifecycle.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // The adjacent rooms README maps facade, admission/membership workflows, translation, events,
    // and session handles. Those are direct room owners; another folder would add navigation
    // without separating an independent lifecycle. Only these reviewed clusters are covered.
    Object.freeze({
        path: 'packages/shared-web/browser/rooms',
        rule: 'layout.directory-density',
        symbol: 'rooms',
        maximumMagnitude: 22
    }),
    Object.freeze({
        path: 'packages/shared-web/browser/rooms',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:room',
        maximumMagnitude: 16
    }),
    // Separation review: one authenticated page connection owns room/command/snapshot attempts
    // and their cancellation. Observer callbacks can stop or replace that connection, so each
    // continued effect checks its captured lifecycle beside the effect. Related state changes
    // publish atomically. Pure acceptance/delivery policy, browser ports, React subscription and
    // presentation remain separate owners. This exact review-tier cap permits no further growth;
    // no function-size, navigation-length or other-rule exception is granted.
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 202
    }),
    // These three class-method occurrences accept promise rejection values, fence stale attempts,
    // and immediately normalize with toError. Only typed error messages reach connection state.
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    // The cleanup-failure classifier checks Error, the named partial-failure contract, and
    // operation before the caller's fenced recovery. Its only result is a boolean.
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
        rule: 'boundary.unknown',
        symbol: 'isCreatedRoomCleanupFailure',
        maximumMagnitude: 1
    }),
    // App extraction keeps each HUD capability together: intel and clue display, map projection,
    // party admission/readiness/coordination, and action planning. These files do not own transport
    // or authoritative state. Named subcomponents expose the decisions without pass-through files.
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game/hud/relic-intel.tsx',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 52
    }),
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game/hud/relic-map.tsx',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 67
    }),
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game/hud/relic-party.tsx',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 137
    }),
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game/hud/relic-plan.tsx',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 78
    }),
    // The adjacent game README gives the entry-to-effect map. HUD, AI, and scene already have
    // their own directories; direct files retain game lifecycle and pure rule ownership.
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game',
        rule: 'layout.directory-density',
        symbol: 'game',
        maximumMagnitude: 22
    }),
    Object.freeze({
        path: 'apps/relic-hunters-v1/src/game',
        rule: 'layout.feature-prefix-cluster',
        symbol: 'prefix:relic',
        maximumMagnitude: 11
    }),
    // The fetch fixture captures outgoing JSON as raw observation data for independent equality
    // assertions. No captured value is used to authorize or construct a production mutation.
    Object.freeze({
        path: 'packages/tests/shared-web/rooms/room-group-state-mutation-workflows.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 1
    }),
    // Fixture response serialization intentionally accepts arbitrary bodies, including malformed
    // values. Production decoding, rather than this transport fixture, owns their admission.
    Object.freeze({
        path: 'packages/tests/shared-web/rooms/room-group-state-mutation-workflows.test.ts',
        rule: 'boundary.unknown',
        symbol: 'jsonResponse',
        maximumMagnitude: 1
    })
]);
