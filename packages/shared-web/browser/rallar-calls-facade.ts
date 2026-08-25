import type { RallarMessage, RallarMessageSendResult } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMediaSourcesFacade, RallarMediaSourceStatus } from '@shared-web/browser/rallar-media-facade.ts';
import type {
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarTargetMembership,
    RallarTargetSelector
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcLaneStatus, RallarWaitForOpenOptions } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export interface RallarCallMediaInput {
    readonly stream?: MediaStream;
    readonly audio?: boolean;
    readonly video?: boolean;
}

export interface RallarCallDataInput {
    readonly lanes?: readonly string[];
    readonly openTimeoutMs?: number;
}

export interface RallarCallStartInput extends RallarTargetSelector {
    readonly callId?: string;
    readonly media?: RallarCallMediaInput;
    readonly data?: RallarCallDataInput;
}

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

export interface RallarCallParticipantStatus {
    readonly peerId: string;
    readonly state: RallarCallParticipantState;
    readonly lanes: readonly RallarRtcLaneStatus[];
    readonly readyLaneIds: readonly string[];
    readonly failedLaneIds: readonly string[];
    readonly reason?: string;
}

export interface RallarCallStatus {
    readonly callId: string;
    readonly state: RallarCallState;
    readonly peerIds: readonly string[];
    readonly laneIds: readonly string[];
    readonly participants: readonly RallarCallParticipantStatus[];
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs?: number;
    readonly media: RallarCallMediaStatus;
}

export interface RallarCallMediaStatus {
    readonly localStreamId?: string;
    readonly audioEnabled?: boolean;
    readonly videoEnabled?: boolean;
    readonly sources: readonly RallarMediaSourceStatus[];
}

export interface RallarCallEndOptions {
    readonly stopLocalMedia?: boolean;
    readonly disconnectPeers?: boolean;
}

export type RallarCallSignalKind =
    | 'invite'
    | 'accepted'
    | 'declined'
    | 'cancelled';

export interface RallarCallSignalPayload {
    readonly kind: RallarCallSignalKind;
    readonly callId: string;
    readonly fromPeerId: string;
    readonly toPeerIds: readonly string[];
    readonly roomRef?: GroupRef;
    readonly membership?: RallarTargetMembership;
    readonly data?: RallarCallSignalData;
    readonly media?: RallarCallSignalMedia;
    readonly message?: string;
    readonly reason?: string;
    readonly occurredAtEpochMs: number;
}

export interface RallarCallSignalData {
    readonly laneIds: readonly string[];
}

export interface RallarCallSignalMedia {
    readonly audio?: boolean;
    readonly video?: boolean;
    readonly screen?: boolean;
}

export interface RallarCallInviteInput extends RallarCallStartInput {
    readonly message?: string;
}

export interface RallarCallSignalSend {
    readonly peerId: string;
    readonly result: RallarMessageSendResult;
}

export interface RallarCallInviteResult {
    readonly callId: string;
    readonly peerIds: readonly string[];
    readonly signals: readonly RallarCallSignalSend[];
}

export interface RallarCallSignalEvent {
    readonly kind: RallarCallSignalKind;
    readonly callId: string;
    readonly fromPeerId: string;
    readonly toPeerIds: readonly string[];
    readonly roomRef?: GroupRef;
    readonly membership?: RallarTargetMembership;
    readonly dataLaneIds: readonly string[];
    readonly media: RallarCallSignalMedia;
    readonly message?: string;
    readonly reason?: string;
    readonly payload: RallarCallSignalPayload;
    readonly raw: RallarMessage<RallarCallSignalPayload>;
}

export interface RallarIncomingCallInvite extends RallarCallSignalEvent {
    readonly kind: 'invite';
    accept(input?: Partial<RallarCallStartInput>): Promise<RallarCallHandle>;
    decline(reason?: string): Promise<readonly RallarCallSignalSend[]>;
}

export type RallarCallSignalListener = (
    event: RallarCallSignalEvent
) => void | Promise<void>;

export type RallarCallInviteListener = (
    invite: RallarIncomingCallInvite
) => void | Promise<void>;

export interface RallarCallHandle {
    readonly id: string;
    status(): RallarCallStatus;
    wait(options?: RallarWaitForOpenOptions): Promise<RallarCallStatus>;
    channel<T>(definition?: Partial<RallarTargetedChannelDefinition>): RallarTargetedChannel<T>;
    setLocalStream(stream: MediaStream): Promise<void>;
    setAudioEnabled(enabled: boolean): Promise<void>;
    setVideoEnabled(enabled: boolean): Promise<void>;
    stopLocal(kind: 'audio' | 'video' | 'all'): Promise<void>;
    readonly sources: RallarMediaSourcesFacade;
    end(options?: RallarCallEndOptions): Promise<RallarCallStatus>;
}

export interface RallarCallsFacade {
    start(input: RallarCallStartInput): Promise<RallarCallHandle>;
    invite(input: RallarCallInviteInput): Promise<RallarCallInviteResult>;
    onInvite(listener: RallarCallInviteListener): RallarUnsubscribe;
    onSignal(listener: RallarCallSignalListener): RallarUnsubscribe;
}
