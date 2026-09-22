import type { DistributedArtifactEvidenceEntry } from '../distributed-artifact-evidence-contracts.ts';
import { compareEvidenceEntries } from './compare-evidence-entries.ts';

/**
 * The failed result with failure details that ranks first: a result of the failing command before any other, then
 * the evidence order. The failing command is undefined when the analysis names none.
 */
export function resolvePrimaryDistributedArtifactResultFailure<Entry extends DistributedArtifactEvidenceEntry>(
    entries: readonly Entry[],
    failureCommandId: string | undefined
): Entry | undefined {
    let selected: Entry | undefined;
    for (const entry of entries) {
        if (entry.kind !== 'result' || entry.status !== 'failed' || !entry.failureDetails) {
            continue;
        }
        if (!selected || comparePrimaryResultFailures(entry, selected, failureCommandId) < 0) {
            selected = entry;
        }
    }
    return selected;
}

function comparePrimaryResultFailures(
    left: DistributedArtifactEvidenceEntry,
    right: DistributedArtifactEvidenceEntry,
    failureCommandId: string | undefined
): number {
    return computeResultFailureCorrelationRank(left, failureCommandId) -
            computeResultFailureCorrelationRank(right, failureCommandId) ||
        compareEvidenceEntries(left, right);
}

function computeResultFailureCorrelationRank(
    entry: DistributedArtifactEvidenceEntry,
    failureCommandId: string | undefined
): number {
    return failureCommandId !== undefined && entry.commandId !== failureCommandId ? 1 : 0;
}
