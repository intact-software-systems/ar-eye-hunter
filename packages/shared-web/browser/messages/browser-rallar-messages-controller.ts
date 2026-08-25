import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserRallarMessageSubscriptions } from '@shared-web/browser/messages/browser-rallar-message-subscriptions.ts';
import type { RallarCrdtMessageTransport } from '@shared-web/browser/rallar-crdt-transport.ts';
import type {
    RallarMessageHandler,
    RallarMessageSendBase,
    RallarMessageSendResult,
    RallarMessageTransport,
    RallarRoomMessageChannelDefinition,
    RallarRtcSendInput,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarTypedMessageSendOptions,
    RallarTypedRtcSendOptions,
    RallarTypedWsSendOptions,
    RallarWsSendInput
} from '@shared-web/browser/rallar-message-contracts.ts';
import {
    normalizeRallarMessageSelector,
    type RallarMessageSelectorInput
} from '@shared-web/browser/rallar-message-selectors.ts';
import type { RallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    newALUnicastMessage,
    toALGroupTargetKey,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult, ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES, throwRallarValidation } from '@shared/api/rallar-validation.ts';

interface ResolvedRtcMessageTarget {
    readonly room: string | GroupRef | undefined;
    readonly roomId: string;
    readonly roomRef: GroupRef;
}

interface RallarRtcMessageLane {
    send<T>(input: RallarRtcSendInput<T>): Promise<RallarMessageSendResult>;
    onMessage<T = never>(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>
    ): RallarUnsubscribe;
}

interface RallarWsMessageLane {
    send<T>(input: RallarWsSendInput<T>): Promise<RallarMessageSendResult>;
    onMessage<T = never>(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>
    ): RallarUnsubscribe;
}

export interface BrowserRallarMessagesControllerInput {
    readonly wsInbox: RallarWsInbox;
    connect(): Promise<ApiMiddleware>;
    readMiddleware(): ApiMiddleware | undefined;
    requireSession(): AuthSession;
    resolveDefaultRoom(): string | GroupRef | undefined;
    resolveCurrentRoomRef(): GroupRef | undefined;
    toRoomId(room: string | GroupRef | undefined): string | undefined;
    resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
    resolveRoomMinSnapshotVersion(
        room: string | GroupRef | undefined,
        explicitMinSnapshotVersion?: number
    ): number | undefined;
    resolveRoomPeerIds(room: string | GroupRef): readonly string[];
    readMessageMaxPayloadBytes?(): number;
}

export interface RallarWsUnicastSendInput<T> {
    readonly peerId: string;
    readonly payload: T;
    readonly typeId: string;
    readonly route: RallarWsUnicastRoute;
}

export interface RallarWsUnicastRoute {
    topicId: string;
    contextId: string;
    resourceId?: string;
}

interface WakeableQueueBoxEngine {
    wake(): void;
}

export interface RallarMessagesOperations {
    readonly rtc: RallarRtcMessageLane;
    readonly ws: RallarWsMessageLane;
    channel<T>(
        definition: RallarTypedMessageChannelDefinition
    ): RallarTypedMessageChannel<T>;
    room<T>(
        definition: RallarRoomMessageChannelDefinition
    ): RallarTypedMessageChannel<T>;
}

export interface RallarMessagesController {
    readonly operations: RallarMessagesOperations;
    sendWsUnicast<T>(input: RallarWsUnicastSendInput<T>): Promise<RallarMessageSendResult>;
    toCrdtMessageTransport(): RallarCrdtMessageTransport;
    attachRtc(ctx?: ApiMiddleware): void;
    detachRtc(ctx?: ApiMiddleware): void;
}

export class BrowserRallarMessagesController implements RallarMessagesController {
    private readonly inputValidator: BrowserMessageInputValidator;
    private readonly subscriptions: BrowserRallarMessageSubscriptions;

    private readonly options: BrowserRallarMessagesControllerInput;

    public constructor(options: BrowserRallarMessagesControllerInput) {
        this.options = options;
        this.subscriptions = new BrowserRallarMessageSubscriptions({
            wsInbox: options.wsInbox,
            readMiddleware: () => options.readMiddleware()
        });
        this.inputValidator = new BrowserMessageInputValidator({
            readMaxPayloadBytes: () => this.resolveMessageMaxPayloadBytes()
        });
    }

    readonly operations: RallarMessagesController['operations'] = {
        rtc: {
            send: async <T>(input: RallarRtcSendInput<T>) => await this.sendRtcMessage(input),
            onMessage: <T>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>
            ) => this.subscriptions.subscribe('rtc', selector, handler)
        },
        ws: {
            send: async <T>(input: RallarWsSendInput<T>) => await this.sendWsMessage(input),
            onMessage: <T>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>
            ) => this.subscriptions.subscribe('ws', selector, handler)
        },
        channel: <T>(
            definition: RallarTypedMessageChannelDefinition
        ): RallarTypedMessageChannel<T> => this.createMessageChannel<T>(definition),
        room: <T>(
            definition: RallarRoomMessageChannelDefinition
        ): RallarTypedMessageChannel<T> => this.createRoomMessageChannel<T>(definition)
    };

    async sendWsUnicast<T>(input: RallarWsUnicastSendInput<T>): Promise<RallarMessageSendResult> {
        const ctx = await this.options.connect();
        const session = this.options.requireSession();
        const message = newALUnicastMessage(
            session.sessionId,
            newALRoute(
                input.route.topicId,
                input.route.contextId,
                input.route.resourceId ?? crypto.randomUUID()
            ),
            input.peerId,
            input.typeId,
            input.payload
        );
        const enqueueResult = await ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(message);
        wakeQBoxEngineIfQueued(ctx.middleware.qboxEngine, enqueueResult);
        return toRallarMessageSendResult('ws', message, enqueueResult);
    }

    private async sendRtcMessage<T>(
        input: RallarRtcSendInput<T>
    ): Promise<RallarMessageSendResult> {
        const target = this.resolveRtcMessageTarget(input);
        const context = await this.options.connect();
        const message = this.toRtcMessage(input, target, this.options.requireSession());
        if (this.options.resolveRoomPeerIds(target.roomRef).length === 0) {
            return toRallarMessageSendResult('rtc', message, {
                status: 'no-route',
                message,
                entries: [],
                reason: 'No RTC peers are desired for this room.'
            });
        }
        const enqueueResult = await context.middleware.rtcRxStreamer
            .enqueueOutboxIfAbsent(message);
        wakeQBoxEngineIfQueued(context.middleware.qboxEngine, enqueueResult);
        return toRallarMessageSendResult('rtc', message, enqueueResult);
    }

    private resolveRtcMessageTarget<T>(
        input: RallarRtcSendInput<T>
    ): ResolvedRtcMessageTarget {
        const room = input.roomRef ??
            input.roomId ??
            this.options.resolveDefaultRoom() ??
            this.options.resolveCurrentRoomRef();
        const roomId = this.options.toRoomId(room);

        this.inputValidator.assertRtc(input, roomId);
        const roomRef = this.options.resolveRoomRef(room);

        if (!roomId) {
            throwMessageValidationIssue(
                '$.roomId',
                'missing-room',
                'Cannot send RTC message: no current room.'
            );
        }
        if (!roomRef) {
            throwMessageValidationIssue(
                '$.roomRef',
                'missing-room-ref',
                'Cannot send RTC message: no scoped room reference.'
            );
        }
        this.inputValidator.assertResolvedRoomRef(roomRef, '$.roomRef');
        return { room, roomId, roomRef };
    }

    private toRtcMessage<T>(
        input: RallarRtcSendInput<T>,
        target: ResolvedRtcMessageTarget,
        session: AuthSession
    ): ALMessage {
        return newALMulticastMessage(
            session.sessionId,
            newALRoute(
                input.topicId ?? input.typeId,
                input.contextId ?? target.roomId,
                input.resourceId ?? crypto.randomUUID()
            ),
            target.roomRef,
            input.typeId,
            input.payload,
            {
                membershipEpoch: input.membershipEpoch,
                minSnapshotVersion: this.options.resolveRoomMinSnapshotVersion(
                    target.room,
                    input.minSnapshotVersion
                ),
                ttlHops: input.ttlHops,
                ttlMs: input.ttlMs,
                seq: input.seq,
                orderingKey: input.orderingKey ?? toALGroupTargetKey(target.roomRef),
                reliability: input.reliability ?? 'at-least-once',
                ack: input.ack ?? 'none',
                ownership: input.ownership ?? 'shared',
                nextHopPeerIds: input.nextHopPeerIds,
                overlayId: input.overlayId ?? toScopedOverlayId(target.roomRef),
                fanoutLimit: input.fanoutLimit
            }
        );
    }

    private async sendWsMessage<T>(
        input: RallarWsSendInput<T>
    ): Promise<RallarMessageSendResult> {
        const room = input.roomRef ??
            input.roomId ??
            (input.scope === undefined ? this.options.resolveDefaultRoom() : undefined);
        const roomId = this.options.toRoomId(room);
        const scope = input.scope ?? (roomId ? 'room' : 'all');
        const roomRef = scope === 'room' ? this.options.resolveRoomRef(room) : undefined;

        this.inputValidator.assertWs({ input, scope, roomId, roomRef });

        const ctx = await this.options.connect();
        const session = this.options.requireSession();
        const contextId = input.contextId ?? roomId ?? input.scope ?? 'all';
        const minSnapshotVersion = room
            ? this.options.resolveRoomMinSnapshotVersion(room, input.minSnapshotVersion)
            : input.minSnapshotVersion;
        const msg = newALBroadcastMessage(
            session.sessionId,
            newALRoute(
                input.topicId ?? input.typeId,
                contextId,
                input.resourceId ?? crypto.randomUUID()
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
                ownership: input.ownership ?? 'shared'
            }
        );

        const enqueueResult = await ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(msg);
        wakeQBoxEngineIfQueued(ctx.middleware.qboxEngine, enqueueResult);

        return toRallarMessageSendResult('ws', msg, enqueueResult);
    }

    toCrdtMessageTransport(): RallarCrdtMessageTransport {
        return {
            ws: {
                send: async (input) => {
                    const result = await this.operations.ws.send(input as never);
                    return {
                        transport: 'ws',
                        status: result.status,
                        reason: result.reason
                    };
                },
                onMessage: (selector, handler) =>
                    this.operations.ws.onMessage(selector, async (message) => {
                        await handler({
                            payload: message.payload as never,
                            topicId: message.topicId,
                            typeId: message.typeId,
                            transport: 'ws'
                        });
                    })
            },
            rtc: {
                send: async (input) => {
                    const result = await this.operations.rtc.send(input as never);
                    return {
                        transport: 'rtc',
                        status: result.status,
                        reason: result.reason
                    };
                },
                onMessage: (selector, handler) =>
                    this.operations.rtc.onMessage(selector, async (message) => {
                        await handler({
                            payload: message.payload as never,
                            topicId: message.topicId,
                            typeId: message.typeId,
                            transport: 'rtc'
                        });
                    })
            }
        };
    }

    private createMessageChannel<T>(
        definition: RallarTypedMessageChannelDefinition
    ): RallarTypedMessageChannel<T> {
        const selector = normalizeRallarMessageSelector(definition);
        if (!selector.typeId) {
            throw new Error('Typed message channels require a typeId.');
        }
        const channelDefinition = {
            topicId: selector.topicId,
            typeId: selector.typeId
        };
        this.inputValidator.assertTypedChannel(
            channelDefinition.topicId,
            channelDefinition.typeId
        );

        return {
            send: async (payload, options: RallarTypedMessageSendOptions<T> = {}) =>
                await this.sendTypedMessageWithStrategy(
                    channelDefinition,
                    payload,
                    options
                ),
            sendRtc: async (payload, options: RallarTypedRtcSendOptions<T> = {}) =>
                await this.operations.rtc.send<T>({
                    ...options,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload
                }),
            sendWs: async (payload, options: RallarTypedWsSendOptions<T> = {}) =>
                await this.operations.ws.send<T>({
                    ...options,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload
                }),
            onRtc: (handler) =>
                this.operations.rtc.onMessage<T>(channelDefinition, async (message) => {
                    await handler(message.payload, message);
                }),
            onWs: (handler) =>
                this.operations.ws.onMessage<T>(channelDefinition, async (message) => {
                    await handler(message.payload, message);
                })
        };
    }

    private createRoomMessageChannel<T>(
        definition: RallarRoomMessageChannelDefinition
    ): RallarTypedMessageChannel<T> {
        this.inputValidator.assertRoomChannel(definition);
        const channel = this.createMessageChannel<T>(definition);
        const roomDefaults = {
            roomId: definition.roomRef ? undefined : definition.roomId,
            roomRef: definition.roomRef
        };

        return {
            send: async (payload, options: RallarTypedMessageSendOptions<T> = {}) =>
                await channel.send(payload, {
                    ...roomDefaults,
                    strategy: options.strategy ?? 'rtc-with-ws-fallback',
                    ...options
                }),
            sendRtc: async (payload, options: RallarTypedRtcSendOptions<T> = {}) =>
                await channel.sendRtc(payload, {
                    ...roomDefaults,
                    ...options
                }),
            sendWs: async (payload, options: RallarTypedWsSendOptions<T> = {}) =>
                await channel.sendWs(payload, {
                    ...roomDefaults,
                    scope: options.scope ?? 'room',
                    ...options
                }),
            onRtc: (handler) => channel.onRtc(handler),
            onWs: (handler) => channel.onWs(handler)
        };
    }

    private async sendTypedMessageWithStrategy<T>(
        channelDefinition: RallarTypedMessageChannelDefinition,
        payload: T,
        options: RallarTypedMessageSendOptions<T>
    ): Promise<RallarMessageSendResult> {
        const { strategy = 'rtc-with-ws-fallback', ...sendOptions } = options;
        const rtcOptions = sendOptions as RallarTypedRtcSendOptions<T>;
        const wsOptions = sendOptions as RallarTypedWsSendOptions<T>;

        switch (strategy) {
            case 'ws':
                return await this.sendTypedWs(channelDefinition, payload, wsOptions);
            case 'rtc':
            case 'realtime':
                return await this.sendTypedRtc(channelDefinition, payload, rtcOptions);
            case 'ws-then-rtc': {
                const wsResult = await this.sendTypedWs(
                    channelDefinition,
                    payload,
                    wsOptions
                );
                if (isSuccessfulRallarMessageSendStatus(wsResult.status)) {
                    return wsResult;
                }
                return await this.sendTypedRtc(channelDefinition, payload, rtcOptions);
            }
            case 'rtc-with-ws-fallback':
            default: {
                const rtcResult = await this.sendTypedRtc(
                    channelDefinition,
                    payload,
                    rtcOptions
                );
                if (isSuccessfulRallarMessageSendStatus(rtcResult.status)) {
                    return rtcResult;
                }
                return await this.sendTypedWs(channelDefinition, payload, wsOptions);
            }
        }
    }

    private sendTypedRtc<T>(
        definition: RallarTypedMessageChannelDefinition,
        payload: T,
        options: RallarTypedRtcSendOptions<T>
    ): Promise<RallarMessageSendResult> {
        return this.operations.rtc.send<T>({
            ...options,
            topicId: definition.topicId,
            typeId: definition.typeId,
            payload
        });
    }

    private sendTypedWs<T>(
        definition: RallarTypedMessageChannelDefinition,
        payload: T,
        options: RallarTypedWsSendOptions<T>
    ): Promise<RallarMessageSendResult> {
        return this.operations.ws.send<T>({
            ...options,
            topicId: definition.topicId,
            typeId: definition.typeId,
            payload
        });
    }

    attachRtc(ctx?: ApiMiddleware): void {
        this.subscriptions.attachRtc(ctx);
    }

    detachRtc(ctx?: ApiMiddleware): void {
        this.subscriptions.detachRtc(ctx);
    }

    private resolveMessageMaxPayloadBytes(): number {
        return (
            this.options.readMessageMaxPayloadBytes?.() ??
                RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES
        );
    }
}

function toRallarMessageSendResult(
    transport: RallarMessageTransport,
    message: ALMessage,
    result: ALOutboundEnqueueResult
): RallarMessageSendResult {
    return {
        transport,
        status: result.status,
        message,
        entry: result.entry,
        entries: result.entries,
        reason: result.reason
    };
}

function throwMessageValidationIssue(
    path: string,
    code: string,
    message: string
): never {
    throwRallarValidation([{ path, code, message }]);
}

function isSuccessfulRallarMessageSendStatus(
    status: ALOutboundEnqueueStatus
): boolean {
    return (
        status === 'enqueued' ||
        status === 'sent-immediate' ||
        status === 'duplicate' ||
        status === 'superseded' ||
        status === 'skipped'
    );
}

function wakeQBoxEngineIfQueued(
    engine: WakeableQueueBoxEngine,
    result: ALOutboundEnqueueResult
): void {
    if (result.status === 'enqueued' || result.status === 'duplicate') {
        engine.wake();
    }
}
