import type { RallarRtcRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import { describeRtcRoomTransport } from '@shared-web/browser/rtc/rtc-room-transport-status.ts';

export interface FormationReadinessCapturedFacts {
    readonly returnedRoomReason: string | null;
    readonly laneId: string | null;
    readonly desiredPeerIds: readonly string[] | null;
    readonly readyPeerIds: readonly string[] | null;
    readonly peerIdentitiesTruncated: boolean | null;
}

export interface FormationReadinessRejection extends FormationReadinessCapturedFacts {
    readonly kind: 'formation-readiness-rejected';
    readonly roomTransportState: RallarRtcRoomTransportStatus['state'];
    readonly summaryAvailable: boolean;
    readonly roomOpen: boolean;
    readonly hasDesiredPeers: boolean;
    readonly desiredPeerCount: number;
    readonly readyPeerCount: number;
    readonly waitTerminalCause: 'unknown';
}

const FORMATION_CAPTURED_ROOM_REASONS = [
    describeRtcRoomTransport('halted'),
    describeRtcRoomTransport('idle'),
    describeRtcRoomTransport('partial'),
    describeRtcRoomTransport('degraded'),
    describeRtcRoomTransport('idle', 'empty'),
    describeRtcRoomTransport('idle', 'timeout'),
    describeRtcRoomTransport('idle', 'failed'),
    describeRtcRoomTransport('idle', 'aborted'),
    describeRtcRoomTransport('idle', 'not-connected')
];

/** What a readiness that found no open room with peers saw, bounded for the recorder. */
export function toFormationReadinessRejection(
    room: RallarRtcRoomTransportStatus,
    summaryAvailable: boolean
): FormationReadinessRejection {
    return {
        kind: 'formation-readiness-rejected',
        roomTransportState: room.state,
        summaryAvailable,
        roomOpen: room.state === 'open',
        hasDesiredPeers: room.desiredPeerIds.length > 0,
        desiredPeerCount: room.desiredPeerIds.length,
        readyPeerCount: room.readyPeerIds.length,
        waitTerminalCause: 'unknown',
        ...toFormationReadinessCapturedFacts({
            returnedRoomReason: room.reason ?? null,
            laneId: room.laneId,
            desiredPeerIds: room.desiredPeerIds,
            readyPeerIds: room.readyPeerIds,
            peerIdentitiesTruncated: false
        })
    };
}

/** Sanitizes only supplemental returned-room facts; readiness policy and counts stay with their owners. */
export function toFormationReadinessCapturedFacts(
    input: FormationReadinessCapturedFacts
): FormationReadinessCapturedFacts {
    const desiredCandidates = toCapturedPeerIdentities(input.desiredPeerIds);
    const readyCandidates = toCapturedPeerIdentities(input.readyPeerIds);
    const desiredPeerIds: string[] | null = desiredCandidates === null ? null : [];
    const readyPeerIds: string[] | null = readyCandidates === null ? null : [];
    const facts = {
        returnedRoomReason: FORMATION_CAPTURED_ROOM_REASONS.find((reason) => reason === input.returnedRoomReason) ??
            null,
        laneId: isCapturedPeerIdentity(input.laneId) ? input.laneId : null,
        desiredPeerIds,
        readyPeerIds,
        peerIdentitiesTruncated: input.peerIdentitiesTruncated
    };
    if (desiredPeerIds === null || readyPeerIds === null) {
        facts.peerIdentitiesTruncated = facts.peerIdentitiesTruncated === true ? true : null;
    }
    if (
        (desiredCandidates !== null && desiredCandidates.length > 10) ||
        (readyCandidates !== null && readyCandidates.length > 10)
    ) {
        facts.peerIdentitiesTruncated = true;
    }
    if (appendCapturedPeerIdentities(facts, desiredPeerIds, desiredCandidates)) {
        facts.peerIdentitiesTruncated = true;
    }
    if (appendCapturedPeerIdentities(facts, readyPeerIds, readyCandidates)) {
        facts.peerIdentitiesTruncated = true;
    }
    return facts;
}

/** Each list retains its longest prefix that fits beside previously retained facts. */
function appendCapturedPeerIdentities(
    facts: FormationReadinessCapturedFacts,
    retained: string[] | null,
    candidates: readonly string[] | null
): boolean {
    if (retained === null || candidates === null) {
        return false;
    }
    for (const identity of candidates.slice(0, 10)) {
        retained.push(identity);
        // This caps the facts payload, not its recorder envelope or unrelated metadata.
        if (new TextEncoder().encode(JSON.stringify(facts)).byteLength > 8_192) {
            retained.pop();
            return true;
        }
    }
    return false;
}

function toCapturedPeerIdentities(value: readonly string[] | null): readonly string[] | null {
    return value !== null && value.every(isCapturedPeerIdentity)
        ? value
        : null;
}

function isCapturedPeerIdentity(value: string | null): boolean {
    return value !== null && value.length > 0 && value.length <= 256;
}
