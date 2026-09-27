import type {
    BrowserMessageInputValidator,
    ResolvedWsMessageInput
} from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type {
    RallarMessageHandle,
    RallarRtcSendInput,
    RallarTypedMessageSendStrategy,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    toBrowserMessageSendDefaults,
    type BrowserTypedChannelPolicy
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    newALRoute,
    toALGroupTargetKey,
    type ALMessage,
    type newALBroadcastMessage,
    type newALMulticastMessage,
    type newALUnicastMessage
} from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { throwRallarValidation, type RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import type { BrowserRallarDeliveryRegistry } from './browser-rallar-delivery-registry.ts';
import type { BrowserRallarMessageDispatch } from './browser-rallar-message-dispatch.ts';

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
        newResourceId(): string;
    }

    export interface TypedInput<T> extends RallarRtcSendInput<T>, RallarWsSendInput<T> {
        readonly strategy?: RallarTypedMessageSendStrategy;
    }

    export interface Input {
        readonly creation: Creation;
        readonly deliveries: BrowserRallarDeliveryRegistry;
        readonly dispatch: BrowserRallarMessageDispatch;
        readonly inputValidator: BrowserMessageInputValidator;
        connect(): Promise<ApiMiddleware>;
        requireSession(): AuthSession;
        resolveDefaultRoom(): string | GroupRef | undefined;
        resolveCurrentRoomRef(): GroupRef | undefined;
        toRoomId(room: string | GroupRef | undefined): string | undefined;
        resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
        resolveRoomMinSnapshotVersion(
            room: string | GroupRef | undefined,
            explicitMinSnapshotVersion?: number
        ): number | undefined;
    }

    export interface WsUnicastInput<T> {
        readonly peerId: string;
        readonly payload: T;
        readonly typeId: string;
        readonly route: WsUnicastRoute;
    }

    export interface WsUnicastRoute {
        topicId: string;
        contextId: string;
        resourceId?: string;
    }
}

export class BrowserRallarMessageSender {
    public static readonly DEFAULT_MESSAGE_TTL_MS = 30_000;
    private readonly input: BrowserRallarMessageSender.Input;

    public constructor(input: BrowserRallarMessageSender.Input) {
        this.input = input;
    }

    public async sendWsUnicast<T>(
        input: BrowserRallarMessageSender.WsUnicastInput<T>
    ): Promise<RallarMessageHandle> {
        const payloadValidation = this.capturePayload(input.payload);
        const context = await this.input.connect();
        const session = this.input.requireSession();
        const message = this.input.creation.createUnicast(
            session.sessionId,
            newALRoute(
                input.route.topicId,
                input.route.contextId,
                input.route.resourceId ?? this.input.creation.newResourceId()
            ),
            input.peerId,
            input.typeId,
            parseCapturedPayload(payloadValidation),
            { ttlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS }
        );
        return this.startDelivery({
            context,
            carrier: 'ws',
            message,
            canFallback: false,
            payloadIssues: payloadValidation.issues
        });
    }

    public async sendRtc<T>(
        input: RallarRtcSendInput<T>,
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        const target = this.resolveRtcMessageTarget(input, []);
        const payloadValidation = this.capturePayload(input.payload);
        const context = await this.input.connect();
        const message = this.createRtcMessage({
            input,
            payloadValidation,
            target,
            session: this.input.requireSession(),
            channel
        });
        return this.startDelivery({
            context,
            carrier: 'rtc',
            message,
            canFallback: false,
            payloadIssues: payloadValidation.issues
        });
    }

    public async sendWs<T>(
        input: RallarWsSendInput<T>,
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        const room = input.roomRef ??
            input.roomId ??
            (input.scope === undefined ? this.input.resolveDefaultRoom() : undefined);
        const roomId = this.input.toRoomId(room);
        const scope = input.scope ?? (roomId ? 'room' : 'all');
        const roomRef = scope === 'room' ? this.input.resolveRoomRef(room) : undefined;

        throwIfMessageIssues([
            ...this.input.inputValidator.validateWs({ input, scope, roomId, roomRef }),
            ...this.input.inputValidator.validateWsOrdering(input)
        ]);

        const payloadValidation = this.capturePayload(input.payload);
        const context = await this.input.connect();
        const message = this.createWsMessage({
            resolved: { input, scope, roomId, roomRef },
            room,
            payloadValidation,
            session: this.input.requireSession(),
            channel
        });

        return this.startDelivery({
            context,
            carrier: 'ws',
            message,
            canFallback: false,
            payloadIssues: payloadValidation.issues
        });
    }

    public async sendTyped<T>(
        input: BrowserRallarMessageSender.TypedInput<T>,
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        switch (input.strategy ?? 'rtc-with-ws-fallback') {
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

    private async sendRoomWithFallback<T>(
        input: BrowserRallarMessageSender.TypedInput<T>,
        firstCarrier: 'rtc' | 'ws',
        channel: BrowserTypedChannelPolicy | undefined
    ): Promise<RallarMessageHandle> {
        const target = this.resolveRtcMessageTarget(input, validateRoomFallbackInput(input));
        throwIfMessageIssues(
            this.input.inputValidator.validateWs({
                input,
                scope: 'room',
                roomId: target.roomId,
                roomRef: target.roomRef
            })
        );
        const payloadValidation = this.capturePayload(input.payload);
        const context = await this.input.connect();
        const message = toRoomFallbackMessage(
            this.createRtcMessage({ input, payloadValidation, target, session: this.input.requireSession(), channel }),
            input.exceptPeerIds
        );
        return this.startDelivery({
            context,
            carrier: firstCarrier,
            message,
            canFallback: true,
            payloadIssues: payloadValidation.issues
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
        const handle = this.input.deliveries.open(delivery.message, delivery.carrier);
        this.input.dispatch.send(delivery);
        return handle;
    }

    private resolveRtcMessageTarget<T>(
        input: RallarRtcSendInput<T>,
        initialIssues: readonly RallarValidationIssue[]
    ): ResolvedRtcMessageTarget {
        const room = input.roomRef ??
            input.roomId ??
            this.input.resolveDefaultRoom() ??
            this.input.resolveCurrentRoomRef();
        const roomId = this.input.toRoomId(room);

        const roomRef = this.input.resolveRoomRef(room);
        const issues = [...initialIssues, ...this.input.inputValidator.validateRtc(input, roomId)];
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

    private createWsMessage<T>(
        { resolved, room, payloadValidation, session, channel }: CreateWsMessageInput<T>
    ): ALMessage {
        const { input, scope, roomId, roomRef } = resolved;
        const defaults = toBrowserMessageSendDefaults({
            send: input,
            channel,
            hasLogicalAudience: scope === 'room',
            laneTtlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
        });
        return this.input.creation.createBroadcast(
            session.sessionId,
            newALRoute(
                input.topicId ?? input.typeId,
                input.contextId ?? roomId ?? input.scope ?? 'all',
                input.resourceId ?? this.input.creation.newResourceId()
            ),
            scope,
            input.typeId,
            parseCapturedPayload(payloadValidation),
            {
                groupRef: roomRef,
                exceptPeerIds: input.exceptPeerIds,
                minSnapshotVersion: room
                    ? this.input.resolveRoomMinSnapshotVersion(room, input.minSnapshotVersion)
                    : input.minSnapshotVersion,
                ttlHops: input.ttlHops,
                ttlMs: defaults.ttlMs,
                reliability: defaults.reliability,
                ack: defaults.ack,
                ownership: input.ownership ?? 'shared',
                qos: defaults.qos,
                ordering: input.orderingKey !== undefined && input.seq !== undefined
                    ? { orderingKey: input.orderingKey, seq: input.seq }
                    : undefined
            }
        );
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
                membershipEpoch: input.membershipEpoch,
                minSnapshotVersion: this.input.resolveRoomMinSnapshotVersion(
                    target.room,
                    input.minSnapshotVersion
                ),
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

function validateRoomFallbackInput<T>(
    input: BrowserRallarMessageSender.TypedInput<T>
): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    if (input.scope !== undefined && input.scope !== 'room') {
        issues.push({
            path: '$.scope',
            code: 'unsupported',
            message: 'RTC/WS fallback requires the same scoped room audience on both carriers.'
        });
    }
    if (input.membershipEpoch !== undefined) {
        issues.push({
            path: '$.membershipEpoch',
            code: 'unsupported',
            message: 'Authoritative membership fencing is not supported.'
        });
    }
    return issues;
}

/** The parser sees only the immutable JSON already accepted by the configured validator. */
function parseCapturedPayload(payload: CapturedMessagePayload): unknown {
    return JSON.parse(payload.serialized);
}

function throwIfMessageIssues(issues: readonly RallarValidationIssue[]): void {
    if (issues.length > 0) {
        throwRallarValidation(issues);
    }
}

function toRoomFallbackMessage(message: ALMessage, exceptPeerIds: readonly string[] | undefined): ALMessage {
    if (exceptPeerIds === undefined || message.targets?.mode !== 'multicast') {
        return message;
    }
    return {
        ...message,
        targets: {
            mode: 'broadcast',
            scope: 'room',
            groupRef: message.targets.groupRef,
            minSnapshotVersion: message.targets.minSnapshotVersion,
            exceptPeerIds: [...exceptPeerIds]
        }
    };
}

function throwMessageValidationIssue(path: string, code: string, message: string): never {
    throwRallarValidation([{ path, code, message }]);
}
