import { toBrowserRtcCaptureIntent } from '@shared-web/browser/connection/browser-rtc-capture-intent.ts';
import {
    isExclusiveSendInput,
    type BrowserMessageInputValidator,
    type ResolvedWsMessageInput
} from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type {
    RallarMessageHandle,
    RallarMessagePayload,
    RallarRoomAudienceInput,
    RallarRtcSendInput,
    RallarTypedMessageSendStrategy,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    resolveBrowserStorageUnavailablePolicy,
    toBrowserMessageSendDefaults,
    type BrowserMessageSendDefaults,
    type BrowserTypedChannelPolicy
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RoomSendFence } from '@shared-web/browser/rooms/room-state-store.ts';
import {
    newALRoute,
    toALGroupTargetKey,
    type ALBroadcastMessageBuilderOptions,
    type ALMessage,
    type ALPrincipalBroadcastTarget,
    type newALBroadcastMessage,
    type newALMulticastMessage,
    type newALPrincipalBroadcastMessage,
    type newALUnicastMessage
} from '@shared/al-contracts/al-contract.ts';
import { toALPrincipalBroadcastTargets } from '@shared/al-contracts/read-al-principal-broadcast-target.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { throwRallarValidation, type RallarValidationIssue } from '@shared/api/rallar-validation.ts';

import type { BrowserRallarDeliveryRegistry } from './browser-rallar-delivery-registry.ts';
import type { BrowserRallarMessageDispatch } from './browser-rallar-message-dispatch.ts';
import type { BrowserSessionDeliveries } from './browser-session-deliveries.ts';
import {
    createBrowserUnicastMessage,
    validateBrowserPeerInput,
    validateBrowserPeerServer
} from './create-browser-unicast-message.ts';
import {
    validateBrowserRtcPeerSend,
    type BrowserRtcPeerSend
} from './validate-browser-rtc-peer-send.ts';

interface ResolvedRtcMessageTarget {
    readonly room: string | GroupRef | undefined;
    readonly roomId: string;
    readonly roomRef: GroupRef;
}

interface CapturedMessagePayload {
    readonly serialized: string;
    readonly issues: readonly RallarValidationIssue[];
}

interface CreateWsMessageInput<T> {
    readonly resolved: ResolvedWsMessageInput<T>;
    readonly room: string | GroupRef | undefined;
    readonly payloadValidation: CapturedMessagePayload;
    readonly session: AuthSession;
    readonly channel: BrowserTypedChannelPolicy | undefined;
}

interface ResolvedWsAudience<T> {
    readonly room: string | GroupRef | undefined;
    readonly resolved: ResolvedWsMessageInput<T>;
}

interface CreateRtcMessageInput<T> {
    readonly input: RallarRtcSendInput<T>;
    readonly payloadValidation: CapturedMessagePayload;
    readonly target: ResolvedRtcMessageTarget;
    readonly session: AuthSession;
    readonly channel: BrowserTypedChannelPolicy | undefined;
}

export namespace BrowserRallarMessageSender {
    /** Canonical AL constructors own message ID, clock, serialization and deadline policy. */
    export interface Creation {
        readonly createUnicast: typeof newALUnicastMessage;
        readonly createMulticast: typeof newALMulticastMessage;
        readonly createBroadcast: typeof newALBroadcastMessage;
        readonly createPrincipalBroadcast: typeof newALPrincipalBroadcastMessage;
        newResourceId(): string;
    }

    export interface TypedInput<T> extends RallarRtcSendInput<T>, RallarWsSendInput<T> {
        readonly strategy?: RallarTypedMessageSendStrategy;
    }

    export interface Input {
        readonly creation: Creation;
        readonly deliveries: BrowserRallarDeliveryRegistry;
        readonly dispatch: BrowserRallarMessageDispatch;
        readonly sessionDeliveries: BrowserSessionDeliveries;
        readonly inputValidator: BrowserMessageInputValidator;
        connect(capture?: Pick<RallarOperationOptions, 'rtcCaptureMode' | 'rtcCaptureContext'>): Promise<ApiMiddleware>;
        requireSession(): AuthSession;
        resolveDefaultRoom(): string | GroupRef | undefined;
        resolveCurrentRoomRef(): GroupRef | undefined;
        toRoomId(room: string | GroupRef | undefined): string | undefined;
        resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
        resolveRoomSendFence(room: string | GroupRef | undefined, explicitMinSnapshotVersion?: number): RoomSendFence;
    }
}

export class BrowserRallarMessageSender {
    public static readonly DEFAULT_MESSAGE_TTL_MS = 30_000;
    private readonly input: BrowserRallarMessageSender.Input;

    public constructor(input: BrowserRallarMessageSender.Input) {
        this.input = input;
    }

    /** A `world` send is the world broadcast its RTC leg refuses as unsupported: RTC carries room audiences only. */
    public async sendRtc<T>(
        input: RallarRtcSendInput<T>,
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        if (input.scope === 'world') {
            return await this.sendScoped(input, 'rtc', channel);
        }
        const capture = toBrowserRtcCaptureIntent(input);
        const target = this.resolveRtcMessageTarget(input);
        const payloadValidation = this.capturePayload(input.payload);
        const context = await this.input.connect(capture.options);
        const rtcCapture = this.input.sessionDeliveries.readRtcCapture(context);
        const message = toRoomFallbackMessage(
            this.createRtcMessage({ input, payloadValidation, target, session: this.input.requireSession(), channel }),
            input
        );
        return this.startDelivery({
            requestedConfiguration: capture.requestedConfiguration,
            rtcCapture,
            context,
            carrier: 'rtc',
            message,
            canFallback: false,
            payloadIssues: payloadValidation.issues,
            onStorageUnavailable: resolveBrowserStorageUnavailablePolicy(channel)
        });
    }

    public async sendWs<T>(
        input: RallarWsSendInput<T>,
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        return await this.sendScoped(input, 'ws', channel);
    }

    private async sendScoped<T>(
        input: RallarWsSendInput<T>,
        carrier: 'ws' | 'rtc',
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        const capture = toBrowserRtcCaptureIntent(input);
        const { room, resolved } = this.resolveWsAudience(input);
        const { roomRef } = resolved;

        throwIfMessageIssues([
            ...this.input.inputValidator.validateWs(resolved),
            ...this.input.inputValidator.validateWsOrdering(input),
            ...validateBrowserPeerInput({ send: input, roomRef })
        ]);

        const payloadValidation = this.capturePayload(input.payload);
        const context = await this.input.connect(capture.options);
        const rtcCapture = this.input.sessionDeliveries.readRtcCapture(context);
        throwIfMessageIssues(validateBrowserPeerServer({
            peerId: input.peerId,
            strategy: 'ws',
            serverPeerId: context.middleware.webSocketQueueBox.serverPeerId
        }));
        const session = this.input.requireSession();
        const message = this.createWsSendMessage({
            resolved,
            room,
            payloadValidation,
            session,
            channel
        });

        return this.startDelivery({
            requestedConfiguration: capture.requestedConfiguration,
            rtcCapture,
            context,
            carrier,
            message,
            canFallback: false,
            payloadIssues: payloadValidation.issues,
            onStorageUnavailable: resolveBrowserStorageUnavailablePolicy(channel)
        });
    }

    /**
     * A world send names no room even when its channel does; every room audience, principal and list included,
     * names its room or the default room; a send that names neither a room nor a scope reaches the sender's world.
     */
    private resolveWsAudience<T>(input: RallarWsSendInput<T>): ResolvedWsAudience<T> {
        const room = input.scope === 'world'
            ? undefined
            : input.roomRef ?? input.roomId ?? this.input.resolveDefaultRoom();
        const roomId = this.input.toRoomId(room);
        const scope = input.scope ?? (roomId ? 'room' : 'world');
        const roomRef = scope === 'world' ? undefined : this.input.resolveRoomRef(room);
        return { room, resolved: { input, scope, roomId, roomRef } };
    }

    /**
     * Only the WS server arbitrates a claim, so an exclusive send, room- or peer-addressed, and a world send go over WS
     * under every strategy but `rtc`, whose own carrier refuses them as unsupported.
     */
    public async sendTyped<T>(
        input: BrowserRallarMessageSender.TypedInput<T>,
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        const strategy = input.strategy ?? 'rtc-with-ws-fallback';
        if (isExclusiveSendInput(input) && strategy !== 'rtc') {
            return await this.sendWs(input, channel);
        }
        if (input.peerId !== undefined && strategy !== 'ws') {
            return strategy === 'ws-then-rtc'
                ? throwMessageValidationIssue(
                    '$.peerId',
                    'unsupported',
                    'A peer-addressed typed send takes the ws, rtc or rtc-with-ws-fallback strategy.'
                )
                : await this.sendRtcPeer({ send: input, peerId: input.peerId, strategy }, channel);
        }
        if (input.scope === 'world' && strategy !== 'rtc') {
            return await this.sendWs(input, channel);
        }
        switch (strategy) {
            case 'ws':
                return await this.sendWs(input, channel);
            case 'rtc':
                return await this.sendRtc(input, channel);
            case 'ws-then-rtc':
                return await this.sendRoomWithFallback(input, 'ws', channel);
            case 'rtc-with-ws-fallback':
                return await this.sendRoomWithFallback(input, 'rtc', channel);
            default:
                return throwMessageValidationIssue(
                    '$.strategy',
                    'unsupported',
                    'Unsupported message transport strategy.'
                );
        }
    }

    private async sendRtcPeer<T>(
        peer: BrowserRtcPeerSend<T>,
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        const capture = toBrowserRtcCaptureIntent(peer.send);
        const target = this.resolveRtcMessageTarget(peer.send);
        const resolved: ResolvedWsMessageInput<T> = {
            input: peer.send,
            scope: 'room',
            roomId: target.roomId,
            roomRef: target.roomRef
        };
        throwIfMessageIssues(validateBrowserRtcPeerSend({ peer, resolved, inputValidator: this.input.inputValidator }));
        const payloadValidation = this.capturePayload(peer.send.payload);
        const context = await this.input.connect(capture.options);
        const rtcCapture = this.input.sessionDeliveries.readRtcCapture(context);
        throwIfMessageIssues(validateBrowserPeerServer({
            peerId: peer.peerId,
            strategy: peer.strategy,
            serverPeerId: context.middleware.webSocketQueueBox.serverPeerId
        }));
        return this.startDelivery({
            requestedConfiguration: capture.requestedConfiguration,
            rtcCapture,
            context,
            carrier: 'rtc',
            message: createBrowserUnicastMessage({
                creation: this.input.creation,
                resolved,
                peerId: peer.peerId,
                payload: parseCapturedPayload(payloadValidation),
                senderId: this.input.requireSession().sessionId,
                channel,
                laneTtlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
            }),
            canFallback: peer.strategy === 'rtc-with-ws-fallback',
            payloadIssues: payloadValidation.issues,
            onStorageUnavailable: resolveBrowserStorageUnavailablePolicy(channel)
        });
    }

    private async sendRoomWithFallback<T>(
        input: BrowserRallarMessageSender.TypedInput<T>,
        firstCarrier: 'rtc' | 'ws',
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        const capture = toBrowserRtcCaptureIntent(input);
        const target = this.resolveRtcMessageTarget(input);
        throwIfMessageIssues(
            this.input.inputValidator.validateWs({
                input,
                scope: input.scope ?? 'room',
                roomId: target.roomId,
                roomRef: target.roomRef
            })
        );
        const payloadValidation = this.capturePayload(input.payload);
        const context = await this.input.connect(capture.options);
        const rtcCapture = this.input.sessionDeliveries.readRtcCapture(context);
        const message = toRoomFallbackMessage(
            this.createRtcMessage({ input, payloadValidation, target, session: this.input.requireSession(), channel }),
            input
        );
        return this.startDelivery({
            requestedConfiguration: capture.requestedConfiguration,
            rtcCapture,
            context,
            carrier: firstCarrier,
            message,
            canFallback: true,
            payloadIssues: payloadValidation.issues,
            onStorageUnavailable: resolveBrowserStorageUnavailablePolicy(channel)
        });
    }

    private capturePayload(payload: unknown): CapturedMessagePayload {
        const validation = this.input.inputValidator.readPayloadValidation(payload);
        throwIfMessageIssues(validation.issues.filter((issue) => issue.code !== 'payload-too-large'));
        if (validation.serialized === undefined) {
            throw new Error('Validated message payload is missing its serialized representation.');
        }
        return { serialized: validation.serialized, issues: validation.issues };
    }

    private startDelivery(delivery: BrowserRallarMessageDispatch.Delivery): RallarMessageHandle {
        const handle = this.input.deliveries.open(delivery.message, delivery.carrier, delivery.rtcCapture);
        this.input.dispatch.send(delivery);
        return handle;
    }

    private resolveRtcMessageTarget<T>(
        input: RallarRtcSendInput<T>
    ): ResolvedRtcMessageTarget {
        const room = input.roomRef ??
            input.roomId ??
            this.input.resolveDefaultRoom() ??
            this.input.resolveCurrentRoomRef();
        const roomId = this.input.toRoomId(room);

        const roomRef = this.input.resolveRoomRef(room);
        const issues = [...this.input.inputValidator.validateRtc(input, roomId)];
        if (!roomId) {
            issues.push({
                path: '$.roomId',
                code: 'missing-room',
                message: 'Cannot send RTC message: no current room.'
            });
        }
        if (!roomRef) {
            issues.push({
                path: '$.roomRef',
                code: 'missing-room-ref',
                message: 'Cannot send RTC message: no scoped room reference.'
            });
        }
        else {
            issues.push(...this.input.inputValidator.validateResolvedRoomRef(roomRef, '$.roomRef'));
        }
        if (!roomId || !roomRef || issues.length > 0) {
            throwRallarValidation(issues);
        }
        return { room, roomId, roomRef };
    }

    private createWsSendMessage<T>(input: CreateWsMessageInput<T>): ALMessage {
        const peerId = input.resolved.input.peerId;
        if (peerId === undefined) {
            return this.createWsMessage(input);
        }
        return createBrowserUnicastMessage({
            creation: this.input.creation,
            resolved: input.resolved,
            peerId,
            payload: parseCapturedPayload(input.payloadValidation),
            senderId: input.session.sessionId,
            channel: input.channel,
            laneTtlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
        });
    }

    private createWsMessage<T>(
        { resolved, room, payloadValidation, session, channel }: CreateWsMessageInput<T>
    ): ALMessage {
        const { input, scope, roomId, roomRef } = resolved;
        const defaults = toBrowserMessageSendDefaults({
            send: input,
            channel,
            hasLogicalAudience: scope !== 'world',
            laneTtlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
        });
        const route = newALRoute(
            input.topicId ?? input.typeId,
            input.contextId ?? roomId ?? scope,
            input.resourceId ?? this.input.creation.newResourceId()
        );
        const payload = parseCapturedPayload(payloadValidation);
        const options = this.toWsBroadcastOptions(input, room, defaults);
        if (scope !== 'principal') {
            const listed = { ...options, groupRef: roomRef, recipientPeerIds: input.recipientPeerIds };
            return this.input.creation.createBroadcast(session.sessionId, route, scope, input.typeId, payload, listed);
        }
        const target = toPrincipalTarget(roomRef, input.principalId);
        return this.input.creation.createPrincipalBroadcast(
            session.sessionId,
            route,
            target,
            input.typeId,
            payload,
            options
        );
    }

    private toWsBroadcastOptions<T>(
        input: RallarWsSendInput<T>,
        room: string | GroupRef | undefined,
        defaults: BrowserMessageSendDefaults
    ): ALBroadcastMessageBuilderOptions {
        return {
            exceptPeerIds: input.exceptPeerIds,
            ...(room
                ? this.input.resolveRoomSendFence(room, input.minSnapshotVersion)
                : { minSnapshotVersion: input.minSnapshotVersion }),
            ttlHops: input.ttlHops,
            ttlMs: defaults.ttlMs,
            reliability: defaults.reliability,
            ack: defaults.ack,
            ownership: input.ownership ?? 'shared',
            qos: defaults.qos,
            ordering: input.orderingKey !== undefined && input.seq !== undefined
                ? { orderingKey: input.orderingKey, seq: input.seq }
                : undefined
        };
    }

    private createRtcMessage<T>(
        { input, payloadValidation, target, session, channel }: CreateRtcMessageInput<T>
    ): ALMessage {
        const defaults = toBrowserMessageSendDefaults({
            send: input,
            channel,
            hasLogicalAudience: true,
            laneTtlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
        });
        return this.input.creation.createMulticast(
            session.sessionId,
            newALRoute(
                input.topicId ?? input.typeId,
                input.contextId ?? target.roomId,
                input.resourceId ?? this.input.creation.newResourceId()
            ),
            target.roomRef,
            input.typeId,
            parseCapturedPayload(payloadValidation),
            {
                ...this.input.resolveRoomSendFence(target.room, input.minSnapshotVersion),
                ttlHops: input.ttlHops,
                ttlMs: defaults.ttlMs,
                seq: input.seq,
                orderingKey: input.orderingKey ?? toALGroupTargetKey(target.roomRef),
                reliability: defaults.reliability,
                ack: defaults.ack,
                ownership: input.ownership ?? 'shared',
                qos: defaults.qos,
                nextHopPeerIds: input.nextHopPeerIds,
                overlayId: input.overlayId ?? toScopedOverlayId(target.roomRef),
                fanoutLimit: input.fanoutLimit
            }
        );
    }
}

/** The parser sees only the immutable JSON already accepted by the configured validator. */
function parseCapturedPayload(payload: CapturedMessagePayload): RallarMessagePayload {
    return JSON.parse(payload.serialized);
}

function throwIfMessageIssues(issues: readonly RallarValidationIssue[]): void {
    if (issues.length > 0) {
        throwRallarValidation(issues);
    }
}

/**
 * The room send both carriers take: a multicast, or the room broadcast that names its exclusions or its fixed
 * list, or the principal broadcast in the room. The RTC leg freezes a principal or listed broadcast as a room
 * multicast; a leg that cannot freeze it hands it to WS as it is.
 */
function toRoomFallbackMessage(message: ALMessage, audience: Omit<RallarRoomAudienceInput, 'scope'>): ALMessage {
    const { exceptPeerIds, principalId, recipientPeerIds } = audience;
    if (
        message.targets?.mode !== 'multicast' ||
        (exceptPeerIds === undefined && principalId === undefined && recipientPeerIds === undefined)
    ) {
        return message;
    }
    const { groupRef, minSnapshotVersion, rosterVersion } = message.targets;
    const room = { groupRef, minSnapshotVersion, rosterVersion, exceptPeerIds: exceptPeerIds && [...exceptPeerIds] };
    return {
        ...message,
        targets: principalId === undefined
            ? { mode: 'broadcast', scope: 'room', ...room, recipientPeerIds: recipientPeerIds && [...recipientPeerIds] }
            : toALPrincipalBroadcastTargets(toPrincipalTarget(groupRef, principalId), room)
    };
}

/** The principal broadcast's target in its room; the validator has already refused a principal send without either. */
function toPrincipalTarget(
    roomRef: GroupRef | undefined,
    principalId: string | undefined
): ALPrincipalBroadcastTarget {
    if (roomRef === undefined || principalId === undefined) {
        throw new Error('A validated principal send names its room and its principal.');
    }
    return {
        groupRef: roomRef,
        principalRef: { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId, principalId }
    };
}

function throwMessageValidationIssue(path: string, code: string, message: string): never {
    throwRallarValidation([{ path, code, message }]);
}
