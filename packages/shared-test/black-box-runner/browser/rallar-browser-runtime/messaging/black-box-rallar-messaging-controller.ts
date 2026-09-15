import { toError } from '@shared/resilience/to-error.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarMessagesRtcSendDiagnostics,
    BlackBoxRallarRealtimeSendDiagnostics,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarWsSendDiagnostics
} from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarRoomRefOf, blackBoxRallarScopeDiagnosticsOf } from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxRallarRuntime } from '../black-box-rallar-runtime-contract.ts';
import type {
    BlackBoxBrowserMessagesDependency,
    BlackBoxBrowserRealtimeDependency
} from '../browser-rallar-runtime-composition.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarTransport
} from '../connection/black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarHealthReader } from '../connection/black-box-rallar-health-reader.ts';
import { decodeBlackBoxRallarSendInput } from '../decode-black-box-rallar-command-input.ts';
import { toDeliveryObservation } from './black-box-rallar-delivery-ledger.ts';
import type {
    BlackBoxRallarMessagingLease,
    BlackBoxRallarMessagingResourceController
} from './create-black-box-rallar-messaging-resource-controller.ts';
import {
    computeRealtimeSendSummary,
    resolveRealtimePeerIds,
    toMessageRoutingDiagnostics,
    toRtcSendRequest,
    toWsSendContext,
    toWsSendRequest,
    type PreparedWsSend,
    type WsSendContext
} from './to-black-box-rallar-send-requests.ts';

export namespace BlackBoxRallarMessagingController {
    export interface Input {
        readonly messages: BlackBoxBrowserMessagesDependency;
        readonly realtime: BlackBoxBrowserRealtimeDependency;
        readonly resources: BlackBoxRallarMessagingResourceController;
        readonly health: BlackBoxRallarHealthReader;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        requireConfig(): BlackBoxRallarConnectionConfig;
    }
}

interface RealtimeSendTarget {
    readonly config: BlackBoxRallarConnectionConfig;
    readonly transport: BlackBoxRallarRealtimeSendDiagnostics['transport'];
    readonly lease: BlackBoxRallarMessagingLease;
}

const LATE_SEND_MESSAGE = 'Rallar send completed after the runtime closed.';

export class BlackBoxRallarMessagingController {
    readonly #input: BlackBoxRallarMessagingController.Input;

    constructor(input: BlackBoxRallarMessagingController.Input) {
        this.#input = input;
    }

    send = async (input: Parameters<BlackBoxRallarRuntime['send']>[0]): Promise<BlackBoxRallarSendDiagnostics> => {
        const config = this.#input.requireConfig();
        const lease = this.#input.resources.lease();
        this.#input.resources.assertCurrent(lease, LATE_SEND_MESSAGE);
        const transport = resolveBlackBoxRallarTransport(config);
        try {
            return transport === 'messages.rtc'
                ? await this.#sendMessagesRtc(decodeBlackBoxRallarSendInput(input, 'messages.rtc'), config, lease)
                : await this.#sendRealtime(decodeBlackBoxRallarSendInput(input, 'realtime'), {
                    config,
                    transport,
                    lease
                });
        }
        catch (caught) {
            const error = toError(caught);
            this.#input.diagnostics.emitError({
                config,
                topic: `rallar.browser.${transport}.send_failed`,
                error,
                data: { transport }
            });
            throw error;
        }
    };

    sendWs = async (
        input: Parameters<BlackBoxRallarRuntime['sendWs']>[0]
    ): Promise<BlackBoxRallarWsSendDiagnostics> => {
        const config = this.#input.requireConfig();
        const lease = this.#input.resources.lease();
        this.#input.resources.assertCurrent(lease, LATE_SEND_MESSAGE);
        const prepared = toWsSendRequest(input, config);
        const context = toWsSendContext(config, prepared);
        this.#ensureWsMessageSubscription(config, prepared.request.typeId, prepared.request.topicId);
        this.#input.diagnostics.emit({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.send_started',
            ...context,
            data: {
                scope: prepared.request.scope,
                minSnapshotVersion: prepared.request.minSnapshotVersion,
                wsStatus: this.#input.health.getWsStatus()
            }
        });
        try {
            return await this.#writeWs(prepared, { config, context, lease });
        }
        catch (caught) {
            const error = toError(caught);
            this.#input.diagnostics.emitError({
                config,
                topic: 'rallar.browser.ws.send_failed',
                error,
                data: { ...context, scope: prepared.request.scope }
            });
            throw error;
        }
    };

    cleanupWsSubscriptions = (): number => this.#input.resources.cleanupWsSubscriptions();

    async #sendRealtime(
        normalized: BlackBoxRallarSendInput,
        target: RealtimeSendTarget
    ): Promise<BlackBoxRallarRealtimeSendDiagnostics> {
        const { config, transport, lease } = target;
        const peerIds = resolveRealtimePeerIds(normalized, config) ??
            this.#input.health.getRtcStatus(config).readyPeerIds;
        const laneId = normalized.laneId ?? resolveBlackBoxRallarLaneId(config);
        const roomId = normalized.roomId ?? config.roomId;
        const roomRef = blackBoxRallarRoomRefOf(config, normalized);
        const scopeDiagnostics = blackBoxRallarScopeDiagnosticsOf(config, normalized);
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.send_started', {
            roomId,
            roomRef,
            ...scopeDiagnostics,
            laneId,
            peerIds
        });
        const results = await this.#input.realtime.sendJson({
            data: 'data' in normalized ? normalized.data : normalized.payload,
            laneId,
            roomId,
            roomRef,
            peerIds,
            openTimeoutMs: normalized.openTimeoutMs ?? config.rallar.openTimeoutMs,
            key: normalized.key,
            maxAgeMs: normalized.maxAgeMs
        });
        this.#input.resources.assertCurrent(lease, LATE_SEND_MESSAGE);
        const diagnostics: BlackBoxRallarRealtimeSendDiagnostics = {
            status: results.length === 0 ? 'no-peers' : 'sent',
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId,
            ...scopeDiagnostics,
            laneId,
            peerIds,
            results,
            health: this.#input.health.getLaneHealth(config)
        };
        this.#emitRealtimeSendOutcome(config, diagnostics);
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.send_completed', diagnostics);
        return diagnostics;
    }

    #emitRealtimeSendOutcome(
        config: BlackBoxRallarConnectionConfig,
        diagnostics: BlackBoxRallarRealtimeSendDiagnostics
    ): void {
        const summary = computeRealtimeSendSummary(diagnostics.results);
        const data = {
            roomId: diagnostics.roomId,
            laneId: diagnostics.laneId,
            peerIds: diagnostics.peerIds,
            health: diagnostics.health,
            summary
        };
        const statuses = summary.statuses;
        if (diagnostics.results.length === 0) {
            this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.peer_not_found', data);
        }
        if ((statuses.closed ?? 0) > 0) {
            this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.data_channel_not_open', data);
        }
        const attention = (statuses.queued ?? 0) + (statuses.dropped ?? 0) + (statuses.replaced ?? 0) +
            (statuses.closed ?? 0);
        if (attention > 0) {
            this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.send_result_attention', data);
        }
    }

    async #sendMessagesRtc(
        normalized: BlackBoxRallarSendInput,
        config: BlackBoxRallarConnectionConfig,
        lease: BlackBoxRallarMessagingLease
    ): Promise<BlackBoxRallarMessagesRtcSendDiagnostics> {
        const request = toRtcSendRequest(normalized, config);
        const context = {
            ...toMessageRoutingDiagnostics(request),
            ...blackBoxRallarScopeDiagnosticsOf(config, normalized),
            nextHopPeerIds: request.nextHopPeerIds
        };
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.messages.rtc.send_started', context);
        const handle = await this.#input.messages.rtc.send(request);
        this.#input.resources.assertCurrent(lease, LATE_SEND_MESSAGE);
        const diagnostics: BlackBoxRallarMessagesRtcSendDiagnostics = {
            connection: config.connection,
            actor: config.actor,
            transport: 'messages.rtc',
            ...context,
            message: toDeliveryObservation(handle.msgId, handle.lifecycle()),
            health: this.#input.health.getLaneHealth(config)
        };
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.messages.rtc.send_completed', diagnostics);
        return diagnostics;
    }

    async #writeWs(prepared: PreparedWsSend, sending: WsSending): Promise<BlackBoxRallarWsSendDiagnostics> {
        const { config, context, lease } = sending;
        const handle = await this.#input.messages.ws.send(prepared.request);
        this.#input.resources.assertCurrent(lease, LATE_SEND_MESSAGE);
        const diagnostics: BlackBoxRallarWsSendDiagnostics = {
            status: 'sent',
            ...context,
            scope: prepared.scope,
            minSnapshotVersion: prepared.request.minSnapshotVersion,
            message: prepared.request.payload,
            result: toDeliveryObservation(handle.msgId, handle.lifecycle()),
            wsStatus: this.#input.health.getWsStatus(),
            rtcStatus: this.#input.health.getRtcStatus(config)
        };
        this.#input.diagnostics.emit({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.send_completed',
            ...context,
            data: diagnostics
        });
        return diagnostics;
    }

    #ensureWsMessageSubscription(
        config: BlackBoxRallarConnectionConfig,
        typeId: string,
        topicId: string | undefined
    ): void {
        this.#input.resources.ensureWsSubscription(JSON.stringify({ typeId, topicId }), () => {
            const unsubscribe = this.#input.messages.ws.onMessage(
                { typeId, ...(topicId ? { topicId } : {}) },
                (message) => {
                    this.#input.diagnostics.emit({
                        kind: 'message',
                        topic: 'rallar.browser.ws.message',
                        connection: config.connection,
                        actor: config.actor,
                        transport: 'ws',
                        roomId: message.roomId ?? config.roomId,
                        ...blackBoxRallarScopeDiagnosticsOf(config),
                        senderId: message.senderId,
                        typeId: message.typeId,
                        topicId: message.topicId,
                        contextId: message.contextId,
                        resourceId: message.resourceId,
                        data: message.payload
                    });
                }
            );
            this.#input.diagnostics.emit({
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.subscribed',
                connection: config.connection,
                actor: config.actor,
                transport: 'ws',
                roomId: config.roomId,
                ...blackBoxRallarScopeDiagnosticsOf(config),
                typeId,
                topicId
            });
            return unsubscribe;
        });
    }
}

interface WsSending {
    readonly config: BlackBoxRallarConnectionConfig;
    readonly context: WsSendContext;
    readonly lease: BlackBoxRallarMessagingLease;
}
