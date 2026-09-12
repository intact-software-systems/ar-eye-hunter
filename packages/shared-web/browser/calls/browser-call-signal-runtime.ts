import type { RallarMessage, RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type {
    RallarCallHandle,
    RallarCallInviteInput,
    RallarCallInviteListener,
    RallarCallInviteResult,
    RallarCallSignalEvent,
    RallarCallSignalKind,
    RallarCallSignalListener,
    RallarCallSignalPayload,
    RallarCallSignalSend,
    RallarCallStartInput,
    RallarIncomingCallInvite
} from '@shared-web/browser/rallar-calls-facade.ts';
import type { RallarMediaSourceKind, RallarMediaSourceStatus } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    validateRallarGroupRef,
    validateRallarNonNegativeInteger,
    validateRallarRouteId
} from '@shared/api/rallar-validation.ts';

const RALLAR_CALL_SIGNAL_TOPIC_ID = 'app.rallar.calls';
const RALLAR_CALL_INVITE_TYPE_ID = 'app.rallar.calls.invite.v1';
const RALLAR_CALL_ACCEPT_TYPE_ID = 'app.rallar.calls.accept.v1';
const RALLAR_CALL_DECLINE_TYPE_ID = 'app.rallar.calls.decline.v1';
const RALLAR_CALL_CANCEL_TYPE_ID = 'app.rallar.calls.cancel.v1';

export namespace BrowserCallSignalRuntime {
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

    export interface Input {
        connect(): Promise<void>;
        nowMs(): number;
        createCallId(): string;
        readSession(): AuthSession | undefined;
        requireSession(): AuthSession;
        resolveRoomRef(room?: string | GroupRef): GroupRef | undefined;
        resolveTargetPeerIds(input?: RallarCallInviteInput): readonly string[];
        readonly messages: { readonly ws: Pick<RallarMessagesOperations['ws'], 'onMessage'>; };
        readSourceStatus(kind: RallarMediaSourceKind): RallarMediaSourceStatus | undefined;
        sendWsUnicast<T>(input: SignalSendInput<T>): Promise<RallarMessageHandle>;
        startCall(input: RallarCallStartInput): Promise<RallarCallHandle>;
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
export class BrowserCallSignalRuntime {
    private readonly input: BrowserCallSignalRuntime.Input;

    public constructor(input: BrowserCallSignalRuntime.Input) {
        this.input = input;
    }

    public async invite(input: RallarCallInviteInput): Promise<RallarCallInviteResult> {
        await this.input.connect();
        const callId = input.callId ?? this.input.createCallId();
        const peerIds = this.input.resolveTargetPeerIds(input);
        const payload = this.createSignalPayload({
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

    public onSignal(listener: RallarCallSignalListener): RallarUnsubscribe {
        return this.input.messages.ws.onMessage<unknown>(
            { topicId: RALLAR_CALL_SIGNAL_TOPIC_ID },
            async (message) => {
                const event = toSignalEvent(message, this.input.readSession()?.sessionId);
                if (event) {
                    await listener(event);
                }
            }
        );
    }

    public onInvite(listener: RallarCallInviteListener): RallarUnsubscribe {
        return this.input.messages.ws.onMessage<unknown>(
            {
                topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
                typeId: RALLAR_CALL_INVITE_TYPE_ID
            },
            async (message) => {
                const event = toSignalEvent(message, this.input.readSession()?.sessionId);
                if (event?.kind === 'invite') {
                    await listener(this.createIncomingInvite(event));
                }
            }
        );
    }

    private createSignalPayload(
        input: BrowserCallSignalRuntime.SignalPayloadInput
    ): RallarCallSignalPayload {
        const fromPeerId = this.input.requireSession().sessionId;
        const roomRef = input.invite.roomRef ??
            (input.invite.roomId ? this.input.resolveRoomRef(input.invite.roomId) : undefined);
        const screenOpen = this.input.readSourceStatus('screen')?.state === 'open';
        const occurredAtEpochMs = this.input.nowMs();
        return toSignalPayload({ input, fromPeerId, roomRef, screenOpen, occurredAtEpochMs });
    }

    private async sendSignals(
        peerIds: readonly string[],
        payload: RallarCallSignalPayload
    ): Promise<readonly RallarCallSignalSend[]> {
        const uniquePeerIds = [...new Set(peerIds)]
            .filter((peerId) => peerId !== payload.fromPeerId);
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

    private createIncomingInvite(
        event: RallarCallSignalEvent
    ): RallarIncomingCallInvite {
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
            this.createSignalPayload({
                kind: 'accepted',
                callId: event.callId,
                toPeerIds: [event.fromPeerId],
                invite: toAcceptedSignalInput(event, startInput)
            })
        );
        return await this.input.startCall(startInput);
    }

    private async declineInvite(
        event: RallarCallSignalEvent,
        reason?: string
    ): Promise<readonly RallarCallSignalSend[]> {
        return await this.sendSignals(
            [event.fromPeerId],
            this.createSignalPayload({
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

interface SignalPayloadFacts {
    readonly input: BrowserCallSignalRuntime.SignalPayloadInput;
    readonly fromPeerId: string;
    readonly roomRef?: GroupRef;
    readonly screenOpen: boolean;
    readonly occurredAtEpochMs: number;
}

function toSignalPayload(facts: SignalPayloadFacts): RallarCallSignalPayload {
    const { input } = facts;
    return {
        kind: input.kind,
        callId: input.callId,
        fromPeerId: facts.fromPeerId,
        toPeerIds: [...new Set(input.toPeerIds)],
        roomRef: facts.roomRef,
        membership: input.invite.membership,
        data: { laneIds: [...new Set(input.invite.data?.lanes ?? [])] },
        media: { audio: input.invite.media?.audio, video: input.invite.media?.video, screen: facts.screenOpen },
        message: input.invite.message,
        reason: input.reason,
        occurredAtEpochMs: facts.occurredAtEpochMs
    };
}

function toSignalEvent(
    message: RallarMessage<unknown>,
    sessionId: string | undefined
): RallarCallSignalEvent | undefined {
    const payload = normalizeRallarCallSignalPayload(message.payload);
    if (
        !payload || !sessionId || payload.fromPeerId === sessionId ||
        (payload.toPeerIds.length > 0 && !payload.toPeerIds.includes(sessionId))
    ) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSignalRoomRef(value: unknown): value is GroupRef {
    return isRecord(value) && validateRallarGroupRef(value).ok &&
        validateRallarRouteId(value.workspaceId, '$.workspaceId', 'Workspace ID').ok;
}

function isSignalData(value: unknown): value is { readonly laneIds: readonly string[]; } {
    return isRecord(value) && isStringArray(value.laneIds);
}

function isSignalMedia(value: unknown): value is RallarCallSignalPayload['media'] {
    return isRecord(value) && ['audio', 'video', 'screen'].every(
        (key) => value[key] === undefined || typeof value[key] === 'boolean'
    );
}

function normalizeRallarCallSignalPayload(value: unknown): RallarCallSignalPayload | undefined {
    if (
        !isRecord(value) ||
        !(value.kind === 'invite' || value.kind === 'accepted' || value.kind === 'declined' ||
            value.kind === 'cancelled') ||
        typeof value.callId !== 'string' || typeof value.fromPeerId !== 'string' ||
        !isStringArray(value.toPeerIds) || typeof value.occurredAtEpochMs !== 'number' ||
        !validateRallarNonNegativeInteger(value.occurredAtEpochMs).ok ||
        (value.roomRef !== undefined && !isSignalRoomRef(value.roomRef)) ||
        (value.membership !== undefined && value.membership !== 'fixed' && value.membership !== 'live') ||
        (value.data !== undefined && !isSignalData(value.data)) ||
        (value.media !== undefined && !isSignalMedia(value.media)) ||
        (value.message !== undefined && typeof value.message !== 'string') ||
        (value.reason !== undefined && typeof value.reason !== 'string')
    ) {
        return undefined;
    }
    return {
        kind: value.kind,
        callId: value.callId,
        fromPeerId: value.fromPeerId,
        toPeerIds: value.toPeerIds,
        occurredAtEpochMs: value.occurredAtEpochMs,
        roomRef: value.roomRef,
        membership: value.membership,
        data: value.data,
        media: value.media,
        message: value.message,
        reason: value.reason
    };
}
