import {
    type ArenaEvent,
    type Vec3Tuple
} from './arena-contracts.ts';

export const ARENA_EVENT_HEADLINE_MS = 2_800;

export interface CreateSystemEventInput {
    readonly kind: ArenaEvent['kind'];
    readonly revision: number;
    readonly nowEpochMs: number;
    readonly position: Vec3Tuple | undefined;
    readonly headline: string;
}

export function createSystemEvent(
    { kind, revision, nowEpochMs, position, headline }: CreateSystemEventInput
): ArenaEvent {
    return {
        id: `${kind}:${revision}:${nowEpochMs}`,
        kind,
        position,
        radius: kind === 'player-eliminated' ? 5 : 3,
        intensity: 1,
        durationMs: ARENA_EVENT_HEADLINE_MS,
        startsAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + ARENA_EVENT_HEADLINE_MS,
        revision,
        source: 'director',
        headline
    };
}
