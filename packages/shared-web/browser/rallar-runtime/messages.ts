import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarCrdtMessageTransport } from '@shared-web/browser/rallar-crdt-transport.ts';
import type {
    RallarMessageHandler,
    RallarMessageSendBase,
    RallarMessageSendResult,
    RallarMessageSendStatus,
    RallarMessageTransport,
    RallarRoomMessageChannel,
    RallarRoomMessageChannelDefinition,
    RallarRtcSendInput,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarTypedMessageSendOptions,
    RallarTypedRtcSendOptions,
    RallarTypedWsSendOptions,
    RallarUnsubscribe,
    RallarWsSendInput,
} from '@shared-web/browser/rallar-facade-contract.ts';
import {
    matchesRallarMessageSelector,
    normalizeRallarMessageSelector,
    type RallarMessageSelector,
    type RallarMessageSelectorInput,
    toRallarMessageSelectorKey,
} from '@shared-web/browser/rallar-message-selectors.ts';
import type { CreateRallarMessagesFacadeOptions } from '@shared-web/browser/rallar-messages-facade.ts';
import { toRallarMessage } from '@shared-web/browser/rallar-runtime/message-conversion.ts';
import type { RallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import {
    type ALMessage,
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    newALUnicastMessage,
    toALGroupTargetKey,
} from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    type RallarValidationIssue,
    throwRallarValidation,
    validateRallarGroupRef,
    validateRallarJsonPayload,
    validateRallarNonNegativeInteger,
    validateRallarRouteId,
    validateRallarWsUserTopicId,
} from '@shared/api/rallar-validation.ts';

type RallarMessageSubscription = Readonly<{
    selector: RallarMessageSelector;
    listeners: Set<RallarMessageHandler<unknown>>;
}>;

export type CreateRallarMessagesControllerOptions = Readonly<{
    wsInbox: RallarWsInbox;
    connect(): Promise<ApiMiddleware>;
    readMiddleware(): ApiMiddleware | undefined;
    requireSession(): AuthSession;
    resolveDefaultRoom(): string | GroupRef | undefined;
    resolveCurrentRoomRef(): GroupRef | undefined;
    toRoomId(room: string | GroupRef | undefined): string | undefined;
    resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
    resolveRoomMinSnapshotVersion(
        room: string | GroupRef | undefined,
        explicitMinSnapshotVersion?: number,
    ): number | undefined;
    resolveRoomPeerIds(room: string | GroupRef): readonly string[];
    readMessageMaxPayloadBytes?(): number;
}>;

export type RallarMessagesController = Readonly<{
    operations: CreateRallarMessagesFacadeOptions;
    sendWsUnicast<T>(
        peerId: string,
        payload: T,
        typeId: string,
        route: Readonly<{
            topicId: string;
            contextId: string;
            resourceId?: string;
        }>,
    ): Promise<RallarMessageSendResult>;
    toCrdtMessageTransport(): RallarCrdtMessageTransport;
    attachRtc(ctx?: ApiMiddleware): void;
    detachRtc(ctx?: ApiMiddleware): void;
}>;

export function createRallarMessagesController(
    options: CreateRallarMessagesControllerOptions,
): RallarMessagesController {
    return new BrowserRallarMessagesController(options);
}

class BrowserRallarMessagesController implements RallarMessagesController {
    private readonly rtcMessageListeners = new Map<
        string,
        RallarMessageSubscription
    >();
    private readonly wsMessageListeners = new Map<
        string,
        RallarMessageSubscription
    >();
    private readonly registeredRtcMessageTypes = new Set<string>();
    private stopWsInbox: RallarUnsubscribe | undefined;

    constructor(
        private readonly options: CreateRallarMessagesControllerOptions,
    ) {}

    readonly operations: CreateRallarMessagesFacadeOptions = {
        rtc: {
            send: async <T>(input: RallarRtcSendInput<T>) =>
                await this.sendRtcMessage(input),
            onMessage: <T = unknown>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>,
            ) => this.onRtcMessage(selector, handler),
        },
        ws: {
            send: async <T>(input: RallarWsSendInput<T>) =>
                await this.sendWsMessage(input),
            onMessage: <T = unknown>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>,
            ) => this.onWsMessage(selector, handler),
        },
        channel: <T>(
            definition: RallarTypedMessageChannelDefinition,
        ): RallarTypedMessageChannel<T> => this.createMessageChannel<T>(definition),
        room: <T>(
            definition: RallarRoomMessageChannelDefinition,
        ): RallarRoomMessageChannel<T> =>
            this.createRoomMessageChannel<T>(definition),
    };

    async sendWsUnicast<T>(
        peerId: string,
        payload: T,
        typeId: string,
        route: Readonly<{
            topicId: string;
            contextId: string;
            resourceId?: string;
        }>,
    ): Promise<RallarMessageSendResult> {
        const ctx = await this.options.connect();
        const session = this.options.requireSession();
        const message = newALUnicastMessage(
            session.sessionId,
            newALRoute(
                route.topicId,
                route.contextId,
                route.resourceId ?? crypto.randomUUID(),
            ),
            peerId,
            typeId,
            payload,
        );
        const enqueueResult = await ctx.middleware.webSocketQueueBox
            .enqueueOutboxIfAbsent(message);
        wakeQBoxEngineIfQueued(ctx.middleware.qboxEngine, enqueueResult);
        return toRallarMessageSendResult('ws', message, enqueueResult);
    }

    private assertValidRtcMessageInput<T>(
        input: RallarRtcSendInput<T>,
        roomId: string | undefined,
    ): void {
        const issues: RallarValidationIssue[] = [];
        this.pushBaseMessageValidationIssues(input, 'rtc', issues);
        this.pushOptionalRouteIdIssue(input.roomId, '$.roomId', 'Room ID', issues);
        this.pushOptionalGroupRefIssue(input.roomRef, '$.roomRef', issues);
        this.pushOptionalRouteIdIssue(input.orderingKey, '$.orderingKey', 'Ordering key', issues);
        this.pushOptionalRouteIdIssue(input.overlayId, '$.overlayId', 'Overlay ID', issues);
        input.nextHopPeerIds?.forEach((peerId, index) =>
            this.pushOptionalRouteIdIssue(
                peerId,
                `$.nextHopPeerIds[${index}]`,
                'Peer ID',
                issues,
            )
        );
        this.pushOptionalNonNegativeIntegerIssue(
            input.membershipEpoch,
            '$.membershipEpoch',
            issues,
        );
        this.pushOptionalNonNegativeIntegerIssue(
            input.minSnapshotVersion,
            '$.minSnapshotVersion',
            issues,
        );
        this.pushOptionalNonNegativeIntegerIssue(input.seq, '$.seq', issues);
        this.pushOptionalNonNegativeIntegerIssue(
            input.fanoutLimit,
            '$.fanoutLimit',
            issues,
        );
        if (input.roomId && input.roomRef && input.roomId !== input.roomRef.groupId) {
            issues.push({
                path: '$.roomRef.groupId',
                code: 'room-id-mismatch',
                message: 'roomId must match roomRef.groupId.',
            });
        }
        if (roomId !== undefined) {
            this.pushOptionalRouteIdIssue(roomId, '$.roomId', 'Room ID', issues);
        }
        this.throwIfValidationIssues(issues);
    }

    private assertValidWsMessageInput<T>(
        input: RallarWsSendInput<T>,
        scope: 'room' | 'world' | 'all',
        roomId: string | undefined,
        roomRef: GroupRef | undefined,
    ): void {
        const issues: RallarValidationIssue[] = [];
        this.pushBaseMessageValidationIssues(input, 'ws', issues);
        this.pushOptionalRouteIdIssue(input.roomId, '$.roomId', 'Room ID', issues);
        this.pushOptionalGroupRefIssue(input.roomRef, '$.roomRef', issues);
        input.exceptPeerIds?.forEach((peerId, index) =>
            this.pushOptionalRouteIdIssue(
                peerId,
                `$.exceptPeerIds[${index}]`,
                'Peer ID',
                issues,
            )
        );
        this.pushOptionalNonNegativeIntegerIssue(
            input.minSnapshotVersion,
            '$.minSnapshotVersion',
            issues,
        );
        if (!['room', 'world', 'all'].includes(scope)) {
            issues.push({
                path: '$.scope',
                code: 'invalid-scope',
                message: 'WS scope must be room, world, or all.',
            });
        }
        if (input.roomId && input.roomRef && input.roomId !== input.roomRef.groupId) {
            issues.push({
                path: '$.roomRef.groupId',
                code: 'room-id-mismatch',
                message: 'roomId must match roomRef.groupId.',
            });
        }
        if (scope === 'room') {
            if (!roomId) {
                issues.push({
                    path: '$.roomId',
                    code: 'missing-room',
                    message: 'Room-scoped WS messages require a roomId or roomRef.',
                });
            }
            if (!roomRef) {
                issues.push({
                    path: '$.roomRef',
                    code: 'missing-room-ref',
                    message: 'Room-scoped WS messages require a scoped roomRef.',
                });
            } else {
                this.pushOptionalGroupRefIssue(roomRef, '$.roomRef', issues);
            }
        }
        this.throwIfValidationIssues(issues);
    }

    private pushBaseMessageValidationIssues<T>(
        input: RallarMessageSendBase<T>,
        transport: RallarMessageTransport,
        issues: RallarValidationIssue[],
    ): void {
        if (transport === 'ws') {
            issues.push(
                ...validateRallarWsUserTopicId(
                    input.topicId ?? input.typeId,
                    '$.topicId',
                ).issues,
            );
        } else {
            issues.push(
                ...validateRallarRouteId(
                    input.topicId ?? input.typeId,
                    '$.topicId',
                    'Topic ID',
                ).issues,
            );
        }
        issues.push(
            ...validateRallarRouteId(input.typeId, '$.typeId', 'Type ID').issues,
        );
        this.pushOptionalRouteIdIssue(input.contextId, '$.contextId', 'Context ID', issues);
        this.pushOptionalRouteIdIssue(input.resourceId, '$.resourceId', 'Resource ID', issues);
        this.pushOptionalNonNegativeIntegerIssue(input.ttlHops, '$.ttlHops', issues);
        this.pushOptionalNonNegativeIntegerIssue(input.ttlMs, '$.ttlMs', issues);
        issues.push(
            ...validateRallarJsonPayload(input.payload, {
                path: '$.payload',
                maxBytes: this.resolveMessageMaxPayloadBytes(),
            }).issues,
        );
    }

    private assertValidResolvedRoomRef(roomRef: GroupRef, path: string): void {
        this.throwIfValidationIssues(validateRallarGroupRef(roomRef, path).issues);
    }

    private pushOptionalRouteIdIssue(
        value: string | undefined,
        path: string,
        label: string,
        issues: RallarValidationIssue[],
    ): void {
        if (value === undefined) {
            return;
        }
        issues.push(...validateRallarRouteId(value, path, label).issues);
    }

    private pushOptionalGroupRefIssue(
        value: GroupRef | undefined,
        path: string,
        issues: RallarValidationIssue[],
    ): void {
        if (value === undefined) {
            return;
        }
        issues.push(...validateRallarGroupRef(value, path).issues);
    }

    private pushOptionalNonNegativeIntegerIssue(
        value: number | undefined,
        path: string,
        issues: RallarValidationIssue[],
    ): void {
        if (value === undefined) {
            return;
        }
        issues.push(...validateRallarNonNegativeInteger(value, path).issues);
    }

    private throwMessageValidationIssue(
        path: string,
        code: string,
        message: string,
    ): never {
        throwRallarValidation([{ path, code, message }]);
    }

    private throwIfValidationIssues(
        issues: readonly RallarValidationIssue[],
    ): void {
        if (issues.length > 0) {
            throwRallarValidation(issues);
        }
    }

    private async sendRtcMessage<T>(
        input: RallarRtcSendInput<T>,
    ): Promise<RallarMessageSendResult> {
        const room = input.roomRef ??
            input.roomId ??
            this.resolveDefaultRoom() ??
            this.resolveCurrentRoomRef();
        const roomId = this.toRoomId(room);

        this.assertValidRtcMessageInput(input, roomId);
        const roomRef = this.resolveRoomRef(room);

        if (!roomId) {
            this.throwMessageValidationIssue(
                '$.roomId',
                'missing-room',
                'Cannot send RTC message: no current room.',
            );
        }
        if (!roomRef) {
            this.throwMessageValidationIssue(
                '$.roomRef',
                'missing-room-ref',
                'Cannot send RTC message: no scoped room reference.',
            );
        }
        this.assertValidResolvedRoomRef(roomRef, '$.roomRef');

        const ctx = await this.connect();
        const session = this.requireSession();

        const msg = newALMulticastMessage(
            session.sessionId,
            newALRoute(
                input.topicId ?? input.typeId,
                input.contextId ?? roomId,
                input.resourceId ?? crypto.randomUUID(),
            ),
            roomRef,
            input.typeId,
            input.payload,
            {
                membershipEpoch: input.membershipEpoch,
                minSnapshotVersion: this.resolveRoomMinSnapshotVersion(
                    room,
                    input.minSnapshotVersion,
                ),
                ttlHops: input.ttlHops,
                ttlMs: input.ttlMs,
                seq: input.seq,
                orderingKey: input.orderingKey ??
                    toALGroupTargetKey(roomRef),
                reliability: input.reliability ?? 'at-least-once',
                ack: input.ack ?? 'none',
                ownership: input.ownership ?? 'shared',
                nextHopPeerIds: input.nextHopPeerIds,
                overlayId: input.overlayId ?? toScopedOverlayId(roomRef),
                fanoutLimit: input.fanoutLimit,
            },
        );

        if (this.resolveRoomPeerIds(roomRef).length === 0) {
            return toRallarMessageSendResult(
                'rtc',
                msg,
                {
                    status: 'no-route',
                    message: msg,
                    entries: [],
                    reason: 'No RTC peers are desired for this room.',
                },
            );
        }

        const enqueueResult = await ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent(msg);
        wakeQBoxEngineIfQueued(ctx.middleware.qboxEngine, enqueueResult);

        return toRallarMessageSendResult(
            'rtc',
            msg,
            enqueueResult,
        );
    }

    private onRtcMessage<T = unknown>(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>,
    ): RallarUnsubscribe {
        return this.onTransportMessage(
            'rtc',
            selector,
            handler as RallarMessageHandler<unknown>,
        );
    }

    private async sendWsMessage<T>(
        input: RallarWsSendInput<T>,
    ): Promise<RallarMessageSendResult> {
        const room = input.roomRef ??
            input.roomId ??
            (input.scope === undefined ? this.resolveDefaultRoom() : undefined);
        const roomId = this.toRoomId(room);
        const scope = input.scope ?? (roomId ? 'room' : 'all');
        const roomRef = scope === 'room' ? this.resolveRoomRef(room) : undefined;

        this.assertValidWsMessageInput(input, scope, roomId, roomRef);

        const ctx = await this.connect();
        const session = this.requireSession();
        const contextId = input.contextId ?? roomId ?? input.scope ??
            'all';
        const minSnapshotVersion = room
            ? this.resolveRoomMinSnapshotVersion(
                room,
                input.minSnapshotVersion,
            )
            : input.minSnapshotVersion;
        const msg = newALBroadcastMessage(
            session.sessionId,
            newALRoute(
                input.topicId ?? input.typeId,
                contextId,
                input.resourceId ?? crypto.randomUUID(),
            ),
            scope,
            input.typeId,
            input.payload,
            {
                groupRef: roomRef,
                exceptPeerIds: input.exceptPeerIds,
                minSnapshotVersion,
                ttlHops: input.ttlHops,
                ttlMs: input.ttlMs,
                reliability: input.reliability ?? 'at-least-once',
                ack: input.ack ?? 'none',
                ownership: input.ownership ?? 'shared',
            },
        );

        const enqueueResult = await ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(msg);
        wakeQBoxEngineIfQueued(ctx.middleware.qboxEngine, enqueueResult);

        return toRallarMessageSendResult(
            'ws',
            msg,
            enqueueResult,
        );
    }

    private onWsMessage<T = unknown>(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>,
    ): RallarUnsubscribe {
        return this.onTransportMessage(
            'ws',
            selector,
            handler as RallarMessageHandler<unknown>,
        );
    }

    toCrdtMessageTransport(): RallarCrdtMessageTransport {
        return {
            ws: {
                send: async (input) => {
                    const result = await this.operations.ws.send(input as never);
                    return {
                        transport: 'ws',
                        status: result.status,
                        reason: result.reason,
                    };
                },
                onMessage: (selector, handler) =>
                    this.operations.ws.onMessage(selector, async (message) => {
                        await handler({
                            payload: message.payload as never,
                            topicId: message.topicId,
                            typeId: message.typeId,
                            transport: 'ws',
                        });
                    }),
            },
            rtc: {
                send: async (input) => {
                    const result = await this.operations.rtc.send(input as never);
                    return {
                        transport: 'rtc',
                        status: result.status,
                        reason: result.reason,
                    };
                },
                onMessage: (selector, handler) =>
                    this.operations.rtc.onMessage(selector, async (message) => {
                        await handler({
                            payload: message.payload as never,
                            topicId: message.topicId,
                            typeId: message.typeId,
                            transport: 'rtc',
                        });
                    }),
            },
        };
    }

    private createMessageChannel<T>(
        definition: RallarTypedMessageChannelDefinition,
    ): RallarTypedMessageChannel<T> {
        const selector = normalizeRallarMessageSelector(definition);
        if (!selector.typeId) {
            throw new Error('Typed message channels require a typeId.');
        }
        const channelDefinition = {
            topicId: selector.topicId,
            typeId: selector.typeId,
        };
        this.assertValidTypedMessageChannelDefinition(channelDefinition);


        return {
            send: async (
                payload,
                options: RallarTypedMessageSendOptions<T> = {},
            ) =>
                await this.sendTypedMessageWithStrategy(
                    channelDefinition,
                    payload,
                    options,
                ),
            sendRtc: async (
                payload,
                options: RallarTypedRtcSendOptions<T> = {},
            ) =>
                await this.operations.rtc.send<T>({
                    ...options,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                }),
            sendWs: async (
                payload,
                options: RallarTypedWsSendOptions<T> = {},
            ) =>
                await this.operations.ws.send<T>({
                    ...options,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                }),
            onRtc: (handler) =>
                this.operations.rtc.onMessage<T>(
                    channelDefinition,
                    async (message) => {
                        await handler(message.payload, message);
                    },
                ),
            onWs: (handler) =>
                this.operations.ws.onMessage<T>(
                    channelDefinition,
                    async (message) => {
                        await handler(message.payload, message);
                    },
                ),
        };
    }

    private createRoomMessageChannel<T>(
        definition: RallarRoomMessageChannelDefinition,
    ): RallarRoomMessageChannel<T> {
        this.assertValidRoomMessageChannelDefinition(definition);
        const channel = this.createMessageChannel<T>(definition);
        const roomDefaults = {
            roomId: definition.roomRef ? undefined : definition.roomId,
            roomRef: definition.roomRef,
        };

        return {
            send: async (
                payload,
                options: RallarTypedMessageSendOptions<T> = {},
            ) =>
                await channel.send(payload, {
                    ...roomDefaults,
                    strategy: options.strategy ?? 'rtc-with-ws-fallback',
                    ...options,
                }),
            sendRtc: async (
                payload,
                options: RallarTypedRtcSendOptions<T> = {},
            ) =>
                await channel.sendRtc(payload, {
                    ...roomDefaults,
                    ...options,
                }),
            sendWs: async (
                payload,
                options: RallarTypedWsSendOptions<T> = {},
            ) =>
                await channel.sendWs(payload, {
                    ...roomDefaults,
                    scope: options.scope ?? 'room',
                    ...options,
                }),
            onRtc: (handler) => channel.onRtc(handler),
            onWs: (handler) => channel.onWs(handler),
        };
    }

    private assertValidTypedMessageChannelDefinition(
        definition: RallarTypedMessageChannelDefinition,
    ): void {
        const issues: RallarValidationIssue[] = [];
        this.pushOptionalRouteIdIssue(definition.topicId, '$.topicId', 'Topic ID', issues);
        issues.push(
            ...validateRallarRouteId(definition.typeId, '$.typeId', 'Type ID').issues,
        );
        this.throwIfValidationIssues(issues);
    }

    private assertValidRoomMessageChannelDefinition(
        definition: RallarRoomMessageChannelDefinition,
    ): void {
        const issues: RallarValidationIssue[] = [];
        this.pushOptionalRouteIdIssue(definition.roomId, '$.roomId', 'Room ID', issues);
        this.pushOptionalGroupRefIssue(definition.roomRef, '$.roomRef', issues);
        if (
            definition.roomId &&
            definition.roomRef &&
            definition.roomId !== definition.roomRef.groupId
        ) {
            issues.push({
                path: '$.roomRef.groupId',
                code: 'room-id-mismatch',
                message: 'roomId must match roomRef.groupId.',
            });
        }
        this.throwIfValidationIssues(issues);
    }

    private async sendTypedMessageWithStrategy<T>(
        channelDefinition: RallarTypedMessageChannelDefinition,
        payload: T,
        options: RallarTypedMessageSendOptions<T>,
    ): Promise<RallarMessageSendResult> {
        const { strategy = 'rtc-with-ws-fallback', ...sendOptions } = options;
        const rtcOptions = sendOptions as RallarTypedRtcSendOptions<T>;
        const wsOptions = sendOptions as RallarTypedWsSendOptions<T>;

        switch (strategy) {
            case 'ws':
                return await this.operations.ws.send<T>({
                    ...wsOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
            case 'rtc':
            case 'realtime':
                return await this.operations.rtc.send<T>({
                    ...rtcOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
            case 'ws-then-rtc': {
                const wsResult = await this.operations.ws.send<T>({
                    ...wsOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
                if (isSuccessfulRallarMessageSendStatus(wsResult.status)) {
                    return wsResult;
                }

                return await this.operations.rtc.send<T>({
                    ...rtcOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
            }
            case 'rtc-with-ws-fallback':
            default: {
                const rtcResult = await this.operations.rtc.send<T>({
                    ...rtcOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
                if (isSuccessfulRallarMessageSendStatus(rtcResult.status)) {
                    return rtcResult;
                }

                return await this.operations.ws.send<T>({
                    ...wsOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
            }
        }
    }

    attachRtc(ctx = this.readMiddleware()): void {
        if (!ctx) {
            return;
        }
        for (const subscription of this.rtcMessageListeners.values()) {
            this.registerRtcMessageCallback(subscription.selector, ctx);
        }
    }

    detachRtc(ctx = this.readMiddleware()): void {
        if (ctx) {
            for (const typeId of this.registeredRtcMessageTypes) {
                ctx.middleware.rtcRxStreamer.removeInboxMessageCallback(typeId);
            }
        }
        this.registeredRtcMessageTypes.clear();
    }

    private onTransportMessage(
        transport: RallarMessageTransport,
        selectorInput: RallarMessageSelectorInput,
        handler: RallarMessageHandler<unknown>,
    ): RallarUnsubscribe {
        const selector = normalizeRallarMessageSelector(selectorInput);
        if (transport === 'rtc' && !selector.typeId) {
            throw new Error('RTC message subscriptions require a typeId.');
        }

        const subscription = this.messageSubscription(transport, selector);
        subscription.listeners.add(handler);
        if (transport === 'rtc') {
            this.registerRtcMessageCallback(selector);
        } else {
            this.ensureWsInbox();
        }

        return () => {
            subscription.listeners.delete(handler);
            if (subscription.listeners.size > 0) {
                return;
            }

            const registry = transport === 'rtc'
                ? this.rtcMessageListeners
                : this.wsMessageListeners;
            registry.delete(toRallarMessageSelectorKey(selector));

            if (transport === 'rtc' && selector.typeId) {
                if (!this.hasRtcSubscriptionsForTypeId(selector.typeId)) {
                    this.unregisterRtcMessageCallback(selector.typeId);
                }
                return;
            }

            if (transport === 'ws' && this.wsMessageListeners.size === 0) {
                this.stopWsInbox?.();
                this.stopWsInbox = undefined;
            }
        };
    }

    private messageSubscription(
        transport: RallarMessageTransport,
        selector: RallarMessageSelector,
    ): RallarMessageSubscription {
        const registry = transport === 'rtc'
            ? this.rtcMessageListeners
            : this.wsMessageListeners;
        const key = toRallarMessageSelectorKey(selector);
        const existing = registry.get(key);
        if (existing) {
            return existing;
        }
        const created: RallarMessageSubscription = {
            selector,
            listeners: new Set<RallarMessageHandler<unknown>>(),
        };
        registry.set(key, created);
        return created;
    }

    private ensureWsInbox(): void {
        if (this.stopWsInbox || this.wsMessageListeners.size === 0) {
            return;
        }
        this.stopWsInbox = this.options.wsInbox.subscribe({
            id: 'messages',
            order: 20,
            onMessage: async (message) => {
                await this.dispatchTransportMessage('ws', message);
            },
        });
    }

    private registerRtcMessageCallback(
        selector: RallarMessageSelector,
        ctx = this.readMiddleware(),
    ): void {
        const typeId = selector.typeId;
        if (!ctx || !typeId || this.registeredRtcMessageTypes.has(typeId)) {
            return;
        }
        ctx.middleware.rtcRxStreamer.onInboxMessageDo(typeId, {
            onMessage: async (message: ALMessage) => {
                await this.dispatchTransportMessage('rtc', message);
            },
        });
        this.registeredRtcMessageTypes.add(typeId);
    }

    private unregisterRtcMessageCallback(typeId: string): void {
        const ctx = this.readMiddleware();
        ctx?.middleware.rtcRxStreamer.removeInboxMessageCallback(typeId);
        this.registeredRtcMessageTypes.delete(typeId);
    }

    private hasRtcSubscriptionsForTypeId(typeId: string): boolean {
        for (const subscription of this.rtcMessageListeners.values()) {
            if (subscription.selector.typeId === typeId) {
                return true;
            }
        }
        return false;
    }

    private async dispatchTransportMessage(
        transport: RallarMessageTransport,
        message: ALMessage,
    ): Promise<void> {
        const registry = transport === 'rtc'
            ? this.rtcMessageListeners
            : this.wsMessageListeners;
        const listeners = new Set<RallarMessageHandler<unknown>>();
        for (const subscription of registry.values()) {
            if (!matchesRallarMessageSelector(subscription.selector, message)) {
                continue;
            }
            for (const listener of subscription.listeners) {
                listeners.add(listener);
            }
        }
        if (listeners.size === 0) {
            return;
        }

        const rallarMessage = toRallarMessage(transport, message);
        await Promise.all(
            [...listeners].map(async (listener) => {
                try {
                    await listener(rallarMessage);
                } catch (error) {
                    console.error('Error notifying Rallar message listener', error);
                }
            }),
        );
    }

    private resolveMessageMaxPayloadBytes(): number {
        return this.options.readMessageMaxPayloadBytes?.() ??
            RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES;
    }

    private connect(): Promise<ApiMiddleware> {
        return this.options.connect();
    }

    private readMiddleware(): ApiMiddleware | undefined {
        return this.options.readMiddleware();
    }

    private requireSession(): AuthSession {
        return this.options.requireSession();
    }

    private resolveDefaultRoom(): string | GroupRef | undefined {
        return this.options.resolveDefaultRoom();
    }

    private resolveCurrentRoomRef(): GroupRef | undefined {
        return this.options.resolveCurrentRoomRef();
    }

    private toRoomId(room: string | GroupRef | undefined): string | undefined {
        return this.options.toRoomId(room);
    }

    private resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined {
        return this.options.resolveRoomRef(room);
    }

    private resolveRoomMinSnapshotVersion(
        room: string | GroupRef | undefined,
        explicitMinSnapshotVersion?: number,
    ): number | undefined {
        return this.options.resolveRoomMinSnapshotVersion(
            room,
            explicitMinSnapshotVersion,
        );
    }

    private resolveRoomPeerIds(room: string | GroupRef): readonly string[] {
        return this.options.resolveRoomPeerIds(room);
    }
}

function toRallarMessageSendResult(
    transport: RallarMessageTransport,
    message: ALMessage,
    result: ALOutboundEnqueueResult,
): RallarMessageSendResult {
    return {
        transport,
        status: result.status,
        message,
        entry: result.entry,
        entries: result.entries,
        reason: result.reason,
    };
}

function isSuccessfulRallarMessageSendStatus(
    status: RallarMessageSendStatus,
): boolean {
    return status === 'enqueued' ||
        status === 'sent-immediate' ||
        status === 'duplicate' ||
        status === 'superseded' ||
        status === 'skipped';
}

function wakeQBoxEngineIfQueued(
    engine: Readonly<{ wake(): void }>,
    result: ALOutboundEnqueueResult,
): void {
    if (result.status === 'enqueued' || result.status === 'duplicate') {
        engine.wake();
    }
}
