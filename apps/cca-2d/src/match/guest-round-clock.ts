import { readRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import { roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import type { TownMatchFrame } from './match-protocol.ts';
import type { RoomTimeline, RoomTimelineAdvance, RoomTimelineExtension } from '@shared/api/group-deadlines/room-timeline.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

interface GuestRoundClockPort {
    advanceTimeline(room: GroupRef, change: RoomTimelineAdvance, requestId: string): Promise<RoomTimeline | void>;
    extendTimeline(room: GroupRef, change: RoomTimelineExtension, requestId: string): Promise<RoomTimeline | void>;
}

interface GuestRoundClockChange {
    readonly room: GroupRef;
    readonly matchId: string;
    readonly directorEpoch: number;
    readonly timeline: RoomTimeline | null;
    readonly action:
        | { readonly kind: 'start'; readonly durationMs: number; readonly players: readonly string[] }
        | { readonly kind: 'extend'; readonly durationMs: number; readonly totalDurationMs: number }
        | { readonly kind: 'finish' };
}

/** Start and extend are acknowledged by the room before the director changes its simulation. */
export async function writeGuestRoundClock(port: GuestRoundClockPort, change: GuestRoundClockChange): Promise<void> {
    const { action, timeline, matchId, room } = change;
    const command = { name: 'guest-play', expectedRevision: timeline?.revision ?? 0, expectedDirectorEpoch: change.directorEpoch };
    if (action.kind === 'start') {
        if (timeline?.phase === matchId) return;
        await port.advanceTimeline(room, {
            ...command, phase: matchId, participantPrincipalIds: action.players, durationMs: action.durationMs
        }, 'cca-guest-round-start-' + matchId);
    }
    else if (timeline?.phase === matchId) {
        if (action.kind === 'finish') {
            await port.advanceTimeline(room, { ...command, phase: 'results', durationMs: 1 }, 'cca-guest-round-finish-' + matchId);
        }
        else if (timeline.status === 'running' && timeline.startedAtEpochMs !== undefined &&
            timeline.endsAtEpochMs - timeline.startedAtEpochMs < action.totalDurationMs) {
            await port.extendTimeline(room, { ...command, durationMs: action.durationMs },
                'cca-guest-round-extend-' + matchId + '-' + action.totalDurationMs);
        }
    }
}

/** A guest finishing a round can exchange checkpoints and controls only for that occurrence. */
export function permitsFinishingGuestAction(
    phase: string | undefined, frame: { readonly matchId: string; readonly action: { readonly kind: string } }
): boolean {
    return phase === frame.matchId && !['ready', 'start', 'extend', 'rematch'].includes(frame.action.kind);
}

interface GuestFrameExchange {
    readonly sender: string;
    readonly receiver: string;
    readonly frame: TownMatchFrame;
    readonly now: number | undefined;
}

export function permitsGuestFrame(snapshot: GroupSnapshot, exchange: GuestFrameExchange): boolean {
    for (const member of snapshot.members) {
        if (!member.guestLease || (member.principalId !== exchange.sender && member.principalId !== exchange.receiver)) continue;
        if (exchange.now === undefined) return false;
        const mode = roomGuestAccessMode(snapshot.group, member, exchange.now);
        if (mode === 'expired' || (mode === 'finish-round' &&
            !permitsFinishingGuestAction(readRoomTimeline(snapshot.group.metadata, 'guest-play')?.phase, exchange.frame))) return false;
    }
    return true;
}
