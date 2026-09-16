import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';

export function distributedRunDuration(run: ControlDistributedRunSnapshot): number | undefined {
    const start = run.startedAtEpochMs ?? run.stagedAtEpochMs ?? run.createdAtEpochMs;
    const end = run.completedAtEpochMs ?? run.cancelledAtEpochMs ?? run.updatedAtEpochMs;
    return end >= start ? end - start : undefined;
}
