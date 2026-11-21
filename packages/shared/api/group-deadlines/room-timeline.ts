import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requireRecord } from '../exact-object-decoding.ts';
import { readRoomClock, type RoomClock } from './room-clock.ts';
import { assertRoomDeadlineName } from './room-deadline.ts';

export const ROOM_TIMELINES_METADATA_KEY = 'rallarRoomTimelines';

export interface RoomTimelineAdvance {
    readonly name: string;
    readonly phase: string;
    readonly durationMs: number;
    readonly expectedRevision: number;
    readonly expectedDirectorEpoch: number;
}

/** The clock and phase come from the same durable group revision. */
export type RoomTimeline = RoomClock & { readonly phase: string; readonly startedAtRevision: number; };

export function readRoomTimeline(metadata: ApiJsonObject, name: string): RoomTimeline | null {
    assertRoomDeadlineName(name);
    if (!Object.hasOwn(metadata, ROOM_TIMELINES_METADATA_KEY)) {
        return null;
    }
    const phases = requireRecord(metadata[ROOM_TIMELINES_METADATA_KEY], 'Room timelines');
    if (!Object.hasOwn(phases, name)) {
        return null;
    }
    const phase = requireRecord(phases[name], 'Timeline phase');
    requireExactKeys(phase, ['phase', 'startedAtRevision'], 'Timeline phase');
    assertRoomDeadlineName(phase.phase);
    requireEpoch(phase.startedAtRevision, 'Phase starting revision');
    const clock = readRoomClock(metadata, name);
    if (!clock || phase.startedAtRevision < 1 || phase.startedAtRevision > clock.revision) {
        throw new TypeError('Timeline phase has no matching clock revision.');
    }
    return { ...clock, phase: phase.phase, startedAtRevision: phase.startedAtRevision };
}
