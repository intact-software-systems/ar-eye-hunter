import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { isALControlTypeId, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import {
    isReservedRallarWsTopicId,
    RALLAR_AL_CONTROL_TOPIC_ID,
    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    RALLAR_USER_WS_TOPIC_PREFIXES
} from '@shared/api/rallar-validation.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeStateSyncMessage } from '../../state-sync/state-sync-payload.ts';
import {
    authorizeRallarServerWsIngress,
    decodeRallarServerWsIngress,
    readRallarServerWsRoomId,
    readRallarServerWsRoomRef,
    toRallarServerWsTopicMetadata
} from './decode-rallar-server-ws-ingress.ts';
import { publishRallarServerWsMessage } from './publish-rallar-server-ws-message.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsPayload,
    RallarServerWsProxyRule,
    RallarServerWsPublishResult,
    RallarServerWsRouterOptions,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from './rallar-server-ws-router-contracts.ts';
import { readRallarServerWsStatus, type RallarServerWsStatus } from './rallar-server-ws-status.ts';
import { RallarServerWsTopicRegistry } from './rallar-server-ws-topic-registry.ts';

const ROUTER_CALLBACK_ID = 'rallar-server-ws-router';
const RESERVED_TOPIC_IDS = new Set<string>(Object.values(AppTopics));

export class RallarServerWsRouter {
    private readonly registry = new RallarServerWsTopicRegistry();
    private readonly maxPayloadBytes: number;
    private readonly sendNacks: boolean;
    private readonly allowImplicitUserTopics: boolean;
    private readonly defaultFanout: RallarServerWsFanout;
    private readonly authorizeRoomMessage: RallarServerWsRouterOptions['authorizeRoomMessage'];
    private readonly wakeOutbox: RallarServerWsRouterOptions['wakeOutbox'];
    private readonly service: WsQueueBoxServerService;
    private installed = false;

    constructor(
        service: WsQueueBoxServerService,
        options: RallarServerWsRouterOptions = {}
    ) {
        this.service = service;
        this.maxPayloadBytes = options.maxPayloadBytes ??
            RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES;
        this.sendNacks = options.sendNacks ?? true;
        this.allowImplicitUserTopics = options.allowImplicitUserTopics ?? true;
        this.defaultFanout = options.defaultFanout ?? 'live-only';
        this.authorizeRoomMessage = options.authorizeRoomMessage;
        this.wakeOutbox = options.wakeOutbox;
    }

    install(): this {
        if (this.installed) {
            throw new Error('Rallar server websocket router is already installed.');
        }
        this.service.onAnyInboxMessageDo(ROUTER_CALLBACK_ID, {
            onMessage: async (
                message: ALMessage,
                entry: ResourceEntry,
                webSocketServer: JsonWebSocketServer
            ) => await this.route(message, entry, webSocketServer)
        });
        this.installed = true;
        return this;
    }

    defineTopic<T extends RallarServerWsPayload>(
        definition: RallarServerWsTopicDefinition<T>
    ): this {
        this.registry.define(definition);
        return this;
    }

    removeTopic(selector: RallarServerWsSelector): boolean {
        return this.registry.remove(selector);
    }

    on<T extends RallarServerWsPayload>(
        selector: RallarServerWsSelector,
        handler: RallarServerWsHandler<T>
    ): () => boolean {
        return this.registry.subscribe(selector, handler);
    }

    proxy<T extends RallarServerWsPayload>(rule: RallarServerWsProxyRule<T>): () => boolean {
        return this.registry.addProxy(rule);
    }

    publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult> {
        return this.publishToFanout(message, fanout ?? this.defaultFanout);
    }

    status(): RallarServerWsStatus {
        return readRallarServerWsStatus(this.service);
    }

    async route(
        message: ALMessage,
        _entry?: ResourceEntry,
        _webSocketServer?: JsonWebSocketServer
    ): Promise<void> {
        if (decodeStateSyncMessage(message).kind !== 'unsupported') {
            return;
        }
        if (this.isSystemMessage(message)) {
            return;
        }
        if (isReservedRallarWsTopicId(message.route.topicId)) {
            this.reject(
                message,
                'unauthorized',
                `Rejected reserved Rallar WS topic: ${message.route.topicId}`
            );
            return;
        }

        const definition = this.registry.find(message);
        if (!definition && !this.isImplicitUserTopic(message.route.topicId)) {
            this.reject(message, 'no-route', `Rejected unknown WS topic: ${message.route.topicId}`);
            return;
        }
        if (!message.targets) {
            this.reject(
                message,
                'no-route',
                `Rejected Rallar server WS message without targets: ${message.route.topicId}`
            );
            return;
        }
        if (!this.isPayloadSizeAllowed(message, definition?.maxPayloadBytes ?? this.maxPayloadBytes)) {
            this.reject(
                message,
                'overloaded',
                `Rejected oversized Rallar server WS payload: ${message.route.topicId}`
            );
            return;
        }

        const decoded = decodeRallarServerWsIngress(message);
        if (decoded.kind === 'invalid-json') {
            this.reject(
                message,
                'no-route',
                `Rejected Rallar server WS message with invalid JSON payload: ${message.route.topicId}`
            );
            return;
        }
        const authorization = await authorizeRallarServerWsIngress({
            message,
            definition,
            authorizeRoomMessage: this.authorizeRoomMessage
        });
        if (!authorization.authorized) {
            this.reject(
                message,
                authorization.reason ?? 'unauthorized',
                authorization.logMessage ??
                    `Rejected unauthorised Rallar server WS topic: ${message.route.topicId}`,
                { serverSnapshotVersion: authorization.serverSnapshotVersion }
            );
            return;
        }

        const context = this.toMessageContext(definition, message);
        if (definition?.validate && !await definition.validate(decoded.value, context)) {
            this.reject(
                message,
                'no-route',
                `Rejected schema-invalid Rallar server WS payload: ${message.route.topicId}/${message.payload.typeId}`
            );
            return;
        }
        const serverMessage = toRallarServerWsMessage(decoded.value, message);
        if (definition?.authorize && !await definition.authorize(serverMessage, context)) {
            this.reject(
                message,
                'unauthorized',
                `Rejected policy-unauthorised Rallar server WS topic: ${message.route.topicId}`
            );
            return;
        }

        await this.registry.dispatchHandlers(serverMessage, context);
        const suppressDefaultFanout = await this.registry.dispatchProxyRules({
            message: serverMessage,
            context,
            defaultFanout: this.defaultFanout,
            publish: async (targetMessage, fanout) => await this.publishToFanout(targetMessage, fanout)
        });
        if (!suppressDefaultFanout) {
            await this.publishToFanout(
                message,
                definition?.fanout ?? this.defaultFanout
            );
        }
    }

    private publishToFanout(
        message: ALMessage,
        fanout: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult> {
        return publishRallarServerWsMessage({
            service: this.service,
            message,
            fanout,
            wakeOutbox: this.wakeOutbox
        });
    }

    private toMessageContext(
        definition: RallarServerWsTopicDefinition<JsonWireValue> | undefined,
        message: ALMessage
    ): RallarServerWsMessageContext {
        const fanout = definition?.fanout ?? this.defaultFanout;
        return {
            service: this.service,
            definition: definition
                ? toRallarServerWsTopicMetadata(definition)
                : undefined,
            roomId: readRallarServerWsRoomId(message),
            roomRef: readRallarServerWsRoomRef(message),
            senderId: message.id.senderId,
            proxy: {
                toTargets: async (targetMessage, selectedFanout) =>
                    await this.publishToFanout(targetMessage, selectedFanout ?? fanout),
                toPeer: async (peerId, targetMessage, selectedFanout) =>
                    await this.publishToFanout({
                        ...targetMessage,
                        targets: { mode: 'unicast', toPeerId: peerId }
                    }, selectedFanout ?? fanout),
                toRoom: async (roomId, targetMessage, options) =>
                    await this.publishToFanout({
                        ...targetMessage,
                        route: { ...targetMessage.route, contextId: roomId },
                        targets: {
                            mode: 'broadcast',
                            scope: 'room',
                            exceptPeerIds: options?.exceptPeerIds
                        }
                    }, options?.fanout ?? fanout),
                toAll: async (targetMessage, options) =>
                    await this.publishToFanout({
                        ...targetMessage,
                        targets: {
                            mode: 'broadcast',
                            scope: 'all',
                            exceptPeerIds: options?.exceptPeerIds
                        }
                    }, options?.fanout ?? fanout)
            }
        };
    }

    private isSystemMessage(message: ALMessage): boolean {
        return RESERVED_TOPIC_IDS.has(message.route.topicId) ||
            message.route.topicId === RALLAR_AL_CONTROL_TOPIC_ID ||
            isALControlTypeId(message.payload.typeId);
    }

    private isImplicitUserTopic(topicId: string): boolean {
        return this.allowImplicitUserTopics &&
            RALLAR_USER_WS_TOPIC_PREFIXES.some((prefix) => topicId.startsWith(prefix));
    }

    private isPayloadSizeAllowed(message: ALMessage, maxPayloadBytes: number): boolean {
        return new TextEncoder().encode(message.payload.resource).length <= maxPayloadBytes;
    }

    private reject(
        message: ALMessage,
        reason: ALNackReason,
        logMessage: string,
        nackOptions: Readonly<{ serverSnapshotVersion?: number; }> = {}
    ): void {
        console.warn(logMessage);
        if (!this.sendNacks) {
            return;
        }
        try {
            const nack = newALNackControlMessage(
                this.service.name,
                message.id.senderId,
                message.id.msgId,
                reason,
                undefined,
                nackOptions
            );
            if (this.service.sendToTargets(nack) === 0) {
                console.warn(`Could not send WS NACK to ${message.id.senderId} for ${message.id.msgId}`);
            }
        }
        catch (error) {
            console.warn(
                `Failed to send WS NACK to ${message.id.senderId} for ${message.id.msgId}`,
                error
            );
        }
    }
}

function toRallarServerWsMessage<T extends RallarServerWsPayload>(
    payload: T,
    raw: ALMessage
): RallarServerWsMessage<T> {
    return { payload, raw, receivedAtEpochMs: Date.now() };
}
