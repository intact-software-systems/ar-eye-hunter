import { isSameGroupLayoutIdentity, toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { computeTopologyPromotionEntry } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import {
    PSqlResourceInboxEntryRepository,
    ResourceInboxInvariantCorruptionError
} from '../../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';

/**
 * The route-less promotion producer's read surface (decision 27): present
 * only when a consumer is installed, and enqueueing only for groups whose
 * topology policy lands reconfigurations with `apply`.
 */
export interface TopologyPromotionPublicationPort {
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    /** The current group facts, never the work payload's enqueue-time copy. */
    readonly findCurrentGroup: (ref: GroupRef) => Promise<Group | null>;
}

export interface WriteTopologyPromotionRequestInput {
    readonly publication: TopologyPromotionPublicationPort | undefined;
    readonly serviceId: string | undefined;
    readonly transaction: PSqlSql;
    readonly entry: ResourceEntry;
    readonly target: RallarOverlayTopologySnapshot | null;
}

/**
 * Decision 27: an accepted apply-landing planned publication durably requests
 * the route-less promotion. Every gate fact is read fresh here — the current
 * group snapshot, never the work payload's enqueue-time copy — and the write
 * also reconciles: a request is minted whenever the group's accepted
 * identity trails the target layout, so a cycle that once saw a stale stage
 * heals on the next pass. The cheap checks run before the policy read; hold
 * promotes only through activate; a corrupt policy and an absent consumer
 * port fail closed; and the entry never expires, so an outbox backlog delays
 * a promotion but cannot drop it.
 */
export async function writeTopologyPromotionRequest(
    input: WriteTopologyPromotionRequestInput
): Promise<void> {
    const { publication, target } = input;
    if (!publication || target === null || target.state !== 'active') {
        return;
    }
    const group = await publication.findCurrentGroup(target.groupRef);
    if (group === null || group.lifecycleState !== 'active') {
        return;
    }
    const targetIdentity = toGroupLayoutIdentity(target);
    if (
        group.acceptedLayoutIdentity !== null &&
        isSameGroupLayoutIdentity(group.acceptedLayoutIdentity, targetIdentity)
    ) {
        return;
    }
    const policyRead = await publication.readLifecyclePolicy(target.groupRef);
    if (policyRead.status === 'corrupt') {
        return;
    }
    const policy = policyRead.status === 'present'
        ? policyRead.policy
        : createDefaultGroupLifecyclePolicy();
    if (policy.topology.reconfigureLanding !== 'apply') {
        return;
    }
    try {
        await new PSqlResourceInboxEntryRepository(input.transaction).writeIfAbsentOrMatch(
            computeTopologyPromotionEntry({
                work: {
                    groupRef: target.groupRef,
                    formationEpoch: group.formationEpoch,
                    expectedLayout: targetIdentity
                },
                senderId: input.serviceId ?? 'topology-promotion',
                createdAtEpochMs: input.entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds,
                expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS
            })
        );
    }
    catch (error) {
        // A same-identity request with different audit bytes already exists:
        // the promotion is already durably requested, which is this write's
        // whole goal — swallow the mismatch instead of wedging the
        // publication transaction.
        if (!(error instanceof ResourceInboxInvariantCorruptionError)) {
            throw error;
        }
    }
}
