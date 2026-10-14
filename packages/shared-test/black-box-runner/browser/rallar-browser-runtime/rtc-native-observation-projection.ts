import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

export interface RtcNativeProjection {
    readonly recognized: boolean;
    readonly event: ApiJsonObject | undefined;
}

export const RTC_NATIVE_OBSERVATION_KINDS = [
    'native-lifetime',
    'native-state',
    'native-first-error',
    'native-candidate-application',
    'service-peer-observation',
    'native-observation-status',
    'native-observation-limit',
    'native-observation-unavailable'
] as const;
const REASONS = [
    'disabled',
    'no-native-object',
    'absent',
    'unsupported',
    'unrecognized',
    'read-failed',
    'identity-source-absent',
    'identity-source-failed',
    'identity-invalid',
    'initialization-failed',
    'admission-limit',
    'scope-disposed',
    'payload-bytes',
    'not-applicable'
];
const ERROR_REASONS = [
    'disabled',
    'no-native-object',
    'initialization-failed',
    'admission-limit',
    'unsupported',
    'read-failed',
    'payload-bytes',
    'scope-disposed'
];
const CONNECTION_STATES = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'];
const ICE_STATES = ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'];
const SIGNALING_STATES = [
    'stable',
    'have-local-offer',
    'have-local-pranswer',
    'have-remote-offer',
    'have-remote-pranswer',
    'closed'
];
const ISSUERS = [
    'explicit-remove',
    'disconnect-peer',
    'native-closed',
    'lane-wait-cleanup',
    'unusable-peer-replacement',
    'establishment-timeout',
    'native-start-failure'
];

/** Untrusted serialized native evidence is accepted only as the complete finite wire grammar. */
export function toRtcNativeObservationProjection(value: unknown): RtcNativeProjection {
    const row = toJsonObject(value);
    if (!row || !isOneOf(row.kind, RTC_NATIVE_OBSERVATION_KINDS)) {
        return { recognized: false, event: undefined };
    }
    const body = toNativeBody(row);
    const allowed = [
        'kind',
        'localSessionId',
        'peerSessionId',
        'signalType',
        'offerId',
        'atEpochMs',
        ...Object.keys(body ?? {})
    ];
    if (
        !body || !hasOnlyKeys(row, allowed) || !isIdentityText(row.localSessionId, 256) ||
        !isNonnegative(row.atEpochMs) ||
        (row.peerSessionId !== undefined && !isIdentityText(row.peerSessionId, 256)) ||
        row.offerId !== undefined ||
        (row.signalType !== undefined &&
            !(row.kind === 'native-candidate-application' && row.signalType === 'IceCandidate'))
    ) {
        return { recognized: true, event: undefined };
    }
    return {
        recognized: true,
        event: {
            kind: row.kind as string,
            localSessionId: row.localSessionId as string,
            ...(row.peerSessionId === undefined ? {} : { peerSessionId: row.peerSessionId as string }),
            ...(row.signalType === undefined ? {} : { signalType: 'IceCandidate' }),
            atEpochMs: row.atEpochMs as number,
            ...body
        }
    };
}

function toNativeBody(row: Record<string, unknown>): ApiJsonObject | undefined {
    if (row.kind === 'native-lifetime') {
        const native = toNativeSnapshot(row.native);
        if (!native || !isOneOf(row.action, ['created', 'retiring'])) {
            return undefined;
        }
        if (row.action === 'created') {
            return { action: 'created', native };
        }
        return isOneOf(row.retirement, ['reset', 'replacement', 'channel-close', 'channel-error', 'unknown'])
            ? { action: 'retiring', retirement: row.retirement as string, native }
            : undefined;
    }
    if (row.kind === 'native-state') {
        const native = toNativeSnapshot(row.native);
        return native &&
                isOneOf(row.trigger, [
                    'connection',
                    'ice-connection',
                    'ice-gathering',
                    'signaling',
                    'ice-transport',
                    'dtls',
                    'sctp',
                    'channel-open',
                    'channel-close',
                    'transport-attached'
                ])
            ? { native, trigger: row.trigger as string }
            : undefined;
    }
    if (row.kind === 'native-first-error') {
        const native = toNativeSnapshot(row.native);
        const error = toNativeError(row.error);
        return native && error && isOneOf(row.first, ['observed', 'typed', 'both'])
            ? { native, error, first: row.first as string }
            : undefined;
    }
    if (row.kind === 'native-candidate-application') {
        const projected = toCandidate(row.candidate);
        return projected ? { candidate: projected } : undefined;
    }
    if (row.kind === 'service-peer-observation') {
        const projected = toService(row.service);
        return projected ? { service: projected } : undefined;
    }
    return toNativeControlBody(row);
}

function toNativeControlBody(row: Record<string, unknown>): ApiJsonObject | undefined {
    const capture = toCaptureStatus(row.capture);
    if (!capture) {
        return undefined;
    }
    if (row.kind === 'native-observation-status') {
        const availability = toReadout(row.availability, ['enabled']);
        return availability && isOneOf(row.stage, ['initialized', 'disposed'])
            ? { stage: row.stage as string, availability, capture }
            : undefined;
    }
    const identity = toRtcNativeIdentity(row.identity);
    if (!identity) {
        return undefined;
    }
    if (row.kind === 'native-observation-limit') {
        return isOneOf(row.limit, ['admission', 'ordinary-rows', 'payload-bytes'])
            ? { limit: row.limit as string, identity, capture }
            : undefined;
    }
    const setupId = toReadout(row.setupId, 'identity');
    return setupId && row.reason === 'payload-bytes' &&
            isOneOf(row.originalKind, RTC_NATIVE_OBSERVATION_KINDS.slice(0, 6))
        ? { originalKind: row.originalKind as string, reason: 'payload-bytes', identity, setupId, capture }
        : undefined;
}

export function toRtcNativeIdentity(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (!object || !hasOnlyKeys(object, ['peerConnectionId', 'channelId'])) {
        return undefined;
    }
    const peerConnectionId = toReadout(object.peerConnectionId, 'identity');
    const channelId = toReadout(object.channelId, 'identity');
    return peerConnectionId && channelId ? { peerConnectionId, channelId } : undefined;
}

function toNativeSnapshot(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (
        !object ||
        !hasOnlyKeys(object, ['identity', 'state', 'firstError', 'firstTypedError', 'nativeSequence', 'capture']) ||
        !isInteger(object.nativeSequence)
    ) {
        return undefined;
    }
    const identity = toRtcNativeIdentity(object.identity);
    const state = toNativeState(object.state);
    const firstError = toErrorReadout(object.firstError);
    const firstTypedError = toErrorReadout(object.firstTypedError);
    const capture = toCaptureStatus(object.capture);
    return identity && state && firstError && firstTypedError && capture
        ? { identity, state, firstError, firstTypedError, capture, nativeSequence: object.nativeSequence as number }
        : undefined;
}

function toNativeState(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (
        !object ||
        !hasOnlyKeys(object, [
            'connectionState',
            'iceConnectionState',
            'iceGatheringState',
            'signalingState',
            'iceTransportState',
            'dtlsState',
            'sctpState',
            'channelState',
            'transportObjectOrdinal',
            'transportBinding',
            'listenerCoverage',
            'attachmentGap'
        ])
    ) {
        return undefined;
    }
    const connectionState = toReadout(object.connectionState, CONNECTION_STATES);
    const iceConnectionState = toReadout(object.iceConnectionState, ICE_STATES);
    const iceGatheringState = toReadout(object.iceGatheringState, ['new', 'gathering', 'complete']);
    const signalingState = toReadout(object.signalingState, SIGNALING_STATES);
    const iceTransportState = toReadout(object.iceTransportState, ICE_STATES);
    const dtlsState = toReadout(object.dtlsState, ['new', 'connecting', 'connected', 'closed', 'failed']);
    const sctpState = toReadout(object.sctpState, ['connecting', 'connected', 'closed']);
    const channelState = toReadout(object.channelState, ['connecting', 'open', 'closing', 'closed']);
    const transportObjectOrdinal = toReadout(object.transportObjectOrdinal, Number.MAX_SAFE_INTEGER);
    return connectionState && iceConnectionState && iceGatheringState && signalingState && iceTransportState &&
            dtlsState && sctpState && channelState && transportObjectOrdinal &&
            isOneOf(object.transportBinding, ['data-sctp-chain', 'unavailable']) &&
            isOneOf(object.listenerCoverage, ['attached', 'partial', 'unavailable']) &&
            typeof object.attachmentGap === 'boolean'
        ? {
            connectionState,
            iceConnectionState,
            iceGatheringState,
            signalingState,
            iceTransportState,
            dtlsState,
            sctpState,
            channelState,
            transportObjectOrdinal,
            transportBinding: object.transportBinding as string,
            listenerCoverage: object.listenerCoverage as string,
            attachmentGap: object.attachmentGap
        }
        : undefined;
}

function toNativeError(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (
        !object ||
        !hasOnlyKeys(object, [
            'source',
            'nativeSequence',
            'identity',
            'errorDetail',
            'sctpCauseCode',
            'receivedAlert',
            'sentAlert',
            'iceErrorCode',
            'exceptionName'
        ]) || !isInteger(object.nativeSequence) ||
        !isOneOf(object.source, [
            'ice-candidate-error',
            'dtls-error',
            'channel-error',
            'candidate-rejection',
            'description-rejection'
        ])
    ) {
        return undefined;
    }
    const identity = toRtcNativeIdentity(object.identity);
    const facts = toNativeErrorFacts(object);
    return identity && facts
        ? { ...facts, identity, source: object.source as string, nativeSequence: object.nativeSequence as number }
        : undefined;
}

function toNativeErrorFacts(object: Record<string, unknown>): ApiJsonObject | undefined {
    const errorDetail = toReadout(object.errorDetail, [
        'data-channel-failure',
        'dtls-failure',
        'fingerprint-failure',
        'hardware-encoder-error',
        'hardware-encoder-not-available',
        'sctp-failure',
        'sdp-syntax-error'
    ]);
    const sctpCauseCode = toReadout(object.sctpCauseCode, 65535);
    const receivedAlert = toReadout(object.receivedAlert, 255);
    const sentAlert = toReadout(object.sentAlert, 255);
    const iceErrorCode = toReadout(object.iceErrorCode, 701);
    const exceptionName = toReadout(object.exceptionName, [
        'OperationError',
        'InvalidStateError',
        'TypeError',
        'NotSupportedError',
        'AbortError',
        'UnknownError'
    ]);
    return errorDetail && sctpCauseCode && receivedAlert && sentAlert && iceErrorCode && exceptionName
        ? { errorDetail, sctpCauseCode, receivedAlert, sentAlert, iceErrorCode, exceptionName }
        : undefined;
}

function toErrorReadout(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (!object) {
        return undefined;
    }
    const coverage = toErrorCoverage(object.coverage);
    if (!coverage) {
        return undefined;
    }
    if (object.status === 'observed') {
        const error = toNativeError(object.value);
        return error && hasOnlyKeys(object, ['status', 'value', 'coverage']) && coverage.kind !== 'unavailable' &&
                coverage.stage !== 'pending'
            ? { status: 'observed', value: error, coverage }
            : undefined;
    }
    if (object.status === 'none-observed') {
        return hasOnlyKeys(object, ['status', 'coverage']) &&
                (coverage.kind === 'listener-window' || coverage.stage === 'settled')
            ? { status: 'none-observed', coverage }
            : undefined;
    }
    return object.status === 'unavailable' && hasOnlyKeys(object, ['status', 'reason', 'coverage']) &&
            isOneOf(object.reason, [...ERROR_REASONS, 'not-applicable']) &&
            (object.reason !== 'not-applicable' || coverage.stage === 'pending')
        ? { status: 'unavailable', reason: object.reason as string, coverage }
        : undefined;
}

function toErrorCoverage(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (!object) {
        return undefined;
    }
    if (object.kind === 'listener-window') {
        return hasOnlyKeys(object, ['kind', 'window', 'attachment', 'attachmentGap']) &&
                isOneOf(object.window, ['active', 'ended-at-retirement']) &&
                isOneOf(object.attachment, ['attached', 'partial']) && typeof object.attachmentGap === 'boolean'
            ? {
                kind: 'listener-window',
                window: object.window as string,
                attachment: object.attachment as string,
                attachmentGap: object.attachmentGap
            }
            : undefined;
    }
    if (object.kind === 'native-operation') {
        return hasOnlyKeys(object, ['kind', 'stage']) && isOneOf(object.stage, ['pending', 'settled'])
            ? { kind: 'native-operation', stage: object.stage as string }
            : undefined;
    }
    return object.kind === 'unavailable' && hasOnlyKeys(object, ['kind', 'reason']) &&
            isOneOf(object.reason, ERROR_REASONS)
        ? { kind: 'unavailable', reason: object.reason as string }
        : undefined;
}

function toCaptureStatus(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (
        !object ||
        !hasOnlyKeys(object, ['scopeId', 'scope', 'ordinaryRowsSuppressed', 'admissionLimited', 'payloadLimited'])
    ) {
        return undefined;
    }
    const scopeId = toReadout(object.scopeId, 'scope');
    return scopeId && isOneOf(object.scope, ['active', 'disposed', 'unavailable']) &&
            typeof object.ordinaryRowsSuppressed === 'boolean' && typeof object.admissionLimited === 'boolean' &&
            typeof object.payloadLimited === 'boolean'
        ? {
            scopeId,
            scope: object.scope as string,
            ordinaryRowsSuppressed: object.ordinaryRowsSuppressed,
            admissionLimited: object.admissionLimited,
            payloadLimited: object.payloadLimited
        }
        : undefined;
}

function toCandidate(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (
        !object ||
        !hasOnlyKeys(object, [
            'operationOrdinal',
            'applicationOrdinal',
            'source',
            'stage',
            'currentPeerConnection',
            'identity',
            'fragmentPresence',
            'dataIceFragmentComparison',
            'comparisonReadout',
            'targetTransportAssociation',
            'iceGenerationAssociation',
            'error',
            'capture'
        ]) || !isInteger(object.operationOrdinal) || !isInteger(object.applicationOrdinal) ||
        !isOneOf(object.source, ['direct', 'queue-drain']) ||
        !isOneOf(object.stage, ['submitted', 'returned', 'rejected']) ||
        typeof object.currentPeerConnection !== 'boolean' ||
        !isOneOf(object.fragmentPresence, ['present', 'absent', 'unavailable']) ||
        !isOneOf(object.dataIceFragmentComparison, ['equal', 'different', 'unknown']) ||
        object.targetTransportAssociation !== 'unknown' || object.iceGenerationAssociation !== 'unknown'
    ) {
        return undefined;
    }
    const identity = toRtcNativeIdentity(object.identity);
    const comparisonReadout = toReadout(object.comparisonReadout, ['available']);
    const error = toErrorReadout(object.error);
    const capture = toCaptureStatus(object.capture);
    if (!identity || !comparisonReadout || !error || !capture) {
        return undefined;
    }
    const coverage = toJsonObject(error.coverage);
    if (
        coverage?.kind !== 'native-operation' || (object.stage === 'submitted'
            ? error.status !== 'unavailable' || error.reason !== 'not-applicable' || coverage.stage !== 'pending'
            : coverage.stage !== 'settled' ||
                (object.stage === 'returned' ? error.status !== 'none-observed' : error.status !== 'observed'))
    ) {
        return undefined;
    }
    return {
        operationOrdinal: object.operationOrdinal as number,
        applicationOrdinal: object.applicationOrdinal as number,
        source: object.source as string,
        stage: object.stage as string,
        currentPeerConnection: object.currentPeerConnection,
        identity,
        fragmentPresence: object.fragmentPresence as string,
        dataIceFragmentComparison: object.dataIceFragmentComparison as string,
        comparisonReadout,
        targetTransportAssociation: 'unknown',
        iceGenerationAssociation: 'unknown',
        error,
        capture
    };
}

function toService(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (!object) {
        return undefined;
    }
    const fields = [
        'peerId',
        'setupId',
        'setup',
        'native',
        'channels',
        'channelCount',
        'channelsTruncated',
        'capture',
        'stage',
        'issuer',
        'timeout'
    ];
    if (object.stage === 'establishment-timeout') {
        fields.push('watchStartedAtEpochMs', 'watchTimedOutAtEpochMs', 'removalDisposition');
    }
    if (
        !hasOnlyKeys(object, fields) || !isIdentityText(object.peerId, 256) || !isInteger(object.channelCount) ||
        typeof object.channelsTruncated !== 'boolean' || !Array.isArray(object.channels) || object.channels.length > 4
    ) {
        return undefined;
    }
    const setupId = toReadout(object.setupId, 'identity');
    const setup = toPeerSetup(object.setup);
    const native = toNativeSnapshot(object.native);
    const capture = toCaptureStatus(object.capture);
    const channels = object.channels.map(toCompactChannel);
    const issuer = toReadout(object.issuer, ISSUERS);
    if (
        !setupId || !setup || !native || !capture || !issuer || channels.some((channel) => !channel) ||
        (object.channelCount as number) < channels.length ||
        object.channelsTruncated !== ((object.channelCount as number) > channels.length)
    ) {
        return undefined;
    }
    const common = {
        peerId: object.peerId as string,
        setupId,
        setup,
        native,
        capture,
        channels: channels as ApiJsonObject[],
        channelCount: object.channelCount as number,
        channelsTruncated: object.channelsTruncated,
        issuer
    };
    return toServiceStage(object, common, issuer);
}

function toServiceStage(
    object: Record<string, unknown>,
    common: ApiJsonObject,
    issuer: ApiJsonObject
): ApiJsonObject | undefined {
    if (isOneOf(object.stage, ['setup-started', 'setup-established', 'terminating'])) {
        const timeout = toReadout(object.timeout, []);
        return timeout?.reason === 'not-applicable' &&
                (object.stage === 'terminating' ? issuer.status === 'observed' : issuer.reason === 'not-applicable')
            ? { ...common, stage: object.stage as string, timeout }
            : undefined;
    }
    const timeout = toTimeoutReadout(object.timeout);
    return object.stage === 'establishment-timeout' && timeout && issuer.value === 'establishment-timeout' &&
            isNonnegative(object.watchStartedAtEpochMs) && isNonnegative(object.watchTimedOutAtEpochMs) &&
            isOneOf(object.removalDisposition, ['original-removed', 'original-no-longer-current'])
        ? {
            ...common,
            stage: 'establishment-timeout',
            timeout,
            watchStartedAtEpochMs: object.watchStartedAtEpochMs as number,
            watchTimedOutAtEpochMs: object.watchTimedOutAtEpochMs as number,
            removalDisposition: object.removalDisposition as string
        }
        : undefined;
}

function toCompactChannel(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (!object || !hasOnlyKeys(object, ['identity', 'channelState'])) {
        return undefined;
    }
    const identity = toRtcNativeIdentity(object.identity);
    const channelState = toReadout(object.channelState, ['connecting', 'open', 'closing', 'closed']);
    return identity && channelState ? { identity, channelState } : undefined;
}

function toPeerSetup(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (
        !object || !hasOnlyKeys(
            object,
            object.phase === 'established'
                ? ['peerId', 'phase', 'startedAtEpochMs', 'establishedAtEpochMs']
                : ['peerId', 'phase', 'startedAtEpochMs']
        ) || !isIdentityText(object.peerId, 256) || !isOneOf(object.phase, ['in-flight', 'established']) ||
        !isNonnegative(object.startedAtEpochMs)
    ) {
        return undefined;
    }
    const setup = {
        peerId: object.peerId as string,
        phase: object.phase as string,
        startedAtEpochMs: object.startedAtEpochMs as number
    };
    return object.phase === 'in-flight'
        ? setup
        : isNonnegative(object.establishedAtEpochMs)
        ? { ...setup, establishedAtEpochMs: object.establishedAtEpochMs as number }
        : undefined;
}

function toTimeoutReadout(value: unknown): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    const event = toJsonObject(object?.value);
    return object && hasOnlyKeys(object, ['status', 'value']) && object.status === 'observed' && event &&
            hasOnlyKeys(event, ['peerId', 'reason', 'startedAtEpochMs', 'timedOutAtEpochMs', 'timeoutMs']) &&
            isIdentityText(event.peerId, 256) && event.reason === 'peer-establishment-timeout' &&
            isNonnegative(event.startedAtEpochMs) && isNonnegative(event.timedOutAtEpochMs) &&
            isNonnegative(event.timeoutMs)
        ? {
            status: 'observed',
            value: {
                peerId: event.peerId as string,
                reason: 'peer-establishment-timeout',
                startedAtEpochMs: event.startedAtEpochMs as number,
                timedOutAtEpochMs: event.timedOutAtEpochMs as number,
                timeoutMs: event.timeoutMs as number
            }
        }
        : undefined;
}

function toReadout(
    value: unknown,
    allowed: readonly string[] | 'identity' | 'scope' | number
): ApiJsonObject | undefined {
    const object = toJsonObject(value);
    if (!object) {
        return undefined;
    }
    if (object.status === 'unavailable') {
        return hasOnlyKeys(object, ['status', 'reason']) && isOneOf(object.reason, REASONS)
            ? { status: 'unavailable', reason: object.reason as string }
            : undefined;
    }
    if (object.status !== 'observed' || !hasOnlyKeys(object, ['status', 'value'])) {
        return undefined;
    }
    const valid = typeof allowed === 'number'
        ? isInteger(object.value) && (object.value as number) <= allowed
        : allowed === 'identity' || allowed === 'scope'
        ? isIdentityText(object.value, allowed === 'scope' ? 64 : 128) &&
            /^[A-Za-z0-9_-]+$/.test(object.value as string)
        : isOneOf(object.value, allowed);
    return valid ? { status: 'observed', value: object.value as ApiJsonValue } : undefined;
}

function toJsonObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function isOneOf(value: unknown, allowed: readonly string[]): boolean {
    return typeof value === 'string' && allowed.includes(value);
}
function isIdentityText(value: unknown, maximum: number): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}
function isNonnegative(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isInteger(value: unknown): boolean {
    return isNonnegative(value) && Number.isSafeInteger(value);
}
