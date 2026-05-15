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
    missingClients: readonly string[];
    extraClients: readonly string[];
    staleClients: readonly string[];
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

export type RtcDiagnosticsSnapshot = Readonly<{
    stages: readonly RtcConnectStage[];
    membership: RtcMembershipDiagnostics;
    latency: RtcLatencyDiagnostics;
    failure?: RtcFailureDiagnostics;
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

function isFailureEvent(event: RallarBlackBoxTestEvent): boolean {
    const topic = lowerTopic(event);
    return event.severity === 'error' ||
        topic.includes('failed') ||
        topic.includes('failure') ||
        topic.includes('timeout') ||
        topic.includes('mismatch') ||
        topic.includes('not_found');
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
    stale: readonly string[];
}> {
    const nestedData = asRecord(payload.data);
    const results = asArray(payload.results)
        .map(result => stringValue(asRecord(result).peerId));
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
            ...stringArray(nestedData.senderId),
        ]),
        stale: unique([
            stringValue(payload.staleClient),
            stringValue(payload.staleClientId),
            stringValue(payload.staleSessionId),
            ...stringArray(payload.staleClients),
            ...stringArray(payload.staleClientIds),
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
    const expectedClients = unique(observedSets.flatMap(set => set.expected));
    const observedClients = unique(observedSets.flatMap(set => set.observed));
    const staleClients = unique([
        ...observedSets.flatMap(set => set.stale),
        ...related
            .filter(event => lowerTopic(event).includes('stale'))
            .map(event => stringValue(payloadOf(event).sessionId)),
    ]);
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
        missingClients,
        extraClients,
        staleClients,
        peerCount: numberValue(latestPayload.peerCount) ?? state.latestStats?.rallar?.peerCount,
        laneHealth: latestPayload.laneHealth ?? state.latestStats?.rallar?.laneHealth,
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
    return stringValue(error.message) ??
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
        latestStats: state.latestStats,
        recentResults,
        recentEvents,
    };

    return {
        stages,
        membership,
        latency,
        failure,
        recentEvents,
        recentResults,
        bundle,
    };
}
