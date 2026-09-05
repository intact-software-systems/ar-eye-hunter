import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import {
    acceptGroupStateDeltaEnvelope,
    type GroupStateDeltaAcceptance
} from '../state-cache/group-state-delta-application.ts';
import {
    acceptAuthoritativeGroupStateSnapshot,
    acceptGroupStateSnapshotsOrRecompute
} from '../state-cache/state-cache-snapshot-adoption.ts';
import { emitBrowserStateReadDiagnostic } from './diagnostics.ts';
import { readStateGroupSnapshot } from './point-read.ts';

export namespace ReconcileGroupStateDelta {
    export interface Input {
        readonly envelope: GroupStateDeltaEnvelope;
        readonly scope: StateScope;
        readonly rereadGroupSnapshots:
            | ((
                scope: StateScope
            ) => Promise<readonly GroupSnapshot[]>)
            | undefined;
    }
}

export type GroupStateDeltaReconciliation =
    | 'applied'
    | 'no-op'
    | 'gap-pull'
    | 'revision-conflict';

export async function reconcileGroupStateDelta(
    input: ReconcileGroupStateDelta.Input
): Promise<GroupStateDeltaReconciliation> {
    const startedAtMs = performance.now();
    const acceptance = await acceptGroupStateDeltaEnvelope(
        input.envelope,
        input.scope,
        input.rereadGroupSnapshots
    );
    if (acceptance === 'refresh-required' || acceptance === 'revision-conflict') {
        await refreshGroupStateAtDeltaFloor(input);
    }
    return emitGroupStateDeltaDiagnostic(
        reconciliationResult(acceptance),
        startedAtMs
    );
}

async function refreshGroupStateAtDeltaFloor(
    input: ReconcileGroupStateDelta.Input
): Promise<void> {
    try {
        const pulled = await readStateGroupSnapshot(
            input.envelope.group.groupId,
            input.scope,
            { minCausalRevision: input.envelope.resultingCausalRevision }
        );
        await acceptAuthoritativeGroupStateSnapshot(
            pulled.snapshot,
            input.scope,
            input.rereadGroupSnapshots
        );
    }
    catch {
        await rereadGroupSnapshotsAfterFailedPointRead(input);
    }
}

async function rereadGroupSnapshotsAfterFailedPointRead(
    input: ReconcileGroupStateDelta.Input
): Promise<void> {
    if (input.rereadGroupSnapshots === undefined) {
        return;
    }
    try {
        const snapshots = await input.rereadGroupSnapshots(input.scope);
        await acceptGroupStateSnapshotsOrRecompute(
            snapshots,
            input.scope,
            input.rereadGroupSnapshots
        );
    }
    catch {
        // The standing heartbeat refresh remains the recovery owner when both reads fail.
    }
}

function reconciliationResult(
    acceptance: GroupStateDeltaAcceptance
): GroupStateDeltaReconciliation {
    return acceptance === 'refresh-required' ? 'gap-pull' : acceptance;
}

function emitGroupStateDeltaDiagnostic(
    reconciliation: GroupStateDeltaReconciliation,
    startedAtMs: number
): GroupStateDeltaReconciliation {
    emitBrowserStateReadDiagnostic({
        name: 'rallar.browser.state-read',
        feature: 'group',
        operation: 'delta-apply',
        result: reconciliation,
        durationMs: performance.now() - startedAtMs
    });
    return reconciliation;
}
