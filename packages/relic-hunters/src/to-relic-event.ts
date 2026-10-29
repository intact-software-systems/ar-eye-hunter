import type { RelicAnimationCue, RelicEvent, RelicEventType, RelicGameState } from './model.ts';

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

export interface RelicEventAppend {
    readonly state: Pick<RelicGameState, 'events' | 'round'>;
    readonly message: string;
    readonly now: number;
    readonly options?: RelicEventOptions;
}

export function appendRelicEvent({ state, message, now, options }: RelicEventAppend): readonly RelicEvent[] {
    return [
        ...state.events,
        toRelicEvent({ round: state.round, message, now, options })
    ].slice(-64);
}
export interface RelicStateEvent extends RelicEventAppend {
    readonly state: RelicGameState;
}
export function withRelicEvent({ state, message, now, options }: RelicStateEvent): RelicGameState {
    return {
        ...state,
        events: appendRelicEvent({ state, message, now, options })
    };
}
