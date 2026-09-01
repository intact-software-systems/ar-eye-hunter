import type {
    RallarRealtimeLaneHealth,
    RallarRealtimeSendResult,
    RallarRtcSendInput,
    RallarWsSendInput
} from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from './black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarEvent,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport,
    BlackBoxRallarWsSendDiagnostics
} from './black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarScopeDiagnostics } from './black-box-rallar-operation-policy.ts';
import type {
    BlackBoxBrowserMessagesDependency,
    BlackBoxBrowserRealtimeDependency
} from './browser-rallar-runtime-composition.ts';
import {
    decodeBlackBoxRallarSendInput,
    decodeBlackBoxRallarWsSendInput
} from './decode-black-box-rallar-command-input.ts';
import type { BlackBoxRallarGenerationPort } from './ports.ts';

export interface BlackBoxRallarMessagingLease {
    readonly generation: number;
}

export interface BlackBoxRallarMessagingResourceController {
    lease(): BlackBoxRallarMessagingLease;
    assertCurrent(lease: BlackBoxRallarMessagingLease, message: string): void;
    ensureWsSubscription(key: string, subscribe: () => () => void): void;
    cleanupWsSubscriptions(): number;
}

export function createBlackBoxRallarMessagingResourceController(
    options: BlackBoxRallarGenerationPort
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

function wsSelectorKey(typeId: string, topicId?: string): string {
    return JSON.stringify({ typeId, topicId });
}

interface RealtimeSendSummary {
    readonly total: number;
    readonly statuses: Readonly<Record<string, number>>;
    readonly peerIds: readonly string[];
    readonly attentionResults: readonly RallarRealtimeSendResult[];
}

function summarizeRealtimeSendResults(results: readonly RallarRealtimeSendResult[]): RealtimeSendSummary {
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

interface MessageRoutingDiagnostics {
    readonly roomId: string | undefined;
    readonly roomRef: GroupRef | undefined;
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly contextId: string | undefined;
    readonly resourceId: string | undefined;
    readonly minSnapshotVersion: number | undefined;
}

interface PreparedWsSend {
    readonly request: RallarWsSendInput<unknown>;
    readonly scopeDiagnostics: BlackBoxRallarScopeDiagnostics;
}

interface WsSendContext
    extends Omit<MessageRoutingDiagnostics, 'minSnapshotVersion'>, Omit<BlackBoxRallarScopeDiagnostics, 'roomRef'> {
    readonly connection: string;
    readonly actor: string | undefined;
    readonly transport: 'ws';
}

function messageRoutingDiagnostics(
    request: RallarRtcSendInput<unknown> | RallarWsSendInput<unknown>
): MessageRoutingDiagnostics {
    return {
        roomId: request.roomId,
        roomRef: request.roomRef,
        typeId: request.typeId,
        topicId: request.topicId,
        contextId: request.contextId,
        resourceId: request.resourceId,
        minSnapshotVersion: request.minSnapshotVersion
    };
}

export namespace BlackBoxRallarMessagingController {
    export interface Input extends BlackBoxRallarGenerationPort {
        readonly facade: MessagingFacade;
        requireConfig(): BlackBoxRallarConnectionConfig;
        transportOf(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport;
        laneIdOf(config: BlackBoxRallarConnectionConfig): string;
        typeIdOf(config: BlackBoxRallarConnectionConfig): string;
        topicIdOf(config: BlackBoxRallarConnectionConfig): string | undefined;
        roomRefOf(config: BlackBoxRallarConnectionConfig, input?: BlackBoxRallarSendInput): GroupRef | undefined;
        scopeDiagnostics(
            config: BlackBoxRallarConnectionConfig,
            input?: BlackBoxRallarSendInput
        ): BlackBoxRallarScopeDiagnostics;
        readHealth(config: BlackBoxRallarConnectionConfig): readonly RallarRealtimeLaneHealth[];
        wsStatus(): BlackBoxRallarWsSendDiagnostics['wsStatus'];
        rtcStatus(config: BlackBoxRallarConnectionConfig): BlackBoxRallarWsSendDiagnostics['rtcStatus'];
        emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
        emitDiagnostic(config: BlackBoxRallarConnectionConfig, topic: string, data?: object): void;
        readonly emitError: BlackBoxRallarRuntimeDiagnostics['emitError'];
    }
}

export class BlackBoxRallarMessagingController {
    readonly #options: BlackBoxRallarMessagingController.Input;
    readonly #resources: BlackBoxRallarMessagingResourceController;
    constructor(options: BlackBoxRallarMessagingController.Input) {
        this.#options = options;
        this.#resources = createBlackBoxRallarMessagingResourceController(options);
    }

    private emitRealtimeSendOutcomeDiagnostics = (
        config: BlackBoxRallarConnectionConfig,
        diagnostics: BlackBoxRallarSendDiagnostics
    ): void => {
        const results = diagnostics.results ?? [];
        const summary = summarizeRealtimeSendResults(results);
        if (results.length === 0) {
            this.#options.emitDiagnostic(config, 'rallar.browser.realtime.peer_not_found', {
                roomId: diagnostics.roomId,
                laneId: diagnostics.laneId,
                peerIds: diagnostics.peerIds,
                health: diagnostics.health,
                summary
            });
        }
        if ((summary.statuses.closed ?? 0) > 0) {
            this.#options.emitDiagnostic(config, 'rallar.browser.realtime.data_channel_not_open', {
                roomId: diagnostics.roomId,
                laneId: diagnostics.laneId,
                peerIds: diagnostics.peerIds,
                health: diagnostics.health,
                summary
            });
        }
        if (
            (summary.statuses.queued ?? 0) > 0 ||
            (summary.statuses.dropped ?? 0) > 0 ||
            (summary.statuses.replaced ?? 0) > 0 ||
            (summary.statuses.closed ?? 0) > 0
        ) {
            this.#options.emitDiagnostic(config, 'rallar.browser.realtime.send_result_attention', {
                roomId: diagnostics.roomId,
                laneId: diagnostics.laneId,
                peerIds: diagnostics.peerIds,
                health: diagnostics.health,
                summary
            });
        }
    };

    private sendRealtime = async (
        input: unknown,
        config: BlackBoxRallarConnectionConfig,
        lease: BlackBoxRallarMessagingLease
    ): Promise<BlackBoxRallarSendDiagnostics> => {
        const normalized = decodeBlackBoxRallarSendInput(input, 'realtime');
        const selectedPeerIds = normalized.peerIds ??
            (normalized.remotePeerId
                ? [normalized.remotePeerId]
                : config.remotePeerId
                ? [config.remotePeerId]
                : config.rallar.peerIds);
        const peerIds = selectedPeerIds ?? this.#options.rtcStatus(config).readyPeerIds;
        const laneId = normalized.laneId ?? this.#options.laneIdOf(config);
        const roomId = normalized.roomId ?? config.roomId;
        const roomRef = this.#options.roomRefOf(config, normalized);
        const data = 'data' in normalized ? normalized.data : normalized.payload;
        this.#options.emitDiagnostic(config, 'rallar.browser.realtime.send_started', {
            roomId,
            roomRef,
            ...this.#options.scopeDiagnostics(config, normalized),
            laneId,
            peerIds
        });
        const results = await this.#options.facade.realtime.sendJson({
            data,
            laneId,
            roomId,
            roomRef,
            peerIds,
            openTimeoutMs: normalized.openTimeoutMs ?? config.rallar.openTimeoutMs,
            key: normalized.key,
            maxAgeMs: normalized.maxAgeMs
        });
        this.#resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        const diagnostics: BlackBoxRallarSendDiagnostics = {
            status: results.length === 0 ? 'no-peers' : 'sent',
            connection: config.connection,
            actor: config.actor,
            transport: this.#options.transportOf(config),
            roomId,
            ...this.#options.scopeDiagnostics(config, normalized),
            laneId,
            peerIds,
            results,
            health: this.#options.readHealth(config)
        };
        this.emitRealtimeSendOutcomeDiagnostics(config, diagnostics);
        this.#options.emitDiagnostic(config, 'rallar.browser.realtime.send_completed', diagnostics);
        return diagnostics;
    };

    private rtcRequest(
        input: BlackBoxRallarSendInput,
        config: BlackBoxRallarConnectionConfig
    ): RallarRtcSendInput<unknown> {
        return {
            typeId: input.typeId ?? this.#options.typeIdOf(config),
            topicId: input.topicId ?? this.#options.topicIdOf(config),
            roomId: input.roomId ?? config.roomId,
            roomRef: this.#options.roomRefOf(config, input),
            contextId: input.contextId ?? config.rallar.contextId,
            resourceId: input.resourceId ?? config.rallar.resourceId,
            minSnapshotVersion: input.minSnapshotVersion ?? config.rallar.minSnapshotVersion,
            nextHopPeerIds: input.nextHopPeerIds ?? input.peerIds ?? config.rallar.nextHopPeerIds ??
                config.rallar.peerIds,
            payload: 'payload' in input ? input.payload : input.data,
            ttlHops: input.ttlHops ?? config.rallar.ttlHops,
            ttlMs: input.ttlMs ?? config.rallar.ttlMs,
            reliability: input.reliability ?? config.rallar.reliability,
            ack: input.ack ?? config.rallar.ack,
            ownership: input.ownership ?? config.rallar.ownership,
            membershipEpoch: input.membershipEpoch ?? config.rallar.membershipEpoch,
            seq: input.seq ?? config.rallar.seq,
            orderingKey: input.orderingKey ?? config.rallar.orderingKey,
            overlayId: input.overlayId ?? config.rallar.overlayId,
            fanoutLimit: input.fanoutLimit ?? config.rallar.fanoutLimit
        };
    }

    private sendMessagesRtc = async (
        input: unknown,
        config: BlackBoxRallarConnectionConfig,
        lease: BlackBoxRallarMessagingLease
    ): Promise<BlackBoxRallarSendDiagnostics> => {
        const normalized = decodeBlackBoxRallarSendInput(input, 'messages.rtc');
        const request = this.rtcRequest(normalized, config);
        const context = {
            ...messageRoutingDiagnostics(request),
            ...this.#options.scopeDiagnostics(config, normalized),
            nextHopPeerIds: request.nextHopPeerIds
        };
        this.#options.emitDiagnostic(config, 'rallar.browser.messages.rtc.send_started', context);
        const message = await this.#options.facade.messages.rtc.send(request);
        this.#resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        const diagnostics: BlackBoxRallarSendDiagnostics = {
            status: 'sent',
            connection: config.connection,
            actor: config.actor,
            transport: this.#options.transportOf(config),
            ...context,
            message,
            health: this.#options.readHealth(config)
        };
        this.#options.emitDiagnostic(config, 'rallar.browser.messages.rtc.send_completed', diagnostics);
        return diagnostics;
    };

    private ensureWsMessageSubscription = (
        config: BlackBoxRallarConnectionConfig,
        typeId: string,
        topicId?: string
    ): void => {
        this.#resources.ensureWsSubscription(wsSelectorKey(typeId, topicId), () => {
            const unsubscribe = this.#options.facade.messages.ws.onMessage(
                { typeId, ...(topicId ? { topicId } : {}) },
                (message) => {
                    this.#options.emit({
                        kind: 'message',
                        topic: 'rallar.browser.ws.message',
                        connection: config.connection,
                        actor: config.actor,
                        transport: 'ws',
                        roomId: message.roomId ?? config.roomId,
                        ...this.#options.scopeDiagnostics(config),
                        senderId: message.senderId,
                        typeId: message.typeId,
                        topicId: message.topicId,
                        contextId: message.contextId,
                        resourceId: message.resourceId,
                        data: message.payload
                    });
                }
            );
            this.#options.emit({
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.subscribed',
                connection: config.connection,
                actor: config.actor,
                transport: 'ws',
                roomId: config.roomId,
                ...this.#options.scopeDiagnostics(config),
                typeId,
                topicId
            });
            return unsubscribe;
        });
    };

    send = async (input: unknown): Promise<BlackBoxRallarSendDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.#resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        try {
            return this.#options.transportOf(config) === 'messages.rtc'
                ? await this.sendMessagesRtc(input, config, lease)
                : await this.sendRealtime(input, config, lease);
        }
        catch (caught) {
            const error = toError(caught);
            this.#options.emitError({
                config: config,
                topic: `rallar.browser.${this.#options.transportOf(config)}.send_failed`,
                error: error,
                data: {
                    transport: this.#options.transportOf(config)
                }
            });
            throw error;
        }
    };

    private wsRequest(input: unknown, config: BlackBoxRallarConnectionConfig): PreparedWsSend {
        const normalized = decodeBlackBoxRallarWsSendInput(input);
        const roomId = normalized.roomId ?? normalized.groupId ?? config.roomId;
        const scope = normalized.scope ?? (roomId ? 'room' : 'all');
        const scopedInput: BlackBoxRallarSendInput = { ...normalized, scope: undefined, roomId };
        const typeId = normalized.typeId ?? normalized.topic ?? normalized.kind ?? 'rallar.black-box.ws.json';
        const request: RallarWsSendInput<unknown> = {
            typeId,
            topicId: normalized.topicId ?? normalized.topic ?? typeId,
            contextId: normalized.contextId ?? roomId ?? scope,
            resourceId: normalized.resourceId,
            scope,
            roomId,
            roomRef: roomId ? this.#options.roomRefOf(config, scopedInput) : undefined,
            payload: 'payload' in normalized ? normalized.payload : 'data' in normalized ? normalized.data : input,
            minSnapshotVersion: normalized.minSnapshotVersion ?? config.rallar.minSnapshotVersion,
            exceptPeerIds: normalized.exceptPeerIds,
            ttlHops: normalized.ttlHops ?? config.rallar.ttlHops,
            ttlMs: normalized.ttlMs ?? config.rallar.ttlMs,
            reliability: normalized.reliability ?? config.rallar.reliability,
            ack: normalized.ack ?? config.rallar.ack,
            ownership: normalized.ownership ?? config.rallar.ownership
        };
        return { request, scopeDiagnostics: this.#options.scopeDiagnostics(config, scopedInput) };
    }

    private wsContext(config: BlackBoxRallarConnectionConfig, prepared: PreparedWsSend): WsSendContext {
        return {
            connection: config.connection,
            actor: config.actor,
            transport: 'ws',
            roomId: prepared.request.roomId,
            roomRef: prepared.request.roomRef,
            typeId: prepared.request.typeId,
            topicId: prepared.request.topicId,
            contextId: prepared.request.contextId,
            resourceId: prepared.request.resourceId,
            ...prepared.scopeDiagnostics
        };
    }

    sendWs = async (input: unknown): Promise<BlackBoxRallarWsSendDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.#resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        const prepared = this.wsRequest(input, config);
        const { request } = prepared;
        const context = this.wsContext(config, prepared);
        this.ensureWsMessageSubscription(config, request.typeId, request.topicId);
        this.#options.emit({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.send_started',
            ...context,
            data: {
                scope: request.scope,
                minSnapshotVersion: request.minSnapshotVersion,
                wsStatus: this.#options.wsStatus()
            }
        });
        try {
            const result = await this.#options.facade.messages.ws.send(request);
            this.#resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
            const diagnostics: BlackBoxRallarWsSendDiagnostics = {
                status: 'sent',
                ...context,
                scope: request.scope,
                minSnapshotVersion: request.minSnapshotVersion,
                message: request.payload,
                result,
                wsStatus: this.#options.wsStatus(),
                rtcStatus: this.#options.rtcStatus(config)
            };
            this.#options.emit({
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.send_completed',
                ...context,
                data: diagnostics
            });
            return diagnostics;
        }
        catch (caught) {
            const error = toError(caught);
            this.#options.emitError({
                config,
                topic: 'rallar.browser.ws.send_failed',
                error,
                data: { ...context, scope: request.scope }
            });
            throw error;
        }
    };

    cleanupWsSubscriptions = (): number => this.#resources.cleanupWsSubscriptions();
}
