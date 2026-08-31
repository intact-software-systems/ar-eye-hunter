import type {
    RallarCallParticipantState,
    RallarCallParticipantStatus,
    RallarCallState,
    RallarCallStatus
} from '@shared-web/browser/rallar-calls-facade.ts';
import type {
    RallarRtcFacade,
    RallarRtcLaneStatus,
    RallarRtcPeerStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/web-rtc-connection-service.ts';

export namespace BrowserCallStatusReader {
    export interface Input {
        readonly callId: string;
        readonly laneIds: readonly string[];
        readonly peerIds: readonly string[];
        readonly startedAtEpochMs: number;
        readonly endedAtEpochMs?: number;
        readonly media: RallarCallStatus['media'];
    }

    export interface ParticipantInput extends Input {
        readonly peerId: string;
    }

    export interface ParticipantStateInput {
        readonly ended: boolean;
        readonly peer?: RallarRtcPeerStatus;
        readonly laneCount: number;
        readonly readyLaneCount: number;
        readonly failedLaneCount: number;
    }
}

/** Derives caller-visible call and participant status from current RTC state. */
export class BrowserCallStatusReader {
    private readonly rtc: RallarRtcFacade;

    constructor(rtc: RallarRtcFacade) {
        this.rtc = rtc;
    }

    read(input: BrowserCallStatusReader.Input): RallarCallStatus {
        const participants = input.peerIds.map((peerId) => this.toParticipantStatus({ ...input, peerId }));
        return {
            callId: input.callId,
            state: toCallState(participants, input.endedAtEpochMs),
            peerIds: input.peerIds,
            laneIds: input.laneIds,
            participants,
            startedAtEpochMs: input.startedAtEpochMs,
            endedAtEpochMs: input.endedAtEpochMs,
            media: input.media
        };
    }

    private toParticipantStatus(
        input: BrowserCallStatusReader.ParticipantInput
    ): RallarCallParticipantStatus {
        const rtcStatus = this.rtc.status({
            laneId: input.laneIds[0] ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID
        });
        const peer = rtcStatus.peers.find((candidate) => candidate.peerId === input.peerId);
        const lanes = input.laneIds.length === 0
            ? peer?.lanes ?? []
            : input.laneIds.map((laneId) =>
                peer?.lanes.find((lane) => lane.laneId === laneId) ??
                    toMissingRtcLaneStatus(input.peerId, laneId)
            );
        const readyLaneIds = lanes.filter((lane) => lane.isOpen).map((lane) => lane.laneId);
        const failedLaneIds = lanes
            .filter((lane) => !lane.isOpen && !lane.isReconnectable)
            .map((lane) => lane.laneId);
        return {
            peerId: input.peerId,
            state: toCallParticipantState({
                ended: input.endedAtEpochMs !== undefined,
                peer,
                laneCount: input.laneIds.length,
                readyLaneCount: readyLaneIds.length,
                failedLaneCount: failedLaneIds.length
            }),
            lanes,
            readyLaneIds,
            failedLaneIds,
            reason: toCallParticipantReason(peer, input.laneIds.length, failedLaneIds)
        };
    }
}

function toMissingRtcLaneStatus(peerId: string, laneId: string): RallarRtcLaneStatus {
    return { peerId, laneId, isOpen: false, isReconnectable: false };
}

function toCallParticipantState(
    input: BrowserCallStatusReader.ParticipantStateInput
): RallarCallParticipantState {
    if (input.ended) {
        return 'ended';
    }
    if (!input.peer) {
        return 'idle';
    }
    if (input.laneCount === 0) {
        return input.peer.hasNoReconnectableLanes
            ? 'failed'
            : input.peer.isActive
            ? 'open'
            : 'connecting';
    }
    if (input.readyLaneCount === input.laneCount) {
        return 'open';
    }
    if (input.readyLaneCount > 0) {
        return 'partial';
    }
    if (input.failedLaneCount === input.laneCount) {
        return 'failed';
    }
    return input.peer.isActive ? 'connecting' : 'idle';
}

function toCallState(
    participants: readonly RallarCallParticipantStatus[],
    endedAtEpochMs?: number
): RallarCallState {
    if (endedAtEpochMs !== undefined) {
        return 'ended';
    }
    if (participants.length === 0) {
        return 'empty';
    }
    if (participants.every((participant) => participant.state === 'open')) {
        return 'open';
    }
    if (participants.some((participant) => participant.state === 'open' || participant.state === 'partial')) {
        return 'partial';
    }
    if (participants.every((participant) => participant.state === 'failed')) {
        return 'failed';
    }
    return 'connecting';
}

function toCallParticipantReason(
    peer: RallarRtcPeerStatus | undefined,
    laneCount: number,
    failedLaneIds: readonly string[]
): string | undefined {
    if (!peer) {
        return 'RTC peer has not been opened yet.';
    }
    if (failedLaneIds.length > 0) {
        return `RTC lanes failed or are unavailable: ${failedLaneIds.join(', ')}.`;
    }
    if (laneCount > 0 && peer.readyLaneIds.length === 0) {
        return 'RTC data lanes are not open yet.';
    }
    return undefined;
}
