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
 * A command prefix starts the history at the first retained event of that command, else at the next event; beside an
 * owner's start the later of the two wins. With events evicted and none of the prefix retained, the start is unknown.
 */
export function resolveWaitHistoryStart(
    input: WaitHistoryStartInput
): Either<RallarBlackBoxEventHistory, RallarBlackBoxEventHistorySequence> {
    const { sinceCommandIdPrefix, history, ownerStart } = input;
    const first = input.events.find((event) =>
        event.commandId?.startsWith(sinceCommandIdPrefix) === true && event.history?.runtimeId === history.runtimeId &&
        event.history.generation === history.generation
    );
    if (first === undefined && history.evictedEvents > 0) {
        return Either.ofLeft(history);
    }
    const ordinal = Math.max(first?.history?.ordinal ?? history.totalEvents + 1, ownerStart?.ordinal ?? 0);
    return Either.ofRight({ runtimeId: history.runtimeId, generation: history.generation, ...ownerStart, ordinal });
}
