import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import {
    GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
    GroupConnectTriggerLatchRepository,
    toGroupConnectTriggerStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import type { RtcTopologyMutationRead } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { computeFormationCriterionCommand } from '@shared-server/rallar-system/topology/replay/work/compute-formation-criterion-command.ts';
import {
    createDeferredCriterionPetitioner,
    petitionFormationCriterion,
    petitionGroupStageTrigger,
    type DeferredCriterionPetitionDependencies,
    type StageTriggerPetitionDependencies
} from '@shared-server/rallar-system/topology/replay/work/formation-criterion-observer.ts';
import type { PersistedRtcTopologyWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type {
    GroupLifecyclePolicy,
    GroupLifecycleState,
    GroupStageTrigger
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
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

    authority(): GroupTopologyPlanningAuthority {
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

const PRESENCE_PLAN: GroupStageTrigger = { kind: 'presence', memberCount: 2, fallbackMs: 5_000 };

function createStageTriggerPolicy(
    planTrigger: GroupStageTrigger,
    connectTrigger: GroupStageTrigger
): GroupLifecyclePolicy {
    const managed = resolveGroupLifecyclePolicyPreset('managed');
    return { ...managed, establishment: { ...managed.establishment, planTrigger, connectTrigger } };
}

interface StageTriggerHarness {
    readonly dependencies: StageTriggerPetitionDependencies;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly commands: GroupMutationCommand[];
    readonly latches: GroupConnectTriggerLatchRepository;
}

async function createStageTriggerHarness(
    input: Readonly<{
        lifecycleState: GroupLifecycleState;
        onlineMemberCount: number;
        policy: GroupLifecyclePolicy | 'corrupt';
        readonly awaitingLatchNotBeforeEpochMs: number | null;
    }>
): Promise<StageTriggerHarness> {
    const snapshot = {
        ...base,
        group: { ...base.group, lifecycleState: input.lifecycleState, formationEpoch: 2 },
        onlineMemberCount: input.onlineMemberCount
    };
    const runtime = new FakeRuntimeStateRepository();
    const latches = new GroupConnectTriggerLatchRepository(runtime);
    const identity = {
        groupRef: {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        },
        formationEpoch: 2,
        triggerGeneration: 'plan-1'
    };
    if (input.awaitingLatchNotBeforeEpochMs !== null) {
        await runtime.upsert(
            GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
            toGroupConnectTriggerStorageKey(identity),
            JSON.stringify({
                ...identity,
                notBeforeEpochMs: input.awaitingLatchNotBeforeEpochMs,
                supersedesLayoutIdentity: null,
                state: 'awaiting-publication'
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
    }
    const commands: GroupMutationCommand[] = [];
    const policyRead: GroupLifecyclePolicyRead = input.policy === 'corrupt'
        ? { status: 'corrupt', reason: 'not json' }
        : { status: 'present', policy: input.policy };
    return {
        commands,
        latches,
        authority: {
            group: snapshot,
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttMeasurements: [],
            replanning: 'auto',
            nowEpochMs: 4_000
        },
        dependencies: {
            formationCriterion: { readLifecyclePolicy: async () => policyRead },
            formationAutomation: {
                latches,
                readGroup: async () => snapshot.group,
                readPlanned: async () => planned,
                submitCommand: async (command) => {
                    commands.push(command);
                },
                nowEpochMs: () => 4_000
            }
        }
    };
}

describe('presence stage trigger petition', () => {
    it('plans a forming group once its member threshold is met', async () => {
        const harness = await createStageTriggerHarness({
            lifecycleState: 'forming',
            onlineMemberCount: 2,
            policy: createStageTriggerPolicy(PRESENCE_PLAN, { kind: 'manual' }),
            awaitingLatchNotBeforeEpochMs: null
        });

        await petitionGroupStageTrigger(harness.dependencies, harness.authority);
        await petitionGroupStageTrigger(harness.dependencies, harness.authority);

        expect(harness.commands.map((command) => command.operation)).toEqual(['planGroupLayout', 'planGroupLayout']);
        expect(new Set(harness.commands.map((command) => command.commandId)).size).toBe(1);
        expect(harness.commands[0]!.commandId).toContain('formation-automation:v2:presence-plan:');
    });

    it('waits below the threshold', async () => {
        const harness = await createStageTriggerHarness({
            lifecycleState: 'forming',
            onlineMemberCount: 1,
            policy: createStageTriggerPolicy(PRESENCE_PLAN, { kind: 'manual' }),
            awaitingLatchNotBeforeEpochMs: null
        });

        await petitionGroupStageTrigger(harness.dependencies, harness.authority);

        expect(harness.commands).toEqual([]);
    });

    // Both stages that hold a planned candidate answer to the connect
    // trigger, so the threshold fires ahead of the fallback at either.
    it.each(['planned', 'reconfiguring'] as const)(
        'connects a %s group before its fallback once the threshold is met',
        async (lifecycleState) => {
            const harness = await createStageTriggerHarness({
                lifecycleState,
                onlineMemberCount: 2,
                policy: createStageTriggerPolicy({ kind: 'manual' }, PRESENCE_PLAN),
                awaitingLatchNotBeforeEpochMs: 9_000
            });

            await petitionGroupStageTrigger(harness.dependencies, harness.authority);

            expect(harness.commands.map((command) => command.operation)).toEqual(['connectGroup']);
        }
    );

    it.each([
        ['manual', { kind: 'manual' } as const],
        ['immediate', { kind: 'immediate' } as const],
        ['after', { kind: 'after', settleMs: 400 } as const]
    ])('leaves the %s plan trigger to its timer leg', async (_kind, trigger) => {
        const harness = await createStageTriggerHarness({
            lifecycleState: 'forming',
            onlineMemberCount: 5,
            policy: createStageTriggerPolicy(trigger, { kind: 'manual' }),
            awaitingLatchNotBeforeEpochMs: null
        });

        await petitionGroupStageTrigger(harness.dependencies, harness.authority);

        expect(harness.commands).toEqual([]);
    });

    it('petitions nothing for a group whose formation is immediate', async () => {
        const managed = createStageTriggerPolicy(PRESENCE_PLAN, { kind: 'manual' });
        const harness = await createStageTriggerHarness({
            lifecycleState: 'forming',
            onlineMemberCount: 5,
            policy: { ...managed, formation: 'immediate' },
            awaitingLatchNotBeforeEpochMs: null
        });

        await petitionGroupStageTrigger(harness.dependencies, harness.authority);

        expect(harness.commands).toEqual([]);
    });

    it('petitions nothing on a corrupt stored policy', async () => {
        const harness = await createStageTriggerHarness({
            lifecycleState: 'forming',
            onlineMemberCount: 5,
            policy: 'corrupt',
            awaitingLatchNotBeforeEpochMs: null
        });

        await petitionGroupStageTrigger(harness.dependencies, harness.authority);

        expect(harness.commands).toEqual([]);
    });

    it('petitions nothing from a stage no trigger governs', async () => {
        const harness = await createStageTriggerHarness({
            lifecycleState: 'active',
            onlineMemberCount: 5,
            policy: createStageTriggerPolicy(PRESENCE_PLAN, PRESENCE_PLAN),
            awaitingLatchNotBeforeEpochMs: null
        });

        await petitionGroupStageTrigger(harness.dependencies, harness.authority);

        expect(harness.commands).toEqual([]);
    });
});
