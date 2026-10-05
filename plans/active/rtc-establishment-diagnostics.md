# RTC establishment diagnostics

Implement configurable RTC capture through the SDK, workbench, ordinary and distributed
recipes, local and hosted agents, GitHub Actions, and B06 evidence. The approved capture
modes are Off, Signaling, and Full native. This specification is the behavioral authority
for that implementation. It preserves the reviewed original-owner native observation
contract while replacing automatic native enablement from sink presence and superseded
approval-stage language. The existing RTC baseline plan remains otherwise unchanged.

## Scope and ownership

`packages/shared/webrtc/rtc-signaling-diagnostics.ts` owns the canonical
`RtcSignalingDiagnostics.CaptureMode = 'off' | 'signaling' | 'native'` and its required
normalized configuration and construction receipt contracts. Associated types retain
that qualification; do not introduce renaming aliases. Browser product composition owns
SDK normalization and native-service construction. `packages/shared-test` owns typed
recipe inputs, run provenance, agent support and application-receipt attribution.
Production packages must not import shared-test to configure capture.

Native PC/channel owners capture their original objects; the connection service owns
setup, timeout and termination evidence; browser translation owns public output; the
existing recorder remains the only history. This work adds no signaling-wire generation,
new recorder, polling, automatic producer, recovery strategy, retry/timer change,
connection-attempt budget change, allocation rollback or independent compatibility layer.
Diagnostic-only cleanup must not become native rollback.

## Mode selection and construction

| Mode                    | Construction behavior                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` / Off             | Do not install the RTC signaling/native observation capability. No native observation scope, tokens, extra listeners or extra native property reads. |
| `signaling` / Signaling | Preserve existing routing/native-signal/caller-release observations, without constructing the native scope or adding its listeners/reads.            |
| `native` / Full native  | Include Signaling plus the original-owner native/service capture defined below. Partial browser API coverage remains explicit.                       |

The switch does not control console verbosity, ALM/storage diagnostics, explicit
health/getStats reads, mandatory results, control receipts or formation evidence.
History visibility and severity/transport filters are presentation settings. Hiding a
panel must not disable capture. Other diagnostic and fault-injection ports remain independent.

Use `rtc.captureMode` in SDK defaults and `rtcCaptureMode` in per-connect operation
options and connection adapters. Preserve it through defaults cloning, operation
resolution, sessions and middleware. External selection is sparse; normalize once into
required `RtcSignalingDiagnostics.CaptureConfiguration` with `mode` and `origin`.
Origins are `run`, `step`, `recipe`, `host`, and `product-default`.

The pure core owner is `packages/shared/webrtc/rtc-capture-configuration.ts`.
`resolveRtcCaptureConfiguration({ run?, step?, recipe?, host?, sinkAvailable: boolean })`
accepts optional canonical mode selections and returns the required
`RtcSignalingDiagnostics.CaptureConfiguration`.
`parseRtcCaptureMode(value: unknown): Either<readonly RtcCaptureModeValidationIssue[], ParsedRtcCaptureMode>`
validates the untrusted boundary value. Its named interfaces live in the same module:
`RtcCaptureModeValidationIssue` has required readonly
`code: 'invalid-rtc-capture-mode'` and `message: string`; `ParsedRtcCaptureMode` has required
readonly `mode: RtcSignalingDiagnostics.CaptureMode | undefined`. No raw invalid value is
retained in the issue. Only undefined means omission, represented by Right `{ mode: undefined }`,
never `Either.ofRight(undefined)`. Invalid supplied values return Left issues without throwing.
CLI, URL and workflow adapters translate their documented empty/Inherit choices into undefined
before calling the parser, then fold Left into their existing framework rejection/error convention.
The resolver accepts already validated canonical typed selections. No environment read, scope
construction or sink invocation belongs in these pure operations.

Resolve the first explicit selection in this order:

1. Run override.
2. Connect/step override, including a direct SDK operation or Manual Connect selection.
3. Authored recipe configuration.
4. Host/launch/default configuration, including SDK defaults.
5. Product default: Off without an RTC diagnostic sink; Signaling with an existing sink.

`off` is an explicit value. `inherit` is an operator omission choice, not a runtime mode.
Empty optional launch/workflow inputs inherit; invalid nonempty values fail boundary
validation. Do not coerce booleans or silently downgrade unsupported values. A configured
sink alone never selects Full native. An explicit capture request without a sink or
required capability yields unavailable application evidence, not a successful receipt.
Portable SDK composition must work without Vite, process environment or black-box globals.
The no-application-defaults path must compose independently requested diagnostics or
report why it could not.

Capture configuration is immutable for an active or pending middleware/service scope.
Preferences and Configure update desired next-connection settings. Include mode in the
normalized connection-operation fingerprint before pending-request reuse. A compatible
reuse returns its actual existing receipt. An incompatible Connect reports
`new-connection-required` and the current mode; it does not claim application or reconnect
automatically. Normal explicit disconnect/connect creates the new scope. URL/deployment
locks remain visible ownership constraints in the UI.

## Construction receipts and required-mode acceptance

The existing connection result/status boundary exposes these canonical namespace contracts.
Every field is readonly and required; named object variants are interfaces, with closed
unions for alternatives. All references use `RtcSignalingDiagnostics` qualification.

- `CaptureOrigin`: `run | step | recipe | host | product-default`.
- `CaptureConfiguration`: `mode: CaptureMode`, `origin: CaptureOrigin`.
- `CaptureApplied`: `status: 'applied'`, `mode: CaptureMode`.
- `CaptureUnavailable`: `status: 'unavailable'`,
  `reason: 'sink-unavailable' | 'unsupported' | 'initialization-failed'`.
- `CaptureApplication`: `CaptureApplied | CaptureUnavailable`.
- `CaptureReceipt`: `configuration: CaptureConfiguration`, `application: CaptureApplication`,
  `connectionId: Readout<string>`, `nativeScopeId: Readout<string>`,
  `configurationVersion: 1`, `nativeAvailability: Readout<'enabled'>`,
  `nativeCoverage: 'attached' | 'partial' | 'unavailable' | 'not-applicable'`.

Required identity/readout fields survive JSON serialization. Connection identity is the
owned connection's observed identity; do not fabricate it from timestamps or the requested
target. Off and Signaling use unavailable/not-applicable native scope, disabled native
availability and not-applicable native coverage. Full native can be applied with partial
API coverage when its scope was successfully constructed. Coverage is the observation at
receipt capture, not a future or complete-history guarantee. Missing sink, unsupported mode
implementation and scope initialization failure remain distinct unavailable reasons.
For incompatible reuse, retain the current receipt and report the new request's
`new-connection-required` operation result separately with its requested configuration.
Never overwrite current evidence with desired configuration. Native identity-source failure
may leave live capture with unavailable IDs; it does not erase observed state/error evidence.

Preserve the connection operation's `Promise<ApiMiddleware>` success contract. An incompatible
active or pending reuse rejects with additive public
`RallarRtcCaptureConnectionRequiredError`: `code: 'new-connection-required'`,
`requestedConfiguration: RtcSignalingDiagnostics.CaptureConfiguration`,
`currentConfiguration: RtcSignalingDiagnostics.CaptureConfiguration`, and
`currentReceipt: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>`.
A pending connection whose scope has not been constructed reports its current normalized
configuration and unavailable/absent receipt, never an invented applied receipt.

The browser connection error owner exposes one pure expected-failure classifier:
`checkRtcCaptureCompatibility(input: CheckRtcCaptureCompatibilityInput): Either<RallarRtcCaptureConnectionRequiredError, RtcSignalingDiagnostics.CaptureConfiguration>`.
`CheckRtcCaptureCompatibilityInput` has required readonly fields
`requested: RtcSignalingDiagnostics.CaptureConfiguration`,
`current: RtcSignalingDiagnostics.CaptureConfiguration | undefined`, and
`currentReceipt: RtcSignalingDiagnostics.CaptureReceipt | undefined`.
Absent current configuration or equal modes returns Right requested configuration, including
when only origin differs. A different mode returns Left with the typed error above; its current
receipt is observed when available, otherwise unavailable/absent. Both lifecycle and transport
reuse this same classification before their active/pending reuse decisions; do not duplicate
compatibility policy. The existing `Promise<ApiMiddleware>` boundary deliberately rejects Left
before entering the generic lifecycle initialization catch that invalidates authentication.
Configuration incompatibility must not invalidate authentication or become an initialization error.
Compatible reuse keeps and returns the actual current receipt even when request origin differs.

Expose readback through
`RallarConnectionOperations.rtcCapture(): RtcSignalingDiagnostics.CaptureReceipt | undefined`.
Undefined means no constructed receipt is available. The active/pending transport context owns
actual construction evidence. The initializer returns required
`BrowserConnectedMiddleware.rtcCaptureReceipt: RtcSignalingDiagnostics.CaptureReceipt`,
and the transport retains it beside its current context. Do not add a required aggregate member
to every `ApiMiddleware` or its unrelated fixtures. Readback always returns actual construction evidence,
never newly edited defaults; after scope replacement it must not return the retired scope as
current. Diagnostic initialization failure is a truthful receipt and preserves the business
connection outcome; mode incompatibility is an explicit configuration error at connection reuse.

Shared-test application receipts attach the exact run, agent, recipe body/load/run
invocation, command and connection/scope to that core receipt. They retain requested
selection and origin, advertised configuration support/version, actual application,
and source/build/version facts only where known, with explicit unavailable otherwise.
Cancelled/failed connects retain their actual disposition. Replayed/cached results keep
original attribution and an explicit replay disposition; a reused command ID cannot
certify new configuration. A reference-only recipe start must verify the actual loaded
body/configuration identity, never infer it from a recipe ID alone.

Support-check every targeted agent before required-mode work, then verify the actual
connection receipt before measurement. An older agent silently dropping a record-shaped
field, missing receipt, unavailable application or requested/applied mismatch fails
required-mode acceptance and makes the cohort ineligible. Advertised support, manifest
hashes, command echoes and deployment stamps are insufficient. Native API gaps remain
partial evidence and do not invent a business RTC failure. Minimal result/status receipts
remain available in Off independently of the disabled event stream. Missing event rows
cannot prove Off, successful application, or absence of errors.

## Required end-to-end behavior

| Surface                            | Required outcome                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual workbench                   | Visible Off/Signaling/Full native selector; draft, persistence and reset support; separate desired and current values. Connect/Join sends the visible selection without requiring Configure first. Recorded command export contains the selection used.                                                                                                                                                   |
| Recipe Console and local recipe UI | Run-level Inherit/Off/Signaling/Full native; generated recipes/manifests retain authored or resolved intent. Edit, Load, Run, Rerun, import/export and saved recipes preserve explicit Off and immutable body/configuration identity.                                                                                                                                                                     |
| Ordinary recipes                   | Typed recipe configuration, executable schema, connect payload, decoder and catalog builders preserve selection. The canonical connect boundary resolves precedence once; adapters do not invent independent policy tables. A recipe Configure cannot erase a run override.                                                                                                                               |
| Nested and scripted execution      | Inline/load/run, nested recipes, loops and parallel children carry immutable invocation context without leaking settings between siblings. Implicit WS/CRDT connections, reconnect, reload and successor flows use the same selection or report no applicable override. Reload/resume reapplies accepted intent; completed command IDs alone do not establish configuration.                              |
| Scenario recipes and providers     | Existing adapters carry selection through fragments/includes, request expansion, browser/remote-browser, parity conversion, soak, replay and traffic generation. Later Configure effects cannot silently disappear in parity conversion. API-only recipes need no RTC installation; signaling-only providers must report Full native unsupported.                                                         |
| Distributed runs                   | Typed manifest/selection/run contracts and strict schema carry the override into executable configure/connect requests for all targets/roles. Cover inline and reference-only recipes, stage/ACK/barrier/manual/auto/scheduled starts, restore, cancellation and timeout. Persist the effective materialized recipe/manifest and each applied receipt. Metadata or unexecuted variables are insufficient. |
| Local/hosted bootstrap             | Strict CLI/env/query decoding; explicit worker environment allowlist; env-to-agent-URL-to-bootstrap-to-command projection. Host defaults cannot override per-connection run intent. Invalid nonempty URL values fail rather than falling back to environment.                                                                                                                                             |
| Spawned/external/mixed workers     | Hetzner and GitHub-hosted/external legs receive executable connection selection. External prepare/run cannot assume controller environment rewrites a running agent. Preserve scope isolation and source/materialized manifest identity.                                                                                                                                                                  |
| Already-running world fleet        | Supported commands carry mode, support preflight and applied receipts. Preserve no-spawn behavior: no worker start, stop, restart, reinstall or launch-URL rewrite to satisfy a requested connection mode.                                                                                                                                                                                                |
| Actions and helpers                | Manual distributed wrapper, reusable runner, supported-manifest CI, GitHub-free workflow, B06 workflow, dispatch helper, world-fleet CLI and controller commands forward one finite selection. Inherit defaults must not override authored settings. Console level, expected-failure permission and publish/diagnostic run mode remain independent.                                                       |
| Reports                            | Sanitized per-agent/per-invocation requested and applied receipts survive exports and restore. Actual mode participates in connection/recipe fingerprints, run provenance and validated B06 cohort identity. Old exported receipts never certify a replay's new scope.                                                                                                                                    |

The standalone headless lifecycle workflow keeps its existing **25 manual inputs**.
Do not add a 26th input, remove an existing input or raise a test cap. That workflow
manages processes, not a recipe connection. Connection-mode selection lives in the
distributed run workflow and commands after launch, including already-running agents.
Host defaults remain available through the CLI/environment/query path; lifecycle start
or restart preserves supported host configuration without a new dispatch input. This is
the final input-budget decision, not deferred interface work.

Missing optional saved preference or recipe input means inheritance under the current
contract. Do not create setting aliases, old-format rewrites, migration adapters or a
configuration registry. Unrelated existing Configure merge/replacement semantics stay
explicit; inherited capture context belongs to the owned invocation, not mutable global
configuration or generic object traversal.

## Original-owner native observation contract

`RtcSignalingDiagnostics` remains the optional establishment diagnostic capability and existing event topic. Its existing observations already cross service admission, native signal application and caller release. The extension covers original native establishment/retirement evidence for those decisions, with no general packet/media/stats telemetry. If that name is rejected, renaming/removal is a separate compatibility decision; there is no old/new alias or dual port here.

Associated canonical types live in its type-only namespace, qualified everywhere. Object shapes are interfaces and closed alternatives discriminated unions. All new JSON fields below are required; none uses `undefined` as evidence. Existing signal identity fields keep their current optional/undefined wire-independent meanings.

`RtcSignalingDiagnostics.Readout<T>` is a closed union of required readonly object interfaces: `ObservedReadout<T> { status: 'observed'; value: T }` and `UnavailableReadout { status: 'unavailable'; reason: ReadoutUnavailableReason }`. `ReadoutUnavailableReason` is the closed union: `disabled`, `no-native-object`, `absent`, `unsupported`, `unrecognized`, `read-failed`, `identity-source-absent`, `identity-source-failed`, `identity-invalid`, `initialization-failed`, `admission-limit`, `scope-disposed`, `payload-bytes`, `not-applicable`. No fabricated zero/null/native value or stringified exception. Absence of SCTP is different from an unsupported accessor or throwing getter.

`RtcSignalingDiagnostics.ErrorCoverage` is one of:

- `{ kind: 'listener-window', window: 'active' | 'ended-at-retirement', attachment: 'attached' | 'partial', attachmentGap: boolean }`;
- `{ kind: 'native-operation', stage: 'pending' | 'settled' }`;
- `{ kind: 'unavailable', reason: 'disabled' | 'no-native-object' | 'initialization-failed' | 'admission-limit' | 'unsupported' | 'read-failed' | 'payload-bytes' | 'scope-disposed' }`.

`RtcSignalingDiagnostics.ErrorReadout` is the following JSON-representable union (every displayed field mandatory):

- `{ status: 'observed', value: NativeError, coverage: ErrorCoverage }`;
- `{ status: 'none-observed', coverage: ErrorCoverage }`;
- `{ status: 'unavailable', reason: 'disabled' | 'no-native-object' | 'initialization-failed' | 'admission-limit' | 'unsupported' | 'read-failed' | 'payload-bytes' | 'scope-disposed' | 'not-applicable', coverage: ErrorCoverage }`.

A none-observed listener result requires an attached/partial actual window; it means no qualifying error observed during that window, never no underlying or pre-attachment error. No-native, disabled, unsupported typed observation and unobserved windows require unavailable. Identity-source failure alone does not invalidate genuinely observed state/error: its identity is unavailable while its observed error retains truthful window coverage. A candidate submitted row has unavailable/not-applicable error with pending operation coverage; returned has none-observed with settled operation coverage; rejected has observed finite error with settled coverage even when all typed fields are unavailable. A missing property in JSON cannot equal any of these variants.

| Canonical declaration    | Required fields and meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NativeIdentity`         | `peerConnectionId: Readout<string>`, `channelId: Readout<string>`. PC uses channel not-applicable. Opaque diagnostic IDs name local object lifetimes; not offer/session IDs, numeric native channel IDs, timestamps, transport associations or ICE generations. Joins include run, agent and scope.                                                                                                                                                                                                                                                                             |
| `NativeState`            | `connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`, `iceTransportState`, `dtlsState`, `sctpState`, `channelState`, each a finite readout. `transportObjectOrdinal: Readout<number>` local to captured PC, `transportBinding: 'data-sctp-chain' \| 'unavailable'`, `listenerCoverage: 'attached' \| 'partial' \| 'unavailable'`, `attachmentGap: boolean`. No payload, labels or addresses.                                                                                                                                                          |
| `NativeError`            | `source: 'ice-candidate-error' \| 'dtls-error' \| 'channel-error' \| 'candidate-rejection' \| 'description-rejection'`, `nativeSequence`, `identity`, `errorDetail`, `sctpCauseCode`, `receivedAlert`, `sentAlert`, `iceErrorCode`, `exceptionName` as finite readouts. No message/stack/cause object, URL, SDP/certificate/address.                                                                                                                                                                                                                                            |
| `NativeSnapshot`         | `identity`, `state`, `firstError: ErrorReadout`, `firstTypedError: ErrorReadout`, `nativeSequence`, `capture: CaptureStatus`. Only the exact object's first generic and first typed finite summaries are retained. The parent PC can retain the same immutable channel error, preserving its channel source identity.                                                                                                                                                                                                                                                           |
| `CaptureStatus`          | `scopeId: Readout<string>`, `scope: 'active' \| 'disposed' \| 'unavailable'`, `ordinaryRowsSuppressed: boolean`, `admissionLimited: boolean`, `payloadLimited: boolean`. These are cumulative flags at capture, not full-stream receipt claims. No unbounded drop-count update or completeness claim.                                                                                                                                                                                                                                                                           |
| `CandidateApplication`   | `operationOrdinal`, `applicationOrdinal` (direct zero, queue drain spliced index), `source: 'direct' \| 'queue-drain'`, `stage: 'submitted' \| 'returned' \| 'rejected'`, `currentPeerConnection`, `identity`, `fragmentPresence: 'present' \| 'absent' \| 'unavailable'`, `dataIceFragmentComparison: 'equal' \| 'different' \| 'unknown'`, `comparisonReadout: Readout<'available'>`, `targetTransportAssociation: 'unknown'`, `iceGenerationAssociation: 'unknown'`, `error: ErrorReadout`, `capture: CaptureStatus`. Resolution is submission acceptance, not connectivity. |
| `ServicePeerObservation` | `peerId`, `setupId: Readout<string>`, original `setup: WebRtcConnectionService.PeerSetup`, `native: NativeSnapshot`, up to four compact current channel entries containing only NativeIdentity and channelState readout, `channelCount`, `channelsTruncated`, `capture: CaptureStatus`; plus the stage-specific fields below. These current compact channel entries are not substitutes for each channel's separately reserved final snapshot/error evidence.                                                                                                                   |

Service stages are closed variants: setup-started/setup-established require `issuer` unavailable/not-applicable and `timeout` unavailable/not-applicable; establishment-timeout requires observed original timeout DTO, separately named `watchStartedAtEpochMs` and `watchTimedOutAtEpochMs`, observed issuer establishment-timeout and `removalDisposition: 'original-removed' | 'original-no-longer-current'`; terminating requires observed actual issuer and timeout unavailable/not-applicable. A setup-started capture before native creation has explicit no-native-object state/errors and unavailable PC identity. Setup is the existing original DTO, not a new policy/identity generation. No public lifecycle callback argument is added.

The added observation variants under existing `SignalIdentity` are:

- `native-lifetime`: `native`, action created or retiring. Retiring also requires `retirement: 'reset' | 'replacement' | 'channel-close' | 'channel-error' | 'unknown'`. Each admitted native lifetime has at most one final retiring row, carrying its own first/first-typed summaries.
- `native-state`: `native`, trigger connection/ice-connection/ice-gathering/signaling/ice-transport/dtls/sctp/channel-open/channel-close/transport-attached.
- `native-first-error`: `native`, `error: NativeError`, `first: 'observed' | 'typed' | 'both'`; emitted only as ordinary early evidence. Retained error memory and final snapshots are independent of ordinary publication exhaustion.
- `native-candidate-application`: `candidate: CandidateApplication`.
- `service-peer-observation`: `service: ServicePeerObservation`.
- `native-observation-status`: `stage: 'initialized' | 'disposed'`, `availability: Readout<'enabled'>`, `capture: CaptureStatus`. Only two fixed control attempts per configured scope, described below.
- `native-observation-limit`: `limit: 'admission' | 'ordinary-rows' | 'payload-bytes'`, captured `identity`, `capture`; only the first scope limit gets a separate notice attempt.
- `native-observation-unavailable`: `originalKind` from the six snapshot/state/error/candidate/service/status kinds, `reason: 'payload-bytes'`, captured `identity`, `setupId: Readout<string>`, `capture`. This replaces one already-admitted row that cannot fit; it is not another independent limit notice or another slot. No incomplete payload masquerades as a `NativeSnapshot`.

Service/native state rows have signalType/offerId undefined; candidate rows have IceCandidate and offerId undefined. Existing Offer/Answer identity stays exact. Existing native-signal/release observations gain captured native identity readouts; they do not become generation assertions. Missing identities cannot be joined by peer name, timestamp or current replacement.

`Event.atEpochMs` remains injected publication epoch. `nativeSequence` is assigned at capture before sink invocation, is a local order counter, and is not a native timestamp. Separate service/watch/browser/runtime/control clock fields preserve their original meanings. No cross-agent total order is inferred.

### One allocation/admission scope, with external effects before setup

Use one small concrete `RtcNativeObservationScope` owner beside `rtc-signaling-diagnostics.ts`, with its same-name type namespace before the class. It owns the validated opaque scope nonce, local next ordinal, finite kind admission and ordinary/final/control row admission, active/disposed state and the three capture-limit flags. It owns no native object map, listeners, first-error history, sink, timer, transport policy or recorder. Those remain in existing native/service shells. This is a real optional diagnostic lifetime/admission boundary, not a parallel observer runtime.

The existing optional `RtcSignalingDiagnostics` gains one optional `nativeObservation: RtcNativeObservationScope.Capability`. That canonical capability is `{ status: 'available', scope: RtcNativeObservationScope }` or `{ status: 'unavailable', reason: 'initialization-failed' }`. No `createNativeLifetimeId` callback remains on the capability. The scope is a concrete production class with private owned state; browser and directly injected callers construct it through the same factory `RtcNativeObservationScope.create({ createScopeId })`. `createScopeId` is optional only to support deliberate identity-source absence; an absent nativeObservation capability means native observation itself is disabled. The existing required clock/sink inputs and wire types do not change.

The factory initializes private state, invokes the optional source once, validates the returned nonce, and finishes before the capability is supplied to a service or standalone peer. Source throw, including a throwing source constructor invoked inside that function, yields a live scope whose identities report identity-source-failed; no source yields identity-source-absent; malformed values yield identity-invalid. A failure constructing the scope itself returns unavailable/initialization-failed from the guarded factory. As with any JS recovery, catastrophic allocation failure preventing even a failure DTO is outside a delivery guarantee; it must not be represented as successful initialization. Browser composition calls this guarded factory with a fresh `crypto.randomUUID` source only when the resolved capture mode is `native` and its diagnostic sink is available. A configured sink alone never enables native observation. No external source call occurs from service/PC/channel allocation.

Nonce validation is a pure bounded check: string length 1–64, ASCII letters/digits/underscore/hyphen only, checked for length before scanning. No native/session/offer identifier or timestamp is entropy. Local IDs are the validated nonce plus a closed kind token and one strictly increasing scope ordinal, at most 128 characters. Allocation checks kind cap and active state, then consumes the ordinal and reservation in one synchronous owned operation before returning the complete readout. No external effect, getter, clock, sink, callback or await is part of it. Ordinals are never reused, refunded or reset, even for failed native starts. Kind and range validation occur here for every consumer, not in browser composition or a test allocator.

Avoid a duplicate/malformed-per-allocation registry: arbitrary per-lifetime strings are no longer accepted. Local duplicate allocation cannot occur under the monotonic owner; exhaustion returns admission-limit, never a recycled ID. The source is responsible for distinct nonces across distinct scope instances. A repeated nonce across separately constructed scopes is not detectable without a cross-scope registry; there is no claimed global guarantee. Reusing the same scope instance continues its counters/IDs and shares its limits rather than resetting; callers must give it the lifetime they intend. Artifact joins require run+agent+scope and must not treat a nonce source with unverified uniqueness as generation proof. Tests explicitly demonstrate the separate-scope duplicate-source assumption; they do not fake a local production duplicate allocator that no longer exists.

**Exact scope lifetime:** browser initialization constructs one scope just before its WebRtcConnectionService, not per peer or reconnect cycle. That service and its child peers/channels receive the same instance. `BrowserTransportRuntime.shutdownMiddleware` first performs its existing disconnect-peer loop, allowing final owner captures, then invokes a narrow `WebRtcConnectionService.disposeNativeObservations()` inside the same cleanup protection. This detaches remaining observation listeners from existing peers if any and closes the scope without changing native/business cleanup. The scope returns a frozen final status for one disposal observation, marks disposed before any sink, releases its nonce/admission storage, and never reopens. Pending operations keep their already captured strings/DTOs but cannot publish new scope rows after disposal. Browser reconnect constructs a new scope. Auth cancellation of a completed initialization already calls shutdownMiddleware and follows the same boundary.

Initialization failure also has an explicit owner: after the scope is created, initialiseRtcConnectionService disposes it if construction/connectSignaler fails; after that function returns, initialiseBrowserRtcTransport disposes through the service if the remaining RTC construction fails; after RTC transport returns, initialiseMiddleware does the same if later state/heartbeat initialization fails. Preserve and rethrow the original exception, perform no new native rollback, and add no diagnostic await. These small exception-side disposal hooks enter full touched-file closure. Direct service/standalone-peer consumers construct the same scope before their graph, dispose it only when that graph ends, and use the owned peer/service detach operations before scope disposal. A peer reset or channel replacement retires that object but does not reset the enclosing scope budget.

**Allocator reentry rule:** the only user-supplied allocation effect is scope construction. The new scope/capability has not been published to any new service, PC or channel while the source runs. A source may synchronously call an already existing service/peer/channel; those owners allocate locally through their already completed scope, so no recursive allocator effect occurs. Its explicit reset/reconnect side effect still happens normally. Construction completion neither writes a returned ID into that old owner nor resumes an old setup against its replacement. Source exceptions are contained in the new capability and cannot replace any original native exception. Semantic tests exercise this reentry from the factory against existing service, PC and channel owners and then use the returned capability in new construction. There is intentionally no synthetic runtime-allocator callback during native setup: that unsafe extension point has been removed.

At service setup, allocate a local setup token associated with the exact new PeerEntry before watchdog/start, without external calls. At native PC success, allocate a local PC token for the captured returned PC and install its capture state; a throwing native constructor has no PC identity and preserves the original thrown value. At channel create/accept, capture exact channel and parent PC token before callback consumption; local allocation cannot reenter. No identity operation reads the current replacement after a sink/app callback. Tokens for unavailable identity still carry admission/final-slot state locally; nonce failure does not consume extra fake IDs or weaken terminal allocation accounting.

The existing peer owns narrow child operations to create a captured channel observation binding and record a sanitized channel capture against its captured parent. They implement parent lifetime binding and shared scope admission, not a generic sink proxy. The channel keeps its own native handle/first errors. Its existing third constructor argument remains `now`; no callback is added to InputDto. Public additive peer/service operations and the new scope capability are explicit compatibility-sensitive additions.

### Finite values and privacy

State readouts use existing native state unions plus RTCIceTransportState/RTCDtlsTransportState/RTCSctpTransportState. Unknown future values become unrecognized. Error detail accepts only the seven RTCErrorDetailType values. Exception names accept OperationError, InvalidStateError, TypeError, NotSupportedError, AbortError and UnknownError; other names become unrecognized. ICE codes are integers 0–701, DTLS alerts 0–255, SCTP causes 0–65535. No constructor-name strings, raw Error messages, SDP/certificates/addresses, or getRemoteCertificates call.

Guard native boundary property reads and follow them with pure finite translators. Missing RTCError global, absent/null fields, unsupported methods or throwing getters yield explicit readouts, without replacing native errors or changing candidate admission. Native getters are only observed after the existing synchronous business decision/action where a read could otherwise introduce reentry; pre-teardown callback capture uses exact original handles and a post-capture original-object guard before continuing existing effects. No diagnostic read authorizes work against a replacement. Business exceptions never enter the instrumentation catch.

## Candidate association: deliberately limited proof

The canonical application owner remains `QRtcPeerConnection.handleInboundIceCandidate` and its `flushIceCandidates` call into `flushRtcIceCandidateQueue`. Observe each actual native call at that boundary; retain the native PC captured for that call, a local increasing operation ordinal plus per-operation application index, direct/drain source and actual resolution/rejection. Do not change `QRtcSignal`, the decoder, its queue element type, or its wire payload.

At submission and completion, when available, compare the supplied candidate `usernameFragment` to the **captured data SCTP chain's ICE transport** `getRemoteParameters().usernameFragment` using exact equality. Read only the fragment member, never spread, serialize or retain the parameter object or password. Before equality, require each fragment to be a nonempty string of at most 256 code units; an oversized/invalid diagnostic fragment produces `unrecognized` comparison readout and unknown equality, while the original candidate still reaches native application unchanged. Comparison work is therefore bounded independently of the incoming candidate length. No SDP parser is added. No string from either side survives into the event; only presence/equality/readout disposition. Use a small structural method check at this untrusted native boundary because the current installed DOM typings omit `getRemoteParameters`. Missing method is `unsupported`; null parameters or empty/missing fragment is absent; thrown access is `read-failed`. Do not cast the whole transport to an invented fully supported browser interface.

This proves only fragment equality to the observed data ICE transport at that instant. It **does not prove** that a candidate's `sdpMid`/`sdpMLineIndex` selects that transport, that a native applied generation is current, or that another media transport has different credentials. The two explicit association fields stay `unknown` in this minimum design. A different fragment is not classified as an invalid candidate: pending/current descriptions and other media transports may legitimately differ. Native rejection alone does not supply generation provenance.

| Case                         | Required behavior / truthful limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing/null/empty fragment  | Record absent fragment and unknown comparison/association even if native addition succeeds. Do not use latest offer, retry or description count as a proxy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Before remote description    | Existing `ice-queued` observation remains admission only. No native-application success is emitted. Queue insertion is not joined to an application by payload equality.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Queue drain                  | Add optional `onCandidateObservation` to `FlushRtcIceCandidateQueueInput`, with the named `FlushRtcIceCandidateQueueObservation` contract: readonly candidate, zero-based index in this spliced drain, stage `submitted`/`returned`/`rejected`. Submitted/returned variants carry no error field at this internal boundary; rejected carries required sanitized finite error-detail facts. The peer adds its captured identity/sequence and builds the mandatory public CandidateApplication.error ErrorReadout. The drain never invents peer identity or sequence. The peer captures one operation ordinal before calling the drain; the callback's index identifies submitted/settled of that native call even for repeated identical candidate objects. When an ordinary slot is available, the caller performs the bounded fragment comparison and publishes only its safe DTO. If the ordinary budget is exhausted, native addition proceeds and the diagnostic comparison is skipped; later final snapshots carry ordinaryRowsSuppressed. Diagnostic callback failures are caught separately from native addition/counter effects. The drain owns FIFO/continue-on-error, the peer owns identity and diagnostics. Existing required `onCandidateAdded` remains the independently required accounting callback; its count/reset behavior is preserved. No queue migration, second queue, metadata sidecar or raw candidate retention is added. |
| Queue association            | The operation/index pair is fixed by the actual direct invocation or spliced drain, not queue insertion. It correlates submitted/returned/rejected of that call only. Original receipt/queue-entry association remains unknown, which is safer than guessing when the same candidate object/value is queued twice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Failure                      | Direct path keeps its existing throw/ignore decision and original exception. Drain keeps its warning/continuation/count behavior. Diagnostic failure cannot become native failure, skip the next item or increment successful counters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ICE restart or renegotiation | Comparison is a fresh point observation. Before/after equality does not prove no intervening change; unchanged credentials may span negotiations, and restart request does not prove new credentials were applied. No generation ID is minted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Multiple/non-data transport  | No enumeration of transceivers or media credentials. Only the data SCTP chain is observed. Even equal fragments never establish media-section/transport binding. No SCTP chain means association unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Retired/replacement PC       | Pending operations retain original identity. Late settlement uses `currentPeerConnection: false`, never replacement parameters/state. If the captured old transport is unavailable/closed, record that. Existing queued-drain behavior continues unchanged against the PC already supplied to the drain; no new cancellation/retry is introduced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Browser support is an observed availability result, never an assumption from DOM typings. Runtime availability and first-stall capture remain unmeasured.

## Construction, invocation, retirement and publication

### Native PC and transport family

The browser completes the scope factory before service/native construction. The service constructs the existing peer/lane/media graph, records setup, registers channel-open establishment callbacks, starts the existing watchdog and calls connect. QRtcPeerConnection constructs/stores the native PC and installs the existing business callbacks. Its local token/capture binding invokes no external code. Observational ICE/gathering/signaling/ICE-error listeners use addEventListener without replacing business properties, after the owned native setup is complete. Attach/read failures set partial/unavailable coverage. Initial publication happens only after the caller's synchronous setup transaction has reached its normal stable boundary; nested peer/channel creation records detached finite captures for the owning service to publish after start/created notification, not between service admission and native start. A standalone peer publishes after its own complete connect. This is a bounded setup batch (created setup/PC and configured admitted channels), not a new asynchronous queue/history.

Bind exact `pc.sctp -> transport -> iceTransport` at creation, description settlements, relevant native state callbacks and channel create/accept. Attach exact objects, then snapshot, marking an already advanced discovery as attachment evidence, never an observed earlier transition. First discovery beyond initial state sets attachmentGap. Exact chain changes detach old listeners and advance the PC-local transportObjectOrdinal; state changes alone do not. A DTLS object can represent a new association without changing identity. No association or ICE generation ID is claimed. First-error coverage begins at actual attachment: discovering a transport after description application cannot prove no earlier error.

Native callbacks freeze captured finite state, local sequence and first-error decisions before the sink. Changed state emits ordinary rows; duplicates do not. Capture first generic and first typed errors at most once each per exact object even after ordinary rows are exhausted, because final snapshots need them. Once both are retained, repeated errors add no diagnostic history. No callback polls, parses SDP, walks peer registries or calls getStats.

On reset, freeze original pre-close state with error coverage ending at this retirement; mark the token retired; detach observers from exact PC/transports before deliberate close; perform existing status swap, abort, timer/handler cleanup and native close; publish the final snapshot after synchronous effects. A stale callback checks its exact retired binding and cannot mutate replacement summaries or reattach. Pending native promises may publish ordinary late outcomes with currentPeerConnection false while their scope remains active and ordinary quota remains. Disposal suppresses them with no replacement join. Keep only current owned state/first errors and immutable captures retained by existing operations; no native-object history map.

### Channel family and ended error windows

Local create/accepted remote channel binds a locally allocated token to that exact channel and captured parent PC. Existing callbacks retain business authority. Enrich onopen/onclose/onerror at their existing entries; receive the error event only for finite translation. Replacement freezes the old final snapshot before existing clear/close and installs a new token for the new object. A denied admission still permits all native channel behavior but no promised diagnostic history; the scope's admissionLimited flag appears in later admitted rows.

On native error, capture original finite state/error before clearDataChannelReference, then perform current Failed state, waiter settlement, queued-send failure, handler/reference clearing and error/close notification. Set the channel error window ended-at-retirement. Publish its reserved final snapshot only after the existing error/close notification sequence has completed, preserving those original callbacks and exception behavior; it uses the frozen pre-clear data. Any ordinary native-first-error row for the same channel failure is also deferred to that safe boundary, not inserted between notifyError and notifyClose. No extra await is introduced. If an existing business callback never settles, delivery can remain pending; final projection cannot infer no error from the missing row. The final reservation does not depend on an early ordinary attempt succeeding.

A generic first error leaves firstError observed. If typed observation was supported but no typed error was seen before detachment, firstTypedError is none-observed with ended-at-retirement coverage; if typed support/readout could not be established, it is unavailable with that coverage/reason. **A later event on this detached original channel does nothing.** No extra onerror/addEventListener handler remains to manufacture a second typed event. A later genuinely live DTLS/ICE event can fill the PC aggregate's firstTypedError with its own source and PC identity; a replacement channel has its own ID and may provide its own typed error. Neither rewrites the retired channel's summary. Close/error order does not establish cause.

### Service setup, timeout and original termination

PeerEntry stays setup authority; no new watchdog. Allocate its local diagnostic token before native start without an external allocator/sink. Capture immutable setup-started data (explicit no-native yet) and publish only after the original successful setup transaction. On native-start failure, capture terminating/native-start-failure before the current release behavior, publish after it, omit created/deleted callbacks exactly as today, and rethrow the original exception. A failed native constructor never produces a fabricated created PC row.

At markPeerEstablished, freeze original established setup and original native snapshot. At timeout, freeze original PeerSetup, PeerEstablishmentTimeoutEvent, native snapshot and existing AsyncCommandTimeoutEvent watchStartedAtEpochMs/watchTimedOutAtEpochMs before callbacks. After the existing timeout notification/removal decision, publish the reserved timeout row with actual removalDisposition. Reentrant timeout observers may replace the peer; the original record is immutable and replacement cannot be removed by this timeout. Timeout and termination have separate reservations because callback replacement may cause actual removal to be skipped.

Before releasePeer resets resources, capture original native state plus compact current channel states and finite issuer from the actual internal caller: explicit-remove, disconnect-peer, native-closed, lane-wait-cleanup, unusable-peer-replacement, establishment-timeout, native-start-failure. Public remove/disconnect signatures keep their owned default issuer; no required reason input. The terminating service row and each admitted native object's final row preserve distinct setup/native ownership. Parent/child final rows may publish in a different order from capture; join exact identities and local sequence, not inferred envelope causality.

Keep PeerLifecycleCallback and RallarRtcLifecycleEvent unchanged. Browser lifecycle rows remain facade-current-at-notification, independently useful for current status. Original setup/timeout/teardown evidence comes from direct service observations on the existing diagnostic export. Current rows cannot fill a missing original service observation.

Service setup/timeout epochs, watch scheduling/firing epochs, publication epoch, runtime envelope epoch and control envelope epoch remain separately named. timeoutMs is configured scheduler duration. Injected service epoch subtraction is not timer delay; watch epoch subtraction is observed wall-clock elapsed, not monotonic deadline proof.

### Sink/app reentry and failure containment

Freeze/copy detached finite DTOs and first-error choices before any clock/sink. Consume the row's local quota/token before attempting publication. Reentrant clock/sink cannot spend the same reservation twice. All new emissions occur outside the business decision-to-action transaction, including completion of existing awaited business notification sequences when publication could otherwise perturb remaining callbacks; nested setup/release observations are flushed only when the topmost existing owner operation has completed its synchronous business effects and captured required original records. This finite per-operation batch is capped by admitted lifetimes/ordinary rows and discarded after publication; it does not retain ongoing history. Where existing signal observations already precede native actions, preserve existing captured-object guards and add no new allocation effect or await.

After any external app/sink continuation, use the captured token/object solely for its own observation; never restore it as current or write into a replacement. A sink can explicitly reset/reconnect through application calls; those effects remain normal application reentry, not extra permission to continue old setup against a new object. Instrumentation catches surround only capture/translation/publication, not business operations. Disabled capture does not allocate tokens, attach extra listeners or read extra properties. The record helper already isolates throwing clocks/sinks. Failed attempts consume their slot, are not retried, and do not count as native failure. Local first-error memory survives until retirement and may appear in a later row. No successful-delivery acknowledgement or guaranteed self-report through a throwing sink is claimed.

## Existing current-stats join: minimum correction

`BrowserRtcDiagnosticsRuntime.read` captures service, peer object, PC and current native identity before awaiting the existing reader. `readPeer` receives that capture plus the original service reference so after await it can check `service.readPeer(peerId) === capturedPeer` and `capturedPeer.connection.status.pc === capturedPc`; middleware/runtime identity must also remain the captured one. Checking only the mutable peer's PC misses removal/replacement of the whole peer.

Add complete `captureIdentity` and `statsObservation` fields to `RallarRtcPeerDiagnostics`. `statsObservation` is a finite union: `current-at-completion`, `retired-during-read`, `no-native-peer`, `unsupported`, `no-selected-pair`, or `read-failed`. Captured connection/lanes/counters remain explicitly the pre-await sample. If the capture retired or runtime changed, do not join a candidate pair into that row as current: omit it, keep `statsAvailable: false`/`usesRelay: false`, and state `retired-during-read`. Native identity remains the original readout. Do not reread a replacement to fill missing facts, retry `getStats`, or label stats as historical first-error evidence. A fulfilled current read retains existing selected-pair projection semantics. The first-pair heuristic/address fields are not expanded; changing their independent public behavior requires separate scope. Add no hot-callback stats call.

## Owner-to-final-output path and bounds

Construction: existing `createBlackBoxRallarDiagnosticsPorts` callback is passed through `RallarDiagnosticsPortsInput/Ports`, `initialise-browser-middleware`, then `initialiseRtcConnectionService`; the clock and completed optional native observation scope are ready before service/native construction. Native and service shells own capture. Finite pure translation runs before `recordRtcSignalingObservation` calls the external sink. The callback emits the existing topic with the already safe data.

Invocation/export: `BlackBoxRallarRuntimeDiagnostics.emit` adds browser emission time -> `toRallarBrowserEventInput`/`toRallarBlackBoxRuntimeDiagnostic` preserve producer data and browser time -> `InMemoryRallarBlackBoxTestRuntime.appendEvent` adds its own ID/time and configured redaction -> `RallarBlackBoxControlClient.sendNewEvents` forwards unseen events -> control `controlEventArtifactJsonl`/`artifactEventFromControlEvent` adds agent/control envelope and redacts -> `ControlArtifactRecorder` serially appends **`<storageDir>/<encoded-runId>/events.jsonl`**. This is the existing recorder, with existing snapshot response fallback; no new file stream or transport protocol.

On B06 failure, matrix `finalizeLiveRtcAttempt` invokes failure health capture before resource cleanup. `LiveRtcControlClient.captureDiagnostics` reads health A/B/C sequentially, then reads `/runs/<runId>/events.jsonl` once. `toLiveRtcLifecycleHistory` performs the existing exact agent/window scope, positive projection and shared bounded retention; the output is embedded as each agent's `details.lifecycleHistory`. Existing sidecar/attachment `live-rtc-diagnostics-<label>.json` remains optional output. Matrix `writeAttemptEvidence` passes those diagnostic checkpoints to `buildLiveRtcExternalAttempt` and `writeLiveRtcPerformanceEvidence`; the latter writes one create-new, fsynced JSON line at **`tmp/perf/rtc-baseline/<baselineId>/<locator.rawResultRelativePath>`**, confined under `artifacts/staging/`. The current locator is `artifacts/staging/rtc-b06-<case>-<inputKey>-<phase>-<paddedOrdinal>.json`; despite the `.json` extension the writer emits exactly one JSON line. That is the final attempt evidence content, subsequently subject to existing baseline validation/archive/accounting. A failure remains failed with no accepted metrics. Keep the existing artifact path and create-new behavior.

Extend `toLiveRtcDiagnosticEvent`'s existing topic branch with a positive discriminated projection of the new rows. Permit only the exact keys, states, numeric ranges, bounded opaque IDs and nested readout/error fields listed above. Validate IDs before joining; never coerce unknown strings into identities. Reject extra raw payload, fragment, SDP, credentials, certificate, address, arbitrary error text, candidate object, or transport object. Existing general recursive redaction is defense in depth, not this privacy policy. JSONL tests must inject those forbidden keys at every nested boundary, not merely look for a top-level token.

### One finite policy, including the unchanged retention100 scope

Fixed constants live in RtcNativeObservationScope, not settings or several policy owners. No per-PC state/candidate counters, ID registry, per-error reservation or per-limit/owner notice counter remains. Each successful lifetime admission allocates its terminal entitlement atomically:

| Kind           | Lifetime admissions per scope | Reserved attempts per admitted lifetime | Reserved payload                                                                     |
| -------------- | ----------------------------: | --------------------------------------: | ------------------------------------------------------------------------------------ |
| Setup          |                           256 |                                       2 | one establishment-timeout (only if timeout occurs), one terminating service snapshot |
| Native PC      |                           256 |                                       1 | final pre-close native snapshot with first/typed error summaries                     |
| Native channel |                         1,024 |                                       1 | final pre-clear native snapshot with its first/typed summaries                       |

This is at most 1,536 lifetime tokens/IDs and 1,792 terminal attempts. A kind cap denies only diagnostic admission; PC/channel/service behavior continues. All consumers use the same counters. A missing/failed nonce still admits bounded tokens with unavailable IDs, so observations remain finite but cannot claim an ID join. A channel whose captured parent PC lacks admission is also denied; never attach it to a replacement. PC reset within one service setup consumes a new PC admission, while that setup keeps its original timeout/termination entitlement. Channels replacing within an admitted PC each consume a new channel admission and carry their own final entitlement. No entitlement is transferred, recycled, borrowed or reset. Unused timeout slots expire with their setup; this conservatively over-reserves actual output.

There are 4,096 **ordinary** attempts total per scope, shared by created rows, changed state/attachment rows, native-first-error early rows, candidate submitted/returned/rejected (each costs one), and service setup-started/setup-established. Final native retiring rows and service timeout/terminating rows consume only their own terminal entitlement. Terminal snapshots include retained first/typed errors, so ordinary exhaustion does not silence terminal errors of an admitted channel. No separate guarantee exists for an immediate first-error row after ordinary exhaustion. Late promise settlement is ordinary only, never a terminal-slot consumer. Existing three signaling variants keep their existing path and are outside these new-row limits; adding a scalar identity to them does not reserve a native timeline.

Exactly two fixed **status** attempts exist, initialized and disposed, plus exactly one separate **first scope limit** attempt. No extra notice is emitted for later kinds/limits/owners. Flags on all later admitted rows report cumulative ordinary/admission/payload suppression, so a later-cycle terminal can reveal a prior limit even if the single notice was evicted. Scope init unavailable/disabled may be stated only where an existing sink actually receives an explicit status. With no sink/capability there is no guaranteed source status event.

Maximum new attempts per available scope: 4,096 + 1,792 + 2 + 1 = **5,891**, regardless of retry/state/candidate repetition. Ordinary exhaustion prevents further extra state/fragment work, while maintaining first-error scalars and terminal snapshots for already admitted objects. After kind admission exhaustion, new objects lack that promised capture and final reservation; scope flags remain the only source-budget evidence in surviving admitted terminal/status rows. After all admitted lifetimes end and all reserved attempts are spent, no new source evidence is guaranteed. Scope disposal ends even unused entitlements. This is honest bounded evidence, not a guarantee to capture every later failure indefinitely.

Each owner tracks terminal-used/retired state already corresponding to its lifetime; setup additionally tracks whether its one timeout attempt was used. The common scope validates/reserves and consumes counts, with no independently tuned per-channel reservation policy. First/typed errors are finite object summaries, not an event history. No retry of a throwing sink consumes another slot.

**Byte accounting:** source data must fit 8,192 UTF-8 bytes at the owner publication boundary. If it does not, substitute one minimal native-observation-unavailable row (original kind, original bounded identity/setup readouts, payload-bytes, capture flags) using **the same ordinary/terminal/status slot**. It carries no error absence claim because the snapshot was not exported. Also attempt the scope's one separate limit notice only if still unused. The unavailable row itself must fit; if it does not, or serialization/sink fails, no recursive unavailable row or retry is attempted. First-error summaries may appear in a later legitimate snapshot, but a missing final payload remains unavailable.

The source cannot inspect a future control envelope or retroactively replace an already forwarded row. The existing consumer still enforces 16,384-byte control rows: envelope overflow remains its existing oversized/truncated/missing evidence, reported by the new summary, without inventing a source payload-bytes notice. Full maximum-shape acceptance must serialize through the real browser/control translation and prove all allowed native variants fit both limits with bounded permitted identifiers. The 8,192-byte source cap accommodates complete service/error variants; compact service channel entries contain only identity plus channelState, not another NativeSnapshot. Existing 16,384-byte control-row and 262,144-byte shared-output caps stay fixed. A routinely overflowing promised terminal variant is an implementation failure, not acceptable “capture by fallback.” An unexpectedly oversized external envelope still has an honest consumer disposition and no delivery guarantee.

**Actual retention100 workload:** initializer composes once per service; matrix opens A/B/C once, then closes/reconnects C 100 times while A/B persist. No source-budget reset occurs on A/B peer changes or checkpoint reads. Driver connect config has no lane override; middleware supplies realtime, service prepends reliable. Thus two native channels are nominally established per peer PC. The initial A–B link plus 101 C incarnations gives **102 nominal PC/setup lifetimes per surviving A or B**, with 204 native channels: 408 identity tokens each. Each C service scope nominally has two peer PCs/setups and four channels: eight tokens; there are 101 C service scopes across initial+100 reconnects. This accounting does not conflate wrappers with native channel lifetimes.

102 is **not a conservative maximum on actual native work**: retries, native-PC recreation within a setup, duplicate remote channels, glare/replacements or repeated application activity can add lifetimes/rows. For capacity review, doubling every nominal A/B setup+PC admission gives 204 each; allowing four native channels per such PC (two configured lanes plus two replacements) gives 816 channels, 1,224 tokens and at most 1,428 reserved terminal attempts. Those all fit the fixed caps, with 52 setup/PC admissions and 208 channel admissions remaining. This is an explicit stress allowance, not a theorem bounding recovery. A workload with more replacements reaches admission-limit, keeps native behavior/sample grammar unchanged and produces incomplete evidence. At nominal 102 PCs, even 64 state+128 candidate rows per PC could require 19,584 ordinary rows before any setup/create/error rows; the 4,096 ordinary quota is therefore deliberately not advertised as retention100 timeline capacity. Later admitted failures still have their terminal snapshot reservations regardless of that early exhaustion. Runtime measurements must report limits reached; they cannot silently use a fresh A/B scope per cycle or accept fewer cycles.

Keep existing independent limits exactly: formation facts 8,192 UTF-8 bytes/up to 10 desired + 10 ready identities; recorder read input 8,388,608 bytes; transport 67,108,864 bytes; read timeout 30,000 ms; scanned 20,000 rows; row 16,384 bytes; retained 600 rows; shared output 262,144 bytes; identity characters 256. Native rows share the same 600-row/262,144-byte pool. Even 5,891 bounded new attempts can overflow those independent artifact suffix limits, and healthy nominal terminal history is not guaranteed to survive a full retention100 suffix. The existing source recorder itself grows/copies/scans events; these bounds do not fix its global retention or the separate allocation-rollback candidate. Source admission, attempted publication, recorder retention and final projection are distinct evidence limits.

### Positive serialized projection and final evidence dispositions

Extend the existing lifecycle-history result with one mandatory `nativeObservation` summary, positive projected in the same output budget: `status: 'observations-present' | 'unavailable'`, `delivery: 'received' | 'missing-or-failed' | 'stream-unavailable'`, `coverage: 'bounded-partial' | 'unavailable'`, and required booleans `malformedRows`, `sourceAdmissionLimited`, `sourceOrdinaryLimited`, `sourcePayloadLimited`, `artifactTruncated`. It also has `capability: Readout<'enabled'>`; only a received valid initialized/status row may establish enabled/disabled/initialization-failed for its exact scope. If no such row survives, capability is unavailable/absent, not inferred disabled. For multiple scopes, per-row scope readouts carry their own capability evidence; the summary must not let one scope's enabled status prove another's coverage. Its capability may be observed only for one exactly identified received scope; otherwise it is unavailable/absent and the rows remain individually readable. Summary limit booleans mean a received row or existing artifact metadata reported that condition; false means no retained report, not proof it never occurred. There is no complete-history value.

Every valid new row requires its exact discriminant and all required fields, bounds, readout variants and coverage compatibility. Each error observed variant requires the finite NativeError; none-observed requires valid actual-window/settled-operation coverage and has no error payload; unavailable requires recognized reason+coverage. Missing/null/undefined-after-serialization, malformed nested fields or impossible combinations invalidate that native row; mark malformedRows and do not transform it into none-observed. Unknown extra keys are never copied. Do not synthesize original object state from another row or present current facade health as missing owner evidence. For a recognized valid unavailable fallback row, preserve payload-bytes explicitly and sourcePayloadLimited; error readouts remain unavailable as a consequence of absent exported snapshot, not fabricated none-observed.

| Source/transport case                                                              | What final artifact may state                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Complete valid snapshot with observed error                                        | Exact source/identity/readouts and observation-window coverage, even if scope identity is unavailable; no join without identity.                                                                                                                                                                                                                       |
| Valid none-observed error                                                          | No qualifying error observed in that specific window; partial attachment/ended window remains explicit.                                                                                                                                                                                                                                                |
| Setup before PC allocation or native constructor throw                             | Explicit no-native-object snapshot/error readouts in received service row. Original native exception behavior is preserved; diagnostics do not manufacture a PC lifetime.                                                                                                                                                                              |
| Native diagnostics deliberately absent/disabled                                    | If an existing diagnostic status actually arrives, capability disabled. If diagnostics are entirely absent, artifact says unavailable/missing-or-failed and capability absent; absence of delivery cannot prove deliberate disablement.                                                                                                                |
| Scope factory/native identity source failure                                       | Initialization-failed capability if its status arrives; or state/error observations with identity-source-absent/failed/invalid IDs if a live scope records them. Missing status remains unknown/missing-or-failed.                                                                                                                                     |
| Ordinary exhausted                                                                 | Received final snapshots carry sourceOrdinaryLimited; first-error summaries in those snapshots remain valid. Missing candidate/state rows cannot be reconstructed.                                                                                                                                                                                     |
| Kind admission exhausted                                                           | Received scope/admitted terminal rows carry sourceAdmissionLimited; unadmitted later objects have no promised terminal/error capture. Never map them to the last known identity.                                                                                                                                                                       |
| Row data/envelope too large                                                        | Oversized source data gets same-slot unavailable fallback when possible; oversized downstream envelope gets existing consumer oversized/truncation evidence or missing-or-failed, not an invented source fallback. No omitted fields interpreted as no errors.                                                                                         |
| Throwing clock/sink, lost forwarding/control append, missing terminal              | Cannot be reliably self-reported by that sink. No delivery acknowledgement exists. If rows are absent, summary missing-or-failed; if some arrive, delivery received with bounded-partial coverage, never “all terminal evidence delivered.”                                                                                                            |
| Missing recorder, malformed rows, window filtering, scanned/retained/output limits | Preserve existing stream failure/truncation metadata; new summary unavailable or bounded-partial with the corresponding flags. A surviving suffix proves only surviving rows. If the optional diagnostic output itself fails, existing failed-attempt/output-error path records that failure; do not assert this summary exists in a nonexistent file. |

This summary is evidence interpretation, not a second recorder or a new diagnosis. It uses existing stream/projection outcomes, does not acknowledge events, retry recording, add a timer, or enlarge retained pools. Pure positive projection and source finite translators remain the only privacy boundaries; existing generic redaction is supplemental.

## B06 evidence and preserved findings

Capture mode belongs to validated resolved configuration, producer observation and metric
cohort grouping. Propagate it explicitly through observation CLI, workflow, worker and
browser query/configuration; scrub or reject inherited environment that could alter a
sealed attempt. CI, benchmarks and generated investigative recipes record an explicit
resolved mode rather than relying on the sink-dependent product default. Different modes,
unavailable application and unverified receipts cannot be pooled as one comparison.
Source, environment, browser, workload and applied mode must match.

Preserve default/all-scenarios/retention100, **three warmups and eleven retained primary
attempts**, controlled-repeat rules, scenario timing/accounting, immutable source identity
and output confinement. Keep every failed primary unchanged with no accepted metrics.
Use the existing `npm run perf:rtc-baseline -- observe-live-rtc` producer when separately
requested; implementing capture does not dispatch it automatically. A diagnostic
perturbation experiment remains separately labeled and cannot become accepted baseline
evidence merely because its mode is valid.

Runtime evidence must answer actual browser API/listener availability, whether a naturally
failed attempt retains the original identity/error/candidate/timeout evidence, which bounds
were reached, and the added CPU/wall/heap/allocation/GC/event-loop cost. Use existing
profiling around publication, append/forward scans and recorder output; do not add another
hot-path sink to measure sink cost. A bounded source ceiling is not an acceptable-overhead
claim, and a retained suffix is not complete history.

The measured UI observer experiment remains **117–150 ms versus about 4 ms for 2,136
events**, in Vite development/StrictMode only. The recovery-expiry mechanism is confirmed;
matching Answers, current layout and B-ready are positive correlations. The initial
post-ICE/native-and-channel-connecting stall remains **UNKNOWN**. Allocation rollback
remains separate and unimplemented. E3 has no accepted cohort, B07 remains held, and the
full baseline remains incomplete. This feature does not itself change those findings.

## Semantic acceptance

Exercise the real owning boundaries and serialized outputs, not private counter topology
or source-string inventories. Required observable proofs are:

- All modes, all precedence levels, explicit Off, invalid nonempty values, omitted/inherited
  settings and JSON round trips; actual SDK composition and no-application-defaults path;
  correct active/pending reuse and explicit disconnect/connect. Off adds no RTC observation
  work; Signaling installs no native capture; Full native applies the complete contract.
- Visible Manual and Recipe Console controls: Connect without Configure, save/restore/reset,
  Load/Run/Rerun and command export. Assert resulting commands and actual applied browser
  state; query setup or selected widget value alone is insufficient.
- Ordinary/scenario/distributed execution across nested/parallel/implicit/reload/reconnect,
  inline/reference-only and spawned/external/mixed/no-spawn paths. Required-mode acceptance
  rejects old agents, dropped fields, stale body/configuration identity and replayed receipts.
  Actual env-to-URL-to-bootstrap-to-command propagation covers Inherit and explicit Off;
  workflow text assertions only supplement executable propagation tests.
- The real scope factory, shared admissions and monotonic allocation for browser and direct
  consumers; missing/throwing/invalid nonce sources; duplicate nonces across distinct scopes
  demonstrate the uniqueness assumption rather than a global registry guarantee. Source
  reentry into an existing service/peer/channel cannot bind new graph IDs to old owners.
- Native constructor failure preserves the exact original thrown value and existing callback
  behavior. Sink/clock reentry at setup, creation, timeout, reset and channel error cannot
  overwrite replacement capture, spend a reservation twice or change existing native outcomes.
  Initialization failure, cancellation and shutdown dispose only diagnostic resources, once.
- Actual PC/ICE/DTLS/SCTP/channel events prove exact binding, late attachment/gaps, unsupported
  APIs, chain replacement and detached callbacks. First and first-typed errors survive
  retirement and ordinary exhaustion. A later typed event on a detached original channel
  does nothing; parent/replacement errors keep their own identities and ended windows.
- Direct and drained candidate submitted/returned/rejected events preserve FIFO, successful
  counts, continuation and original exceptions. Include repeated equal candidates, invalid
  and oversized fragments, equal/different fragments, missing/throwing parameter methods,
  renegotiation, media transports and late settlements after replacement/disposal. Both
  association fields stay unknown and no raw fragment/candidate/credential survives.
- Original setup, watch clocks, timeout and issuer survive reentrant peer replacement;
  only the original peer is eligible for removal. Cover every named termination issuer.
  Native final rows and service timeout/termination remain independent entitlements.
- A persistent A/B-like scope survives retention100 replacements without resetting budgets.
  Exhaust ordinary quota early, then capture a later admitted channel failure and timeout.
  Exercise 204 setup/PC plus 816 channel stress allowance, all admission limits and the
  5,891-attempt ceiling; denied diagnostic admission never denies native work.
- Maximum permitted DTO shapes fit 8,192 source bytes and 16,384 translated row bytes.
  Source overflow uses the same slot for unavailable; downstream envelope overflow retains
  consumer disposition. No recursive fallback, extra notice, borrowed slot or missing-field
  stripping. Required error/readout discriminants survive stringify/parse and real control
  JSONL translation. Missing/null/malformed/impossible coverage and forbidden nested payloads
  cannot become none-observed.
- Mixed history obeys the existing shared suffix/output bounds. Missing recorder, malformed
  rows, absent/evicted finals and optional output failure remain unavailable/bounded-partial;
  failed attempts never acquire accepted metrics. One scope's enabled status cannot certify
  another scope. Formation limits stay unchanged.
- Delay the existing getStats read, then replace PC, whole peer, service or middleware/runtime,
  including rejection after retirement. Return the captured pre-await sample with
  retired-during-read and no replacement pair; make exactly the existing single read.
- B06 validation rejects mode-mixed, ambiently overridden, unavailable or unproven cohorts
  while retaining exact sample/workload/attempt grammar. Configuration tests do not claim
  deployed native availability or a new accepted baseline.

## Implementation horizon and validation

Keep only these next two slices concrete:

1. Canonical mode normalization, real SDK composition and immutable active/pending selection,
   with complete truthful construction receipts. During this intermediate slice a native
   request can explicitly report unavailable while native capture is not yet implemented;
   that temporary status does not satisfy final acceptance.
2. Complete original-owner native/service capture through the existing bounded artifact path,
   with current-stats identity fencing, semantic error/budget/privacy proofs and affected
   consumer validation.

UI, ordinary/distributed recipe, local/hosted/Actions and B06 propagation are required later
outcomes, not optional follow-ups. Detail their next slices when current evidence supports
sequencing. Any necessary coherent consolidation remains within these outcomes and preserves
one owner-to-result path. The implementation is not complete until all surfaces and acceptance
above are delivered.

Run focused native/service/browser tests first, including signaling diagnostics, peer/channel,
queue drain, service timeout/redial, browser initialization/recovery/stats and live RTC
projection/control tests. Add affected recipe/schema/control/distributed/headless/worker/
workflow and B06 semantic suites as those surfaces change. Use visible-control Playwright
coverage for UI behavior.

Then run affected shared/shared-web/shared-server TypeScript checks, shared-test and
shared-rtc-bench checks, test typecheck, black-box/headless builds, control Deno check,
shared-web public API snapshots and browser-bundle boundaries, and game consumer builds
where the browser surface is consumed. API snapshots inventory exports; compiler and
serialization tests prove required field contracts. No production benchmark dependency
is introduced. Database mutation/topology gates are not required solely for diagnostics.

Before broad final validation run `npm run pr:delivery -- status`; repair a real conflict,
not BEHIND alone while mergeable. Run applicable formatting, repo style/changed style,
construction details, structure, test coupling and retained-legacy checks, with manual
owner-to-result review and independent implementation review. Root owns publication and
`pr:delivery -- ready`. Passing checks are validation evidence, not live skill-order proof.

Review and remediate every changed human-authored file in full; every support file modified
by that remediation enters closure recursively; independent untouched code remains outside
closure. Keep public additions intentional, compile affected exhaustive/structural consumers,
and remove affected legacy without an independent requirement. A genuine newly discovered
public compatibility conflict requires its precise maintainer decision; no generic approval
stage is reopened. Do not create progress ledgers, source inventories or stage logs in this
specification. Report actual passed, failed and skipped commands at handoff.
