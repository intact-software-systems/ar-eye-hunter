import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';

export const TEST_CHECKPOINT_SETTINGS: ALCheckpointWriter.Settings = { intervalMs: 1_000, lagBoundMs: 10_000 };

/** The global timers, read at each call, so a test's fake timers drive the writer. */
export const GLOBAL_CHECKPOINT_TIMERS: ALCheckpointWriter.Timers = {
    schedule: (run, delayMs) => {
        const handle = setTimeout(run, delayMs);
        return () => clearTimeout(handle);
    }
};

export interface TakeableDurableWorkOwnership extends ALDurableWorkOwnership {
    take(): void;
}

/** A session ownership a test hands to this runtime when it chooses, as a released owner lock does. */
export function createTakeableDurableWorkOwnership(owned: boolean): TakeableDurableWorkOwnership {
    const value = new ObservableLatestValue<boolean>().set(owned);
    return {
        owned: value,
        isOwned: () => value.peek() === true,
        take: () => value.accept(true),
        announceCommit: () => undefined,
        onForeignCommit: () => () => undefined
    };
}
