import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    toStoredRtcTopologySnapshotRow
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import {
    toRtcTopologyFingerprintNamespace,
    toStoredRtcTopologyInputFingerprintValue
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { PlannedLayoutPromotion } from '../../mutation/aggregate/compute-planned-layout-promotion.ts';
import type { GroupLayoutTombstones } from '../../mutation/group-mutation-contracts.ts';

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

/**
 * Reset preserves both layout rows as revision-guarded removal tombstones, so
 * teardown identity remains durable while a concurrent replan still conflicts.
 */
export function toGroupLayoutTombstoneEffects(
    tombstones: GroupLayoutTombstones
): readonly RuntimeStateGuardedBatchEffect[] {
    return [
        toLayoutTombstoneEffect('planned-layout-tombstone', RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, tombstones.planned),
        toLayoutTombstoneEffect(
            'accepted-layout-tombstone',
            RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
            tombstones.accepted
        )
    ].filter((effect): effect is RuntimeStateGuardedBatchEffect => effect !== null);
}

function toLayoutTombstoneEffect(
    effectId: string,
    namespace: string,
    tombstone: Readonly<{ snapshot: RallarOverlayTopologySnapshot; revision: number; }> | null
): RuntimeStateGuardedBatchEffect | null {
    if (tombstone === null) {
        return null;
    }
    const row = toStoredRtcTopologySnapshotRow(tombstone.snapshot);
    return {
        effectId,
        operation: 'update',
        namespace,
        expectedRevision: tombstone.revision,
        key: row.key,
        value: row.value,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

/**
 * Applies an accepted-layout promotion atomically with the group row: the
 * planned revision fence prevents a stale promotion and the accepted slot is
 * inserted or updated at the revision compute observed.
 */
export function toGroupLayoutPromotionEffects(
    promotion: Extract<PlannedLayoutPromotion, { outcome: 'apply'; }>
): readonly RuntimeStateGuardedBatchEffect[] {
    const row = toStoredRtcTopologySnapshotRow(promotion.acceptedSnapshot);
    const stored = {
        key: row.key,
        value: row.value,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    } as const;
    const effects: RuntimeStateGuardedBatchEffect[] = [
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
    if (promotion.acceptedInputFingerprint !== null) {
        // Unguarded on purpose: the fingerprint row is derived from the planned
        // row the fence above already guards, so it can only follow that fence.
        effects.push({
            effectId: 'accepted-layout-fingerprint',
            operation: 'put',
            namespace: toRtcTopologyFingerprintNamespace('accepted'),
            key: row.key,
            value: toStoredRtcTopologyInputFingerprintValue(
                promotion.acceptedSnapshot.groupRef,
                promotion.acceptedInputFingerprint
            ),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
    }
    return effects;
}
