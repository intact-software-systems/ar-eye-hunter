import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type {
    RallarMessageSendResult,
    RallarMessageTransport,
    RallarRtcSendInput,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    newALUnicastMessage,
    toALGroupTargetKey,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { throwRallarValidation } from '@shared/api/rallar-validation.ts';

interface ResolvedRtcMessageTarget {
    readonly room: string | GroupRef | undefined;
    readonly roomId: string;
    readonly roomRef: GroupRef;
}

interface WakeableQueueBoxEngine {
    wake(): void;
}

export namespace BrowserRallarMessageSender {
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
        resolveRoomPeerIds(room: string | GroupRef): readonly string[];
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
            input.payload
        );
        const enqueueResult = await context.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(message);
        wakeQueueBoxEngineIfQueued(context.middleware.qboxEngine, enqueueResult);
        return toRallarMessageSendResult('ws', message, enqueueResult);
    }

    public async sendRtc<T>(input: RallarRtcSendInput<T>): Promise<RallarMessageSendResult> {
        const target = this.resolveRtcMessageTarget(input);
        const context = await this.input.connect();
        const message = this.toRtcMessage(input, target, this.input.requireSession());
        if (this.input.resolveRoomPeerIds(target.roomRef).length === 0) {
            return toRallarMessageSendResult('rtc', message, {
                status: 'no-route',
                message,
                entries: [],
                reason: 'No RTC peers are desired for this room.'
            });
        }
        const enqueueResult = await context.middleware.rtcRxStreamer.enqueueOutboxIfAbsent(message);
        wakeQueueBoxEngineIfQueued(context.middleware.qboxEngine, enqueueResult);
        return toRallarMessageSendResult('rtc', message, enqueueResult);
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
                ttlMs: input.ttlMs,
                reliability: input.reliability ?? 'at-least-once',
                ack: input.ack ?? 'none',
                ownership: input.ownership ?? 'shared'
            }
        );

        const enqueueResult = await context.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(message);
        wakeQueueBoxEngineIfQueued(context.middleware.qboxEngine, enqueueResult);

        return toRallarMessageSendResult('ws', message, enqueueResult);
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
