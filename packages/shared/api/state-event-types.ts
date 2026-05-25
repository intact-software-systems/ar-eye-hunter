export type StateEventCursor = Readonly<{
    snapshotVersion: number;
    occurredAtEpochMs: number;
    eventId: string;
}>;

export type StateEventPage<TEvent> = Readonly<{
    events: readonly TEvent[];
    nextCursor?: StateEventCursor;
    hasMore: boolean;
}>;
