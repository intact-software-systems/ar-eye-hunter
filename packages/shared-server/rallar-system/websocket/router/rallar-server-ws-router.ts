import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { resolveALAdmittedRoomAudience } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { isALUnicastAddressedTo } from '@shared/al-contracts/is-al-unicast-addressed-to.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import {
    isReservedRallarWsTopicId,
    RALLAR_AL_CONTROL_TOPIC_ID,
    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    RALLAR_USER_WS_TOPIC_PREFIXES
} from '@shared/api/rallar-validation.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { WsServerInboundAuthorization } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { LiveWsInboundReference } from '../../queue-pubsub/live-ws-notice.ts';
import { decodeStateSyncMessage } from '../../state-sync/state-sync-payload.ts';
import {
    authorizeRallarServerWsIngress,
    computeAdmittedRallarServerWsMessage,
    computeRallarServerWsRetainedAudience,
    decodeRallarServerWsIngress,
    readRallarServerWsRoomId,
    readRallarServerWsRoomRef,
    toRallarServerWsMessage,
    toRallarServerWsTopicMetadata
} from './decode-rallar-server-ws-ingress.ts';
import {
    assertRallarServerWsPublishInput,
    publishRallarServerWsMessage
} from './publish-rallar-server-ws-message.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsPayload,
    RallarServerWsProxyRule,
    RallarServerWsPublishInputDto,
    RallarServerWsPublishResult,
    RallarServerWsRoomAudience,
    RallarServerWsRouterOptions,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from './rallar-server-ws-router-contracts.ts';
import { readRallarServerWsStatus, type RallarServerWsStatus } from './rallar-server-ws-status.ts';
import { RallarServerWsTopicRegistry } from './rallar-server-ws-topic-registry.ts';
import { readRallarServerWsPublishAudience } from './read-rallar-server-ws-publish-audience.ts';

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

    export interface PublishToFanoutInputDto {
        readonly message: ALMessage;
        readonly fanout: RallarServerWsFanout;
        readonly audience?: PublishAudience;
        readonly inboundScope?: StateScope | null;
        readonly origin?: 'server' | 'proxy' | 'admitted';
        readonly inbound?: LiveWsInboundReference;
    }
}

export class RallarServerWsRouter {
    private readonly registry = new RallarServerWsTopicRegistry();
    private readonly maxPayloadBytes: number;
    private readonly sendNacks: boolean;
    private readonly allowImplicitUserTopics: boolean;
    private readonly defaultFanout: RallarServerWsFanout;
    private readonly authorizeRoomMessage: RallarServerWsRouterOptions['authorizeRoomMessage'];
    private readonly readServerPublishAudience: RallarServerWsRouterOptions['readServerPublishAudience'];
    private readonly wakeOutbox: RallarServerWsRouterOptions['wakeOutbox'];
    private readonly livePublication: RallarServerWsRouterOptions['livePublication'];
    private readonly service: WsQueueBoxServerService;
    private readonly nowEpochMs: () => number;
    /** The peer id the WS server answers as: the id clients address it by and its own publishes carry (D57, D58). */
    readonly serverPeerId: string;
    private installed = false;

    constructor(
        service: WsQueueBoxServerService,
        options: RallarServerWsRouterOptions = {}
    ) {
        this.service = service;
        this.serverPeerId = service.name;
        this.maxPayloadBytes = options.maxPayloadBytes ??
            RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES;
        this.sendNacks = options.sendNacks ?? true;
        this.allowImplicitUserTopics = options.allowImplicitUserTopics ?? true;
        this.defaultFanout = options.defaultFanout ?? 'live-only';
        this.authorizeRoomMessage = options.authorizeRoomMessage;
        this.readServerPublishAudience = options.readServerPublishAudience;
        this.wakeOutbox = options.wakeOutbox;
        this.livePublication = options.livePublication;
        this.nowEpochMs = options.nowEpochMs ?? Date.now;
    }

    install(): this {
        if (this.installed) {
            throw new Error('Rallar server websocket router is already installed.');
        }
        this.service.authorizeInboundMessagesWith({
            sendNacks: this.sendNacks,
            authorize: async (message) => await this.authorizeBeforeAdmission(message)
        });
        this.service.onAnyInboxMessageDo(ROUTER_CALLBACK_ID, {
            onMessage: async (message, entry, context) =>
                await this.route(
                    computeAdmittedRallarServerWsMessage(message, entry.audit.expiryTs.epochMilliseconds),
                    context.source
                )
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

    async publish(input: RallarServerWsPublishInputDto): Promise<RallarServerWsPublishResult> {
        assertRallarServerWsPublishInput(input);
        const selected = input.fanout ?? this.defaultFanout;
        const frozen = await readRallarServerWsPublishAudience({
            message: input.message,
            fanout: selected,
            serverPeerId: this.serverPeerId,
            readRoomAudience: this.readServerPublishAudience
        });
        return await this.publishToFanout({
            message: input.message,
            fanout: selected,
            audience: frozen,
            inboundScope: input.scope
        });
    }

    status(): RallarServerWsStatus {
        return readRallarServerWsStatus(this.service);
    }

    async route(message: ALMessage, source?: ALInboundMessageRuntime.Source): Promise<void> {
        if (this.isMiddlewareOwnedMessage(message)) {
            return;
        }
        const admittedPeerIds = source?.kind === 'ws-client' ? source.groupRecipientPeerIds : undefined;
        const inboundScope = source?.kind === 'ws-client' ? source.authenticatedScope ?? null : undefined;
        const admitted = await this.readAuthorizedIngress(message, admittedPeerIds, inboundScope);
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
            publish: async (targetMessage, fanout) =>
                await this.publishToFanout({ message: targetMessage, fanout, inboundScope, origin: 'proxy' })
        });
        // A unicast addressed to the server ends at its handlers: the server is its recipient (D57 as applied).
        if (!suppressDefaultFanout && !isALUnicastAddressedTo(message, this.serverPeerId)) {
            await this.publishToFanout({
                message,
                fanout: ingress.definition?.fanout ?? this.defaultFanout,
                audience: { current: audience, admittedPeerIds },
                inboundScope,
                origin: 'admitted',
                inbound: source?.kind === 'ws-client'
                    ? {
                        namespace: this.service.getInboundNamespace(),
                        reference: { senderId: message.id.senderId, msgId: message.id.msgId }
                    }
                    : undefined
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
        const audience = admitted.right!.audience;
        return audience === undefined ? { authorized: true } : {
            authorized: true,
            roomAudience: {
                recipientPeerIds: resolveALAdmittedRoomAudience(
                    message,
                    audience.sessions.map((session) => session.sessionId)
                ),
                snapshotVersion: audience.snapshotVersion
            }
        };
    }

    private async readAuthorizedIngress(
        message: ALMessage,
        groupRecipientPeerIds?: readonly string[],
        inboundScope?: StateScope | null
    ): Promise<Either<RallarServerWsRouter.Rejection, RallarServerWsRouter.AuthorizedIngress>> {
        const decoded = this.decodeIngress(message);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const ingress = decoded.right!;
        const context = this.toMessageContext(ingress.definition, message, inboundScope);
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
        const audience = computeRallarServerWsRetainedAudience(authorization.audience, groupRecipientPeerIds);
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

    private async publishToFanout(
        input: RallarServerWsRouter.PublishToFanoutInputDto
    ): Promise<RallarServerWsPublishResult> {
        const { message, fanout, audience, inboundScope } = input;
        return await publishRallarServerWsMessage({
            service: this.service,
            message,
            fanout,
            audience: audience?.current,
            admittedPeerIds: audience?.admittedPeerIds,
            inboundScope,
            nowEpochMs: this.nowEpochMs(),
            wakeOutbox: this.wakeOutbox,
            livePublication: this.livePublication,
            inbound: input.inbound,
            origin: input.origin,
            authorizeRoomMessage: this.authorizeRoomMessage
        });
    }

    private toMessageContext(
        definition: RallarServerWsTopicDefinition<JsonWireValue> | undefined,
        message: ALMessage,
        inboundScope?: StateScope | null
    ): RallarServerWsMessageContext {
        return {
            service: this.service,
            definition: definition
                ? toRallarServerWsTopicMetadata(definition)
                : undefined,
            roomId: readRallarServerWsRoomId(message),
            roomRef: readRallarServerWsRoomRef(message),
            senderId: message.id.senderId,
            authenticatedScope: inboundScope ?? undefined,
            proxy: this.toMessageProxy(definition?.fanout ?? this.defaultFanout, inboundScope)
        };
    }

    private toMessageProxy(
        fanout: RallarServerWsFanout,
        inboundScope: StateScope | null | undefined
    ): RallarServerWsMessageContext['proxy'] {
        return {
            toTargets: async (targetMessage, selectedFanout) =>
                await this.publishToFanout({
                    message: targetMessage,
                    fanout: selectedFanout ?? fanout,
                    inboundScope,
                    origin: 'proxy'
                }),
            toPeer: async (input) =>
                await this.publishToFanout({
                    message: {
                        ...input.message,
                        targets: { mode: 'unicast', toPeerId: input.peerId }
                    },
                    fanout: input.fanout ?? fanout,
                    inboundScope: input.scope,
                    origin: 'proxy'
                }),
            toRoom: async (roomRef, targetMessage, options) =>
                await this.publishToFanout({
                    message: {
                        ...targetMessage,
                        route: { ...targetMessage.route, contextId: roomRef.groupId },
                        targets: {
                            mode: 'broadcast',
                            scope: 'room',
                            groupRef: roomRef,
                            exceptPeerIds: options?.exceptPeerIds
                        }
                    },
                    fanout: options?.fanout ?? fanout,
                    inboundScope,
                    origin: 'proxy'
                }),
            toAll: async (targetMessage, options) =>
                await this.publishToFanout({
                    message: {
                        ...targetMessage,
                        targets: {
                            mode: 'broadcast',
                            scope: 'all',
                            exceptPeerIds: options?.exceptPeerIds
                        }
                    },
                    fanout: options?.fanout ?? fanout,
                    inboundScope,
                    origin: 'proxy'
                })
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
