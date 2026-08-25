import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { BrowserCallSessionRuntime } from '@shared-web/browser/calls/browser-call-session-runtime.ts';
import type { RallarMessagesController } from '@shared-web/browser/messages/browser-rallar-messages-controller.ts';
import type {
    RallarCallHandle,
    RallarCallInviteInput,
    RallarCallInviteListener,
    RallarCallInviteResult,
    RallarCallsFacade,
    RallarCallSignalEvent,
    RallarCallSignalKind,
    RallarCallSignalListener,
    RallarCallSignalPayload,
    RallarCallSignalSend,
    RallarCallStartInput,
    RallarIncomingCallInvite
} from '@shared-web/browser/rallar-calls-facade.ts';
import type { RallarMessage, RallarMessageSendResult } from '@shared-web/browser/rallar-message-contracts.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

const RALLAR_CALL_SIGNAL_TOPIC_ID = 'app.rallar.calls';
const RALLAR_CALL_INVITE_TYPE_ID = 'app.rallar.calls.invite.v1';
const RALLAR_CALL_ACCEPT_TYPE_ID = 'app.rallar.calls.accept.v1';
const RALLAR_CALL_DECLINE_TYPE_ID = 'app.rallar.calls.decline.v1';
const RALLAR_CALL_CANCEL_TYPE_ID = 'app.rallar.calls.cancel.v1';

export namespace BrowserRallarCallsController {
    export interface SignalRoute {
        readonly topicId: string;
        readonly contextId: string;
        readonly resourceId?: string;
    }

    export interface SignalSendInput<T> {
        readonly peerId: string;
        readonly payload: T;
        readonly typeId: string;
        readonly route: SignalRoute;
    }

    export interface Input extends BrowserCallSessionRuntime.Input {
        connect(): Promise<ApiMiddleware>;
        readSession(): AuthSession | undefined;
        requireSession(): AuthSession;
        resolveRoomRef(room?: string | GroupRef): GroupRef | undefined;
        readonly messages: RallarMessagesController['operations'];
        sendWsUnicast<T>(input: SignalSendInput<T>): Promise<RallarMessageSendResult>;
    }

    export interface SignalPayloadInput {
        readonly kind: RallarCallSignalKind;
        readonly callId: string;
        readonly toPeerIds: readonly string[];
        readonly invite: Partial<RallarCallInviteInput>;
        readonly reason?: string;
    }
}

/** Owns call invitations and the translation between WS signals and call sessions. */
export class BrowserRallarCallsController {
    readonly operations: RallarCallsFacade;
    private readonly input: BrowserRallarCallsController.Input;

    constructor(input: BrowserRallarCallsController.Input) {
        this.input = input;
        this.operations = {
            start: async (startInput) => await this.startCall(startInput),
            invite: async (inviteInput) => await this.invite(inviteInput),
            onSignal: (listener) => this.onSignal(listener),
            onInvite: (listener) => this.onInvite(listener)
        };
    }

    private async startCall(input: RallarCallStartInput): Promise<RallarCallHandle> {
        await this.input.connect();
        return await new BrowserCallSessionRuntime(this.input, input).start();
    }

    private async invite(input: RallarCallInviteInput): Promise<RallarCallInviteResult> {
        await this.input.connect();
        const callId = input.callId ?? crypto.randomUUID();
        const peerIds = this.input.resolveTargetPeerIds(input);
        const payload = this.toSignalPayload({
            kind: 'invite',
            callId,
            toPeerIds: peerIds,
            invite: input
        });
        return {
            callId,
            peerIds,
            signals: await this.sendSignals(peerIds, payload)
        };
    }

    private onSignal(listener: RallarCallSignalListener): RallarUnsubscribe {
        return this.input.messages.ws.onMessage<RallarMessage['payload']>(
            { topicId: RALLAR_CALL_SIGNAL_TOPIC_ID },
            async (message) => {
                const event = this.toSignalEvent(message);
                if (event) {
                    await listener(event);
                }
            }
        );
    }

    private onInvite(listener: RallarCallInviteListener): RallarUnsubscribe {
        return this.input.messages.ws.onMessage<RallarMessage['payload']>(
            {
                topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
                typeId: RALLAR_CALL_INVITE_TYPE_ID
            },
            async (message) => {
                const invite = this.toIncomingInvite(message);
                if (invite) {
                    await listener(invite);
                }
            }
        );
    }

    private toSignalPayload(
        input: BrowserRallarCallsController.SignalPayloadInput
    ): RallarCallSignalPayload {
        const session = this.input.requireSession();
        return {
            kind: input.kind,
            callId: input.callId,
            fromPeerId: session.sessionId,
            toPeerIds: [...new Set(input.toPeerIds)],
            roomRef: input.invite.roomRef ??
                (input.invite.roomId
                    ? this.input.resolveRoomRef(input.invite.roomId)
                    : undefined),
            membership: input.invite.membership,
            data: {
                laneIds: input.invite.data?.lanes
                    ? [...new Set(input.invite.data.lanes)]
                    : []
            },
            media: {
                audio: input.invite.media?.audio,
                video: input.invite.media?.video,
                screen: this.input.mediaController.readSourceStatus('screen')
                    ?.state === 'open'
            },
            message: input.invite.message,
            reason: input.reason,
            occurredAtEpochMs: Date.now()
        };
    }

    private async sendSignals(
        peerIds: readonly string[],
        payload: RallarCallSignalPayload
    ): Promise<readonly RallarCallSignalSend[]> {
        const uniquePeerIds = [...new Set(peerIds)]
            .filter((peerId) => peerId !== this.input.requireSession().sessionId);
        return await Promise.all(
            uniquePeerIds.map(async (peerId) => ({
                peerId,
                result: await this.input.sendWsUnicast({
                    peerId,
                    payload,
                    typeId: toCallSignalTypeId(payload.kind),
                    route: {
                        topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
                        contextId: payload.callId
                    }
                })
            }))
        );
    }

    private isSignalForCurrentSession(payload: RallarCallSignalPayload): boolean {
        const sessionId = this.input.readSession()?.sessionId;
        if (!sessionId || payload.fromPeerId === sessionId) {
            return false;
        }
        return payload.toPeerIds.length === 0 || payload.toPeerIds.includes(sessionId);
    }

    private toSignalEvent(
        message: RallarMessage
    ): RallarCallSignalEvent | undefined {
        const payload = normalizeRallarCallSignalPayload(message.payload);
        if (!payload) {
            return undefined;
        }
        if (!this.isSignalForCurrentSession(payload)) {
            return undefined;
        }
        return {
            kind: payload.kind,
            callId: payload.callId,
            fromPeerId: payload.fromPeerId,
            toPeerIds: payload.toPeerIds,
            roomRef: payload.roomRef,
            membership: payload.membership,
            dataLaneIds: payload.data?.laneIds ?? [],
            media: payload.media ?? {},
            message: payload.message,
            reason: payload.reason,
            payload,
            raw: { ...message, payload }
        };
    }

    private toIncomingInvite(
        message: RallarMessage
    ): RallarIncomingCallInvite | undefined {
        const event = this.toSignalEvent(message);
        if (!event || event.kind !== 'invite') {
            return undefined;
        }
        return {
            ...event,
            kind: 'invite',
            accept: async (input = {}) => await this.acceptInvite(event, input),
            decline: async (reason) => await this.declineInvite(event, reason)
        };
    }

    private async acceptInvite(
        event: RallarCallSignalEvent,
        input: Partial<RallarCallStartInput>
    ): Promise<RallarCallHandle> {
        const startInput = toAcceptedLocalCallInput(event, input);
        await this.sendSignals(
            [event.fromPeerId],
            this.toSignalPayload({
                kind: 'accepted',
                callId: event.callId,
                toPeerIds: [event.fromPeerId],
                invite: toAcceptedSignalInput(event, startInput)
            })
        );
        return await this.startCall(startInput);
    }

    private async declineInvite(
        event: RallarCallSignalEvent,
        reason?: string
    ): Promise<readonly RallarCallSignalSend[]> {
        return await this.sendSignals(
            [event.fromPeerId],
            this.toSignalPayload({
                kind: 'declined',
                callId: event.callId,
                toPeerIds: [event.fromPeerId],
                invite: {
                    peerId: event.fromPeerId,
                    callId: event.callId,
                    data: event.dataLaneIds.length > 0
                        ? { lanes: event.dataLaneIds }
                        : undefined,
                    roomRef: event.roomRef,
                    membership: event.membership
                },
                reason
            })
        );
    }
}

function toAcceptedLocalCallInput(
    event: RallarCallSignalEvent,
    input: Partial<RallarCallStartInput>
): RallarCallStartInput {
    return {
        ...input,
        callId: event.callId,
        peerId: event.fromPeerId,
        data: input.data ??
            (event.dataLaneIds.length > 0 ? { lanes: event.dataLaneIds } : undefined)
    };
}

function toAcceptedSignalInput(
    event: RallarCallSignalEvent,
    localInput: RallarCallStartInput
): RallarCallStartInput {
    return {
        ...localInput,
        roomRef: localInput.roomRef ?? event.roomRef,
        membership: localInput.membership ?? event.membership
    };
}

function toCallSignalTypeId(kind: RallarCallSignalKind): string {
    switch (kind) {
        case 'invite':
            return RALLAR_CALL_INVITE_TYPE_ID;
        case 'accepted':
            return RALLAR_CALL_ACCEPT_TYPE_ID;
        case 'declined':
            return RALLAR_CALL_DECLINE_TYPE_ID;
        case 'cancelled':
            return RALLAR_CALL_CANCEL_TYPE_ID;
    }
}

function normalizeRallarCallSignalPayload(
    value: RallarMessage['payload']
): RallarCallSignalPayload | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const candidate = value as Partial<RallarCallSignalPayload>;
    const isValid = (
        candidate.kind === 'invite' || candidate.kind === 'accepted' ||
        candidate.kind === 'declined' || candidate.kind === 'cancelled'
    ) && typeof candidate.callId === 'string' &&
        typeof candidate.fromPeerId === 'string' &&
        Array.isArray(candidate.toPeerIds) &&
        candidate.toPeerIds.every((peerId) => typeof peerId === 'string') &&
        typeof candidate.occurredAtEpochMs === 'number';
    return isValid ? candidate as RallarCallSignalPayload : undefined;
}
