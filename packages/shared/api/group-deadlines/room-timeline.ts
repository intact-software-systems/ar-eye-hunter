import type { ApiJsonObject } from '../api-json-value.ts';
import { readRoomClock, type RoomClock } from './room-clock.ts';

export interface RoomTimelineAdvance {
    readonly name: string;
    readonly phase: string;
    readonly durationMs: number;
    readonly expectedRevision: number;
    readonly expectedDirectorEpoch: number;
}

export interface RoomTimelineExtension {
    readonly name: string;
    readonly durationMs: number;
    readonly expectedRevision: number;
    readonly expectedDirectorEpoch: number;
}

/** The clock and phase come from the same durable group revision. */
export type RoomTimeline = RoomClock & { readonly phase: string; readonly startedAtRevision: number; };

export function readRoomTimeline(metadata: ApiJsonObject, name: string): RoomTimeline | null {
    const clock = readRoomClock(metadata, name);
    return clock && 'phase' in clock ? clock : null;
}
