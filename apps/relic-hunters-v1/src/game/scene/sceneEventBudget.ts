import type { RelicEvent } from '@relic-hunters/mod.ts';

export const MAX_SCENE_EVENT_CUES_PER_SYNC = 1;

export function selectRenderableSceneEventCues(
    events: readonly RelicEvent[],
    maxCues = MAX_SCENE_EVENT_CUES_PER_SYNC,
): readonly RelicEvent[] {
    if (maxCues <= 0) {
        return [];
    }

    const candidates = events
        .map((event, index) => ({ event, index, priority: eventCuePriority(event) }))
        .filter((candidate) => candidate.priority < Number.POSITIVE_INFINITY);

    if (candidates.length <= maxCues) {
        return candidates.map((candidate) => candidate.event);
    }

    return candidates
        .sort((left, right) => {
            const priority = left.priority - right.priority;
            if (priority !== 0) return priority;
            const created = right.event.createdAtEpochMs - left.event.createdAtEpochMs;
            if (created !== 0) return created;
            return right.index - left.index;
        })
        .slice(0, maxCues)
        .sort((left, right) => left.index - right.index)
        .map((candidate) => candidate.event);
}

function eventCuePriority(event: RelicEvent): number {
    const cue = event.animationCue;
    if (!cue) {
        return Number.POSITIVE_INFINITY;
    }

    switch (cue.type) {
        case 'relic_reveal':
        case 'relic_pickup':
        case 'heart_relic_victory':
        case 'room_collapse':
        case 'damage_shake':
        case 'escape_run':
        case 'search_altar':
        case 'steal_attempt':
            return 0;
        case 'noise_pulse':
            return event.type === 'action_revealed' ? 2 : 1;
        case 'camera_move':
            return 3;
    }
}
