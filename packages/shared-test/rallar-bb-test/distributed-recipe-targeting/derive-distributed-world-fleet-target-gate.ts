import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxDistributedTargetResolution } from '../distributed-run.ts';
import type { DistributedWorldFleetTargetGate } from './distributed-recipe-target-contracts.ts';

export function deriveDistributedWorldFleetTargetGate(
    input: Readonly<{
        usesWorldFleetTargets: boolean;
        expectedParticipantCount?: number;
        targetResolutionPreview?: RallarBlackBoxDistributedTargetResolution;
        selectedDistributedRun?: ControlDistributedRunSnapshot;
        distributedRunId?: string;
    }>
): DistributedWorldFleetTargetGate {
    const selectedRunUsesWorldFleetTargets =
        input.selectedDistributedRun?.manifest.targetPolicy.mode === 'all-online-group-members';
    const selectedRunMatchesDraft = input.distributedRunId === undefined ||
        input.selectedDistributedRun?.distributedRunId === input.distributedRunId;
    const useSelectedRunResolution = selectedRunUsesWorldFleetTargets &&
        (!input.usesWorldFleetTargets || selectedRunMatchesDraft);
    const targetResolution = input.usesWorldFleetTargets
        ? input.targetResolutionPreview ??
            (useSelectedRunResolution ? input.selectedDistributedRun?.targetResolution : undefined)
        : useSelectedRunResolution
        ? input.selectedDistributedRun?.targetResolution
        : undefined;
    const usesWorldFleetTargets = input.usesWorldFleetTargets || useSelectedRunResolution;
    const expectedParticipantCount = input.usesWorldFleetTargets
        ? input.expectedParticipantCount
        : useSelectedRunResolution
        ? input.selectedDistributedRun?.manifest.targetPolicy.expectedParticipantCount
        : undefined;
    const previewSelected = usesWorldFleetTargets
        ? targetResolution?.summary.selected
        : undefined;
    const resolutionExpected = targetResolution?.summary.expectedParticipantCount;
    const blocked = usesWorldFleetTargets &&
        (
            targetResolution === undefined ||
            expectedParticipantCount === undefined ||
            resolutionExpected !== expectedParticipantCount ||
            previewSelected !== expectedParticipantCount
        );
    const blockReason = blocked
        ? targetResolution === undefined
            ? 'Resolve world-fleet targets before staging or starting.'
            : `Resolved ${previewSelected ?? 0}/${expectedParticipantCount ?? 'unknown'} world-fleet target(s).`
        : undefined;

    return {
        usesWorldFleetTargets,
        targetResolution,
        expectedParticipantCount,
        previewSelected,
        blocked,
        blockReason
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function uniqueValues<T extends string>(values: readonly T[]): readonly T[] {
    return [...new Set(values)].sort();
}
