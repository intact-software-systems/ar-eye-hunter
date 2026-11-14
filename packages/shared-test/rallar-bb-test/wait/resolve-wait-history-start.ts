import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestEvent } from '../rallar-black-box-test-contracts.ts';
import type { RallarBlackBoxEventHistory, RallarBlackBoxEventHistorySequence } from '../runtime/event-history.ts';

export interface WaitHistoryStartInput {
    readonly sinceCommandIdPrefix: string;
    readonly events: readonly RallarBlackBoxTestEvent[];
    readonly history: RallarBlackBoxEventHistory;
    /** An owned operation's own start, such as a barrier's; absent for a plain wait. */
    readonly ownerStart: RallarBlackBoxEventHistorySequence | undefined;
}

/**
 * A command prefix starts the history at the first event of that command, else at the next event; beside an owner's
 * start the later of the two wins. Once any event was evicted the start is unknown, since retained events cannot prove
 * that the oldest retained event of the prefix was its first.
 */
export function resolveWaitHistoryStart(
    input: WaitHistoryStartInput
): Either<RallarBlackBoxEventHistory, RallarBlackBoxEventHistorySequence> {
    const { sinceCommandIdPrefix, history, ownerStart } = input;
    if (history.evictedEvents > 0) {
        return Either.ofLeft(history);
    }
    const first = input.events.find((event) =>
        event.commandId?.startsWith(sinceCommandIdPrefix) === true && event.history?.runtimeId === history.runtimeId &&
        event.history.generation === history.generation
    );
    const ordinal = Math.max(first?.history?.ordinal ?? history.totalEvents + 1, ownerStart?.ordinal ?? 0);
    return Either.ofRight({ runtimeId: history.runtimeId, generation: history.generation, ...ownerStart, ordinal });
}
