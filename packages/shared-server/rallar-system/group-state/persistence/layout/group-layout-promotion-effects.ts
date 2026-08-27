import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    toStoredRtcTopologySnapshotRow
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_INPUT_FINGERPRINTS_NAMESPACE,
    toStoredRtcTopologyInputFingerprintValue
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { PlannedLayoutPromotion } from '../../mutation/aggregate/compute-planned-layout-promotion.ts';

/**
 * The accepted-layout facts as guarded-batch effects, all-or-nothing with the
 * group row (product decisions 24/42): the accepted row (insert on first
 * promotion, revision-guarded update after), the copied input fingerprint,
 * and a revision-guarded rewrite of the planned row itself — the causal
 * fence's re-assertion inside the transaction, so a replan that landed after
 * the read conflicts the whole batch instead of promoting a superseded plan
 * (decisions 19/32, the PR 3 review's acceptance criterion).
 */
export function groupLayoutPromotionEffects(
    ref: GroupRef,
    promotion: Extract<PlannedLayoutPromotion, { outcome: 'apply'; }>
): readonly RuntimeStateGuardedBatchEffect[] {
    const row = toStoredRtcTopologySnapshotRow(promotion.acceptedSnapshot);
    const effects: RuntimeStateGuardedBatchEffect[] = [
        {
            effectId: 'planned-layout-fence',
            operation: 'update',
            namespace: RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            key: row.key,
            value: row.value,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision: promotion.plannedExpectedRevision
        },
        promotion.acceptedExpectedRevision === null
            ? {
                effectId: 'accepted-layout',
                operation: 'insert',
                namespace: RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
                key: row.key,
                value: row.value,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
            : {
                effectId: 'accepted-layout',
                operation: 'update',
                namespace: RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
                key: row.key,
                value: row.value,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision: promotion.acceptedExpectedRevision
            }
    ];
    if (promotion.acceptedFingerprint !== null) {
        effects.push({
            effectId: 'accepted-layout-fingerprint',
            operation: 'put',
            namespace: RTC_TOPOLOGY_ACCEPTED_INPUT_FINGERPRINTS_NAMESPACE,
            key: row.key,
            value: toStoredRtcTopologyInputFingerprintValue(ref, promotion.acceptedFingerprint),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
    }
    return effects;
}
