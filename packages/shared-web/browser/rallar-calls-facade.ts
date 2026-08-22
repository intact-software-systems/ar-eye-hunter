import type { RallarMediaSourcesFacade, RallarMediaSourceStatus } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarMessage, RallarMessageSendResult } from '@shared-web/browser/rallar-messages-facade.ts';
import type {
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarTargetMembership,
    RallarTargetSelector
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcLaneStatus, RallarWaitForOpenOptions } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export type RallarCallMediaInput = Readonly<{
    stream?: MediaStream;
    audio?: boolean;
    video?: boolean;
}>;

export type RallarCallDataInput = Readonly<{
    lanes?: readonly string[];
    openTimeoutMs?: number;
}>;

export type RallarCallStartInput =
    & RallarTargetSelector
    & Readonly<{
        callId?: string;
        media?: RallarCallMediaInput;
        data?: RallarCallDataInput;
    }>;

export type RallarCallParticipantState =
    | 'idle'
    | 'connecting'
    | 'partial'
    | 'open'
    | 'failed'
    | 'ended';

export type RallarCallState =
    | 'empty'
    | 'connecting'
    | 'partial'
    | 'open'
    | 'failed'
    | 'ended';

export type RallarCallParticipantStatus = Readonly<{
    peerId: string;
    state: RallarCallParticipantState;
    lanes: readonly RallarRtcLaneStatus[];
    readyLaneIds: readonly string[];
    failedLaneIds: readonly string[];
    reason?: string;
}>;

export type RallarCallStatus = Readonly<{
    callId: string;
    state: RallarCallState;
    peerIds: readonly string[];
    laneIds: readonly string[];
    participants: readonly RallarCallParticipantStatus[];
    startedAtEpochMs: number;
    endedAtEpochMs?: number;
    media: Readonly<{
        localStreamId?: string;
        audioEnabled?: boolean;
        videoEnabled?: boolean;
        sources: readonly RallarMediaSourceStatus[];
    }>;
}>;

export type RallarCallWaitOptions = RallarWaitForOpenOptions;

export type RallarCallEndOptions = Readonly<{
    stopLocalMedia?: boolean;
    disconnectPeers?: boolean;
}>;

export type RallarCallSignalKind =
    | 'invite'
    | 'accepted'
    | 'declined'
    | 'cancelled';

export type RallarCallSignalPayload = Readonly<{
    kind: RallarCallSignalKind;
    callId: string;
    fromPeerId: string;
    toPeerIds: readonly string[];
    roomRef?: GroupRef;
    membership?: RallarTargetMembership;
    data?: Readonly<{
        laneIds: readonly string[];
    }>;
    media?: Readonly<{
        audio?: boolean;
        video?: boolean;
        screen?: boolean;
    }>;
    message?: string;
    reason?: string;
    occurredAtEpochMs: number;
}>;

export type RallarCallInviteInput =
    & RallarCallStartInput
    & Readonly<{
        message?: string;
    }>;

export type RallarCallSignalSend = Readonly<{
    peerId: string;
    result: RallarMessageSendResult;
}>;

export type RallarCallInviteResult = Readonly<{
    callId: string;
    peerIds: readonly string[];
    signals: readonly RallarCallSignalSend[];
}>;

export type RallarCallSignalEvent = Readonly<{
    kind: RallarCallSignalKind;
    callId: string;
    fromPeerId: string;
    toPeerIds: readonly string[];
    roomRef?: GroupRef;
    membership?: RallarTargetMembership;
    dataLaneIds: readonly string[];
    media: Readonly<{
        audio?: boolean;
        video?: boolean;
        screen?: boolean;
    }>;
    message?: string;
    reason?: string;
    payload: RallarCallSignalPayload;
    raw: RallarMessage<RallarCallSignalPayload>;
}>;

export type RallarIncomingCallInvite =
    & RallarCallSignalEvent
    & Readonly<{
        kind: 'invite';
        accept(
            input?: Partial<RallarCallStartInput>
        ): Promise<RallarCallHandle>;
        decline(reason?: string): Promise<readonly RallarCallSignalSend[]>;
    }>;

export type RallarCallSignalListener = (
    event: RallarCallSignalEvent
) => void | Promise<void>;

export type RallarCallInviteListener = (
    invite: RallarIncomingCallInvite
) => void | Promise<void>;

export type RallarCallHandle = Readonly<{
    id: string;
    status(): RallarCallStatus;
    wait(options?: RallarCallWaitOptions): Promise<RallarCallStatus>;
    channel<T>(
        definition?: Partial<RallarTargetedChannelDefinition>
    ): RallarTargetedChannel<T>;
    setLocalStream(stream: MediaStream): Promise<void>;
    setAudioEnabled(enabled: boolean): Promise<void>;
    setVideoEnabled(enabled: boolean): Promise<void>;
    stopLocal(kind: 'audio' | 'video' | 'all'): Promise<void>;
    sources: RallarMediaSourcesFacade;
    end(options?: RallarCallEndOptions): Promise<RallarCallStatus>;
}>;

export type RallarCallsFacade = Readonly<{
    start(input: RallarCallStartInput): Promise<RallarCallHandle>;
    invite(input: RallarCallInviteInput): Promise<RallarCallInviteResult>;
    onInvite(listener: RallarCallInviteListener): RallarUnsubscribe;
    onSignal(listener: RallarCallSignalListener): RallarUnsubscribe;
}>;

export type CreateRallarCallsFacadeOptions = RallarCallsFacade;

export function createRallarCallsFacade(
    operations: CreateRallarCallsFacadeOptions
): RallarCallsFacade {
    return {
        start: async (input): Promise<RallarCallHandle> => await operations.start(input),
        invite: async (input): Promise<RallarCallInviteResult> => await operations.invite(input),
        onInvite: (listener): RallarUnsubscribe => operations.onInvite(listener),
        onSignal: (listener): RallarUnsubscribe => operations.onSignal(listener)
    };
}
