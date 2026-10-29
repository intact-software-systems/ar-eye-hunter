import type { RelicAnimationCue, RelicEvent, RelicEventType } from './model.ts';

export interface RelicEventInput {
    readonly round: number;
    readonly message: string;
    readonly now: number;
    readonly options?: RelicEventOptions;
}

export interface RelicEventOptions {
    readonly type?: RelicEventType;
    readonly animationCue?: RelicAnimationCue;
    readonly tone?: RelicEvent['tone'];
}

export function toRelicEvent({ round, message, now, options }: RelicEventInput): RelicEvent {
    return {
        id: `${round}:${now}:${toEventHash(message)}`,
        round,
        type: options?.type ?? 'round_started',
        message,
        animationCue: options?.animationCue,
        tone: options?.tone ?? 'neutral',
        createdAtEpochMs: now
    };
}

function toEventHash(message: string): string {
    let hash = 0;
    for (const char of message) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return hash.toString(36);
}
