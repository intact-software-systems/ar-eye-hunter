import { readGroupRetentionState } from '@shared/api/group-retention.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { startDrainableRepeating } from '@shared/resilience/timing/start-drainable-repeating.ts';

import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import type { GroupRetentionService } from './group-retention-service.ts';

export interface StartGroupRetentionReconciliationInput {
    readonly repository: Pick<GroupStateRepository, 'listGroupsPage'>;
    readonly enqueue: (command: GroupRetentionService.Command) => Promise<void>;
    readonly timers: Timers;
    readonly now: () => number;
    readonly newObservationId: () => string;
    readonly onFailure: (error: Error) => void;
    readonly intervalMs: number;
    readonly pageSize: number;
}

interface RetentionScanCursor {
    afterKey: string | null;
}

/** One bounded page per run; stop cancels the next run and drains the current one before returning. */
export function startGroupRetentionReconciliation(input: StartGroupRetentionReconciliationInput): () => Promise<void> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 500) {
        throw new TypeError('Retention page size must be an integer from 1 through 500');
    }
    const cursor: RetentionScanCursor = { afterKey: null };
    return startDrainableRepeating({
        timers: input.timers,
        intervalMs: input.intervalMs,
        firstRun: 'after-interval',
        retryBackoff: { baseMs: input.intervalMs, maxMs: input.intervalMs * 4 },
        onFailure: input.onFailure,
        run: (stopping) => reconcileGroupRetention(input, cursor, stopping)
    });
}

async function reconcileGroupRetention(
    input: StartGroupRetentionReconciliationInput,
    cursor: RetentionScanCursor,
    stopping: AbortSignal
): Promise<void> {
    const page = await input.repository.listGroupsPage({
        limit: input.pageSize,
        ...(cursor.afterKey === null ? {} : { afterKey: cursor.afterKey })
    });
    if (stopping.aborted) {
        return;
    }
    const requestId = input.newObservationId();
    const observedAtEpochMs = input.now();
    for (const group of page.groups) {
        if (stopping.aborted) {
            return;
        }
        if (
            (group.status === 'active' || group.status === 'archived') &&
            readGroupRetentionState(group.metadata) !== null
        ) {
            await input.enqueue({ groupRef: toCanonicalGroupRef(group), requestId, observedAtEpochMs });
        }
    }
    cursor.afterKey = page.nextKey;
}
