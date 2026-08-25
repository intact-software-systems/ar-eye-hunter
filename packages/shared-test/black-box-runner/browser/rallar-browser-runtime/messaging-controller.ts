import type { RallarRealtimeLaneHealth, RallarRealtimeSendResult } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    BlackBoxBrowserMessagesDependency,
    BlackBoxBrowserRealtimeDependency
} from './browser-rallar-runtime-composition.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarEvent,
    BlackBoxRallarRoomRef,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport,
    BlackBoxRallarWsSendDiagnostics
} from './contracts.ts';
import type { BlackBoxRallarGenerationPort } from './ports.ts';

export type BlackBoxRallarMessagingLease = Readonly<{
    generation: number;
}>;

export type BlackBoxRallarMessagingResourceController = Readonly<{
    lease(): BlackBoxRallarMessagingLease;
    assertCurrent(lease: BlackBoxRallarMessagingLease, message: string): void;
    ensureWsSubscription(key: string, subscribe: () => () => void): void;
    cleanupWsSubscriptions(): number;
}>;

export type CreateBlackBoxRallarMessagingResourceControllerOptions = BlackBoxRallarGenerationPort;

export function createBlackBoxRallarMessagingResourceController(
    options: CreateBlackBoxRallarMessagingResourceControllerOptions
): BlackBoxRallarMessagingResourceController {
    const wsSubscriptions = new Map<string, () => void>();

    return {
        lease: () => ({ generation: options.generation() }),
        assertCurrent: (lease, message) => {
            if (!options.isCurrent(lease.generation)) {
                throw new Error(message);
            }
        },
        ensureWsSubscription: (key, subscribe) => {
            if (!wsSubscriptions.has(key)) {
                wsSubscriptions.set(key, subscribe());
            }
        },
        cleanupWsSubscriptions: () => {
            const subscriptions = [...wsSubscriptions.values()];
            wsSubscriptions.clear();
            for (const unsubscribe of subscriptions) {
                unsubscribe();
            }
            return subscriptions.length;
        }
    };
}

interface MessagingFacade {
    readonly messages: BlackBoxBrowserMessagesDependency;
    readonly realtime: BlackBoxBrowserRealtimeDependency;
}

type ScopeDiagnostics = Readonly<{
    scope?: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }>;
    applicationId?: string;
    workspaceId?: string;
}>;

export type CreateBlackBoxRallarMessagingControllerOptions =
    & BlackBoxRallarGenerationPort
    & Readonly<{
        facade: MessagingFacade;
        requireConfig(): BlackBoxRallarConnectionConfig;
        transportOf(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport;
        laneIdOf(config: BlackBoxRallarConnectionConfig): string;
        typeIdOf(config: BlackBoxRallarConnectionConfig): string;
        topicIdOf(config: BlackBoxRallarConnectionConfig): string | undefined;
        roomRefOf(config: BlackBoxRallarConnectionConfig, input?: BlackBoxRallarSendInput): GroupRef | undefined;
        scopeDiagnostics(config: BlackBoxRallarConnectionConfig, input?: BlackBoxRallarSendInput): ScopeDiagnostics;
        toOptionalNumber(value: unknown): number | undefined;
        readHealth(config: BlackBoxRallarConnectionConfig): readonly RallarRealtimeLaneHealth[];
        wsStatus(): BlackBoxRallarWsSendDiagnostics['wsStatus'];
        rtcStatus(config: BlackBoxRallarConnectionConfig): BlackBoxRallarWsSendDiagnostics['rtcStatus'];
        emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
        emitDiagnostic(config: BlackBoxRallarConnectionConfig, topic: string, data?: unknown): void;
        emitError(config: BlackBoxRallarConnectionConfig, topic: string, error: unknown, data?: unknown): void;
    }>;

export type BlackBoxRallarMessagingController = Readonly<{
    send(input: BlackBoxRallarSendInput | unknown): Promise<BlackBoxRallarSendDiagnostics>;
    sendWs(input: unknown): Promise<BlackBoxRallarWsSendDiagnostics>;
    cleanupWsSubscriptions(): number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function wsScopeValue(value: unknown): 'room' | 'world' | 'all' | undefined {
    return value === 'room' || value === 'world' || value === 'all' ? value : undefined;
}

function maybeStringArray(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? value
        : undefined;
}

function wsSelectorKey(typeId: string, topicId?: string): string {
    return JSON.stringify({ typeId, topicId });
}

function normalizeSendInput(input: BlackBoxRallarSendInput | unknown): BlackBoxRallarSendInput {
    if (
        isRecord(input) &&
        ('data' in input ||
            'laneId' in input ||
            'roomId' in input ||
            'roomRef' in input ||
            'applicationId' in input ||
            'workspaceId' in input ||
            'scope' in input ||
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

function normalizeMessagesRtcSendInput(input: BlackBoxRallarSendInput | unknown): BlackBoxRallarSendInput {
    return isRecord(input) ? (input as BlackBoxRallarSendInput) : { payload: input };
}

function summarizeRealtimeSendResults(results: readonly RallarRealtimeSendResult[]): unknown {
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
        attentionResults
    };
}

function realtimeSendStatusCount(summary: any, status: string): number {
    return Number(summary?.statuses?.[status] ?? 0);
}

export function createBlackBoxRallarMessagingController(
    options: CreateBlackBoxRallarMessagingControllerOptions
): BlackBoxRallarMessagingController {
    const resources = createBlackBoxRallarMessagingResourceController(options);
    const rallar = options.facade;

    const emitRealtimeSendOutcomeDiagnostics = (
        config: BlackBoxRallarConnectionConfig,
        diagnostics: BlackBoxRallarSendDiagnostics
    ): void => {
        const results = diagnostics.results ?? [];
        const summary = summarizeRealtimeSendResults(results);
        if (results.length === 0) {
            options.emitDiagnostic(config, 'rallar.browser.realtime.peer_not_found', {
                roomId: diagnostics.roomId,
                laneId: diagnostics.laneId,
                peerIds: diagnostics.peerIds,
                health: diagnostics.health,
                summary
            });
        }
        if (realtimeSendStatusCount(summary, 'closed') > 0) {
            options.emitDiagnostic(config, 'rallar.browser.realtime.data_channel_not_open', {
                roomId: diagnostics.roomId,
                laneId: diagnostics.laneId,
                peerIds: diagnostics.peerIds,
                health: diagnostics.health,
                summary
            });
        }
        if (
            realtimeSendStatusCount(summary, 'queued') > 0 ||
            realtimeSendStatusCount(summary, 'dropped') > 0 ||
            realtimeSendStatusCount(summary, 'replaced') > 0 ||
            realtimeSendStatusCount(summary, 'closed') > 0
        ) {
            options.emitDiagnostic(config, 'rallar.browser.realtime.send_result_attention', {
                roomId: diagnostics.roomId,
                laneId: diagnostics.laneId,
                peerIds: diagnostics.peerIds,
                health: diagnostics.health,
                summary
            });
        }
    };

    const sendRealtime = async (
        input: BlackBoxRallarSendInput | unknown,
        config: BlackBoxRallarConnectionConfig,
        lease: BlackBoxRallarMessagingLease
    ): Promise<BlackBoxRallarSendDiagnostics> => {
        const normalized = normalizeSendInput(input);
        const peerIds = normalized.peerIds ??
            (normalized.remotePeerId
                ? [normalized.remotePeerId]
                : config.remotePeerId
                ? [config.remotePeerId]
                : config.rallar.peerIds);
        const laneId = normalized.laneId ?? options.laneIdOf(config);
        const roomId = normalized.roomId ?? config.roomId;
        const roomRef = options.roomRefOf(config, normalized);
        const data = 'data' in normalized ? normalized.data : normalized.payload;
        options.emitDiagnostic(config, 'rallar.browser.realtime.send_started', {
            roomId,
            roomRef,
            ...options.scopeDiagnostics(config, normalized),
            laneId,
            peerIds
        });
        const results = await rallar.realtime.sendJson({
            data,
            laneId,
            roomId,
            roomRef,
            peerIds,
            openTimeoutMs: normalized.openTimeoutMs ?? config.rallar.openTimeoutMs,
            key: normalized.key,
            maxAgeMs: normalized.maxAgeMs
        });
        resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        const diagnostics: BlackBoxRallarSendDiagnostics = {
            status: results.length === 0 ? 'no-peers' : 'sent',
            connection: config.connection,
            actor: config.actor,
            transport: options.transportOf(config),
            roomId,
            ...options.scopeDiagnostics(config, normalized),
            laneId,
            peerIds,
            results,
            health: options.readHealth(config)
        };
        emitRealtimeSendOutcomeDiagnostics(config, diagnostics);
        options.emitDiagnostic(config, 'rallar.browser.realtime.send_completed', diagnostics);
        return diagnostics;
    };

    const sendMessagesRtc = async (
        input: BlackBoxRallarSendInput | unknown,
        config: BlackBoxRallarConnectionConfig,
        lease: BlackBoxRallarMessagingLease
    ): Promise<BlackBoxRallarSendDiagnostics> => {
        const normalized = normalizeMessagesRtcSendInput(input);
        const typeId = normalized.typeId ?? options.typeIdOf(config);
        const topicId = normalized.topicId ?? options.topicIdOf(config);
        const roomId = normalized.roomId ?? config.roomId;
        const roomRef = options.roomRefOf(config, normalized);
        const contextId = normalized.contextId ?? config.rallar.contextId;
        const resourceId = normalized.resourceId ?? config.rallar.resourceId;
        const minSnapshotVersion = options.toOptionalNumber(
            normalized.minSnapshotVersion ?? config.rallar.minSnapshotVersion
        );
        const nextHopPeerIds = normalized.nextHopPeerIds ?? normalized.peerIds ?? config.rallar.nextHopPeerIds ??
            config.rallar.peerIds;
        const payload = 'payload' in normalized ? normalized.payload : normalized.data;
        options.emitDiagnostic(config, 'rallar.browser.messages.rtc.send_started', {
            roomId,
            roomRef,
            ...options.scopeDiagnostics(config, normalized),
            nextHopPeerIds,
            typeId,
            topicId,
            contextId,
            resourceId,
            minSnapshotVersion
        });
        const message = await rallar.messages.rtc.send({
            typeId,
            topicId,
            contextId,
            resourceId,
            roomId,
            roomRef,
            payload,
            ttlHops: normalized.ttlHops ?? config.rallar.ttlHops,
            ttlMs: normalized.ttlMs ?? config.rallar.ttlMs,
            reliability: normalized.reliability ?? config.rallar.reliability,
            ack: normalized.ack ?? config.rallar.ack,
            ownership: normalized.ownership ?? config.rallar.ownership,
            membershipEpoch: normalized.membershipEpoch ?? config.rallar.membershipEpoch,
            minSnapshotVersion,
            seq: normalized.seq ?? config.rallar.seq,
            orderingKey: normalized.orderingKey ?? config.rallar.orderingKey,
            nextHopPeerIds,
            overlayId: normalized.overlayId ?? config.rallar.overlayId,
            fanoutLimit: normalized.fanoutLimit ?? config.rallar.fanoutLimit
        } as any);
        resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        const diagnostics: BlackBoxRallarSendDiagnostics = {
            status: 'sent',
            connection: config.connection,
            actor: config.actor,
            transport: options.transportOf(config),
            roomId,
            ...options.scopeDiagnostics(config, normalized),
            nextHopPeerIds,
            typeId,
            topicId,
            contextId,
            resourceId,
            minSnapshotVersion,
            message,
            health: options.readHealth(config)
        };
        options.emitDiagnostic(config, 'rallar.browser.messages.rtc.send_completed', diagnostics);
        return diagnostics;
    };

    const ensureWsMessageSubscription = (
        config: BlackBoxRallarConnectionConfig,
        typeId: string,
        topicId?: string
    ): void => {
        resources.ensureWsSubscription(wsSelectorKey(typeId, topicId), () => {
            const unsubscribe = rallar.messages.ws.onMessage(
                { typeId, ...(topicId ? { topicId } : {}) },
                (message) => {
                    options.emit({
                        kind: 'message',
                        topic: 'rallar.browser.ws.message',
                        connection: config.connection,
                        actor: config.actor,
                        transport: 'ws',
                        roomId: message.roomId ?? config.roomId,
                        ...options.scopeDiagnostics(config),
                        senderId: message.senderId,
                        typeId: message.typeId,
                        topicId: message.topicId,
                        contextId: message.contextId,
                        resourceId: message.resourceId,
                        data: message.payload
                    });
                }
            );
            options.emit({
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.subscribed',
                connection: config.connection,
                actor: config.actor,
                transport: 'ws',
                roomId: config.roomId,
                ...options.scopeDiagnostics(config),
                typeId,
                topicId
            });
            return unsubscribe;
        });
    };

    return {
        send: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
            try {
                return options.transportOf(config) === 'messages.rtc'
                    ? await sendMessagesRtc(input, config, lease)
                    : await sendRealtime(input, config, lease);
            }
            catch (error) {
                options.emitError(config, `rallar.browser.${options.transportOf(config)}.send_failed`, error, {
                    transport: options.transportOf(config)
                });
                throw error;
            }
        },
        sendWs: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
            const normalized = isRecord(input) ? input : { payload: input };
            const roomId = stringValue(normalized.roomId) ?? stringValue(normalized.groupId) ?? config.roomId;
            const scope = wsScopeValue(normalized.scope) ?? (roomId ? 'room' : 'all');
            const scopedInput = { ...normalized, ...(roomId ? { roomId } : {}) } as BlackBoxRallarSendInput;
            const roomRef = roomId ? options.roomRefOf(config, scopedInput) : undefined;
            const typeId = stringValue(normalized.typeId) ??
                stringValue(normalized.topic) ??
                stringValue(normalized.kind) ??
                'rallar.black-box.ws.json';
            const topicId = stringValue(normalized.topicId) ?? stringValue(normalized.topic) ?? typeId;
            const contextId = stringValue(normalized.contextId) ?? roomId ?? scope;
            const resourceId = stringValue(normalized.resourceId);
            const minSnapshotVersion = options.toOptionalNumber(
                normalized.minSnapshotVersion ?? config.rallar.minSnapshotVersion
            );
            const payload = 'payload' in normalized
                ? normalized.payload
                : 'data' in normalized
                ? normalized.data
                : input;
            ensureWsMessageSubscription(config, typeId, topicId);
            options.emit({
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.send_started',
                connection: config.connection,
                actor: config.actor,
                transport: 'ws',
                roomId,
                roomRef,
                ...options.scopeDiagnostics(config, scopedInput),
                typeId,
                topicId,
                contextId,
                resourceId,
                data: { scope, minSnapshotVersion, wsStatus: options.wsStatus() }
            });
            try {
                const result = await rallar.messages.ws.send({
                    typeId,
                    topicId,
                    contextId,
                    resourceId,
                    scope,
                    roomId,
                    roomRef,
                    payload,
                    minSnapshotVersion,
                    exceptPeerIds: maybeStringArray(normalized.exceptPeerIds),
                    ttlHops: options.toOptionalNumber(normalized.ttlHops ?? config.rallar.ttlHops),
                    ttlMs: options.toOptionalNumber(normalized.ttlMs ?? config.rallar.ttlMs),
                    reliability: normalized.reliability ?? config.rallar.reliability,
                    ack: normalized.ack ?? config.rallar.ack,
                    ownership: normalized.ownership ?? config.rallar.ownership
                } as any);
                resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
                const diagnostics: BlackBoxRallarWsSendDiagnostics = {
                    status: 'sent',
                    connection: config.connection,
                    actor: config.actor,
                    transport: 'ws',
                    roomId,
                    roomRef,
                    ...options.scopeDiagnostics(config, scopedInput),
                    scope,
                    typeId,
                    topicId,
                    contextId,
                    resourceId,
                    minSnapshotVersion,
                    message: payload,
                    result,
                    wsStatus: options.wsStatus(),
                    rtcStatus: options.rtcStatus(config)
                };
                options.emit({
                    kind: 'diagnostic',
                    topic: 'rallar.browser.ws.send_completed',
                    connection: config.connection,
                    actor: config.actor,
                    transport: 'ws',
                    roomId,
                    roomRef,
                    ...options.scopeDiagnostics(config, scopedInput),
                    typeId,
                    topicId,
                    contextId,
                    resourceId,
                    data: diagnostics
                });
                return diagnostics;
            }
            catch (error) {
                options.emitError(config, 'rallar.browser.ws.send_failed', error, {
                    transport: 'ws',
                    roomId,
                    roomRef,
                    typeId,
                    topicId,
                    contextId,
                    resourceId,
                    scope
                });
                throw error;
            }
        },
        cleanupWsSubscriptions: resources.cleanupWsSubscriptions
    };
}
