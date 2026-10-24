import { readGroupRetentionState } from '@shared/api/group-retention.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

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

interface RetentionScanLifecycle {
    stopped: boolean;
    cursor: string | null;
    pending: Promise<void>;
}

/** One bounded page per run; stop cancels the next run and drains the current one before returning. */
export function startGroupRetentionReconciliation(input: StartGroupRetentionReconciliationInput): () => Promise<void> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 500) {
        throw new TypeError('Retention page size must be an integer from 1 through 500');
    }
    const lifecycle: RetentionScanLifecycle = { stopped: false, cursor: null, pending: Promise.resolve() };
    const stopRepeating = startRepeating({
        timers: input.timers,
        intervalMs: input.intervalMs,
        firstRun: 'after-interval',
        retryBackoff: { baseMs: input.intervalMs, maxMs: input.intervalMs * 4 },
        run: () => {
            lifecycle.pending = reconcileGroupRetention(input, lifecycle).catch((error) => {
                const failure = toError(error);
                input.onFailure(failure);
                throw failure;
            });
            return lifecycle.pending;
        }
    });
    return async () => {
        lifecycle.stopped = true;
        stopRepeating();
        // Failures already reached onFailure and the repeating scheduler; stopping only drains that owned run.
        await lifecycle.pending.catch(() => undefined);
    };
}

async function reconcileGroupRetention(
    input: StartGroupRetentionReconciliationInput,
    lifecycle: RetentionScanLifecycle
): Promise<void> {
    const page = await input.repository.listGroupsPage({
        limit: input.pageSize,
        ...(lifecycle.cursor === null ? {} : { afterKey: lifecycle.cursor })
    });
    if (lifecycle.stopped) {
        return;
    }
    const requestId = input.newObservationId();
    const observedAtEpochMs = input.now();
    for (const group of page.groups) {
        if (lifecycle.stopped) {
            return;
        }
        if (group.status === 'active' && readGroupRetentionState(group.metadata) !== null) {
            await input.enqueue({ groupRef: toCanonicalGroupRef(group), requestId, observedAtEpochMs });
        }
    }
    lifecycle.cursor = page.nextKey;
}
