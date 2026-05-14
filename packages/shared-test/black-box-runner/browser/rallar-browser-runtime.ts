import type { AuthSession, LoginResponse } from '@shared/api/api-config.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import {
    rallar,
    type RallarRealtimeLaneHealth,
    type RallarRealtimeSendResult,
} from '@shared-web/browser/rallar.ts';

export type BlackBoxRallarTransport = 'realtime' | 'messages.rtc';

export type BlackBoxRallarConfig = Readonly<{
    apiBaseUrl: string;
    username?: string;
    password?: string;
    displayName?: string;
    register?: boolean | 'if-needed';
    transport?: BlackBoxRallarTransport;
    laneId?: string;
    openTimeoutMs?: number;
    timeoutMs?: number;
    peerIds?: readonly string[];
    nextHopPeerIds?: readonly string[];
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    messageSelector?: string | Readonly<{
        topicId?: string;
        typeId?: string;
    }>;
    ttlHops?: number;
    ttlMs?: number;
    reliability?: 'best-effort' | 'at-least-once';
    ack?: string;
    ownership?: 'shared' | 'exclusive';
    membershipEpoch?: number;
    seq?: number;
    orderingKey?: string;
    overlayId?: string;
    fanoutLimit?: number;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    logoutOnClose?: boolean;
}>;

export type BlackBoxRallarConnectionConfig = Readonly<{
    connection: string;
    actor?: string;
    peerId?: string;
    remotePeerId?: string;
    roomId?: string;
    rallar: BlackBoxRallarConfig;
}>;

export type BlackBoxRallarSendInput = Readonly<{
    data?: unknown;
    payload?: unknown;
    laneId?: string;
    roomId?: string;
    peerIds?: readonly string[];
    nextHopPeerIds?: readonly string[];
    remotePeerId?: string;
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    ttlHops?: number;
    ttlMs?: number;
    reliability?: 'best-effort' | 'at-least-once';
    ack?: string;
    ownership?: 'shared' | 'exclusive';
    membershipEpoch?: number;
    seq?: number;
    orderingKey?: string;
    overlayId?: string;
    fanoutLimit?: number;
    openTimeoutMs?: number;
    key?: string;
    maxAgeMs?: number;
}>;

export type BlackBoxRallarEvent = Readonly<{
    kind: 'diagnostic' | 'message' | 'close';
    topic: string;
    atEpochMs: number;
    connection?: string;
    actor?: string;
    transport?: BlackBoxRallarTransport;
    roomId?: string;
    laneId?: string;
    peerId?: string;
    remotePeerId?: string;
    senderId?: string;
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    data?: unknown;
    error?: unknown;
}>;

export type BlackBoxRallarConnectDiagnostics = Readonly<{
    status: 'connected';
    connection: string;
    actor?: string;
    transport: BlackBoxRallarTransport;
    roomId?: string;
    clientId: string;
    sessionId: string;
    username: string;
    laneId?: string;
    typeId?: string;
    topicId?: string;
    health: readonly RallarRealtimeLaneHealth[];
}>;

export type BlackBoxRallarSendDiagnostics = Readonly<{
    status: 'sent' | 'no-peers';
    connection: string;
    actor?: string;
    transport: BlackBoxRallarTransport;
    roomId?: string;
    laneId?: string;
    peerIds?: readonly string[];
    nextHopPeerIds?: readonly string[];
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    results?: readonly RallarRealtimeSendResult[];
    message?: unknown;
    health: readonly RallarRealtimeLaneHealth[];
}>;

export type BlackBoxRallarCloseDiagnostics = Readonly<{
    status: 'closed';
    connection?: string;
    actor?: string;
}>;

export type BlackBoxRallarHealthDiagnostics = Readonly<{
    connected: boolean;
    status: ReturnType<typeof rallar.status>;
    connection?: string;
    actor?: string;
    transport?: BlackBoxRallarTransport;
    roomId?: string;
    session?: AuthSession;
    health: readonly RallarRealtimeLaneHealth[];
}>;

export type BlackBoxRallarRuntime = Readonly<{
    connect(
        config: BlackBoxRallarConnectionConfig,
    ): Promise<BlackBoxRallarConnectDiagnostics>;
    send(input: BlackBoxRallarSendInput | unknown): Promise<BlackBoxRallarSendDiagnostics>;
    close(): Promise<BlackBoxRallarCloseDiagnostics>;
    health(): Promise<BlackBoxRallarHealthDiagnostics>;
}>;

type RuntimeState = {
    config: BlackBoxRallarConnectionConfig;
    unsubscribeRealtime?: () => void;
    unsubscribeMessagesRtc?: () => void;
};

declare global {
    interface Window {
        __blackBoxRallar?: BlackBoxRallarRuntime;
        __blackBoxRallarEmit?: (event: BlackBoxRallarEvent) => void | Promise<void>;
    }
}

const DEFAULT_LANE_ID = 'realtime';

let state: RuntimeState | undefined;

function transportOf(
    config: BlackBoxRallarConnectionConfig,
): BlackBoxRallarTransport {
    return config.rallar.transport ?? 'realtime';
}

function laneIdOf(config: BlackBoxRallarConnectionConfig): string {
    return config.rallar.laneId ?? DEFAULT_LANE_ID;
}

function typeIdOf(config: BlackBoxRallarConnectionConfig): string {
    const typeId = config.rallar.typeId;
    if (!typeId) {
        throw new Error('rallar.typeId is required for messages.rtc transport.');
    }

    return typeId;
}

function topicIdOf(config: BlackBoxRallarConnectionConfig): string | undefined {
    return config.rallar.topicId ?? config.rallar.typeId;
}

function messageSelectorOf(config: BlackBoxRallarConnectionConfig): string | {
    topicId?: string;
    typeId?: string;
} {
    if (config.rallar.messageSelector) {
        return config.rallar.messageSelector;
    }

    return {
        typeId: typeIdOf(config),
        topicId: config.rallar.topicId,
    };
}

function emit(partial: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void {
    const event: BlackBoxRallarEvent = {
        ...partial,
        atEpochMs: Date.now(),
    };
    const handler = window.__blackBoxRallarEmit;
    if (!handler) {
        return;
    }

    try {
        void Promise.resolve(handler(event)).catch((error) => {
            console.error('black-box Rallar event sink failed', error);
        });
    } catch (error) {
        console.error('black-box Rallar event sink failed', error);
    }
}

function emitDiagnostic(
    config: BlackBoxRallarConnectionConfig,
    topic: string,
    data?: unknown,
): void {
    emit({
        kind: 'diagnostic',
        topic,
        connection: config.connection,
        actor: config.actor,
        transport: transportOf(config),
        roomId: config.roomId,
        laneId: laneIdOf(config),
        data,
    });
}

function emitError(
    config: BlackBoxRallarConnectionConfig | undefined,
    topic: string,
    error: unknown,
    data?: unknown,
): void {
    emit({
        kind: 'diagnostic',
        topic,
        connection: config?.connection,
        actor: config?.actor,
        transport: config ? transportOf(config) : undefined,
        roomId: config?.roomId,
        laneId: config ? laneIdOf(config) : undefined,
        data,
        error: serializeError(error),
    });
}

function serializeError(error: unknown): unknown {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    return error;
}

function toSessionDiagnostic(session: LoginResponse | AuthSession): unknown {
    return {
        clientId: session.clientId,
        sessionId: session.sessionId,
        username: session.username,
    };
}

function toDiagnosticObject(data?: unknown): Record<string, unknown> {
    return data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : { data };
}

function emitConnectPhaseStarted(
    config: BlackBoxRallarConnectionConfig,
    phase: string,
    data?: unknown,
): void {
    emitDiagnostic(config, 'rallar.browser.connect.phase_started', {
        phase,
        ...toDiagnosticObject(data),
    });
}

function emitConnectPhaseCompleted(
    config: BlackBoxRallarConnectionConfig,
    phase: string,
    data?: unknown,
): void {
    emitDiagnostic(config, 'rallar.browser.connect.phase_completed', {
        phase,
        ...toDiagnosticObject(data),
    });
}

function requireState(): RuntimeState {
    if (!state) {
        throw new Error('Black-box Rallar runtime is not connected.');
    }
    return state;
}

function readHealth(
    config: BlackBoxRallarConnectionConfig,
): readonly RallarRealtimeLaneHealth[] {
    if (transportOf(config) !== 'realtime') {
        return [];
    }

    return rallar.realtime.health({
        laneIds: [laneIdOf(config)],
        peerIds: config.rallar.peerIds,
    });
}

async function loginOrRestore(
    config: BlackBoxRallarConnectionConfig,
): Promise<LoginResponse | AuthSession> {
    const { username, password, displayName, register, timeoutMs } = config.rallar;
    if (!username || !password) {
        emitDiagnostic(config, 'rallar.browser.auth.restore_started');
        const restored = rallar.auth.restore();
        if (!restored) {
            const error = new Error(
                'Rallar credentials are required when no browser session is restored.',
            );
            emitError(config, 'rallar.browser.auth.restore_failed', error, {
                phase: 'auth-restore',
            });
            throw error;
        }
        emitDiagnostic(config, 'rallar.browser.auth.restore_completed', {
            session: toSessionDiagnostic(restored),
        });
        return restored;
    }

    if (register === true || register === 'if-needed') {
        emitDiagnostic(config, 'rallar.browser.auth.register_started', {
            username,
            register,
        });
        try {
            const registered = await rallar.auth.registerAndLogin(
                { username, password, displayName },
                { timeoutMs },
            );
            emitDiagnostic(config, 'rallar.browser.auth.register_completed', {
                session: toSessionDiagnostic(registered),
            });
            return registered;
        } catch (error) {
            emitError(config, 'rallar.browser.auth.register_failed', error, {
                phase: 'auth-register',
                register,
            });
            if (register !== 'if-needed') {
                throw error;
            }
            emitDiagnostic(config, 'rallar.browser.register_failed_login_fallback', {
                error: serializeError(error),
            });
        }
    }

    emitDiagnostic(config, 'rallar.browser.auth.login_started', {
        username,
    });
    try {
        const loggedIn = await rallar.auth.login({ username, password }, { timeoutMs });
        emitDiagnostic(config, 'rallar.browser.auth.login_completed', {
            session: toSessionDiagnostic(loggedIn),
        });
        return loggedIn;
    } catch (error) {
        emitError(config, 'rallar.browser.auth.login_failed', error, {
            phase: 'auth-login',
        });
        throw error;
    }
}

async function connect(
    config: BlackBoxRallarConnectionConfig,
): Promise<BlackBoxRallarConnectDiagnostics> {
    let phase = 'validate-config';

    try {
        if (!config.rallar.apiBaseUrl) {
            throw new Error('rallar.apiBaseUrl is required.');
        }

        const transport = transportOf(config);

        emitDiagnostic(config, 'rallar.browser.connect_started');

        phase = 'transport-config';
        emitConnectPhaseStarted(config, phase, { transport });
        const laneId = transport === 'realtime' ? laneIdOf(config) : undefined;
        const typeId = transport === 'messages.rtc' ? typeIdOf(config) : undefined;
        const topicId = transport === 'messages.rtc' ? topicIdOf(config) : undefined;
        emitConnectPhaseCompleted(config, phase, {
            transport,
            laneId,
            typeId,
            topicId,
        });

        phase = 'configure';
        emitConnectPhaseStarted(config, phase, {
            apiBaseUrl: config.rallar.apiBaseUrl,
        });
        rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
        emitConnectPhaseCompleted(config, phase);

        phase = 'auth';
        const session = await loginOrRestore(config);
        emitDiagnostic(config, 'rallar.browser.authenticated', {
            clientId: session.clientId,
            sessionId: session.sessionId,
            username: session.username,
        });

        phase = 'rallar-connect';
        emitConnectPhaseStarted(config, phase, {
            timeoutMs: config.rallar.timeoutMs,
            dataChannelLanes: config.rallar.dataChannelLanes,
        });
        await rallar.connect({
            timeoutMs: config.rallar.timeoutMs,
            dataChannelLanes: config.rallar.dataChannelLanes,
        });
        emitConnectPhaseCompleted(config, phase, {
            status: rallar.status(),
        });

        if (config.roomId) {
            phase = 'room-join';
            emitConnectPhaseStarted(config, phase, {
                roomId: config.roomId,
            });
            await rallar.rooms.join(config.roomId, {
                timeoutMs: config.rallar.timeoutMs,
            });
            emitConnectPhaseCompleted(config, phase, {
                roomId: config.roomId,
            });
        }

        phase = transport === 'realtime'
            ? 'subscribe-realtime'
            : 'subscribe-messages.rtc';
        emitConnectPhaseStarted(config, phase, {
            laneId,
            typeId,
            topicId,
            selector: transport === 'messages.rtc' ? messageSelectorOf(config) : undefined,
        });
        const unsubscribeRealtime = transport === 'realtime'
            ? rallar.realtime.onJson(laneId ?? DEFAULT_LANE_ID, (message) => {
                emit({
                    kind: 'message',
                    topic: 'rallar.browser.realtime.message',
                    connection: config.connection,
                    actor: config.actor,
                    transport,
                    roomId: config.roomId,
                    laneId: message.laneId,
                    peerId: session.sessionId,
                    remotePeerId: message.peerId,
                    data: message.data,
                });
            })
            : undefined;
        const unsubscribeMessagesRtc = transport === 'messages.rtc'
            ? rallar.messages.rtc.onMessage(messageSelectorOf(config), (message) => {
                emit({
                    kind: 'message',
                    topic: 'rallar.browser.messages.rtc.message',
                    connection: config.connection,
                    actor: config.actor,
                    transport,
                    roomId: message.roomId ?? config.roomId,
                    peerId: session.sessionId,
                    remotePeerId: message.senderId,
                    senderId: message.senderId,
                    typeId: message.typeId,
                    topicId: message.topicId,
                    contextId: message.contextId,
                    resourceId: message.resourceId,
                    data: message.payload,
                });
            })
            : undefined;
        emitConnectPhaseCompleted(config, phase, {
            laneId,
            typeId,
            topicId,
        });

        state?.unsubscribeMessagesRtc?.();
        state?.unsubscribeRealtime?.();
        state = { config, unsubscribeRealtime, unsubscribeMessagesRtc };

        const diagnostics: BlackBoxRallarConnectDiagnostics = {
            status: 'connected',
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId: config.roomId,
            clientId: session.clientId,
            sessionId: session.sessionId,
            username: session.username,
            laneId,
            typeId,
            topicId,
            health: readHealth(config),
        };
        emitDiagnostic(config, 'rallar.browser.connect_completed', diagnostics);
        return diagnostics;
    } catch (error) {
        emitError(config, 'rallar.browser.connect.phase_failed', error, {
            phase,
        });
        emitError(config, 'rallar.browser.connect_failed', error, {
            phase,
        });
        throw error;
    }
}

function normalizeSendInput(
    input: BlackBoxRallarSendInput | unknown,
): BlackBoxRallarSendInput {
    if (
        input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        ('data' in input ||
            'laneId' in input ||
            'roomId' in input ||
            'peerIds' in input ||
            'nextHopPeerIds' in input ||
            'remotePeerId' in input ||
            'typeId' in input ||
            'topicId' in input ||
            'contextId' in input ||
            'resourceId' in input)
    ) {
        return input as BlackBoxRallarSendInput;
    }

    return { data: input };
}

function normalizeMessagesRtcSendInput(
    input: BlackBoxRallarSendInput | unknown,
): BlackBoxRallarSendInput {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return input as BlackBoxRallarSendInput;
    }

    return { payload: input };
}

function summarizeRealtimeSendResults(
    results: readonly RallarRealtimeSendResult[],
): unknown {
    const statuses: Record<string, number> = {};
    const attentionResults = results.filter((entry) => {
        const status = entry.result.status;
        statuses[status] = (statuses[status] ?? 0) + 1;
        return status !== 'sent';
    });

    return {
        total: results.length,
        statuses,
        peerIds: results.map((entry) => entry.peerId),
        attentionResults,
    };
}

function realtimeSendStatusCount(summary: any, status: string): number {
    return Number(summary?.statuses?.[status] ?? 0);
}

function emitRealtimeSendOutcomeDiagnostics(
    config: BlackBoxRallarConnectionConfig,
    diagnostics: BlackBoxRallarSendDiagnostics,
): void {
    const results = diagnostics.results ?? [];
    const summary = summarizeRealtimeSendResults(results);

    if (results.length === 0) {
        emitDiagnostic(config, 'rallar.browser.realtime.peer_not_found', {
            roomId: diagnostics.roomId,
            laneId: diagnostics.laneId,
            peerIds: diagnostics.peerIds,
            health: diagnostics.health,
            summary,
        });
    }

    if (realtimeSendStatusCount(summary, 'closed') > 0) {
        emitDiagnostic(config, 'rallar.browser.realtime.data_channel_not_open', {
            roomId: diagnostics.roomId,
            laneId: diagnostics.laneId,
            peerIds: diagnostics.peerIds,
            health: diagnostics.health,
            summary,
        });
    }

    if (
        realtimeSendStatusCount(summary, 'queued') > 0 ||
        realtimeSendStatusCount(summary, 'dropped') > 0 ||
        realtimeSendStatusCount(summary, 'replaced') > 0 ||
        realtimeSendStatusCount(summary, 'closed') > 0
    ) {
        emitDiagnostic(config, 'rallar.browser.realtime.send_result_attention', {
            roomId: diagnostics.roomId,
            laneId: diagnostics.laneId,
            peerIds: diagnostics.peerIds,
            health: diagnostics.health,
            summary,
        });
    }
}

async function send(
    input: BlackBoxRallarSendInput | unknown,
): Promise<BlackBoxRallarSendDiagnostics> {
    const runtimeState = requireState();
    const { config } = runtimeState;
    try {
        const transport = transportOf(config);
        if (transport === 'messages.rtc') {
            return await sendMessagesRtc(input, config);
        }

        return await sendRealtime(input, config);
    } catch (error) {
        emitError(config, `rallar.browser.${transportOf(config)}.send_failed`, error, {
            transport: transportOf(config),
        });
        throw error;
    }
}

async function sendRealtime(
    input: BlackBoxRallarSendInput | unknown,
    config: BlackBoxRallarConnectionConfig,
): Promise<BlackBoxRallarSendDiagnostics> {
    const transport = transportOf(config);
    const normalized = normalizeSendInput(input);
    const peerIds = normalized.peerIds ??
        (normalized.remotePeerId
            ? [normalized.remotePeerId]
            : config.remotePeerId
            ? [config.remotePeerId]
            : config.rallar.peerIds);
    const laneId = normalized.laneId ?? laneIdOf(config);
    const roomId = normalized.roomId ?? config.roomId;
    const data = 'data' in normalized ? normalized.data : normalized.payload;

    emitDiagnostic(config, 'rallar.browser.realtime.send_started', {
        roomId,
        laneId,
        peerIds,
    });
    const results = await rallar.realtime.sendJson({
        data,
        laneId,
        roomId,
        peerIds,
        openTimeoutMs: normalized.openTimeoutMs ?? config.rallar.openTimeoutMs,
        key: normalized.key,
        maxAgeMs: normalized.maxAgeMs,
    });
    const diagnostics: BlackBoxRallarSendDiagnostics = {
        status: results.length === 0 ? 'no-peers' : 'sent',
        connection: config.connection,
        actor: config.actor,
        transport,
        roomId,
        laneId,
        peerIds,
        results,
        health: readHealth(config),
    };
    emitRealtimeSendOutcomeDiagnostics(config, diagnostics);
    emitDiagnostic(config, 'rallar.browser.realtime.send_completed', diagnostics);
    return diagnostics;
}

async function sendMessagesRtc(
    input: BlackBoxRallarSendInput | unknown,
    config: BlackBoxRallarConnectionConfig,
): Promise<BlackBoxRallarSendDiagnostics> {
    const transport = transportOf(config);
    const normalized = normalizeMessagesRtcSendInput(input);
    const typeId = normalized.typeId ?? typeIdOf(config);
    const topicId = normalized.topicId ?? topicIdOf(config);
    const roomId = normalized.roomId ?? config.roomId;
    const contextId = normalized.contextId ?? config.rallar.contextId;
    const resourceId = normalized.resourceId ?? config.rallar.resourceId;
    const nextHopPeerIds = normalized.nextHopPeerIds ??
        normalized.peerIds ??
        config.rallar.nextHopPeerIds ??
        config.rallar.peerIds;
    const payload = 'payload' in normalized ? normalized.payload : normalized.data;

    emitDiagnostic(config, 'rallar.browser.messages.rtc.send_started', {
        roomId,
        nextHopPeerIds,
        typeId,
        topicId,
        contextId,
        resourceId,
    });
    const messageInput: Record<string, unknown> = {
        typeId,
        topicId,
        contextId,
        resourceId,
        roomId,
        payload,
        ttlHops: normalized.ttlHops ?? config.rallar.ttlHops,
        ttlMs: normalized.ttlMs ?? config.rallar.ttlMs,
        reliability: normalized.reliability ?? config.rallar.reliability,
        ack: normalized.ack ?? config.rallar.ack,
        ownership: normalized.ownership ?? config.rallar.ownership,
        membershipEpoch: normalized.membershipEpoch ?? config.rallar.membershipEpoch,
        seq: normalized.seq ?? config.rallar.seq,
        orderingKey: normalized.orderingKey ?? config.rallar.orderingKey,
        nextHopPeerIds,
        overlayId: normalized.overlayId ?? config.rallar.overlayId,
        fanoutLimit: normalized.fanoutLimit ?? config.rallar.fanoutLimit,
    };
    const message = await rallar.messages.rtc.send(messageInput as any);

    const diagnostics: BlackBoxRallarSendDiagnostics = {
        status: 'sent',
        connection: config.connection,
        actor: config.actor,
        transport,
        roomId,
        nextHopPeerIds,
        typeId,
        topicId,
        contextId,
        resourceId,
        message,
        health: readHealth(config),
    };
    emitDiagnostic(config, 'rallar.browser.messages.rtc.send_completed', diagnostics);
    return diagnostics;
}

async function close(): Promise<BlackBoxRallarCloseDiagnostics> {
    const runtimeState = state;
    const config = runtimeState?.config;
    try {
        runtimeState?.unsubscribeMessagesRtc?.();
        runtimeState?.unsubscribeRealtime?.();
        if (config?.rallar.logoutOnClose) {
            await rallar.auth.logout({ timeoutMs: config.rallar.timeoutMs });
        } else {
            await rallar.disconnect();
        }
        state = undefined;
        const diagnostics: BlackBoxRallarCloseDiagnostics = {
            status: 'closed',
            connection: config?.connection,
            actor: config?.actor,
        };
        emit({
            kind: 'close',
            topic: 'rallar.browser.closed',
            connection: config?.connection,
            actor: config?.actor,
            transport: config ? transportOf(config) : undefined,
            roomId: config?.roomId,
            data: diagnostics,
        });
        return diagnostics;
    } catch (error) {
        emitError(config, 'rallar.browser.close_failed', error);
        throw error;
    }
}

async function health(): Promise<BlackBoxRallarHealthDiagnostics> {
    const config = state?.config;
    return {
        connected: rallar.isConnected(),
        status: rallar.status(),
        connection: config?.connection,
        actor: config?.actor,
        transport: config ? transportOf(config) : undefined,
        roomId: config?.roomId,
        session: rallar.session(),
        health: config ? readHealth(config) : [],
    };
}

window.__blackBoxRallar = {
    connect,
    send,
    close,
    health,
};

emit({
    kind: 'diagnostic',
    topic: 'rallar.browser.runtime_loaded',
});
