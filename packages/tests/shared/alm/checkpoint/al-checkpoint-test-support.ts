import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';

export const TEST_CHECKPOINT_SETTINGS: ALCheckpointWriter.Settings = { intervalMs: 1_000, lagBoundMs: 10_000 };

/** The global timers, read at each call, so a test's fake timers drive the writer. */
export const GLOBAL_CHECKPOINT_TIMERS: ALCheckpointWriter.Timers = {
    schedule: (run, delayMs) => {
        const handle = setTimeout(run, delayMs);
        return () => clearTimeout(handle);
    }
};
