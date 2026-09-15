import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarWsSendInput } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarSendInput,
    BlackBoxRallarWsSendDiagnostics
} from '../black-box-rallar-operation-contracts.ts';
import {
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeDiagnosticsOf,
    type BlackBoxRallarScopeDiagnostics
} from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxRallarWsSendInput } from '../black-box-rallar-runtime-contract.ts';
import type { BlackBoxBrowserMessagesDependency } from '../browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarHealthReader } from '../connection/black-box-rallar-health-reader.ts';
import { toDeliveryObservation } from './black-box-rallar-delivery-ledger.ts';
import type {
    BlackBoxRallarMessagingLease,
    BlackBoxRallarMessagingResourceController
} from './create-black-box-rallar-messaging-resource-controller.ts';

export namespace BlackBoxRallarWsSendController {
    export interface Input {
        readonly messages: BlackBoxBrowserMessagesDependency;
        readonly resources: BlackBoxRallarMessagingResourceController;
        readonly health: BlackBoxRallarHealthReader;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        requireConfig(): BlackBoxRallarConnectionConfig;
    }
}

interface PreparedWsSend {
    readonly request: RallarWsSendInput<RallarMessagePayload>;
    readonly scope: BlackBoxRallarWsSendDiagnostics['scope'];
    readonly scopeDiagnostics: BlackBoxRallarScopeDiagnostics;
}

interface WsSendContext extends Omit<BlackBoxRallarScopeDiagnostics, 'roomRef'> {
    readonly connection: string;
    readonly actor: string | undefined;
    readonly transport: 'ws';
    readonly roomId: string | undefined;
    readonly roomRef: GroupRef | undefined;
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly contextId: string | undefined;
    readonly resourceId: string | undefined;
}

interface WsSending {
    readonly config: BlackBoxRallarConnectionConfig;
    readonly context: WsSendContext;
    readonly lease: BlackBoxRallarMessagingLease;
}

const LATE_SEND_MESSAGE = 'Rallar send completed after the runtime closed.';
const DEFAULT_WS_TYPE_ID = 'rallar.black-box.ws.json';

/** Owns ws.send over the Rallar signaling WebSocket and the inbound subscription each sent type needs. */
export class BlackBoxRallarWsSendController {
    readonly #input: BlackBoxRallarWsSendController.Input;

    constructor(input: BlackBoxRallarWsSendController.Input) {
        this.#input = input;
    }

    sendWs = async (input: BlackBoxRallarWsSendInput): Promise<BlackBoxRallarWsSendDiagnostics> => {
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

function toWsSendRequest(input: BlackBoxRallarWsSendInput, config: BlackBoxRallarConnectionConfig): PreparedWsSend {
    const roomId = input.roomId ?? input.groupId ?? config.roomId;
    const scope = input.scope ?? (roomId ? 'room' : 'all');
    const scopedInput: BlackBoxRallarSendInput = { ...input, scope: undefined, roomId };
    const typeId = input.typeId ?? input.topic ?? input.kind ?? DEFAULT_WS_TYPE_ID;
    const defaults = config.rallar;
    const request: RallarWsSendInput<RallarMessagePayload> = {
        typeId,
        topicId: input.topicId ?? input.topic ?? typeId,
        contextId: input.contextId ?? roomId ?? scope,
        resourceId: input.resourceId,
        scope,
        roomId,
        roomRef: roomId ? blackBoxRallarRoomRefOf(config, scopedInput) : undefined,
        payload: input.payload,
        minSnapshotVersion: input.minSnapshotVersion ?? defaults.minSnapshotVersion,
        exceptPeerIds: input.exceptPeerIds,
        ttlHops: input.ttlHops ?? defaults.ttlHops,
        ttlMs: input.ttlMs ?? defaults.ttlMs,
        reliability: input.reliability ?? defaults.reliability,
        ack: input.ack ?? defaults.ack,
        ownership: input.ownership ?? defaults.ownership
    };
    return { request, scope, scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf(config, scopedInput) };
}

function toWsSendContext(config: BlackBoxRallarConnectionConfig, prepared: PreparedWsSend): WsSendContext {
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
