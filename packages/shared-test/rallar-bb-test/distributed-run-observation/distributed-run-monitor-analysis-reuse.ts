import type { ControlDistributedRunCommandPhase, ControlDistributedRunSnapshot } from '../control-snapshots.ts';

export interface DistributedRunMonitorAnalysisReuse {
    readonly firstCommandPhasesById: ReadonlyMap<string, ControlDistributedRunCommandPhase>;
    readonly distributedRunAuthority: WeakSet<object>;
    readonly commandLinksAuthority: WeakSet<object>;
}

export interface SetDistributedRunMonitorAnalysisReuseInput {
    readonly monitor: object;
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly firstCommandPhasesById: ReadonlyMap<string, ControlDistributedRunCommandPhase>;
}

const analysisReuseByMonitor = new WeakMap<object, DistributedRunMonitorAnalysisReuse>();

/** Keeps the command phases a report derived from this monitor reuses while it reads the same run and command links. */
export function setDistributedRunMonitorAnalysisReuse(input: SetDistributedRunMonitorAnalysisReuseInput): void {
    analysisReuseByMonitor.set(input.monitor, {
        firstCommandPhasesById: input.firstCommandPhasesById,
        distributedRunAuthority: new WeakSet([input.distributedRun]),
        commandLinksAuthority: new WeakSet([input.distributedRun.commandLinks])
    });
}

export function getDistributedRunMonitorAnalysisReuse(
    monitor: object,
    distributedRun: ControlDistributedRunSnapshot
): DistributedRunMonitorAnalysisReuse | undefined {
    const reuse = analysisReuseByMonitor.get(monitor);
    return reuse?.distributedRunAuthority.has(distributedRun) === true &&
            reuse.commandLinksAuthority.has(distributedRun.commandLinks)
        ? reuse
        : undefined;
}

export function getDistributedRunMonitorFirstPhase(
    reuse: DistributedRunMonitorAnalysisReuse,
    commandId: string | undefined
): ControlDistributedRunCommandPhase | undefined {
    return commandId === undefined
        ? undefined
        : reuse.firstCommandPhasesById.get(commandId);
}
