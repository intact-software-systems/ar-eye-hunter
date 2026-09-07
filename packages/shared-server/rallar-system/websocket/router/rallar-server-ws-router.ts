import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { isALControlTypeId, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import {
    isReservedRallarWsTopicId,
    RALLAR_AL_CONTROL_TOPIC_ID,
    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    RALLAR_USER_WS_TOPIC_PREFIXES
} from '@shared/api/rallar-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { WsServerInboundAuthorization } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
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
    RallarServerWsRoomAudience,
    RallarServerWsRouterOptions,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from './rallar-server-ws-router-contracts.ts';
import { readRallarServerWsStatus, type RallarServerWsStatus } from './rallar-server-ws-status.ts';
import { RallarServerWsTopicRegistry } from './rallar-server-ws-topic-registry.ts';

const ROUTER_CALLBACK_ID = 'rallar-server-ws-router';
const RESERVED_TOPIC_IDS = new Set<string>(Object.values(AppTopics));

export namespace RallarServerWsRouter {
    export interface Ingress {
        readonly definition: RallarServerWsTopicDefinition<JsonWireValue> | undefined;
        readonly payload: JsonWireValue;
    }

    export interface AuthorizedIngress {
        readonly ingress: Ingress;
        readonly message: RallarServerWsMessage<JsonWireValue>;
        readonly context: RallarServerWsMessageContext;
        readonly audience: RallarServerWsRoomAudience | undefined;
    }

    export interface Rejection {
        readonly reason: ALNackReason;
        readonly code: ALMessageRejection['code'];
        readonly logMessage: string;
        readonly serverSnapshotVersion?: number;
    }

    export interface PublishAudience {
        readonly current: RallarServerWsRoomAudience | undefined;
        readonly admittedPeerIds: readonly string[] | undefined;
    }
}

export class RallarServerWsRouter {
    private readonly registry = new RallarServerWsTopicRegistry();
    private readonly maxPayloadBytes: number;
    private readonly sendNacks: boolean;
    private readonly allowImplicitUserTopics: boolean;
    private readonly defaultFanout: RallarServerWsFanout;
    private readonly authorizeRoomMessage: RallarServerWsRouterOptions['authorizeRoomMessage'];
    private readonly wakeOutbox: RallarServerWsRouterOptions['wakeOutbox'];
    private readonly service: WsQueueBoxServerService;
    private readonly nowEpochMs: () => number;
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
        this.nowEpochMs = options.nowEpochMs ?? Date.now;
    }

    install(): this {
        if (this.installed) {
            throw new Error('Rallar server websocket router is already installed.');
        }
        this.service.authorizeInboundMessagesWith({
            authorize: async (message) => await this.authorizeBeforeAdmission(message)
        });
        this.service.onAnyInboxMessageDo(ROUTER_CALLBACK_ID, {
            onMessage: async (message, _entry, context) => await this.route(message, context.source)
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

    async route(message: ALMessage, source?: ALInboundMessageRuntime.Source): Promise<void> {
        if (this.isMiddlewareOwnedMessage(message)) {
            return;
        }
        const admittedPeerIds = source?.kind === 'ws-client' ? source.roomRecipientPeerIds : undefined;
        const admitted = await this.readAuthorizedIngress(message, admittedPeerIds);
        if (admitted.left) {
            this.reject(message, admitted.left);
            return;
        }
        const { ingress, message: serverMessage, context, audience } = admitted.right!;
        await this.registry.dispatchHandlers(serverMessage, context);
        const suppressDefaultFanout = await this.registry.dispatchProxyRules({
            message: serverMessage,
            context,
            defaultFanout: this.defaultFanout,
            publish: async (targetMessage, fanout) => await this.publishToFanout(targetMessage, fanout)
        });
        if (!suppressDefaultFanout) {
            await this.publishToFanout(message, ingress.definition?.fanout ?? this.defaultFanout, {
                current: audience,
                admittedPeerIds
            });
        }
    }

    private async authorizeBeforeAdmission(message: ALMessage): Promise<WsServerInboundAuthorization> {
        if (this.isMiddlewareOwnedMessage(message)) {
            return { authorized: true };
        }
        const admitted = await this.readAuthorizedIngress(message);
        if (admitted.left) {
            return {
                authorized: false,
                reason: admitted.left.reason,
                rejectionCode: admitted.left.code,
                logMessage: admitted.left.logMessage,
                sendNack: this.sendNacks,
                serverSnapshotVersion: admitted.left.serverSnapshotVersion
            };
        }
        return {
            authorized: true,
            ...(admitted.right!.audience === undefined
                ? {}
                : { roomRecipientPeerIds: admitted.right!.audience.sessions.map((session) => session.sessionId) })
        };
    }

    private async readAuthorizedIngress(
        message: ALMessage,
        roomRecipientPeerIds?: readonly string[]
    ): Promise<Either<RallarServerWsRouter.Rejection, RallarServerWsRouter.AuthorizedIngress>> {
        const decoded = this.decodeIngress(message);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const ingress = decoded.right!;
        const context = this.toMessageContext(ingress.definition, message);
        const authorization = await authorizeRallarServerWsIngress({
            message,
            definition: ingress.definition,
            authorizeRoomMessage: this.authorizeRoomMessage
        });
        if (!authorization.authorized) {
            return Either.ofLeft({
                code: 'unauthorized',
                reason: authorization.reason,
                logMessage: authorization.logMessage,
                serverSnapshotVersion: authorization.serverSnapshotVersion
            });
        }
        const topic = await this.authorizeTopicMessage(message, ingress, context);
        if (topic.left) {
            return Either.ofLeft(topic.left);
        }
        const audience = authorization.audience === undefined || roomRecipientPeerIds === undefined
            ? authorization.audience
            : {
                ...authorization.audience,
                sessions: authorization.audience.sessions.filter((session) =>
                    roomRecipientPeerIds.includes(session.sessionId)
                )
            };
        return Either.ofRight({ ingress, message: topic.right!, context, audience });
    }

    private decodeIngress(message: ALMessage): Either<RallarServerWsRouter.Rejection, RallarServerWsRouter.Ingress> {
        const definition = this.registry.find(message);
        const rejection = this.resolveIngressRejection(message, definition);
        if (rejection) {
            return Either.ofLeft(rejection);
        }
        const decoded = decodeRallarServerWsIngress(message);
        if (decoded.kind === 'invalid-json') {
            return Either.ofLeft({
                code: 'malformed',
                reason: 'no-route',
                logMessage: `Rejected Rallar server WS message with invalid JSON payload: ${message.route.topicId}`
            });
        }
        return Either.ofRight({ definition, payload: decoded.value });
    }

    private resolveIngressRejection(
        message: ALMessage,
        definition: RallarServerWsTopicDefinition<JsonWireValue> | undefined
    ): RallarServerWsRouter.Rejection | undefined {
        if (isReservedRallarWsTopicId(message.route.topicId)) {
            return {
                code: 'unauthorized',
                reason: 'unauthorized',
                logMessage: `Rejected reserved Rallar WS topic: ${message.route.topicId}`
            };
        }
        if (!definition && !this.isImplicitUserTopic(message.route.topicId)) {
            return {
                code: 'unsupported',
                reason: 'no-route',
                logMessage: `Rejected unknown WS topic: ${message.route.topicId}`
            };
        }
        if (!message.targets) {
            return {
                code: 'malformed',
                reason: 'no-route',
                logMessage: `Rejected Rallar server WS message without targets: ${message.route.topicId}`
            };
        }
        if (!this.isPayloadSizeAllowed(message, definition?.maxPayloadBytes ?? this.maxPayloadBytes)) {
            return {
                code: 'oversized',
                reason: 'overloaded',
                logMessage: `Rejected oversized Rallar server WS payload: ${message.route.topicId}`
            };
        }
        return undefined;
    }

    private async authorizeTopicMessage(
        message: ALMessage,
        admitted: RallarServerWsRouter.Ingress,
        context: RallarServerWsMessageContext
    ): Promise<Either<RallarServerWsRouter.Rejection, RallarServerWsMessage<JsonWireValue>>> {
        const definition = admitted.definition;
        if (definition?.validate && !await definition.validate(admitted.payload, context)) {
            return Either.ofLeft({
                code: 'malformed',
                reason: 'no-route',
                logMessage:
                    `Rejected schema-invalid Rallar server WS payload: ${message.route.topicId}/${message.payload.typeId}`
            });
        }
        const serverMessage = toRallarServerWsMessage(admitted.payload, message, this.nowEpochMs());
        if (definition?.authorize && !await definition.authorize(serverMessage, context)) {
            return Either.ofLeft({
                code: 'unauthorized',
                reason: 'unauthorized',
                logMessage: `Rejected policy-unauthorised Rallar server WS topic: ${message.route.topicId}`
            });
        }
        return Either.ofRight(serverMessage);
    }

    private publishToFanout(
        message: ALMessage,
        fanout: RallarServerWsFanout,
        audience?: RallarServerWsRouter.PublishAudience
    ): Promise<RallarServerWsPublishResult> {
        return publishRallarServerWsMessage({
            service: this.service,
            message,
            fanout,
            audience: audience?.current,
            admittedPeerIds: audience?.admittedPeerIds,
            nowEpochMs: this.nowEpochMs(),
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
                toRoom: async (roomRef, targetMessage, options) =>
                    await this.publishToFanout({
                        ...targetMessage,
                        route: { ...targetMessage.route, contextId: roomRef.groupId },
                        targets: {
                            mode: 'broadcast',
                            scope: 'room',
                            groupRef: roomRef,
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

    private isMiddlewareOwnedMessage(message: ALMessage): boolean {
        return decodeStateSyncMessage(message).kind !== 'unsupported' || this.isSystemMessage(message);
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
        rejection: RallarServerWsRouter.Rejection
    ): void {
        console.warn(rejection.logMessage);
        if (!this.sendNacks) {
            return;
        }
        try {
            const observedAtEpochMs = this.nowEpochMs();
            const nack = newALNackControlMessage(
                { v: 2, msgId: crypto.randomUUID(), senderId: this.service.name, ts: observedAtEpochMs },
                {
                    fromPeerId: this.service.name,
                    toPeerId: message.id.senderId,
                    msgId: message.id.msgId,
                    reason: rejection.reason,
                    observedAtEpochMs,
                    ...(rejection.serverSnapshotVersion === undefined
                        ? {}
                        : { serverSnapshotVersion: rejection.serverSnapshotVersion })
                }
            );
            if (this.service.sendToTargets(nack) === 0) {
                console.warn(`Could not send WS NACK to ${message.id.senderId} for ${message.id.msgId}`);
            }
        }
        catch (error) {
            console.warn(
                `Failed to send WS NACK to ${message.id.senderId} for ${message.id.msgId}`,
                toError(error)
            );
        }
    }
}

function toRallarServerWsMessage<T extends RallarServerWsPayload>(
    payload: T,
    raw: ALMessage,
    receivedAtEpochMs: number
): RallarServerWsMessage<T> {
    return { payload, raw, receivedAtEpochMs };
}
