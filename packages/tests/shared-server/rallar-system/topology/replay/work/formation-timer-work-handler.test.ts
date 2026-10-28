import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import {
    computeFormationTimerEntries,
    computeFormationTimerEntry,
    decodeFormationTimerWork
} from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import type { GroupFormationTimerWork } from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import type { GroupSystemCommandSubmission } from '@shared-server/rallar-system/group-state/inbox/group-system-command-submission.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import {
    GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
    GroupConnectTriggerLatchRepository,
    toGroupConnectTriggerStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeFormationCriterionCommand } from '@shared-server/rallar-system/topology/replay/work/compute-formation-criterion-command.ts';
import { createFormationTimerWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-formation-timer-work-handler.ts';
import type { GroupFormationAutomationPort } from '@shared-server/rallar-system/topology/replay/work/create-group-connect-trigger-work-handler.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { createGroupAuthorityFacts, transitionCommand } from '../../../group-state/mutation/group-mutation-test-runtime.ts';

import { createTestGroup } from '../../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTopologyTestGroupSnapshot } from '../../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('formation timer work handler', () => {
    it.each(['reconfiguring', 'reconnecting'] as const)('observes criteria and arms deadlines only while %s is dialing', async (lifecycleState) => {
        const base = createTopologyTestGroupSnapshot();
        const group = { ...base, group: createTestGroup({ ...base.group, lifecycleState, formationEpoch: 2, establishmentStartedAtEpochMs: 1000 }) };
        const command = computeFormationCriterionCommand({
            group,
            planned: {
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
            },
            rttMeasurements: [],
            nowEpochMs: 2000,
            lifecyclePolicy: { status: 'present', policy: resolveGroupLifecyclePolicyPreset('managed') }
        });
        expect(command?.operation ?? null).toBe(lifecycleState === 'reconnecting' ? 'activateGroup' : null);
        const entries = computeFormationTimerEntries({
            command: transitionCommand('connectGroup'),
            previous: 'planned',
            next: group.group,
            policy: resolveGroupLifecyclePolicyPreset('managed'),
            facts: createGroupAuthorityFacts()
        });
        expect(entries.map((entry) => decodeFormationTimerWork(entry.resource).kind)).toEqual(lifecycleState === 'reconnecting' ? ['deadline'] : []);
    });

    it.each(['forming', 'active', 'dormant'] as const)('arms automatic retry only for the initial %s failure landing', (lifecycleState) => {
        const next = createTestGroup({ lifecycleState, formationAttemptCount: 1 });
        const entries = computeFormationTimerEntries({
            command: transitionCommand('failGroupFormation'),
            previous: 'connecting',
            next,
            policy: resolveGroupLifecyclePolicyPreset('managed'),
            facts: createGroupAuthorityFacts()
        });
        expect(entries.map((entry) => decodeFormationTimerWork(entry.resource).kind)).toEqual(lifecycleState === 'forming' ? ['retry'] : []);
    });

    it('fails the attempt at once when a due deadline finds no planned topology', async () => {
        const nowEpochMs = 2_000;
        const base = createTopologyTestGroupSnapshot();
        const group = {
            ...base,
            group: createTestGroup({
                ...base.group,
                lifecycleState: 'connecting',
                formationEpoch: 1,
                formationAttemptCount: 1,
                establishmentStartedAtEpochMs: 1_000
            })
        };
        const entry = computeFormationTimerEntry({
            traceId: 'trace-formation-timer-work-handler',
            work: {
                kind: 'deadline',
                groupRef: group.group,
                formationEpoch: group.group.formationEpoch,
                groupSnapshotVersion: group.group.snapshotVersion,
                notBeforeEpochMs: nowEpochMs
            },
            senderId: 'formation-timer-test',
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 60_000
        });
        const submittedCommands: GroupMutationCommand[] = [];
        const handler = createFormationTimerWorkHandler({
            findGroupSnapshotByRef: async () => group,
            readPlannedTopology: async () => null,
            topologyPlanning: {
                readTopologyPlanningAuthority: async () => ({
                    group,
                    config: resolveGroupTopologyConfig({}),
                    kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
                    rttReportingDegreeLimit: 5,
                    rttMeasurements: [],
                    rttReplanMinimumLayoutAgeMs: 15_000,
                    replanning: 'auto' as const,
                    nowEpochMs
                })
            },
            formationCriterion: {
                readLifecyclePolicy: async () => ({ status: 'absent' }),
                submitCommand: async ({ command }) => {
                    submittedCommands.push(command);
                }
            },
            formationAutomation: unusedFormationAutomation(),
            nowEpochMs: () => nowEpochMs
        });
        const message = newALUntargetedMessage(
            'formation-timer-test',
            newALRoute('formation-timer-test', 'formation-timer-test', 'formation-timer-test'),
            AppOutboxType.FORMATION_TIMER,
            {}
        );

        await handler.onMessage(message, entry);
        expect(submittedCommands.map((command) => command.operation)).toEqual(['failGroupFormation']);
    });

    it('refreshes through the timer snapshot version before judging its epoch', async () => {
        const nowEpochMs = 2_000;
        const current = formationGroup({ formationEpoch: 3, snapshotVersion: 8 });
        const requestedVersions: Array<number | undefined> = [];
        const submittedCommands: GroupMutationCommand[] = [];
        const handler = createFormationTimerWorkHandler({
            findGroupSnapshotByRef: async (_ref, options) => {
                requestedVersions.push(options?.minSnapshotVersion);
                return current;
            },
            readPlannedTopology: async () => null,
            topologyPlanning: unusedTopologyPlanning(current, nowEpochMs),
            formationCriterion: {
                readLifecyclePolicy: async () => ({ status: 'absent' }),
                submitCommand: async ({ command }) => {
                    submittedCommands.push(command);
                }
            },
            formationAutomation: createFormationAutomation(submittedCommands),
            nowEpochMs: () => nowEpochMs
        });

        await handler.onMessage(
            formationTimerMessage(),
            computeFormationTimerEntry({
                traceId: 'trace-formation-timer-work-handler',
                work: {
                    kind: 'retry',
                    groupRef: current.group,
                    formationEpoch: current.group.formationEpoch,
                    groupSnapshotVersion: current.group.snapshotVersion,
                    notBeforeEpochMs: nowEpochMs
                },
                senderId: 'formation-timer-test',
                createdAtEpochMs: 1_000,
                expireAtEpochMs: 60_000
            })
        );

        expect(requestedVersions).toEqual([current.group.snapshotVersion]);
        expect(submittedCommands).toMatchObject([
            {
                operation: 'planGroupLayout',
                aggregateRef: {
                    applicationId: current.group.applicationId,
                    workspaceId: current.group.workspaceId,
                    groupId: current.group.groupId
                }
            }
        ]);
    });

    it('keeps the timer retryable when the refreshed group epoch is still behind', async () => {
        const nowEpochMs = 2_000;
        const behind = formationGroup({ formationEpoch: 2, snapshotVersion: 8 });
        const handler = createFormationTimerWorkHandler({
            findGroupSnapshotByRef: async () => behind,
            readPlannedTopology: async () => null,
            topologyPlanning: unusedTopologyPlanning(behind, nowEpochMs),
            formationCriterion: {
                readLifecyclePolicy: async () => ({ status: 'absent' }),
                submitCommand: async () => {
                    throw new Error('A behind snapshot must not submit a command');
                }
            },
            formationAutomation: unusedFormationAutomation(),
            nowEpochMs: () => nowEpochMs
        });

        await expect(
            handler.onMessage(
                formationTimerMessage(),
                computeFormationTimerEntry({
                    traceId: 'trace-formation-timer-work-handler',
                    work: {
                        kind: 'deadline',
                        groupRef: behind.group,
                        formationEpoch: behind.group.formationEpoch + 1,
                        groupSnapshotVersion: behind.group.snapshotVersion,
                        notBeforeEpochMs: nowEpochMs
                    },
                    senderId: 'formation-timer-test',
                    createdAtEpochMs: 1_000,
                    expireAtEpochMs: 60_000
                })
            )
        ).rejects.toThrow('Formation timer group snapshot is behind');
    });

    it('acknowledges a timer whose epoch has already been superseded', async () => {
        const nowEpochMs = 2_000;
        const current = formationGroup({ formationEpoch: 4, snapshotVersion: 9 });
        const handler = createFormationTimerWorkHandler({
            findGroupSnapshotByRef: async () => current,
            readPlannedTopology: async () => null,
            topologyPlanning: unusedTopologyPlanning(current, nowEpochMs),
            formationCriterion: {
                readLifecyclePolicy: async () => ({ status: 'absent' }),
                submitCommand: async () => {
                    throw new Error('A superseded timer must not submit a command');
                }
            },
            formationAutomation: unusedFormationAutomation(),
            nowEpochMs: () => nowEpochMs
        });

        await expect(
            handler.onMessage(
                formationTimerMessage(),
                computeFormationTimerEntry({
                    traceId: 'trace-formation-timer-work-handler',
                    work: {
                        kind: 'deadline',
                        groupRef: current.group,
                        formationEpoch: current.group.formationEpoch - 1,
                        groupSnapshotVersion: current.group.snapshotVersion - 1,
                        notBeforeEpochMs: nowEpochMs
                    },
                    senderId: 'formation-timer-test',
                    createdAtEpochMs: 1_000,
                    expireAtEpochMs: 60_000
                })
            )
        ).resolves.toBeUndefined();
    });

    it.each(
        [
            { kind: 'retry', lifecycleState: 'forming', planned: null, operation: 'planGroupLayout' },
            { kind: 'plan', lifecycleState: 'forming', planned: null, operation: 'planGroupLayout' },
            { kind: 'connect', lifecycleState: 'planned', planned: 'active', operation: 'connectGroup' },
            { kind: 'deadline', lifecycleState: 'connecting', planned: null, operation: 'failGroupFormation' },
            { kind: 'deadline', lifecycleState: 'connecting', planned: 'active', operation: 'activateGroup' }
        ] as const
    )('submits the $kind timer $operation under the timer message trace', async ({ kind, lifecycleState, planned, operation }) => {
        const timer = await createTracedTimerHarness({ kind, lifecycleState, planned });

        await timer.handler.onMessage(formationTimerMessage('trace-formation-timer-1'), timer.entry);

        expect(timer.submissions.map(({ command, traceId }) => ({ operation: command.operation, traceId }))).toEqual([
            { operation, traceId: 'trace-formation-timer-1' }
        ]);
    });

    it('rejects timer work without the snapshot version required by the current reader', () => {
        const current = formationGroup({ formationEpoch: 3, snapshotVersion: 8 });
        const entry = computeFormationTimerEntry({
            traceId: 'trace-formation-timer-work-handler',
            work: {
                kind: 'retry',
                groupRef: current.group,
                formationEpoch: current.group.formationEpoch,
                groupSnapshotVersion: current.group.snapshotVersion,
                notBeforeEpochMs: 2_000
            },
            senderId: 'formation-timer-test',
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 60_000
        });
        const predecessorResource = entry.resource.replace(
            String.raw`,\"groupSnapshotVersion\":8`,
            ''
        );

        expect(predecessorResource).not.toBe(entry.resource);
        expect(() => decodeFormationTimerWork(predecessorResource)).toThrow(
            'Formation timer work payload fields are invalid'
        );
    });
});

function formationGroup(input: Readonly<{ formationEpoch: number; snapshotVersion: number; }>) {
    const base = createTopologyTestGroupSnapshot();
    return {
        ...base,
        group: createTestGroup({
            ...base.group,
            lifecycleState: 'forming',
            formationEpoch: input.formationEpoch,
            formationAttemptCount: 1,
            snapshotVersion: input.snapshotVersion
        })
    };
}

function unusedTopologyPlanning(group: ReturnType<typeof formationGroup>, nowEpochMs: number) {
    return {
        readTopologyPlanningAuthority: async () => ({
            group,
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttReportingDegreeLimit: 5,
            rttMeasurements: [],
            rttReplanMinimumLayoutAgeMs: 15_000,
            replanning: 'auto' as const,
            nowEpochMs
        })
    };
}

function formationTimerMessage(traceId?: string) {
    return newALUntargetedMessage(
        'formation-timer-test',
        newALRoute('formation-timer-test', 'formation-timer-test', 'formation-timer-test'),
        AppOutboxType.FORMATION_TIMER,
        {},
        { traceId }
    );
}

interface TracedTimerHarnessInput {
    readonly kind: GroupFormationTimerWork['kind'];
    readonly lifecycleState: GroupLifecycleState;
    readonly planned: 'active' | null;
}

async function createTracedTimerHarness(input: TracedTimerHarnessInput) {
    const nowEpochMs = 2_000;
    const base = createTopologyTestGroupSnapshot();
    const group = {
        ...base,
        group: createTestGroup({
            ...base.group,
            lifecycleState: input.lifecycleState,
            formationEpoch: 3,
            formationAttemptCount: 1,
            establishmentStartedAtEpochMs: 1_000,
            snapshotVersion: 8
        })
    };
    const planned: RallarOverlayTopologySnapshot | null = input.planned === null ? null : {
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
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 1_000
    };
    const runtime = new FakeRuntimeStateRepository();
    const identity = { groupRef: toCanonicalGroupRef(group.group), formationEpoch: 3, triggerGeneration: 'plan-1' };
    await runtime.upsert(
        GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
        toGroupConnectTriggerStorageKey(identity),
        JSON.stringify({ ...identity, notBeforeEpochMs: 1_000, supersedesLayoutIdentity: null, state: 'awaiting-publication' }),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
    const submissions: GroupSystemCommandSubmission[] = [];
    const submitCommand = async (submission: GroupSystemCommandSubmission) => {
        submissions.push(submission);
    };
    const handler = createFormationTimerWorkHandler({
        findGroupSnapshotByRef: async () => group,
        readPlannedTopology: async () => planned,
        topologyPlanning: unusedTopologyPlanning(group, nowEpochMs),
        formationCriterion: {
            readLifecyclePolicy: async () => ({ status: 'present', policy: resolveGroupLifecyclePolicyPreset('managed') }),
            submitCommand
        },
        formationAutomation: {
            latches: new GroupConnectTriggerLatchRepository(runtime),
            readGroup: async () => group.group,
            readPlanned: async () => planned,
            submitCommand,
            nowEpochMs: () => nowEpochMs
        },
        nowEpochMs: () => nowEpochMs
    });
    const entry = computeFormationTimerEntry({
        traceId: 'trace-formation-timer-entry',
        work: {
            kind: input.kind,
            groupRef: group.group,
            formationEpoch: group.group.formationEpoch,
            groupSnapshotVersion: group.group.snapshotVersion,
            notBeforeEpochMs: nowEpochMs
        },
        senderId: 'formation-timer-test',
        createdAtEpochMs: 1_000,
        expireAtEpochMs: 60_000
    });
    return { handler, entry, submissions };
}

function unusedFormationAutomation(): GroupFormationAutomationPort {
    return createFormationAutomation();
}

function createFormationAutomation(commands?: GroupMutationCommand[]): GroupFormationAutomationPort {
    return {
        latches: new GroupConnectTriggerLatchRepository(new FakeRuntimeStateRepository()),
        readGroup: async () => null,
        readPlanned: async () => null,
        submitCommand: async ({ command }) => {
            if (commands === undefined) {
                throw new Error('unexpected automation submission');
            }
            commands.push(command);
        },
        nowEpochMs: () => 0
    };
}
