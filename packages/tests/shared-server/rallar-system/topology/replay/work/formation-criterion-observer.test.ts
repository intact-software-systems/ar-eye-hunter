import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import type { RtcTopologyMutationRead } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { computeFormationCriterionCommand } from '@shared-server/rallar-system/topology/replay/work/compute-formation-criterion-command.ts';
import {
    createDeferredCriterionPetitioner,
    petitionFormationCriterion,
    type DeferredCriterionPetitionDependencies
} from '@shared-server/rallar-system/topology/replay/work/formation-criterion-observer.ts';
import type { PersistedRtcTopologyWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { describe, expect, it } from 'vitest';
import { storedEntry } from '../../../group-state/mutation/group-mutation-test-runtime.ts';
import { createTopologyTestGroupSnapshot } from '../../config/mutation/group-topology-config-mutation-test-fixtures.ts';

const base = createTopologyTestGroupSnapshot();
const group = { ...base, group: { ...base.group, lifecycleState: 'connecting' as const, formationEpoch: 2, establishmentStartedAtEpochMs: 1000 } };
const planned: RallarOverlayTopologySnapshot = {
    groupRef: group.group,
    overlayId: toScopedOverlayId(group.group),
    name: 'candidate',
    topology: 'tree',
    degreeLimit: 2,
    activeSessionIds: [],
    nextHopsBySessionId: {},
    version: 1,
    state: 'active',
    sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 0 },
    createdByClientId: 'server',
    createdAtEpochMs: 1000,
    updatedAtEpochMs: 1000
};
const work: PersistedRtcTopologyWork = {
    kind: 'group-revision',
    overlayId: planned.overlayId,
    groupSnapshot: group,
    sourceGroupStateCausalRevision: planned.sourceGroupStateCausalRevision,
    requestedAtEpochMs: 1000,
    requestOptions: toCanonicalGroupTopologyConfigPatch({}),
    origin: 'automatic',
    publish: true
};

class ObserverHarness {
    private nowEpochMs = 1000;
    private policy: GroupLifecyclePolicyRead = { status: 'present', policy: resolveGroupLifecyclePolicyPreset('managed') };
    private currentRead: RtcTopologyMutationRead = { snapshot: storedEntry('plan', planned), publicationClaim: null };
    readonly calls: string[] = [];
    readonly submitted: GroupMutationCommand[] = [];
    readonly scheduled: Array<{ delayMs: number; callback: () => Promise<void>; }> = [];
    readonly dependencies: DeferredCriterionPetitionDependencies;

    constructor() {
        this.dependencies = {
            topologyPlanning: {
                readTopologyPlanningAuthority: async () => {
                    this.calls.push('authority');
                    return this.authority();
                }
            },
            executionRepository: {
                readTopologyMutation: async () => {
                    this.calls.push('plan');
                    return this.currentRead;
                }
            },
            formationCriterion: {
                readLifecyclePolicy: async () => {
                    this.calls.push('policy');
                    return this.policy;
                },
                submitCommand: async (command) => {
                    this.calls.push('submit');
                    this.submitted.push(command);
                },
                deferred: {
                    minIntervalMs: 500,
                    nowEpochMs: () => this.nowEpochMs,
                    schedule: (delayMs, callback) => {
                        this.scheduled.push({ delayMs, callback });
                    }
                }
            }
        };
    }

    authority() {
        return {
            group,
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttMeasurements: [],
            replanning: 'auto' as const,
            nowEpochMs: this.nowEpochMs
        };
    }

    read(): RtcTopologyMutationRead {
        return this.currentRead;
    }

    advanceTo(value: number): void {
        this.nowEpochMs = value;
    }

    replacePolicy(value: GroupLifecyclePolicyRead): void {
        this.policy = value;
    }

    removePlan(): void {
        this.currentRead = { ...this.currentRead, snapshot: storedEntry('plan', { ...planned, state: 'removed' }) };
    }
}

describe('formation criterion read and scheduling owner', () => {
    it('computes synchronously from policy values and fails closed for corrupt policy', () => {
        const input = { group, planned, rttMeasurements: [], nowEpochMs: 1000 };
        expect(
            computeFormationCriterionCommand({ ...input, lifecyclePolicy: { status: 'present', policy: resolveGroupLifecyclePolicyPreset('managed') } })
                ?.operation
        ).toBe('activateGroup');
        expect(computeFormationCriterionCommand({ ...input, lifecyclePolicy: { status: 'corrupt', reason: 'bad row' } })).toBeNull();
        expect(computeFormationCriterionCommand({ ...input, lifecyclePolicy: { status: 'absent' } })).toBeNull();
    });

    it('owns the policy read before computing and submitting a publication petition', async () => {
        const harness = new ObserverHarness();
        await petitionFormationCriterion(harness.dependencies, harness.authority(), planned);
        expect(harness.calls).toEqual(['policy', 'submit']);
        expect(harness.submitted).toHaveLength(1);
    });

    it.each(
        [
            { stage: 'reconfiguring', state: 'active' },
            { stage: 'connecting', state: 'removed' }
        ] as const
    )('skips policy I/O for $stage with a $state plan', async ({ stage, state }) => {
        const harness = new ObserverHarness();
        const authority = harness.authority();
        await petitionFormationCriterion(harness.dependencies, {
            ...authority,
            group: { ...group, group: { ...group.group, lifecycleState: stage } }
        }, { ...planned, state });
        expect(harness.calls).toEqual([]);
        expect(harness.submitted).toEqual([]);
    });

    it('uses the injected clock and one trailing schedule, then rereads current policy', async () => {
        const harness = new ObserverHarness();
        const observer = createDeferredCriterionPetitioner(harness.dependencies)!;
        await observer.request(work, harness.read());
        expect(harness.calls).toEqual(['authority', 'policy', 'submit']);
        harness.advanceTo(1100);
        await observer.request(work, harness.read());
        harness.advanceTo(1200);
        await observer.request(work, harness.read());
        expect(harness.scheduled.map((entry) => entry.delayMs)).toEqual([400]);
        expect(harness.submitted).toHaveLength(1);
        harness.replacePolicy({ status: 'corrupt', reason: 'changed after scheduling' });
        harness.advanceTo(1500);
        await harness.scheduled[0].callback();
        expect(harness.calls).toEqual(['authority', 'policy', 'submit', 'plan', 'authority', 'policy']);
        expect(harness.submitted).toHaveLength(1);
        harness.replacePolicy({ status: 'present', policy: resolveGroupLifecyclePolicyPreset('managed') });
        harness.advanceTo(2000);
        await observer.request(work, harness.read());
        expect(harness.submitted).toHaveLength(2);
    });

    it('does not petition a plan removed before the trailing callback runs', async () => {
        const harness = new ObserverHarness();
        const observer = createDeferredCriterionPetitioner(harness.dependencies)!;
        await observer.request(work, harness.read());
        harness.advanceTo(1100);
        await observer.request(work, harness.read());
        harness.removePlan();
        harness.advanceTo(1500);
        await harness.scheduled[0].callback();
        expect(harness.calls).toEqual(['authority', 'policy', 'submit', 'plan']);
        expect(harness.submitted).toHaveLength(1);
    });
});
