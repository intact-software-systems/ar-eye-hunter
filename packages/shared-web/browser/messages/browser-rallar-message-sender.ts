import type { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type {
    RallarMessageSendResult,
    RallarMessageTransport,
    RallarRtcSendInput,
    RallarTypedMessageSendStrategy,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    newALUnicastMessage,
    toALGroupTargetKey,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundEnqueueStatus
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { throwRallarValidation, type RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

interface ResolvedRtcMessageTarget {
    readonly room: string | GroupRef | undefined;
    readonly roomId: string;
    readonly roomRef: GroupRef;
}

interface WakeableQueueBoxEngine {
    wake(): void;
}

export namespace BrowserRallarMessageSender {
    export interface TypedInput<T> extends RallarRtcSendInput<T>, RallarWsSendInput<T> {
        readonly strategy?: RallarTypedMessageSendStrategy;
    }

    export interface Input {
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
    private static readonly DEFAULT_MESSAGE_TTL_MS = 30_000;
    private readonly input: BrowserRallarMessageSender.Input;

    public constructor(input: BrowserRallarMessageSender.Input) {
        this.input = input;
    }

    public async sendWsUnicast<T>(
        input: BrowserRallarMessageSender.WsUnicastInput<T>
    ): Promise<RallarMessageSendResult> {
        const context = await this.input.connect();
        const session = this.input.requireSession();
        const message = newALUnicastMessage(
            session.sessionId,
            newALRoute(
                input.route.topicId,
                input.route.contextId,
                input.route.resourceId ?? crypto.randomUUID()
            ),
            input.peerId,
            input.typeId,
            input.payload,
            { ttlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS }
        );
        return await this.sendCapturedMessage(context, 'ws', message);
    }

    public async sendRtc<T>(input: RallarRtcSendInput<T>): Promise<RallarMessageSendResult> {
        const target = this.resolveRtcMessageTarget(input);
        const context = await this.input.connect();
        const message = this.toRtcMessage(input, target, this.input.requireSession());
        return await this.sendCapturedMessage(context, 'rtc', message);
    }

    public async sendWs<T>(input: RallarWsSendInput<T>): Promise<RallarMessageSendResult> {
        const room = input.roomRef ??
            input.roomId ??
            (input.scope === undefined ? this.input.resolveDefaultRoom() : undefined);
        const roomId = this.input.toRoomId(room);
        const scope = input.scope ?? (roomId ? 'room' : 'all');
        const roomRef = scope === 'room' ? this.input.resolveRoomRef(room) : undefined;

        this.input.inputValidator.assertWs({ input, scope, roomId, roomRef });

        const context = await this.input.connect();
        const session = this.input.requireSession();
        const contextId = input.contextId ?? roomId ?? input.scope ?? 'all';
        const minSnapshotVersion = room
            ? this.input.resolveRoomMinSnapshotVersion(room, input.minSnapshotVersion)
            : input.minSnapshotVersion;
        const message = newALBroadcastMessage(
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
                ttlMs: input.ttlMs ?? BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS,
                reliability: input.reliability ?? 'at-least-once',
                ack: input.ack ?? 'none',
                ownership: input.ownership ?? 'shared'
            }
        );

        return await this.sendCapturedMessage(context, 'ws', message);
    }

    public async sendTyped<T>(input: BrowserRallarMessageSender.TypedInput<T>): Promise<RallarMessageSendResult> {
        switch (input.strategy ?? 'rtc-with-ws-fallback') {
            case 'ws':
                return await this.sendWs(input);
            case 'rtc':
            case 'realtime':
                return await this.sendRtc(input);
            case 'ws-then-rtc':
                return await this.sendRoomWithFallback(input, 'ws');
            case 'rtc-with-ws-fallback':
                return await this.sendRoomWithFallback(input, 'rtc');
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
        firstCarrier: 'rtc' | 'ws'
    ): Promise<RallarMessageSendResult> {
        const validated = validateRoomFallbackInput(input);
        if (validated.left) {
            throwRallarValidation([validated.left]);
        }
        const target = this.resolveRtcMessageTarget(input);
        this.input.inputValidator.assertWs({ input, scope: 'room', roomId: target.roomId, roomRef: target.roomRef });
        const context = await this.input.connect();
        const message = toRoomFallbackMessage(
            this.toRtcMessage(input, target, this.input.requireSession()),
            input.exceptPeerIds
        );
        const result = await this.sendCapturedMessage(context, firstCarrier, message);
        const fallback = computeFallbackDisposition(result.status, message.constraints?.expiresAtMs, Date.now());
        if (fallback === 'expired') {
            return { ...result, status: 'expired', reason: 'Message deadline elapsed before fallback.' };
        }
        if (fallback === 'stop') {
            return result;
        }
        return await this.sendCapturedMessage(context, firstCarrier === 'rtc' ? 'ws' : 'rtc', message);
    }

    private async sendCapturedMessage(
        context: ApiMiddleware,
        carrier: 'rtc' | 'ws',
        message: ALMessage
    ): Promise<RallarMessageSendResult> {
        const validated = decodeALMessageValue(message);
        if (validated.left) {
            throwMessageValidationIssue('$', validated.left.code, validated.left.message);
        }
        if (message.constraints?.expiresAtMs !== undefined && message.constraints.expiresAtMs <= Date.now()) {
            return {
                transport: carrier,
                status: 'expired',
                message,
                entries: [],
                reason: 'Message deadline elapsed before carrier admission.'
            };
        }
        const enqueueResult = carrier === 'rtc'
            ? await context.middleware.rtcRxStreamer.enqueueOutboxIfAbsent(message)
            : await context.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(message);
        wakeQueueBoxEngineIfQueued(context.middleware.qboxEngine, enqueueResult);
        return toRallarMessageSendResult(carrier, message, enqueueResult);
    }

    private resolveRtcMessageTarget<T>(input: RallarRtcSendInput<T>): ResolvedRtcMessageTarget {
        const room = input.roomRef ??
            input.roomId ??
            this.input.resolveDefaultRoom() ??
            this.input.resolveCurrentRoomRef();
        const roomId = this.input.toRoomId(room);

        this.input.inputValidator.assertRtc(input, roomId);
        const roomRef = this.input.resolveRoomRef(room);

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
        this.input.inputValidator.assertResolvedRoomRef(roomRef, '$.roomRef');
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
                minSnapshotVersion: this.input.resolveRoomMinSnapshotVersion(
                    target.room,
                    input.minSnapshotVersion
                ),
                ttlHops: input.ttlHops,
                ttlMs: input.ttlMs ?? BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS,
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
}

function validateRoomFallbackInput<T>(
    input: BrowserRallarMessageSender.TypedInput<T>
): Either<RallarValidationIssue, BrowserRallarMessageSender.TypedInput<T>> {
    if (input.scope !== undefined && input.scope !== 'room') {
        return Either.ofLeft({
            path: '$.scope',
            code: 'unsupported',
            message: 'RTC/WS fallback requires the same scoped room audience on both carriers.'
        });
    }
    if (input.membershipEpoch !== undefined) {
        return Either.ofLeft({
            path: '$.membershipEpoch',
            code: 'unsupported',
            message: 'Authoritative membership fencing is not supported.'
        });
    }
    return Either.ofRight(input);
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

function computeFallbackDisposition(
    status: ALOutboundEnqueueStatus,
    expiresAtMs: number | undefined,
    nowMs: number
): 'retry' | 'stop' | 'expired' {
    if (status !== 'no-route' && status !== 'circuit-open') {
        return 'stop';
    }
    return expiresAtMs !== undefined && expiresAtMs <= nowMs ? 'expired' : 'retry';
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

function throwMessageValidationIssue(path: string, code: string, message: string): never {
    throwRallarValidation([{ path, code, message }]);
}

function wakeQueueBoxEngineIfQueued(
    engine: WakeableQueueBoxEngine,
    result: ALOutboundEnqueueResult
): void {
    if (result.status === 'enqueued' || result.status === 'duplicate') {
        engine.wake();
    }
}
