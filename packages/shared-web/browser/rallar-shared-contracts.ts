import type { StateEventCursor } from '@shared/api/state-event-types.ts';

export type RallarUnsubscribe = () => void;

export type RallarStateListener<T> = (state: T) => void | Promise<void>;

export type RallarOnChangeOptions = Readonly<{
    emitCurrent?: boolean;
}>;

export type RallarReplayEventsResult<TEvent> = Readonly<{
    events: readonly TEvent[];
    nextCursor?: StateEventCursor;
    hasMore: boolean;
    pageCount: number;
    replayedCount: number;
    duplicateCount: number;
}>;

export type RallarSubscriptionScope = Readonly<{
    add(unsubscribe?: RallarUnsubscribe | null): RallarSubscriptionScope;
    unsubscribe(): void;
    size(): number;
}>;
