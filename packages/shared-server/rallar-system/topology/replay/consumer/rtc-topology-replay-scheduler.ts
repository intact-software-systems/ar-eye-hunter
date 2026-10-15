import { startRepeating } from '@shared/resilience/repeating-run.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

export interface RtcTopologyReplayServiceScheduler {
    repeat(task: () => void, intervalMs: number): () => void;
    yield(): Promise<void>;
}

export function rotateRtcTopologyReplayPublishers<T>(
    values: readonly T[],
    offset: number
): readonly T[] {
    if (values.length < 2 || offset === 0) {
        return values;
    }
    return [...values.slice(offset), ...values.slice(0, offset)];
}

const timers = createDefaultTimers();

export const defaultRtcTopologyReplayScheduler: RtcTopologyReplayServiceScheduler = {
    repeat: (task, intervalMs) => startRepeating({ timers, intervalMs, firstRun: 'after-interval', run: task }),
    yield: () => new Promise<void>((resolve) => timers.schedule(resolve, 0))
};
