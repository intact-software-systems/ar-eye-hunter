import { resolveCoverageBasisLayoutIdentity } from '@shared/api/group-lifecycle/compute-group-activation-condition.ts';
import { computeGroupFormationReading } from '@shared/api/group-lifecycle/compute-group-formation-reading.ts';
import { isSameGroupLayoutIdentity, toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { GroupMutationCommand } from '../../../group-state/mutation/group-mutation-contracts.ts';
import { toUpdateGroupActivationStatusCommand } from '../../../group-state/to-update-group-activation-status-command.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';

export interface GroupActivationStatusPort {
    submitCommand(command: GroupMutationCommand, atEpochMs: number): Promise<void>;
}

export interface GroupActivationStatusPetitionDependencies {
    readonly activationStatus?: GroupActivationStatusPort;
}

/**
 * The evidence leg of the observed status (product decision 3). It rides the
 * topology work cycle rather than widening the criterion's establishment
 * guard: `consumesFormationDeadlineAt` is the only thing keeping an `active`
 * group at zero criterion evaluations per minute, and widening it is what
 * turns that zero into one evaluation per accepted RTT mutation. Riding the
 * cycle instead inherits the dampers already between evidence and this
 * point -- the RTT refinement gate and the fingerprint skip -- so the status
 * costs no new evaluation rate of its own.
 *
 * Petitioning is not writing. The command re-authorizes through AppInbox
 * against fresh state, and its compute drops an equal-or-older watermark and
 * no-ops an unchanged band, so a steady group pays an enqueue and nothing
 * durable.
 */
export async function petitionGroupActivationStatus(
    dependencies: GroupActivationStatusPetitionDependencies,
    authority: GroupTopologyPlanningAuthority,
    planned: RallarOverlayTopologySnapshot | null
): Promise<void> {
    if (!dependencies.activationStatus) {
        return;
    }
    const group = authority.group.group;
    const basis = resolveCoverageBasisLayoutIdentity({
        lifecycleState: group.lifecycleState,
        accepted: group.acceptedLayoutIdentity ?? undefined,
        plannedCandidate: planned === null || planned.state !== 'active'
            ? undefined
            : toGroupLayoutIdentity(planned)
    });
    if (basis === undefined) {
        // No layout carries traffic or is being dialed, so there is no
        // coverage to report and no causal series to report it in.
        return;
    }
    if (
        planned === null || planned.state !== 'active' ||
        !isSameGroupLayoutIdentity(toGroupLayoutIdentity(planned), basis)
    ) {
        // Measure the layout the basis names or measure nothing. The snapshot
        // in hand is the one this work cycle committed, which is not always
        // the accepted layout the basis resolves to -- and reporting a
        // planned candidate's coverage as the accepted layout's is the exact
        // confusion slice 12a's review caught on the read surface.
        return;
    }
    const reading = computeGroupFormationReading({
        planned,
        rttMeasurements: authority.rttMeasurements,
        nowEpochMs: authority.nowEpochMs
    });
    await dependencies.activationStatus.submitCommand(
        toUpdateGroupActivationStatusCommand({
            groupRef: {
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                groupId: group.groupId
            },
            formationEpoch: group.formationEpoch,
            coverageBasisLayoutIdentity: basis,
            coverageRate: reading.readiness.observedRate,
            evidenceWatermark: reading.evidenceWatermark,
            dwell: null
        }),
        authority.nowEpochMs
    );
}
