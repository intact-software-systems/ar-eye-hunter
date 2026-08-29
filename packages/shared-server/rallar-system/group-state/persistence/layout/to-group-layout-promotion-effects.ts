import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    toStoredRtcTopologySnapshotRow
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { PlannedLayoutPromotion } from '../../mutation/aggregate/compute-planned-layout-promotion.ts';

/**
 * The accepted-layout facts as guarded-batch effects, all-or-nothing with the
 * group row (product decisions 24/42): the accepted row (insert on first
 * promotion, revision-guarded update after) and a revision-guarded rewrite of
 * the planned row itself — the causal fence's re-assertion inside the
 * transaction, so a replan that landed after the read conflicts the whole
 * batch instead of promoting a superseded plan (decisions 19/32). Both rows
 * carry the identical encoded snapshot by construction: `row` is computed
 * once and spread into every effect.
 */
/**
 * The causal fence re-asserted inside the transaction (product decisions
 * 19/32): a revision-guarded rewrite of the planned row the command was
 * fenced against, so a replan that landed between the read and the commit
 * conflicts the whole batch instead of letting a superseded command commit.
 * `connect` carries this alone — it dials a candidate without promoting it
 * (decision 42) — while a promotion emits the same guard plus its accepted
 * write.
 */
export function toPlannedLayoutFenceEffect(
    planned: Readonly<{ snapshot: RallarOverlayTopologySnapshot; revision: number; }>
): RuntimeStateGuardedBatchEffect {
    const row = toStoredRtcTopologySnapshotRow(planned.snapshot);
    return {
        effectId: 'planned-layout-fence',
        operation: 'update',
        namespace: RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
        expectedRevision: planned.revision,
        key: row.key,
        value: row.value,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export function toGroupLayoutPromotionEffects(
    promotion: Extract<PlannedLayoutPromotion, { outcome: 'apply'; }>
): readonly RuntimeStateGuardedBatchEffect[] {
    const row = toStoredRtcTopologySnapshotRow(promotion.acceptedSnapshot);
    const stored = {
        key: row.key,
        value: row.value,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    } as const;
    return [
        {
            effectId: 'planned-layout-fence',
            operation: 'update',
            namespace: RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            expectedRevision: promotion.plannedExpectedRevision,
            ...stored
        },
        promotion.acceptedExpectedRevision === null
            ? {
                effectId: 'accepted-layout',
                operation: 'insert',
                namespace: RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
                ...stored
            }
            : {
                effectId: 'accepted-layout',
                operation: 'update',
                namespace: RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
                expectedRevision: promotion.acceptedExpectedRevision,
                ...stored
            }
    ];
}
