import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
    RallarBlackBoxTestTransport
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { DistributedRunMonitor } from './distributed-recipes.ts';

export type RtcConnectStageId =
    | 'auth'
    | 'runtime-bootstrap'
    | 'group-join'
    | 'signaling'
    | 'peer-discovery'
    | 'data-channel'
    | 'first-payload';

export type RtcConnectStageStatus = 'observed' | 'pending' | 'warning' | 'failed';

/** One connect stage as the RTC timeline shows it. */
export type RtcConnectStage = Readonly<{
    stageId: RtcConnectStageId;
    label: string;
    status: RtcConnectStageStatus;
    /** Absent while no observed event has reached the stage. */
    atEpochMs?: number;
    /** Absent while no observed event has reached the stage. */
    durationFromStartMs?: number;
    /** Absent while no observed event has reached the stage. */
    eventId?: string;
    /** Absent while no observed event has reached the stage. */
    topic?: string;
    /** The reaching event's payload; absent when that event carried none. */
    details?: ApiJsonValue;
}>;

export type RtcMembershipDiagnostics = Readonly<{
    connection: string;
    actor: string;
    roomId: string;
    /** Absent when neither the latest RTC event nor the runtime config names a session. */
    sessionId?: string;
    expectedClients: readonly string[];
    observedClients: readonly string[];
    readyPeerIds: readonly string[];
    activePeerIds: readonly string[];
    missingClients: readonly string[];
    extraClients: readonly string[];
    staleClients: readonly string[];
    nackCodes: readonly string[];
    /** Absent until an RTC event or a stats snapshot reports a peer count. */
    peerCount?: number;
    /** Absent until an RTC event or a stats snapshot reports lane health. */
    laneHealth?: ApiJsonValue;
    /** Absent when no RTC-related event has arrived. */
    sourceTopic?: string;
}>;

export type RtcLatencyDiagnostics = Readonly<{
    /** Absent until an `rtc.connect` command has completed. */
    connectMs?: number;
    /** Absent until a message or an `rtc.send` command has completed. */
    firstPayloadMs?: number;
    /** Absent until both a connect and a first message have completed. */
    firstPayloadFromConnectMs?: number;
    /** Absent until one command the runtime can time has completed. */
    lastCommandMs?: number;
    /** Absent until the runtime has published command-latency stats. */
    averageCommandMs?: number;
    /** Absent until the runtime has published command-latency stats. */
    maxCommandMs?: number;
}>;

/** The first failing RTC event. */
export type RtcFailureDiagnostics = Readonly<{
    /** Absent when the failing event maps to no connect stage. */
    stageId?: RtcConnectStageId;
    source: 'control' | 'provider-config' | 'rallar-auth' | 'rallar-permission' | 'rallar-cleanup' | 'rallar-runtime';
    /** Absent when the failing event carried no id. */
    eventId?: string;
    /** Absent when the failing event carried no topic. */
    topic?: string;
    /** Absent when the failing event carried no time. */
    atEpochMs?: number;
    message: string;
    /** Absent when the failing event stated no severity. */
    severity?: string;
    /** The failing event's payload; absent when it carried none. */
    details?: ApiJsonValue;
}>;

export type RtcDiagnosticsTimeseriesSeriesId =
    | 'events'
    | 'messages'
    | 'failures'
    | 'phase-duration';

export type RtcDiagnosticsTimeseriesPoint = Readonly<{
    atEpochMs: number;
    value: number;
}>;

export type RtcDiagnosticsTimeseriesSeries = Readonly<{
    seriesId: RtcDiagnosticsTimeseriesSeriesId;
    label: string;
    unit: string;
    tone: 'good' | 'warn' | 'bad' | 'active' | 'muted';
    latest: number;
    max: number;
    points: readonly RtcDiagnosticsTimeseriesPoint[];
}>;

export type RtcDiagnosticsTimeseriesOptions = Readonly<{
    bucketCount: number;
    /** `undefined` sizes each bucket from the span of the related events. */
    bucketMs: number | undefined;
    /** `undefined` ends the series at the latest related event, or at `nowEpochMs` without one. */
    endAtEpochMs: number | undefined;
    /** The clock the caller read; used only when neither an explicit end nor an event supplies one. */
    nowEpochMs: number;
}>;

type RtcDiagnosticsBundleAuth = Readonly<{
    hasUsername: boolean;
    hasPassword: boolean;
    hasToken: boolean;
    restoreSession: boolean;
    /** The configured registration setting verbatim; absent when the runtime config carries none. */
    register?: ApiJsonValue;
    logoutOnClose: boolean;
    /** The configured leave-on-close setting verbatim; absent when the config carries none. */
    leaveRoomOnClose?: ApiJsonValue;
}>;

type RtcDiagnosticsBundleConfig = Readonly<{
    /** Absent when neither the control block nor the defaults name a provider mode. */
    providerMode?: ApiJsonValue;
    /** Absent when the runtime config names no environment. */
    environment?: string;
    /** Absent when the runtime config names no API base URL. */
    apiBaseUrl?: string;
    /** Absent when the runtime config names no actor. */
    actor?: string;
    /** Absent when the runtime config names no session. */
    sessionId?: string;
    /** Absent when the runtime config names no room. */
    roomId?: string;
    /** Absent when the runtime config names no transport. */
    transport?: RallarBlackBoxTestTransport;
    auth: RtcDiagnosticsBundleAuth;
}>;

/** The copyable RTC diagnostics document the operator exports. */
export type RtcDiagnosticsBundle = Readonly<{
    generatedAtEpochMs: number;
    /** Absent when the runtime holds no configured run. */
    runId?: string;
    /** Absent when the runtime holds no configured agent. */
    agentId?: string;
    status: RallarBlackBoxTestState['status'];
    config: RtcDiagnosticsBundleConfig;
    commandIds: readonly string[];
    stages: readonly RtcConnectStage[];
    membership: RtcMembershipDiagnostics;
    latency: RtcLatencyDiagnostics;
    /** Absent while no RTC-related event has failed. */
    failure?: RtcFailureDiagnostics;
    timeseries: readonly RtcDiagnosticsTimeseriesSeries[];
    latestStats: RallarBlackBoxTestState['latestStats'];
    recentResults: readonly RallarBlackBoxTestResult[];
    recentEvents: readonly RallarBlackBoxTestEvent[];
}>;

export type RtcDiagnosticsSnapshot = Readonly<{
    stages: readonly RtcConnectStage[];
    membership: RtcMembershipDiagnostics;
    latency: RtcLatencyDiagnostics;
    /** Absent while no RTC-related event has failed. */
    failure?: RtcFailureDiagnostics;
    timeseries: readonly RtcDiagnosticsTimeseriesSeries[];
    recentEvents: readonly RallarBlackBoxTestEvent[];
    recentResults: readonly RallarBlackBoxTestResult[];
    bundle: RtcDiagnosticsBundle;
}>;

export type RtcPerformanceTone = 'good' | 'warn' | 'bad' | 'active' | 'muted';

export type RtcPerformanceScatterPoint = Readonly<{
    sequence: number;
    commandId: string;
    kind: RallarBlackBoxTestResult['kind'] | 'distributed-agent';
    source: 'local-result' | 'distributed-agent';
    transport: 'rtc' | 'ws' | 'runtime';
    status: RallarBlackBoxTestResult['status'];
    ok: boolean;
    /** Absent for a distributed-agent point, which carries only an average latency. */
    startedAtEpochMs?: number;
    /** Absent for a distributed-agent point, which carries only an average latency. */
    endedAtEpochMs?: number;
    /** Absent when the runtime holds no configured agent. */
    agentId?: string;
    durationMs: number;
}>;

export type RtcPerformanceHistogramBucket = Readonly<{
    label: string;
    minMs: number;
    maxMs: number;
    count: number;
}>;

export type RtcPerformancePhaseSpan = Readonly<{
    stageId: RtcConnectStageId;
    label: string;
    status: RtcConnectStageStatus;
    startMs: number;
    endMs: number;
    durationMs: number;
    timingKind: 'duration' | 'observed-delta';
    valueLabel: string;
    tone: RtcPerformanceTone;
    /** Absent when the event that reached the stage carried no id. */
    eventId?: string;
}>;

export type RtcPerformanceAgentLaneCell = Readonly<{
    laneId: string;
    metric: 'expected' | 'observed' | 'ready' | 'active' | 'stale' | 'missing';
    value: string;
    status: RtcPerformanceTone;
}>;

export type RtcPerformanceSummary = Readonly<{
    commandCount: number;
    /** Absent while no timed command has completed. */
    p50Ms?: number;
    /** Absent while no timed command has completed. */
    p95Ms?: number;
    /** Absent while no timed command has completed. */
    p99Ms?: number;
    /** Absent while no timed command has completed. */
    maxMs?: number;
    /** Absent until an `rtc.connect` command has completed. */
    connectMs?: number;
    /** Absent until a message or an `rtc.send` command has completed. */
    firstPayloadMs?: number;
    failureCount: number;
    messageCount: number;
}>;

export type RtcPerformanceView = Readonly<{
    summary: RtcPerformanceSummary;
    emptyReasons: readonly string[];
    timeseries: readonly RtcDiagnosticsTimeseriesSeries[];
    scatter: readonly RtcPerformanceScatterPoint[];
    histogram: readonly RtcPerformanceHistogramBucket[];
    phaseSpans: readonly RtcPerformancePhaseSpan[];
    agentMatrix: readonly RtcPerformanceAgentLaneCell[];
}>;

export type ComputeRtcPerformanceViewInput = Readonly<{
    diagnostics: RtcDiagnosticsSnapshot;
    state: RallarBlackBoxTestState;
    /** `undefined` when the view describes local commands only. */
    distributedMonitor: DistributedRunMonitor | undefined;
    histogramBucketCount: number;
}>;

const RTC_STAGE_DEFINITIONS: readonly Readonly<{
    stageId: RtcConnectStageId;
    label: string;
}>[] = [
    { stageId: 'auth', label: 'Auth' },
    { stageId: 'runtime-bootstrap', label: 'Runtime' },
    { stageId: 'group-join', label: 'Group Join' },
    { stageId: 'signaling', label: 'Signaling' },
    { stageId: 'peer-discovery', label: 'Peer Discovery' },
    { stageId: 'data-channel', label: 'Data Channel' },
    { stageId: 'first-payload', label: 'First Payload' }
];

/** The default number of timeseries buckets the RTC tabs read. */
export const DEFAULT_RTC_TIMESERIES_BUCKET_COUNT = 12;

/** The default number of latency histogram buckets the RTC performance view reads. */
export const DEFAULT_RTC_PERFORMANCE_HISTOGRAM_BUCKET_COUNT = 6;

const MIN_TIMESERIES_BUCKET_MS = 1_000;
const MAX_TIMESERIES_BUCKET_MS = 60_000;

function decodeJsonValue(value: unknown): ApiJsonValue | undefined {
    if (value === null) {
        return null;
    }
    const kind = typeof value;
    return kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'object'
        ? value as ApiJsonValue
        : undefined;
}

function isJsonObject(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJsonObject(value: ApiJsonValue | undefined): ApiJsonObject {
    return isJsonObject(value) ? value : {};
}

function toJsonArray(value: ApiJsonValue | undefined): readonly ApiJsonValue[] {
    return Array.isArray(value) ? value : [];
}

/** The non-blank text a payload field carries, or `undefined` when it carries none. */
function decodeText(value: ApiJsonValue | undefined): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function decodeNumber(value: ApiJsonValue | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toSortedDistinctTexts(values: readonly (string | undefined)[]): readonly string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function decodeTexts(value: ApiJsonValue | undefined): readonly string[] {
    return toSortedDistinctTexts(toJsonArray(value).map((entry) => decodeText(entry)));
}

function resolveLatestDefined<T>(values: readonly (T | undefined)[]): T | undefined {
    return values.findLast((value) => value !== undefined);
}

function toLowerCaseTopic(event: RallarBlackBoxTestEvent): string {
    return event.topic.toLowerCase();
}

function toEventPayload(event: RallarBlackBoxTestEvent): ApiJsonObject {
    return isJsonObject(event.payload) ? event.payload : {};
}

function isRtcRelatedEvent(event: RallarBlackBoxTestEvent): boolean {
    const topic = toLowerCaseTopic(event);
    return event.transport === 'realtime' ||
        event.transport === 'messages.rtc' ||
        event.kind === 'message' ||
        topic.includes('rtc') ||
        topic.includes('rallar.bb.control') ||
        topic.includes('rallar.browser') ||
        topic.includes('realtime') ||
        topic.includes('connect') ||
        topic.includes('peer') ||
        topic.includes('data_channel') ||
        topic.includes('data-channel');
}

function isRtcTimeseriesEvent(event: RallarBlackBoxTestEvent): boolean {
    const topic = toLowerCaseTopic(event);
    return event.transport === 'realtime' ||
        event.transport === 'messages.rtc' ||
        topic.includes('rtc') ||
        topic.includes('realtime') ||
        topic.includes('auth') ||
        topic.includes('runtime') ||
        topic.includes('bootstrap') ||
        topic.includes('group') ||
        topic.includes('room') ||
        topic.includes('join') ||
        topic.includes('connect') ||
        topic.includes('signal') ||
        topic.includes('peer') ||
        topic.includes('lane') ||
        topic.includes('data_channel') ||
        topic.includes('data-channel');
}

function isFailureEvent(event: RallarBlackBoxTestEvent): boolean {
    const topic = toLowerCaseTopic(event);
    return event.severity === 'error' ||
        topic.includes('failed') ||
        topic.includes('failure') ||
        topic.includes('timeout') ||
        topic.includes('mismatch') ||
        topic.includes('not_found') ||
        topic.includes('missing-peer') ||
        topic.includes('stale-agent') ||
        topic.includes('duplicate-session') ||
        topic.includes('permission-denied') ||
        topic.includes('closed-transport') ||
        topic.includes('not-yet-in-sync') ||
        topic.includes('nack');
}

function resolveStageIdFromPhase(value: ApiJsonValue | undefined): RtcConnectStageId | undefined {
    const phase = decodeText(value)?.toLowerCase().replaceAll('_', '-');
    if (!phase) {
        return undefined;
    }

    if (phase.includes('auth') || phase.includes('login')) {
        return 'auth';
    }
    if (phase.includes('runtime') || phase.includes('bootstrap') || phase.includes('config')) {
        return 'runtime-bootstrap';
    }
    if (phase.includes('group') || phase.includes('room') || phase.includes('join')) {
        return 'group-join';
    }
    if (phase.includes('signal') || phase.includes('socket')) {
        return 'signaling';
    }
    if (phase.includes('peer')) {
        return 'peer-discovery';
    }
    if (phase.includes('channel') || phase.includes('lane') || phase.includes('ready')) {
        return 'data-channel';
    }
    if (phase.includes('payload') || phase.includes('message')) {
        return 'first-payload';
    }
    return undefined;
}

export function resolveRtcConnectStageId(
    event: RallarBlackBoxTestEvent
): RtcConnectStageId | undefined {
    const payload = toEventPayload(event);
    const fromPhase = resolveStageIdFromPhase(payload.phase ?? payload.stage ?? payload.connectStage);
    if (fromPhase) {
        return fromPhase;
    }

    if (event.kind === 'message') {
        return 'first-payload';
    }

    const topic = toLowerCaseTopic(event);
    if (topic.includes('auth') || topic.includes('login')) {
        return 'auth';
    }
    if (topic.includes('runtime') || topic.includes('bootstrap') || topic.includes('configured')) {
        return 'runtime-bootstrap';
    }
    if (topic.includes('group') || topic.includes('room') || topic.includes('join')) {
        return 'group-join';
    }
    if (topic.includes('signal') || topic.includes('websocket')) {
        return 'signaling';
    }
    if (topic.includes('peer')) {
        return 'peer-discovery';
    }
    if (
        topic.includes('data_channel') ||
        topic.includes('data-channel') ||
        topic.includes('lane') ||
        topic.includes('rtc.connected') ||
        topic.includes('connect_completed')
    ) {
        return 'data-channel';
    }
    return undefined;
}

function toStageStatus(event: RallarBlackBoxTestEvent): RtcConnectStageStatus {
    if (isFailureEvent(event)) {
        return 'failed';
    }

    return event.severity === 'warning' ? 'warning' : 'observed';
}

function computeRtcConnectStages(events: readonly RallarBlackBoxTestEvent[]): readonly RtcConnectStage[] {
    const relatedEvents = events.filter(isRtcRelatedEvent);
    const startedAt = relatedEvents[0]?.atEpochMs;
    return RTC_STAGE_DEFINITIONS.map((definition) => {
        const matching = relatedEvents
            .filter((event) => resolveRtcConnectStageId(event) === definition.stageId)
            .sort((left, right) => {
                const leftFailed = isFailureEvent(left) ? 0 : 1;
                const rightFailed = isFailureEvent(right) ? 0 : 1;
                return leftFailed - rightFailed || left.atEpochMs - right.atEpochMs;
            })[0];

        return {
            ...definition,
            status: matching ? toStageStatus(matching) : 'pending',
            atEpochMs: matching?.atEpochMs,
            durationFromStartMs: matching && startedAt !== undefined
                ? Math.max(0, matching.atEpochMs - startedAt)
                : undefined,
            eventId: matching?.eventId,
            topic: matching?.topic,
            details: decodeJsonValue(matching?.payload)
        };
    });
}

type PayloadClientIds = Readonly<{
    expected: readonly string[];
    observed: readonly string[];
    ready: readonly string[];
    active: readonly string[];
    stale: readonly string[];
    nackCodes: readonly string[];
}>;

function toPayloadClientIds(payload: ApiJsonObject): PayloadClientIds {
    const nested = toJsonObject(payload.data);
    const nack = toJsonObject(payload.nack);
    const results = toJsonArray(payload.results)
        .map((result) => decodeText(toJsonObject(result).peerId));
    const ready = toSortedDistinctTexts([
        ...decodeTexts(payload.readyPeerIds),
        ...decodeTexts(payload.readyPeers),
        ...decodeTexts(payload.readyClients),
        ...decodeTexts(nested.readyPeerIds)
    ]);
    const active = toSortedDistinctTexts([
        ...decodeTexts(payload.activePeerIds),
        ...decodeTexts(payload.activePeers),
        ...decodeTexts(payload.activeClients),
        ...decodeTexts(payload.connectedPeerIds),
        ...decodeTexts(nested.activePeerIds)
    ]);
    return {
        expected: toSortedDistinctTexts([
            ...decodeTexts(payload.expectedClients),
            ...decodeTexts(payload.expectedClientIds),
            ...decodeTexts(payload.peerIds),
            ...decodeTexts(payload.nextHopPeerIds),
            ...decodeTexts(nested.expectedClients),
            ...decodeTexts(nested.targets)
        ]),
        observed: toSortedDistinctTexts([
            decodeText(payload.sessionId),
            decodeText(payload.peerId),
            decodeText(payload.remotePeerId),
            decodeText(payload.senderId),
            ...results,
            ...decodeTexts(payload.observedClients),
            ...decodeTexts(payload.observedClientIds),
            ...decodeTexts(payload.connectedClients),
            ...decodeTexts(payload.peerIds),
            ...ready,
            ...active,
            ...decodeTexts(nested.senderId)
        ]),
        ready,
        active,
        stale: toSortedDistinctTexts([
            decodeText(payload.staleClient),
            decodeText(payload.staleClientId),
            decodeText(payload.staleSessionId),
            ...decodeTexts(payload.staleClients),
            ...decodeTexts(payload.staleClientIds)
        ]),
        nackCodes: toSortedDistinctTexts([
            decodeText(payload.nackCode),
            decodeText(payload.negativeCase),
            decodeText(nack.code),
            ...decodeTexts(payload.nackCodes)
        ])
    };
}

function computeRtcMembership(
    state: RallarBlackBoxTestState,
    events: readonly RallarBlackBoxTestEvent[]
): RtcMembershipDiagnostics {
    const config = state.currentConfig;
    const related = events.filter(isRtcRelatedEvent);
    const latest = related.at(-1);
    const latestPayload = latest ? toEventPayload(latest) : {};
    const observedSets = related.map((event) => toPayloadClientIds(toEventPayload(event)));
    const relatedPayloads = related.map(toEventPayload);
    const expectedClients = toSortedDistinctTexts(observedSets.flatMap((set) => set.expected));
    const observedClients = toSortedDistinctTexts(observedSets.flatMap((set) => set.observed));
    const readyPeerIds = toSortedDistinctTexts(observedSets.flatMap((set) => set.ready));
    const activePeerIds = toSortedDistinctTexts(observedSets.flatMap((set) => set.active));
    const staleClients = toSortedDistinctTexts([
        ...observedSets.flatMap((set) => set.stale),
        ...related
            .filter((event) => toLowerCaseTopic(event).includes('stale'))
            .map((event) => decodeText(toEventPayload(event).sessionId))
    ]);
    const nackCodes = toSortedDistinctTexts(observedSets.flatMap((set) => set.nackCodes));
    const missingClients = expectedClients.filter((client) => !observedClients.includes(client));
    const extraClients = expectedClients.length === 0
        ? []
        : observedClients.filter((client) => !expectedClients.includes(client));

    return {
        connection: latest?.connection ??
            String(config?.defaults?.connection ?? 'default'),
        actor: latest?.actor ?? config?.actor ?? '-',
        roomId: decodeText(latestPayload.roomId) ?? config?.roomId ?? '-',
        sessionId: decodeText(latestPayload.sessionId) ?? config?.sessionId,
        expectedClients,
        observedClients,
        readyPeerIds,
        activePeerIds,
        missingClients,
        extraClients,
        staleClients,
        nackCodes,
        peerCount: resolveLatestDefined(relatedPayloads.map((payload) => decodeNumber(payload.peerCount))) ??
            decodeNumber(decodeJsonValue(state.latestStats?.rallar?.peerCount)),
        laneHealth: resolveLatestDefined(relatedPayloads.map((payload) => payload.laneHealth)) ??
            decodeJsonValue(state.latestStats?.rallar?.laneHealth),
        sourceTopic: latest?.topic
    };
}

function resolveLatestResult(
    results: readonly RallarBlackBoxTestResult[],
    kind: string
): RallarBlackBoxTestResult | undefined {
    return results.filter((result) => result.kind === kind).at(-1);
}

function computeRtcLatency(
    state: RallarBlackBoxTestState,
    events: readonly RallarBlackBoxTestEvent[]
): RtcLatencyDiagnostics {
    const connectResult = resolveLatestResult(state.commandHistory, 'rtc.connect');
    const sendResult = resolveLatestResult(state.commandHistory, 'rtc.send');
    const firstPayload = events
        .filter((event) => event.kind === 'message')
        .filter((event) => connectResult ? event.atEpochMs >= connectResult.startedAtEpochMs : true)[0];
    const matchingPayloadCommand = firstPayload?.commandId
        ? state.commandHistory.find((result) => result.commandId === firstPayload.commandId)
        : undefined;

    return {
        connectMs: connectResult?.durationMs,
        firstPayloadMs: firstPayload && matchingPayloadCommand
            ? Math.max(0, firstPayload.atEpochMs - matchingPayloadCommand.startedAtEpochMs)
            : sendResult?.durationMs,
        firstPayloadFromConnectMs: firstPayload && connectResult
            ? Math.max(0, firstPayload.atEpochMs - connectResult.startedAtEpochMs)
            : undefined,
        lastCommandMs: state.latestStats?.commandLatency?.lastMs ??
            state.commandHistory.at(-1)?.durationMs,
        averageCommandMs: state.latestStats?.commandLatency?.averageMs,
        maxCommandMs: state.latestStats?.commandLatency?.maxMs
    };
}

function toFailureMessage(event: RallarBlackBoxTestEvent): string {
    const payload = toEventPayload(event);
    const error = toJsonObject(payload.error);
    const nack = toJsonObject(payload.nack);
    return decodeText(error.message) ??
        decodeText(nack.message) ??
        decodeText(payload.message) ??
        decodeText(payload.reason) ??
        event.topic;
}

function resolveFailureSource(event: RallarBlackBoxTestEvent): RtcFailureDiagnostics['source'] {
    const topic = toLowerCaseTopic(event);
    const phase = String(toEventPayload(event).phase ?? '').toLowerCase();
    if (topic.includes('rallar.bb.control')) {
        return 'control';
    }
    if (topic.includes('provider.browser_rallar.config_invalid')) {
        return 'provider-config';
    }
    if (topic.includes('auth') || topic.includes('login') || topic.includes('session')) {
        return 'rallar-auth';
    }
    if (
        topic.includes('not-yet-in-sync') ||
        topic.includes('nack') ||
        decodeText(toEventPayload(event).negativeCase) === 'not-yet-in-sync'
    ) {
        return 'rallar-runtime';
    }
    if (
        topic.includes('permission') ||
        topic.includes('forbidden') ||
        topic.includes('unauthorized') ||
        topic.includes('room_join_failed') ||
        topic.includes('room-join') ||
        phase.includes('room-join') ||
        phase.includes('room_join')
    ) {
        return 'rallar-permission';
    }
    if (topic.includes('cleanup') || topic.includes('close')) {
        return 'rallar-cleanup';
    }
    return 'rallar-runtime';
}

function computeRtcFailure(
    events: readonly RallarBlackBoxTestEvent[]
): RtcFailureDiagnostics | undefined {
    const failure = events.filter(isRtcRelatedEvent).find(isFailureEvent);
    if (!failure) {
        return undefined;
    }

    return {
        stageId: resolveRtcConnectStageId(failure),
        source: resolveFailureSource(failure),
        eventId: failure.eventId,
        topic: failure.topic,
        atEpochMs: failure.atEpochMs,
        message: toFailureMessage(failure),
        severity: failure.severity,
        details: decodeJsonValue(failure.payload)
    };
}

function computeBucketMs(
    events: readonly RallarBlackBoxTestEvent[],
    bucketCount: number
): number {
    if (events.length < 2) {
        return 5_000;
    }

    const spanMs = Math.max(1, events.at(-1)!.atEpochMs - events[0]!.atEpochMs);
    const rawBucketMs = Math.ceil(spanMs / Math.max(1, bucketCount - 1));
    return Math.min(MAX_TIMESERIES_BUCKET_MS, Math.max(MIN_TIMESERIES_BUCKET_MS, rawBucketMs));
}

function toBucketPoints(
    input: Readonly<{
        startAtEpochMs: number;
        bucketMs: number;
        bucketCount: number;
        values: readonly number[];
    }>
): readonly RtcDiagnosticsTimeseriesPoint[] {
    return Array.from({ length: input.bucketCount }, (_, index) => ({
        atEpochMs: input.startAtEpochMs + (index * input.bucketMs),
        value: Math.round((input.values[index] ?? 0) * 100) / 100
    }));
}

function toTimeseriesSeries(
    input: Readonly<{
        seriesId: RtcDiagnosticsTimeseriesSeriesId;
        label: string;
        unit: string;
        tone: RtcDiagnosticsTimeseriesSeries['tone'];
        points: readonly RtcDiagnosticsTimeseriesPoint[];
    }>
): RtcDiagnosticsTimeseriesSeries {
    const values = input.points.map((point) => point.value);
    return {
        ...input,
        latest: values.at(-1) ?? 0,
        max: Math.max(0, ...values)
    };
}

export function computeRtcDiagnosticsTimeseries(
    state: RallarBlackBoxTestState,
    options: RtcDiagnosticsTimeseriesOptions
): readonly RtcDiagnosticsTimeseriesSeries[] {
    const relatedEvents = state.events
        .filter(isRtcTimeseriesEvent)
        .slice()
        .sort((left, right) => left.atEpochMs - right.atEpochMs);
    const bucketCount = Math.max(2, options.bucketCount);
    const bucketMs = Math.max(1, options.bucketMs ?? computeBucketMs(relatedEvents, bucketCount));
    const latestEventAt = relatedEvents.at(-1)?.atEpochMs;
    const endAtEpochMs = options.endAtEpochMs ?? latestEventAt ?? options.nowEpochMs;
    const alignedEnd = Math.ceil(endAtEpochMs / bucketMs) * bucketMs;
    const startAtEpochMs = alignedEnd - ((bucketCount - 1) * bucketMs);
    const eventCounts = Array(bucketCount).fill(0) as number[];
    const messageCounts = Array(bucketCount).fill(0) as number[];
    const failureCounts = Array(bucketCount).fill(0) as number[];
    const phaseDurationSums = Array(bucketCount).fill(0) as number[];
    const phaseDurationCounts = Array(bucketCount).fill(0) as number[];

    for (const event of relatedEvents) {
        const index = Math.floor((event.atEpochMs - startAtEpochMs) / bucketMs);
        if (index < 0 || index >= bucketCount) {
            continue;
        }

        eventCounts[index] += 1;
        if (event.kind === 'message') {
            messageCounts[index] += 1;
        }
        if (isFailureEvent(event)) {
            failureCounts[index] += 1;
        }

        const durationMs = decodeNumber(toEventPayload(event).durationMs);
        if (durationMs !== undefined) {
            phaseDurationSums[index] += durationMs;
            phaseDurationCounts[index] += 1;
        }
    }

    const phaseDurations = phaseDurationSums.map((sum, index) =>
        phaseDurationCounts[index] > 0 ? sum / phaseDurationCounts[index] : 0
    );

    return [
        toTimeseriesSeries({
            seriesId: 'events',
            label: 'RTC events',
            unit: 'events',
            tone: 'active',
            points: toBucketPoints({ startAtEpochMs, bucketMs, bucketCount, values: eventCounts })
        }),
        toTimeseriesSeries({
            seriesId: 'messages',
            label: 'Messages',
            unit: 'messages',
            tone: 'good',
            points: toBucketPoints({ startAtEpochMs, bucketMs, bucketCount, values: messageCounts })
        }),
        toTimeseriesSeries({
            seriesId: 'failures',
            label: 'Failures',
            unit: 'failures',
            tone: failureCounts.some((count) => count > 0) ? 'bad' : 'muted',
            points: toBucketPoints({ startAtEpochMs, bucketMs, bucketCount, values: failureCounts })
        }),
        toTimeseriesSeries({
            seriesId: 'phase-duration',
            label: 'Phase duration',
            unit: 'ms',
            tone: 'warn',
            points: toBucketPoints({ startAtEpochMs, bucketMs, bucketCount, values: phaseDurations })
        })
    ];
}

function isRelevantResult(result: RallarBlackBoxTestResult): boolean {
    return result.kind === 'rtc.connect' ||
        result.kind === 'rtc.send' ||
        result.kind === 'ws.open' ||
        result.kind === 'ws.send' ||
        result.kind === 'close' ||
        result.kind === 'reset' ||
        result.kind === 'health';
}

function toResultTransport(result: RallarBlackBoxTestResult): RtcPerformanceScatterPoint['transport'] {
    if (result.kind.startsWith('rtc.')) {
        return 'rtc';
    }
    if (result.kind.startsWith('ws.')) {
        return 'ws';
    }
    return 'runtime';
}

function computePercentile(values: readonly number[], percentileValue: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)
    );
    return sorted[index];
}

function computeHistogramBuckets(
    durations: readonly number[],
    bucketCount: number
): readonly RtcPerformanceHistogramBucket[] {
    if (durations.length === 0) {
        return [];
    }
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    const count = Math.max(1, bucketCount);
    if (min === max) {
        return [{
            label: `${Math.round(min)} ms`,
            minMs: min,
            maxMs: max,
            count: durations.length
        }];
    }
    const width = (max - min) / count;
    const buckets = Array.from({ length: count }, (_, index) => {
        const minMs = min + (index * width);
        const maxMs = index === count - 1 ? max : min + ((index + 1) * width);
        return {
            label: `${Math.round(minMs)}-${Math.round(maxMs)} ms`,
            minMs,
            maxMs,
            count: 0
        };
    });
    durations.forEach((duration) => {
        const rawIndex = Math.floor((duration - min) / width);
        const index = Math.min(count - 1, Math.max(0, rawIndex));
        buckets[index] = {
            ...buckets[index],
            count: buckets[index].count + 1
        };
    });
    return buckets;
}

function toPerformanceStageTone(status: RtcConnectStageStatus): RtcPerformanceTone {
    if (status === 'observed') {
        return 'good';
    }
    if (status === 'failed') {
        return 'bad';
    }
    if (status === 'warning') {
        return 'warn';
    }
    return 'muted';
}

function computePhaseSpans(
    diagnostics: RtcDiagnosticsSnapshot,
    results: readonly RallarBlackBoxTestResult[]
): readonly RtcPerformancePhaseSpan[] {
    const observedStages = diagnostics.stages.filter((stage) => stage.atEpochMs !== undefined);
    if (observedStages.length === 0) {
        return [];
    }
    const firstEventAt = Math.min(...observedStages.map((stage) => stage.atEpochMs!));
    const firstResultAt = results
        .map((result) => result.startedAtEpochMs)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .sort((left, right) => left - right)[0];
    const baseline = Math.min(firstEventAt, firstResultAt ?? firstEventAt);
    let previousEnd = 0;
    return observedStages.map((stage) => {
        const endMs = Math.max(0, (stage.atEpochMs ?? baseline) - baseline);
        const payloadDurationMs = resolveStagePayloadDurationMs(stage);
        const startMs = payloadDurationMs === undefined
            ? Math.min(previousEnd, endMs)
            : Math.max(0, endMs - payloadDurationMs);
        const durationMs = payloadDurationMs ?? Math.max(0, endMs - startMs);
        previousEnd = endMs;
        const timingKind = payloadDurationMs === undefined ? 'observed-delta' : 'duration';
        return {
            stageId: stage.stageId,
            label: stage.label,
            status: stage.status,
            startMs,
            endMs,
            durationMs,
            timingKind,
            valueLabel: timingKind === 'duration'
                ? `${Math.round(durationMs)} ms duration`
                : `${Math.round(endMs)} ms observed delta`,
            tone: toPerformanceStageTone(stage.status),
            eventId: stage.eventId
        };
    });
}

function resolveStagePayloadDurationMs(stage: RtcConnectStage): number | undefined {
    const details = toJsonObject(stage.details);
    return decodeNumber(
        details.durationMs ??
            details.elapsedMs ??
            details.phaseDurationMs ??
            details.latencyMs
    );
}

function toMembershipLaneCells(
    membership: RtcMembershipDiagnostics
): readonly RtcPerformanceAgentLaneCell[] {
    const laneIds = toSortedDistinctTexts([
        ...membership.expectedClients,
        ...membership.observedClients,
        ...membership.readyPeerIds,
        ...membership.activePeerIds,
        ...membership.staleClients,
        ...membership.missingClients
    ]);
    const expected = new Set(membership.expectedClients);
    const observed = new Set(membership.observedClients);
    const ready = new Set(membership.readyPeerIds);
    const active = new Set(membership.activePeerIds);
    const stale = new Set(membership.staleClients);
    const missing = new Set(membership.missingClients);
    const metrics: readonly RtcPerformanceAgentLaneCell['metric'][] = [
        'expected',
        'observed',
        'ready',
        'active',
        'stale',
        'missing'
    ];

    return laneIds.flatMap((laneId) =>
        metrics.map((metric) => {
            const set = {
                expected,
                observed,
                ready,
                active,
                stale,
                missing
            }[metric];
            const present = set.has(laneId);
            const shouldBePresent = metric === 'expected' ||
                (expected.has(laneId) && metric !== 'stale' && metric !== 'missing');
            const status: RtcPerformanceTone = metric === 'stale' || metric === 'missing'
                ? present ? 'bad' : 'good'
                : present
                ? 'good'
                : shouldBePresent
                ? 'warn'
                : 'muted';
            return {
                laneId,
                metric,
                value: present ? 'yes' : 'no',
                status
            };
        })
    );
}

function toDistributedAgentScatterPoints(
    monitor: DistributedRunMonitor | undefined,
    startSequence: number
): readonly RtcPerformanceScatterPoint[] {
    if (!monitor) {
        return [];
    }
    return monitor.agentProgress
        .filter((row) => typeof row.averageLatencyMs === 'number' && Number.isFinite(row.averageLatencyMs))
        .map((row, index) => {
            const failed = row.failedCommandCount > 0 || row.execution === 'failed';
            return {
                sequence: startSequence + index,
                commandId: row.agentId,
                kind: 'distributed-agent',
                source: 'distributed-agent',
                transport: 'runtime',
                status: failed ? 'failed' : 'ok',
                ok: !failed,
                durationMs: row.averageLatencyMs!,
                agentId: row.agentId
            };
        });
}

function toDistributedMonitorLaneCells(
    monitor: DistributedRunMonitor | undefined
): readonly RtcPerformanceAgentLaneCell[] | undefined {
    if (!monitor || monitor.agentProgress.length === 0) {
        return undefined;
    }
    return monitor.agentProgress.flatMap((row): readonly RtcPerformanceAgentLaneCell[] => {
        const observed = row.resultCount > 0 || row.eventCount > 0 || row.completedCommandCount > 0;
        const ready = row.readiness === 'ready' || row.readiness === 'passed';
        const readinessFailed = row.readiness === 'failed' || row.readiness === 'cancelled' ||
            row.readiness === 'missing';
        const active = row.execution === 'running' || row.execution === 'passed';
        const executionBlocked = row.execution === 'failed' || row.execution === 'cancelled' ||
            row.execution === 'missing';
        const missing = row.readiness === 'missing' || row.execution === 'missing';
        return [
            { laneId: row.agentId, metric: 'expected', value: 'yes', status: 'good' },
            {
                laneId: row.agentId,
                metric: 'observed',
                value: observed ? 'yes' : 'no',
                status: observed ? 'good' : 'warn'
            },
            {
                laneId: row.agentId,
                metric: 'ready',
                value: ready ? 'yes' : 'no',
                status: ready ? 'good' : readinessFailed ? 'bad' : 'warn'
            },
            {
                laneId: row.agentId,
                metric: 'active',
                value: active ? 'yes' : 'no',
                status: active ? 'good' : executionBlocked ? 'warn' : 'muted'
            },
            { laneId: row.agentId, metric: 'stale', value: 'no', status: 'good' },
            {
                laneId: row.agentId,
                metric: 'missing',
                value: missing ? 'yes' : 'no',
                status: missing ? 'bad' : 'good'
            }
        ];
    });
}

export function computeRtcPerformanceView(
    input: ComputeRtcPerformanceViewInput
): RtcPerformanceView {
    const relevantResults = input.diagnostics.recentResults
        .filter((result) => typeof result.durationMs === 'number' && Number.isFinite(result.durationMs));
    const localScatter = relevantResults.map((result, index) => ({
        sequence: index + 1,
        commandId: result.commandId,
        kind: result.kind,
        source: 'local-result' as const,
        transport: toResultTransport(result),
        status: result.status,
        ok: result.ok,
        startedAtEpochMs: result.startedAtEpochMs,
        endedAtEpochMs: result.endedAtEpochMs,
        durationMs: result.durationMs!,
        agentId: input.state.currentConfig?.agentId
    }));
    const scatter = [
        ...localScatter,
        ...toDistributedAgentScatterPoints(input.distributedMonitor, localScatter.length + 1)
    ];
    const durations = scatter.map((point) => point.durationMs);
    const failureCount = input.diagnostics.recentEvents.filter(isFailureEvent).length +
        relevantResults.filter((result) => !result.ok).length +
        (input.distributedMonitor?.agentProgress.reduce(
            (sum, row) => sum + row.failedCommandCount,
            0
        ) ?? 0);
    const messageCount = input.diagnostics.recentEvents.filter((event) => event.kind === 'message').length;
    const emptyReasons = [
        scatter.length === 0 ? 'No RTC/WS command results yet' : undefined,
        input.diagnostics.recentEvents.length === 0 ? 'No RTC timeline events yet' : undefined
    ].filter((value): value is string => Boolean(value));

    return {
        summary: {
            commandCount: scatter.length,
            p50Ms: computePercentile(durations, 0.5),
            p95Ms: computePercentile(durations, 0.95),
            p99Ms: computePercentile(durations, 0.99),
            maxMs: durations.length > 0 ? Math.max(...durations) : undefined,
            connectMs: input.diagnostics.latency.connectMs,
            firstPayloadMs: input.diagnostics.latency.firstPayloadMs,
            failureCount,
            messageCount
        },
        emptyReasons,
        timeseries: input.diagnostics.timeseries,
        scatter,
        histogram: computeHistogramBuckets(durations, input.histogramBucketCount),
        phaseSpans: computePhaseSpans(input.diagnostics, relevantResults),
        agentMatrix: toDistributedMonitorLaneCells(input.distributedMonitor) ??
            toMembershipLaneCells(input.diagnostics.membership)
    };
}

function toRtcDiagnosticsBundleConfig(
    state: RallarBlackBoxTestState
): RtcDiagnosticsBundleConfig {
    const config = state.currentConfig;
    return {
        providerMode: decodeJsonValue(config?.control?.providerMode) ??
            decodeJsonValue(config?.defaults?.providerMode),
        environment: config?.environment,
        apiBaseUrl: config?.apiBaseUrl,
        actor: config?.actor,
        sessionId: config?.sessionId,
        roomId: config?.roomId,
        transport: config?.transport,
        auth: {
            hasUsername: Boolean(config?.rallar?.username),
            hasPassword: Boolean(config?.rallar?.password),
            hasToken: Boolean(config?.rallar?.token),
            restoreSession: config?.rallar?.restoreSession === true,
            register: decodeJsonValue(config?.rallar?.register),
            logoutOnClose: config?.rallar?.logoutOnClose === true,
            leaveRoomOnClose: decodeJsonValue(config?.rallar?.leaveRoomOnClose)
        }
    };
}

export function computeRtcDiagnostics(
    state: RallarBlackBoxTestState,
    nowEpochMs: number
): RtcDiagnosticsSnapshot {
    const recentEvents = state.events.filter(isRtcRelatedEvent).slice(-40);
    const recentResults = state.commandHistory.filter(isRelevantResult).slice(-20);
    const stages = computeRtcConnectStages(state.events);
    const membership = computeRtcMembership(state, state.events);
    const latency = computeRtcLatency(state, state.events);
    const failure = computeRtcFailure(state.events);
    const timeseries = computeRtcDiagnosticsTimeseries(state, {
        bucketCount: DEFAULT_RTC_TIMESERIES_BUCKET_COUNT,
        bucketMs: undefined,
        endAtEpochMs: undefined,
        nowEpochMs
    });
    const bundle: RtcDiagnosticsBundle = {
        generatedAtEpochMs: nowEpochMs,
        runId: state.currentConfig?.runId,
        agentId: state.currentConfig?.agentId,
        status: state.status,
        config: toRtcDiagnosticsBundleConfig(state),
        commandIds: recentResults.map((result) => result.commandId),
        stages,
        membership,
        latency,
        failure,
        timeseries,
        latestStats: state.latestStats,
        recentResults,
        recentEvents
    };

    return {
        stages,
        membership,
        latency,
        failure,
        timeseries,
        recentEvents,
        recentResults,
        bundle
    };
}
