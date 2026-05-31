import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';

export type RtcConnectStageId =
    | 'auth'
    | 'runtime-bootstrap'
    | 'group-join'
    | 'signaling'
    | 'peer-discovery'
    | 'data-channel'
    | 'first-payload';

export type RtcConnectStageStatus = 'observed' | 'pending' | 'warning' | 'failed';

export type RtcConnectStage = Readonly<{
    stageId: RtcConnectStageId;
    label: string;
    status: RtcConnectStageStatus;
    atEpochMs?: number;
    durationFromStartMs?: number;
    eventId?: string;
    topic?: string;
    details?: unknown;
}>;

export type RtcMembershipDiagnostics = Readonly<{
    connection: string;
    actor: string;
    roomId: string;
    sessionId?: string;
    expectedClients: readonly string[];
    observedClients: readonly string[];
    readyPeerIds: readonly string[];
    activePeerIds: readonly string[];
    missingClients: readonly string[];
    extraClients: readonly string[];
    staleClients: readonly string[];
    nackCodes: readonly string[];
    peerCount?: number;
    laneHealth?: unknown;
    sourceTopic?: string;
}>;

export type RtcLatencyDiagnostics = Readonly<{
    connectMs?: number;
    firstPayloadMs?: number;
    firstPayloadFromConnectMs?: number;
    lastCommandMs?: number;
    averageCommandMs?: number;
    maxCommandMs?: number;
}>;

export type RtcFailureDiagnostics = Readonly<{
    stageId?: RtcConnectStageId;
    source: 'control' | 'provider-config' | 'rallar-auth' | 'rallar-permission' | 'rallar-cleanup' | 'rallar-runtime';
    eventId?: string;
    topic?: string;
    atEpochMs?: number;
    message: string;
    severity?: string;
    details?: unknown;
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
    bucketCount?: number;
    bucketMs?: number;
    endAtEpochMs?: number;
}>;

export type RtcDiagnosticsSnapshot = Readonly<{
    stages: readonly RtcConnectStage[];
    membership: RtcMembershipDiagnostics;
    latency: RtcLatencyDiagnostics;
    failure?: RtcFailureDiagnostics;
    timeseries: readonly RtcDiagnosticsTimeseriesSeries[];
    recentEvents: readonly RallarBlackBoxTestEvent[];
    recentResults: readonly RallarBlackBoxTestResult[];
    bundle: unknown;
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
    { stageId: 'first-payload', label: 'First Payload' },
];

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function asArray(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unique(values: readonly (string | undefined)[]): readonly string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function latestDefined<T>(values: readonly (T | undefined)[]): T | undefined {
    return values.findLast(value => value !== undefined);
}

function stringArray(value: unknown): readonly string[] {
    return unique(asArray(value).map(entry => stringValue(entry)));
}

function lowerTopic(event: RallarBlackBoxTestEvent): string {
    return event.topic.toLowerCase();
}

function payloadOf(event: RallarBlackBoxTestEvent): Record<string, unknown> {
    return asRecord(event.payload);
}

function eventLooksRtcRelated(event: RallarBlackBoxTestEvent): boolean {
    const topic = lowerTopic(event);
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

function eventLooksRtcTimeseriesRelated(event: RallarBlackBoxTestEvent): boolean {
    const topic = lowerTopic(event);
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
    const topic = lowerTopic(event);
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

function stageFromPhase(value: unknown): RtcConnectStageId | undefined {
    const phase = stringValue(value)?.toLowerCase().replaceAll('_', '-');
    if (!phase) {
        return undefined;
    }

    if (phase.includes('auth') || phase.includes('login')) return 'auth';
    if (phase.includes('runtime') || phase.includes('bootstrap') || phase.includes('config')) {
        return 'runtime-bootstrap';
    }
    if (phase.includes('group') || phase.includes('room') || phase.includes('join')) {
        return 'group-join';
    }
    if (phase.includes('signal') || phase.includes('socket')) return 'signaling';
    if (phase.includes('peer')) return 'peer-discovery';
    if (phase.includes('channel') || phase.includes('lane') || phase.includes('ready')) {
        return 'data-channel';
    }
    if (phase.includes('payload') || phase.includes('message')) return 'first-payload';
    return undefined;
}

export function rtcConnectStageIdForEvent(
    event: RallarBlackBoxTestEvent,
): RtcConnectStageId | undefined {
    const payload = payloadOf(event);
    const fromPhase = stageFromPhase(payload.phase ?? payload.stage ?? payload.connectStage);
    if (fromPhase) {
        return fromPhase;
    }

    if (event.kind === 'message') {
        return 'first-payload';
    }

    const topic = lowerTopic(event);
    if (topic.includes('auth') || topic.includes('login')) return 'auth';
    if (topic.includes('runtime') || topic.includes('bootstrap') || topic.includes('configured')) {
        return 'runtime-bootstrap';
    }
    if (topic.includes('group') || topic.includes('room') || topic.includes('join')) {
        return 'group-join';
    }
    if (topic.includes('signal') || topic.includes('websocket')) return 'signaling';
    if (topic.includes('peer')) return 'peer-discovery';
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

function stageStatusForEvent(event: RallarBlackBoxTestEvent): RtcConnectStageStatus {
    if (isFailureEvent(event)) {
        return 'failed';
    }

    return event.severity === 'warning' ? 'warning' : 'observed';
}

function deriveStages(events: readonly RallarBlackBoxTestEvent[]): readonly RtcConnectStage[] {
    const relatedEvents = events.filter(eventLooksRtcRelated);
    const startedAt = relatedEvents[0]?.atEpochMs;
    return RTC_STAGE_DEFINITIONS.map(definition => {
        const matching = relatedEvents
            .filter(event => rtcConnectStageIdForEvent(event) === definition.stageId)
            .sort((left, right) => {
                const leftFailed = isFailureEvent(left) ? 0 : 1;
                const rightFailed = isFailureEvent(right) ? 0 : 1;
                return leftFailed - rightFailed || left.atEpochMs - right.atEpochMs;
            })[0];

        return {
            ...definition,
            status: matching ? stageStatusForEvent(matching) : 'pending',
            atEpochMs: matching?.atEpochMs,
            durationFromStartMs: matching && startedAt !== undefined
                ? Math.max(0, matching.atEpochMs - startedAt)
                : undefined,
            eventId: matching?.eventId,
            topic: matching?.topic,
            details: matching?.payload,
        };
    });
}

function gatherClientIdsFromPayload(payload: Record<string, unknown>): Readonly<{
    expected: readonly string[];
    observed: readonly string[];
    ready: readonly string[];
    active: readonly string[];
    stale: readonly string[];
    nackCodes: readonly string[];
}> {
    const nestedData = asRecord(payload.data);
    const nack = asRecord(payload.nack);
    const results = asArray(payload.results)
        .map(result => stringValue(asRecord(result).peerId));
    const ready = unique([
        ...stringArray(payload.readyPeerIds),
        ...stringArray(payload.readyPeers),
        ...stringArray(payload.readyClients),
        ...stringArray(nestedData.readyPeerIds),
    ]);
    const active = unique([
        ...stringArray(payload.activePeerIds),
        ...stringArray(payload.activePeers),
        ...stringArray(payload.activeClients),
        ...stringArray(payload.connectedPeerIds),
        ...stringArray(nestedData.activePeerIds),
    ]);
    return {
        expected: unique([
            ...stringArray(payload.expectedClients),
            ...stringArray(payload.expectedClientIds),
            ...stringArray(payload.peerIds),
            ...stringArray(payload.nextHopPeerIds),
            ...stringArray(nestedData.expectedClients),
            ...stringArray(nestedData.targets),
        ]),
        observed: unique([
            stringValue(payload.sessionId),
            stringValue(payload.peerId),
            stringValue(payload.remotePeerId),
            stringValue(payload.senderId),
            ...results,
            ...stringArray(payload.observedClients),
            ...stringArray(payload.observedClientIds),
            ...stringArray(payload.connectedClients),
            ...stringArray(payload.peerIds),
            ...ready,
            ...active,
            ...stringArray(nestedData.senderId),
        ]),
        ready,
        active,
        stale: unique([
            stringValue(payload.staleClient),
            stringValue(payload.staleClientId),
            stringValue(payload.staleSessionId),
            ...stringArray(payload.staleClients),
            ...stringArray(payload.staleClientIds),
        ]),
        nackCodes: unique([
            stringValue(payload.nackCode),
            stringValue(payload.negativeCase),
            stringValue(nack.code),
            ...stringArray(payload.nackCodes),
        ]),
    };
}

function deriveMembership(
    state: RallarBlackBoxTestState,
    events: readonly RallarBlackBoxTestEvent[],
): RtcMembershipDiagnostics {
    const config = state.currentConfig;
    const related = events.filter(eventLooksRtcRelated);
    const latest = related.at(-1);
    const latestPayload = latest ? payloadOf(latest) : {};
    const observedSets = related.map(event => gatherClientIdsFromPayload(payloadOf(event)));
    const relatedPayloads = related.map(payloadOf);
    const expectedClients = unique(observedSets.flatMap(set => set.expected));
    const observedClients = unique(observedSets.flatMap(set => set.observed));
    const readyPeerIds = unique(observedSets.flatMap(set => set.ready));
    const activePeerIds = unique(observedSets.flatMap(set => set.active));
    const staleClients = unique([
        ...observedSets.flatMap(set => set.stale),
        ...related
            .filter(event => lowerTopic(event).includes('stale'))
            .map(event => stringValue(payloadOf(event).sessionId)),
    ]);
    const nackCodes = unique(observedSets.flatMap(set => set.nackCodes));
    const missingClients = expectedClients.filter(client => !observedClients.includes(client));
    const extraClients = expectedClients.length === 0
        ? []
        : observedClients.filter(client => !expectedClients.includes(client));

    return {
        connection: latest?.connection ??
            String(config?.defaults?.connection ?? 'default'),
        actor: latest?.actor ?? config?.actor ?? '-',
        roomId: stringValue(latestPayload.roomId) ?? config?.roomId ?? '-',
        sessionId: stringValue(latestPayload.sessionId) ?? config?.sessionId,
        expectedClients,
        observedClients,
        readyPeerIds,
        activePeerIds,
        missingClients,
        extraClients,
        staleClients,
        nackCodes,
        peerCount: latestDefined(relatedPayloads.map(payload => numberValue(payload.peerCount))) ??
            state.latestStats?.rallar?.peerCount,
        laneHealth: latestDefined(relatedPayloads.map(payload => payload.laneHealth)) ??
            state.latestStats?.rallar?.laneHealth,
        sourceTopic: latest?.topic,
    };
}

function latestResult(
    results: readonly RallarBlackBoxTestResult[],
    kind: string,
): RallarBlackBoxTestResult | undefined {
    return results.filter(result => result.kind === kind).at(-1);
}

function deriveLatency(
    state: RallarBlackBoxTestState,
    events: readonly RallarBlackBoxTestEvent[],
): RtcLatencyDiagnostics {
    const connectResult = latestResult(state.commandHistory, 'rtc.connect');
    const sendResult = latestResult(state.commandHistory, 'rtc.send');
    const firstPayload = events
        .filter(event => event.kind === 'message')
        .filter(event =>
            connectResult ? event.atEpochMs >= connectResult.startedAtEpochMs : true
        )[0];
    const matchingPayloadCommand = firstPayload?.commandId
        ? state.commandHistory.find(result => result.commandId === firstPayload.commandId)
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
        maxCommandMs: state.latestStats?.commandLatency?.maxMs,
    };
}

function failureMessage(event: RallarBlackBoxTestEvent): string {
    const payload = payloadOf(event);
    const error = asRecord(payload.error);
    const nack = asRecord(payload.nack);
    return stringValue(error.message) ??
        stringValue(nack.message) ??
        stringValue(payload.message) ??
        stringValue(payload.reason) ??
        event.topic;
}

function failureSource(event: RallarBlackBoxTestEvent): RtcFailureDiagnostics['source'] {
    const topic = lowerTopic(event);
    const phase = String(payloadOf(event).phase ?? '').toLowerCase();
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
        stringValue(payloadOf(event).negativeCase) === 'not-yet-in-sync'
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

function deriveFailure(
    events: readonly RallarBlackBoxTestEvent[],
): RtcFailureDiagnostics | undefined {
    const failure = events.filter(eventLooksRtcRelated).find(isFailureEvent);
    if (!failure) {
        return undefined;
    }

    return {
        stageId: rtcConnectStageIdForEvent(failure),
        source: failureSource(failure),
        eventId: failure.eventId,
        topic: failure.topic,
        atEpochMs: failure.atEpochMs,
        message: failureMessage(failure),
        severity: failure.severity,
        details: failure.payload,
    };
}

const DEFAULT_TIMESERIES_BUCKET_COUNT = 12;
const MIN_TIMESERIES_BUCKET_MS = 1_000;
const MAX_TIMESERIES_BUCKET_MS = 60_000;

function bucketMsForEvents(
    events: readonly RallarBlackBoxTestEvent[],
    bucketCount: number,
): number {
    if (events.length < 2) {
        return 5_000;
    }

    const spanMs = Math.max(1, events.at(-1)!.atEpochMs - events[0]!.atEpochMs);
    const rawBucketMs = Math.ceil(spanMs / Math.max(1, bucketCount - 1));
    return Math.min(MAX_TIMESERIES_BUCKET_MS, Math.max(MIN_TIMESERIES_BUCKET_MS, rawBucketMs));
}

function makeBucketPoints(
    startAtEpochMs: number,
    bucketMs: number,
    bucketCount: number,
    values: readonly number[],
): readonly RtcDiagnosticsTimeseriesPoint[] {
    return Array.from({ length: bucketCount }, (_, index) => ({
        atEpochMs: startAtEpochMs + (index * bucketMs),
        value: Math.round((values[index] ?? 0) * 100) / 100,
    }));
}

function makeSeries(input: Readonly<{
    seriesId: RtcDiagnosticsTimeseriesSeriesId;
    label: string;
    unit: string;
    tone: RtcDiagnosticsTimeseriesSeries['tone'];
    points: readonly RtcDiagnosticsTimeseriesPoint[];
}>): RtcDiagnosticsTimeseriesSeries {
    const values = input.points.map(point => point.value);
    return {
        ...input,
        latest: values.at(-1) ?? 0,
        max: Math.max(0, ...values),
    };
}

export function deriveRtcDiagnosticsTimeseries(
    state: RallarBlackBoxTestState,
    options: RtcDiagnosticsTimeseriesOptions = {},
): readonly RtcDiagnosticsTimeseriesSeries[] {
    const relatedEvents = state.events
        .filter(eventLooksRtcTimeseriesRelated)
        .slice()
        .sort((left, right) => left.atEpochMs - right.atEpochMs);
    const bucketCount = Math.max(2, options.bucketCount ?? DEFAULT_TIMESERIES_BUCKET_COUNT);
    const bucketMs = Math.max(1, options.bucketMs ?? bucketMsForEvents(relatedEvents, bucketCount));
    const latestEventAt = relatedEvents.at(-1)?.atEpochMs;
    const endAtEpochMs = options.endAtEpochMs ?? latestEventAt ?? Date.now();
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

        const durationMs = numberValue(payloadOf(event).durationMs);
        if (durationMs !== undefined) {
            phaseDurationSums[index] += durationMs;
            phaseDurationCounts[index] += 1;
        }
    }

    const phaseDurations = phaseDurationSums.map((sum, index) =>
        phaseDurationCounts[index] > 0 ? sum / phaseDurationCounts[index] : 0
    );

    return [
        makeSeries({
            seriesId: 'events',
            label: 'RTC events',
            unit: 'events',
            tone: 'active',
            points: makeBucketPoints(startAtEpochMs, bucketMs, bucketCount, eventCounts),
        }),
        makeSeries({
            seriesId: 'messages',
            label: 'Messages',
            unit: 'messages',
            tone: 'good',
            points: makeBucketPoints(startAtEpochMs, bucketMs, bucketCount, messageCounts),
        }),
        makeSeries({
            seriesId: 'failures',
            label: 'Failures',
            unit: 'failures',
            tone: failureCounts.some(count => count > 0) ? 'bad' : 'muted',
            points: makeBucketPoints(startAtEpochMs, bucketMs, bucketCount, failureCounts),
        }),
        makeSeries({
            seriesId: 'phase-duration',
            label: 'Phase duration',
            unit: 'ms',
            tone: 'warn',
            points: makeBucketPoints(startAtEpochMs, bucketMs, bucketCount, phaseDurations),
        }),
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

export function deriveRtcDiagnostics(
    state: RallarBlackBoxTestState,
): RtcDiagnosticsSnapshot {
    const recentEvents = state.events.filter(eventLooksRtcRelated).slice(-40);
    const recentResults = state.commandHistory.filter(isRelevantResult).slice(-20);
    const stages = deriveStages(state.events);
    const membership = deriveMembership(state, state.events);
    const latency = deriveLatency(state, state.events);
    const failure = deriveFailure(state.events);
    const timeseries = deriveRtcDiagnosticsTimeseries(state);
    const bundle = {
        generatedAtEpochMs: Date.now(),
        runId: state.currentConfig?.runId,
        agentId: state.currentConfig?.agentId,
        status: state.status,
        config: {
            providerMode: state.currentConfig?.control?.providerMode ??
                state.currentConfig?.defaults?.providerMode,
            environment: state.currentConfig?.environment,
            apiBaseUrl: state.currentConfig?.apiBaseUrl,
            actor: state.currentConfig?.actor,
            sessionId: state.currentConfig?.sessionId,
            roomId: state.currentConfig?.roomId,
            transport: state.currentConfig?.transport,
            auth: {
                hasUsername: Boolean(state.currentConfig?.rallar?.username),
                hasPassword: Boolean(state.currentConfig?.rallar?.password),
                hasToken: Boolean(state.currentConfig?.rallar?.token),
                restoreSession: state.currentConfig?.rallar?.restoreSession === true,
                register: state.currentConfig?.rallar?.register,
                logoutOnClose: state.currentConfig?.rallar?.logoutOnClose === true,
                leaveRoomOnClose: state.currentConfig?.rallar?.leaveRoomOnClose,
            },
        },
        commandIds: recentResults.map(result => result.commandId),
        stages,
        membership,
        latency,
        failure,
        timeseries,
        latestStats: state.latestStats,
        recentResults,
        recentEvents,
    };

    return {
        stages,
        membership,
        latency,
        failure,
        timeseries,
        recentEvents,
        recentResults,
        bundle,
    };
}
