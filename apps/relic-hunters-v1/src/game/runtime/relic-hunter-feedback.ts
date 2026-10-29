import { toRelicRoundTrackKey, type RelicHunterEvent, type RelicPublicSnapshot } from '@relic-hunters/mod.ts';

interface RelicHunterFeedback {
    readonly lastHunterEvent: RelicHunterEvent | undefined;
    readonly error: string | undefined;
}

interface RelicHunterFeedbackState extends RelicHunterFeedback {
    readonly snapshot: RelicPublicSnapshot | undefined;
}

/** A command refusal belongs to the exact completed game that accepted the user's intent. */
export function acceptRelicHunterFeedback(
    state: RelicHunterFeedbackState,
    event: RelicHunterEvent
): RelicHunterFeedback | undefined {
    if (event.kind === 'command-refused') {
        if (
            event.completedGameId !== null &&
            (!state.snapshot || event.completedGameId !== toRelicRoundTrackKey(state.snapshot))
        ) {
            return undefined;
        }
        if (
            state.snapshot?.phase === 'finished' && event.completedGameId === null &&
            event.command !== 'leave-expedition' && event.command !== 'take-keeper'
        ) {
            return undefined;
        }
    }
    const previous = state.lastHunterEvent;
    const priorRefusalDisplayed = previous?.kind === 'command-refused' && state.error === previous.text;
    return {
        lastHunterEvent: event,
        error: event.kind === 'command-refused' ? event.text : priorRefusalDisplayed ? undefined : state.error
    };
}

/** Clear obsolete refusal text when authoritative progress leaves the refused game phase. */
export function expireRelicHunterFeedback(
    state: RelicHunterFeedbackState,
    snapshot: RelicPublicSnapshot
): RelicHunterFeedback {
    const previous = state.snapshot;
    const feedback = state.lastHunterEvent;
    const refusalExpired = feedback?.kind === 'command-refused' && previous !== undefined && (
        previous.createdAtEpochMs !== snapshot.createdAtEpochMs ||
        previous.round !== snapshot.round || previous.phase !== snapshot.phase
    );
    return {
        lastHunterEvent: refusalExpired ? undefined : feedback,
        error: refusalExpired && state.error === feedback?.text ? undefined : state.error
    };
}
