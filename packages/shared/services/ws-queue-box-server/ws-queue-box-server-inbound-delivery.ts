import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../../al-contracts/al-message-persistence-validation.ts';
import {
    planALMessageHandling,
    resolveALMessageExpireAtMs,
    resolveALQosNormalizationInput,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { JsonWebSocketServer } from '../../websocket/json-web-socket-server.ts';
import type { InboxOutboxEngine } from '../InboxOutboxEngine.ts';
import type { OnWebSocketServerMessageCallback, WebSocketServerMessageContext } from '../queue-message-callbacks.ts';
import type { WsQueueBoxServerInboundAuthority } from './ws-queue-box-server-inbound-authority.ts';
import { resolveWsQueueBoxServerInboundRecipients } from './ws-queue-box-server-inbound-recipients.ts';
import type { WsQueueBoxServerLiveDelivery } from './ws-queue-box-server-live-delivery.ts';
import { toWsQueueBoxServerInboundPlan } from './ws-queue-box-server-inbound-plan.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export namespace WsQueueBoxServerInboundDelivery {
    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly serverPeerId: string;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly queueEngine: InboxOutboxEngine;
        readonly qosProvider: ALQosInputProvider;
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        readonly liveDelivery: WsQueueBoxServerLiveDelivery;
        readonly authority: WsQueueBoxServerInboundAuthority;
        readonly routerOwnsRoomFanout: boolean;
    }
}

export class WsQueueBoxServerInboundDelivery {
    private static readonly ALL_IN = '*';

    readonly #socket: JsonWebSocketServer;
    readonly #serverPeerId: string;
    readonly #clock: ALOutboundMessageRuntime.Clock;
    readonly #queueEngine: InboxOutboxEngine;
    readonly #qosProvider: ALQosInputProvider;
    readonly #targetResolution: WsQueueBoxServerTargetResolution;
    readonly #liveDelivery: WsQueueBoxServerLiveDelivery;
    readonly #authority: WsQueueBoxServerInboundAuthority;
    readonly #routerOwnsRoomFanout: boolean;
    readonly #callbacks = new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();
    readonly #observers = new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();

    constructor(dependencies: WsQueueBoxServerInboundDelivery.Dependencies) {
        this.#socket = dependencies.socket;
        this.#serverPeerId = dependencies.serverPeerId;
        this.#clock = dependencies.clock;
        this.#queueEngine = dependencies.queueEngine;
        this.#qosProvider = dependencies.qosProvider;
        this.#targetResolution = dependencies.targetResolution;
        this.#liveDelivery = dependencies.liveDelivery;
        this.#authority = dependencies.authority;
        this.#routerOwnsRoomFanout = dependencies.routerOwnsRoomFanout;
    }

    dispose(): void {
        this.#callbacks.clear();
        this.#observers.clear();
    }

    onAllInboxMessagesDo(callback: OnWebSocketServerMessageCallback<ALMessage>, forceUpdate: boolean): void {
        if (!forceUpdate && this.#callbacks.has(WsQueueBoxServerInboundDelivery.ALL_IN)) {
            throw new Error('Cannot set multiple Ws inbox callbacks for ALL_IN');
        }
        this.#callbacks.set(WsQueueBoxServerInboundDelivery.ALL_IN, callback);
        this.#queueEngine.wake();
    }

    onAnyInboxMessageDo(id: string, callback: OnWebSocketServerMessageCallback<ALMessage>): void {
        this.#observers.set(id, callback);
        this.#queueEngine.wake();
    }

    onInboxMessageDo(id: string, callback: OnWebSocketServerMessageCallback<ALMessage>): void {
        this.#callbacks.set(id, callback);
        this.#queueEngine.wake();
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.#callbacks.delete(id);
    }

    removeAnyInboxMessageCallback(id: string): boolean {
        return this.#observers.delete(id);
    }

    hasInboxConsumer(message: ALMessage): boolean {
        return this.#callbacks.has(message.payload.typeId) ||
            this.#callbacks.has(WsQueueBoxServerInboundDelivery.ALL_IN) ||
            this.#observers.size > 0;
    }

    planIncomingMessage(
        message: ALMessage,
        source: ALInboundMessageRuntime.Source,
        observations: ALMessagePlanningObservations
    ): ALMessageHandlingPlan {
        const fromPeerId = source.kind === 'trusted-server' ? message.id.senderId : source.peerId;
        const resolvedPeerIds = this.#targetResolution.resolveInboundRecipients(message)
            .map((recipient) => recipient.peerId);
        const { recipientPeerIds, groupMemberPeerIds } = resolveWsQueueBoxServerInboundRecipients({
            message,
            source,
            resolvedPeerIds,
            serverPeerId: this.#serverPeerId
        });
        return toWsQueueBoxServerInboundPlan({
            plan: planALMessageHandling(
                message,
                {
                    ...observations,
                    selfPeerId: this.#serverPeerId,
                    fromPeerId,
                    connectedPeerIds: recipientPeerIds,
                    groupMemberPeerIds,
                    overlayNeighborPeerIds: recipientPeerIds
                },
                resolveALQosNormalizationInput(
                    message,
                    { selfPeerId: this.#serverPeerId, fromPeerId, direction: 'inbound' },
                    this.#qosProvider
                )
            ),
            message,
            source,
            serverPeerId: this.#serverPeerId,
            routerOwnsRoomFanout: this.#routerOwnsRoomFanout
        });
    }

    async dispatchInboxEntry(
        entry: ResourceEntry,
        plan: ALMessageHandlingPlan,
        source: ALInboundMessageRuntime.Source
    ): Promise<void | 'completed' | 'retry'> {
        const message = decodePersistedALMessage(entry.resource);
        const authority = await this.#authority.readCurrentDispatchAuthority(message);
        if (typeof authority === 'string') {
            return authority;
        }
        if (entry.audit.expiryTs.epochMilliseconds <= this.#clock.nowMs()) {
            throw new NonRetryableException('Inbound message expired during authorization');
        }

        const context: WebSocketServerMessageContext = { server: this.#socket, source };
        const selected = this.#callbacks.get(message.payload.typeId) ??
            (plan.ownership.exclusive ? this.#callbacks.get(WsQueueBoxServerInboundDelivery.ALL_IN) : undefined);
        await selected?.onMessage(message, entry, context);
        const wildcard = plan.ownership.exclusive
            ? undefined
            : this.#callbacks.get(WsQueueBoxServerInboundDelivery.ALL_IN);
        if (wildcard !== undefined) {
            if (entry.audit.expiryTs.epochMilliseconds <= this.#clock.nowMs()) {
                throw new NonRetryableException('Inbound message expired before wildcard delivery');
            }
            await wildcard.onMessage(message, entry, context);
        }
        for (const callback of this.#observers.values()) {
            if (entry.audit.expiryTs.epochMilliseconds <= this.#clock.nowMs()) {
                throw new NonRetryableException('Inbound message expired before observer delivery');
            }
            await callback.onMessage(message, entry, context);
        }
        if (selected === undefined && wildcard === undefined && this.#observers.size === 0) {
            return 'retry';
        }
    }

    async forwardIncomingMessage(
        input: ALInboundMessageRuntime.ForwardMessageInputDto
    ): Promise<void | 'completed' | 'retry'> {
        const { msg: message, fromPeerId, plan, source } = input;
        const authority = await this.#authority.readCurrentDispatchAuthority(message);
        if (typeof authority === 'string') {
            return authority;
        }
        const expiresAtMs = resolveALMessageExpireAtMs(message, plan.effective);
        if (expiresAtMs !== undefined && expiresAtMs <= this.#clock.nowMs()) {
            throw new NonRetryableException('Inbound message expired before forwarding');
        }
        const audience = authority.roomAudience?.recipientPeerIds;
        const nextHopPeerIds = plan.forwarding.nextHopPeerIds
            .filter((peerId) => peerId !== fromPeerId && (audience === undefined || audience.includes(peerId)));
        if (nextHopPeerIds.length === 0) {
            return;
        }
        console.log(
            `Forwarding WS server message ${message.id.msgId} (${message.payload.typeId}) from ${fromPeerId} to ${
                nextHopPeerIds.join(', ')
            }`
        );
        const encoded = this.#liveDelivery.tryEncodeDirectMessage(message);
        if (!encoded) {
            return;
        }
        let sent = 0;
        for (const peerId of nextHopPeerIds) {
            sent += this.#liveDelivery.sendToResolvedPeer({
                peerId,
                message,
                encoded,
                inboundScope: source.kind === 'ws-client' ? source.authenticatedScope ?? null : undefined
            });
        }
        if (sent === 0) {
            console.warn(
                `No resolved WS server recipients for forwarded message ${message.id.msgId} to ${
                    nextHopPeerIds.join(', ')
                }`
            );
        }
    }
}
