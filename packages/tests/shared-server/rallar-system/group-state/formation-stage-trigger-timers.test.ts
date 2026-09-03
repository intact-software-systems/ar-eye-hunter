import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import {
    computeFormationTimerEntries,
    computeFormationTimerEntry,
    decodeFormationTimerWork,
    type GroupFormationTimerWork
} from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import { computeGroupConnectTrigger } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-group-connect-trigger.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import {
    GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
    GroupConnectTriggerLatchRepository,
    toGroupConnectTriggerStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { createFormationTimerWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-formation-timer-work-handler.ts';
import {
    petitionGroupConnectTrigger,
    type GroupFormationAutomationPort
} from '@shared-server/rallar-system/topology/replay/work/create-group-connect-trigger-work-handler.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy, GroupLifecycleState, GroupStageTrigger } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createTestGroup } from '../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTopologyTestGroupSnapshot } from '../topology/config/mutation/group-topology-config-mutation-test-fixtures.ts';
import { createGroupAuthorityFacts, createGroupAuthorityRead, groupRef, transitionCommand } from './mutation/group-mutation-test-runtime.ts';

const NOW_EPOCH_MS = 2_000;

function policyWith(planTrigger: GroupStageTrigger, connectTrigger: GroupStageTrigger): GroupLifecyclePolicy {
    const managed = resolveGroupLifecyclePolicyPreset('managed');
    return { ...managed, establishment: { ...managed.establishment, planTrigger, connectTrigger } };
}

function createPhasedGroupCommand(policy: GroupLifecyclePolicy): Extract<GroupMutationCommand, { operation: 'createGroup'; }> {
    return {
        operation: 'createGroup',
        aggregateRef: groupRef('pure-room'),
        commandId: 'create-phased',
        requestId: 'create-phased',
        input: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            traceId: null,
            slug: null,
            displayName: 'Created',
            description: null,
            kind: 'room',
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            createdByPrincipalId: 'alice',
            expiresAtEpochMs: null,
            purgeAfterEpochMs: null,
            lifecyclePolicy: policy
        }
    };
}

function timerKinds(entries: ReturnType<typeof computeFormationTimerEntries>): readonly GroupFormationTimerWork[] {
    return entries.map((entry) => decodeFormationTimerWork(entry.resource));
}

describe('stage trigger timer arming', () => {
    it('arms the plan trigger when a phased group is created, at its settle', () => {
        const policy = policyWith({ kind: 'after', settleMs: 400 }, { kind: 'manual' });
        const timers = timerKinds(computeFormationTimerEntries({
            command: createPhasedGroupCommand(policy),
            previous: null,
            next: createTestGroup({ lifecycleState: 'forming', formationEpoch: 0 }),
            policy,
            facts: createGroupAuthorityFacts()
        }));
        expect(timers.map((work) => [work.kind, work.notBeforeEpochMs, work.formationEpoch])).toEqual([['plan', NOW_EPOCH_MS + 400, 0]]);
    });

    it.each([
        ['immediate', { kind: 'immediate' } as const, NOW_EPOCH_MS],
        ['after', { kind: 'after', settleMs: 1_500 } as const, NOW_EPOCH_MS + 1_500]
    ])('arms the %s plan trigger when a series starts from dormant', (_kind, trigger, dueAtEpochMs) => {
        const policy = policyWith(trigger, { kind: 'manual' });
        const timers = timerKinds(computeFormationTimerEntries({
            command: transitionCommand('startGroupFormation'),
            previous: 'dormant',
            next: createTestGroup({ lifecycleState: 'forming', formationEpoch: 5 }),
            policy,
            facts: createGroupAuthorityFacts()
        }));
        expect(timers.map((work) => [work.kind, work.notBeforeEpochMs])).toEqual([['plan', dueAtEpochMs]]);
    });

    it('arms nothing on the timer path for a manual plan trigger', () => {
        const policy = policyWith({ kind: 'manual' }, { kind: 'manual' });
        expect(computeFormationTimerEntries({
            command: transitionCommand('startGroupFormation'),
            previous: 'dormant',
            next: createTestGroup({ lifecycleState: 'forming', formationEpoch: 5 }),
            policy,
            facts: createGroupAuthorityFacts()
        })).toEqual([]);
    });

    it('arms a presence plan trigger at its fallback, the half presence cannot answer', () => {
        const policy = policyWith({ kind: 'presence', memberCount: 2, fallbackMs: 5_000 }, { kind: 'manual' });
        const timers = timerKinds(computeFormationTimerEntries({
            command: transitionCommand('startGroupFormation'),
            previous: 'dormant',
            next: createTestGroup({ lifecycleState: 'forming', formationEpoch: 5 }),
            policy,
            facts: createGroupAuthorityFacts()
        }));
        expect(timers.map((work) => [work.kind, work.notBeforeEpochMs])).toEqual([['plan', NOW_EPOCH_MS + 5_000]]);
    });

    it('leaves a below-floor return into forming to the retry leg alone', () => {
        const policy = policyWith({ kind: 'immediate' }, { kind: 'immediate' });
        const timers = timerKinds(computeFormationTimerEntries({
            command: transitionCommand('failGroupFormation'),
            previous: 'connecting',
            next: createTestGroup({ lifecycleState: 'forming', formationEpoch: 5, formationAttemptCount: 1 }),
            policy,
            facts: createGroupAuthorityFacts()
        }));
        expect(timers.map((work) => work.kind)).toEqual(['retry']);
    });

    it('arms the connect settle on the entry into planned and not on an idempotent replan', () => {
        const policy = policyWith({ kind: 'manual' }, { kind: 'after', settleMs: 700 });
        const entry = timerKinds(computeFormationTimerEntries({
            command: transitionCommand('planGroupLayout'),
            previous: 'forming',
            next: createTestGroup({ lifecycleState: 'planned', formationEpoch: 3 }),
            policy,
            facts: createGroupAuthorityFacts()
        }));
        expect(entry.map((work) => [work.kind, work.notBeforeEpochMs, work.formationEpoch])).toEqual([['connect', NOW_EPOCH_MS + 700, 3]]);
        expect(computeFormationTimerEntries({
            command: transitionCommand('planGroupLayout'),
            previous: 'planned',
            next: createTestGroup({ lifecycleState: 'planned', formationEpoch: 3 }),
            policy,
            facts: createGroupAuthorityFacts()
        })).toEqual([]);
    });

    it('arms nothing on the reconfigure that opens reconfiguring: its own replan has not published', () => {
        const policy = policyWith({ kind: 'manual' }, { kind: 'after', settleMs: 700 });
        expect(computeFormationTimerEntries({
            command: transitionCommand('reconfigureGroup'),
            previous: 'active',
            next: createTestGroup({ lifecycleState: 'reconfiguring', formationEpoch: 4 }),
            policy,
            facts: createGroupAuthorityFacts()
        })).toEqual([]);
    });

    it('arms nothing for a group whose formation is immediate', () => {
        const policy = { ...policyWith({ kind: 'immediate' }, { kind: 'after', settleMs: 700 }), formation: 'immediate' as const };
        expect(computeFormationTimerEntries({
            command: transitionCommand('startGroupFormation'),
            previous: 'dormant',
            next: createTestGroup({ lifecycleState: 'forming', formationEpoch: 5 }),
            policy,
            facts: createGroupAuthorityFacts()
        })).toEqual([]);
    });

    it('keys every arming to its own write, so a re-created group never collides with its previous life', () => {
        const policy = policyWith({ kind: 'immediate' }, { kind: 'manual' });
        const keyFor = (snapshotVersion: number) =>
            computeFormationTimerEntries({
                command: createPhasedGroupCommand(policy),
                previous: null,
                next: createTestGroup({ lifecycleState: 'forming', formationEpoch: 0, snapshotVersion }),
                policy,
                facts: createGroupAuthorityFacts()
            })[0]!.key.resourceId;
        expect(keyFor(1)).not.toBe(keyFor(7));
    });

    it('needs no connect timer for an immediate connect trigger: publication petitions the latch', () => {
        const policy = policyWith({ kind: 'manual' }, { kind: 'immediate' });
        expect(computeFormationTimerEntries({
            command: transitionCommand('planGroupLayout'),
            previous: 'forming',
            next: createTestGroup({ lifecycleState: 'planned', formationEpoch: 3 }),
            policy,
            facts: createGroupAuthorityFacts()
        })).toEqual([]);
    });
});

describe('connect trigger latching by policy', () => {
    function latchFor(
        connectTrigger: GroupStageTrigger,
        previous: GroupLifecycleState,
        authority: 'none' | 'formation-automation' = 'none',
        formationAttemptCount = 0
    ) {
        const command = transitionCommand('planGroupLayout');
        const facts = { ...createGroupAuthorityFacts(), internalAuthority: authority } as const;
        return computeGroupConnectTrigger({
            command,
            read: createGroupAuthorityRead({ lifecycleState: previous, formationEpoch: 2 }),
            facts,
            next: createTestGroup({ lifecycleState: 'planned', formationEpoch: 3, formationAttemptCount }),
            policy: policyWith({ kind: 'manual' }, connectTrigger),
            previous
        });
    }

    function latchedNotBefore(computed: ReturnType<typeof computeGroupConnectTrigger>): number | null {
        return computed.effect && 'value' in computed.effect ? JSON.parse(computed.effect.value).notBeforeEpochMs : null;
    }

    it('latches an application plan under an immediate connect trigger, settled at the plan', () => {
        const computed = latchFor({ kind: 'immediate' }, 'forming');
        expect(computed.effect?.operation).toBe('insert');
        expect(latchedNotBefore(computed)).toBe(0);
        expect(computed.outboxEntries).toHaveLength(1);
    });

    it('latches an after connect trigger at its settle instant', () => {
        const computed = latchFor({ kind: 'after', settleMs: 900 }, 'forming');
        expect(latchedNotBefore(computed)).toBe(NOW_EPOCH_MS + 900);
    });

    it('latches a presence connect trigger at its fallback, petitioned sooner when the threshold is met', () => {
        const computed = latchFor({ kind: 'presence', memberCount: 2, fallbackMs: 5_000 }, 'forming');
        expect(latchedNotBefore(computed)).toBe(NOW_EPOCH_MS + 5_000);
    });

    it('latches nothing for an application plan under a manual connect trigger', () => {
        expect(latchFor({ kind: 'manual' }, 'forming')).toEqual({ effect: null, outboxEntries: [] });
    });

    it('latches nothing for the plan trigger\'s own plan under a manual connect trigger', () => {
        expect(latchFor({ kind: 'manual' }, 'forming', 'formation-automation')).toEqual({ effect: null, outboxEntries: [] });
    });

    it('keeps a re-plan after a failed attempt latched under a manual connect trigger: the series was sanctioned', () => {
        const computed = latchFor({ kind: 'manual' }, 'forming', 'formation-automation', 1);
        expect(computed.effect?.operation).toBe('insert');
        expect(latchedNotBefore(computed)).toBe(0);
    });

    it('latches nothing on the reconfigure that opens reconfiguring', () => {
        const command = transitionCommand('reconfigureGroup');
        const computed = computeGroupConnectTrigger({
            command,
            read: createGroupAuthorityRead({ lifecycleState: 'active', formationEpoch: 2 }),
            facts: createGroupAuthorityFacts(),
            next: createTestGroup({ lifecycleState: 'reconfiguring', formationEpoch: 3 }),
            policy: policyWith({ kind: 'manual' }, { kind: 'immediate' }),
            previous: 'active'
        });
        expect(computed).toEqual({ effect: null, outboxEntries: [] });
    });

    it('latches nothing for a group whose formation is immediate: the vocabulary is phased-only', () => {
        const command = transitionCommand('planGroupLayout');
        const managed = resolveGroupLifecyclePolicyPreset('managed');
        const computed = computeGroupConnectTrigger({
            command,
            read: createGroupAuthorityRead({ lifecycleState: 'forming', formationEpoch: 2 }),
            facts: createGroupAuthorityFacts(),
            next: createTestGroup({ lifecycleState: 'planned', formationEpoch: 3 }),
            policy: { ...managed, formation: 'immediate' },
            previous: 'forming'
        });
        expect(computed).toEqual({ effect: null, outboxEntries: [] });
    });

    it('latches nothing on an idempotent replan while planned', () => {
        expect(latchFor({ kind: 'immediate' }, 'planned')).toEqual({ effect: null, outboxEntries: [] });
    });
});

const PLANNED: RallarOverlayTopologySnapshot = {
    groupRef: groupRef('pure-room'),
    overlayId: toScopedOverlayId(groupRef('pure-room')),
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

const IDENTITY = { groupRef: groupRef('pure-room'), formationEpoch: 3, triggerGeneration: 'trigger-plan' };

async function createAutomationPort(
    input: Readonly<{
        group: Group | null;
        planned: RallarOverlayTopologySnapshot | null;
        notBeforeEpochMs: number;
        nowEpochMs: number;
    }>
): Promise<GroupFormationAutomationPort & { readonly commands: GroupMutationCommand[]; }> {
    const runtime = new FakeRuntimeStateRepository();
    await runtime.upsert(
        GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
        toGroupConnectTriggerStorageKey(IDENTITY),
        JSON.stringify({ ...IDENTITY, notBeforeEpochMs: input.notBeforeEpochMs, state: 'awaiting-publication' }),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
    const commands: GroupMutationCommand[] = [];
    return {
        commands,
        latches: new GroupConnectTriggerLatchRepository(runtime),
        readGroup: async () => input.group,
        readPlanned: async () => input.planned,
        submitCommand: async (command) => {
            commands.push(command);
        },
        nowEpochMs: () => input.nowEpochMs
    };
}

describe('connect trigger settle', () => {
    const plannedGroup = createTestGroup({ lifecycleState: 'planned', formationEpoch: 3 });

    it('leaves a publication ahead of the settle latched', async () => {
        const port = await createAutomationPort({ group: plannedGroup, planned: PLANNED, notBeforeEpochMs: 5_000, nowEpochMs: 4_999 });
        await petitionGroupConnectTrigger(port, IDENTITY, { kind: 'clock', atEpochMs: port.nowEpochMs() });
        expect(port.commands).toEqual([]);
        expect((await port.latches.read(IDENTITY))?.latch.state).toBe('awaiting-publication');
    });

    it('connects once the settle has passed and the layout is published', async () => {
        const port = await createAutomationPort({ group: plannedGroup, planned: PLANNED, notBeforeEpochMs: 5_000, nowEpochMs: 5_000 });
        await petitionGroupConnectTrigger(port, IDENTITY, { kind: 'clock', atEpochMs: port.nowEpochMs() });
        expect(port.commands.map((command) => command.operation)).toEqual(['connectGroup']);
    });

    it('petitions the awaiting latches from the connect timer at the settle, even on a node whose clock lags it', async () => {
        const port = await createAutomationPort({ group: plannedGroup, planned: PLANNED, notBeforeEpochMs: 5_000, nowEpochMs: 4_990 });
        const handler = createTimerHandler({ group: plannedGroup, planned: PLANNED, port, nowEpochMs: 5_000 });
        await handler.onMessage(timerMessage(), timerEntry({ kind: 'connect', formationEpoch: 3, notBeforeEpochMs: 5_000 }, plannedGroup));
        expect(port.commands.map((command) => command.operation)).toEqual(['connectGroup']);
    });
});

describe('plan trigger timer', () => {
    it('plans a group still forming at the timer epoch through the automation authority', async () => {
        const forming = createTestGroup({ lifecycleState: 'forming', formationEpoch: 0, snapshotVersion: 3 });
        const port = await createAutomationPort({ group: forming, planned: null, notBeforeEpochMs: 0, nowEpochMs: 2_400 });
        const handler = createTimerHandler({ group: forming, planned: null, port, nowEpochMs: 2_400 });
        await handler.onMessage(timerMessage(), timerEntry({ kind: 'plan', formationEpoch: 0, notBeforeEpochMs: 2_400 }, forming));
        expect(port.commands.map((command) => [command.operation, command.commandId.startsWith('formation-automation:v2:trigger-plan:')]))
            .toEqual([['planGroupLayout', true]]);
        expect(port.commands[0]!.commandId).toContain('"groupSnapshotVersion":3');
    });

    it('drops the plan timer of a group the application already moved past its epoch', async () => {
        const planned = createTestGroup({ lifecycleState: 'planned', formationEpoch: 1 });
        const port = await createAutomationPort({ group: planned, planned: PLANNED, notBeforeEpochMs: 0, nowEpochMs: 2_400 });
        const handler = createTimerHandler({ group: planned, planned: PLANNED, port, nowEpochMs: 2_400 });
        await handler.onMessage(timerMessage(), timerEntry({ kind: 'plan', formationEpoch: 0, notBeforeEpochMs: 2_400 }, planned));
        expect(port.commands).toEqual([]);
    });
});

describe('deadline without a plan', () => {
    const dialing = createTestGroup({
        lifecycleState: 'connecting',
        formationEpoch: 1,
        formationAttemptCount: 1,
        establishmentStartedAtEpochMs: 1_000
    });

    it('fails the attempt at once with no layout to fence', async () => {
        const port = await createAutomationPort({ group: dialing, planned: null, notBeforeEpochMs: 0, nowEpochMs: 2_000 });
        const submitted: GroupMutationCommand[] = [];
        const handler = createTimerHandler({ group: dialing, planned: null, port, nowEpochMs: 2_000, submitCriterion: submitted });
        await handler.onMessage(timerMessage(), timerEntry({ kind: 'deadline', formationEpoch: 1, notBeforeEpochMs: 2_000 }, dialing));
        expect(submitted.map((command) => [command.operation, command.operation === 'failGroupFormation' ? command.input.expectedLayout : 'n/a']))
            .toEqual([['failGroupFormation', null]]);
        expect(port.commands).toEqual([]);
    });
});

function timerEntry(work: Pick<GroupFormationTimerWork, 'kind' | 'formationEpoch' | 'notBeforeEpochMs'>, group: Group) {
    return computeFormationTimerEntry({
        work: { ...work, groupRef: groupRef('pure-room'), groupSnapshotVersion: group.snapshotVersion },
        senderId: 'formation-timer-test',
        createdAtEpochMs: 1_000,
        expireAtEpochMs: 60_000
    });
}

function timerMessage() {
    return newALUntargetedMessage(
        'formation-timer-test',
        newALRoute('formation-timer-test', 'formation-timer-test', 'formation-timer-test'),
        AppOutboxType.FORMATION_TIMER,
        {}
    );
}

function createTimerHandler(
    input: Readonly<{
        group: Group;
        planned: RallarOverlayTopologySnapshot | null;
        port: GroupFormationAutomationPort;
        nowEpochMs: number;
        submitAutomation?: GroupMutationCommand[];
        submitCriterion?: GroupMutationCommand[];
    }>
) {
    const snapshot = { ...createTopologyTestGroupSnapshot(), group: input.group };
    return createFormationTimerWorkHandler({
        findGroupSnapshotByRef: async () => snapshot,
        readPlannedTopology: async () => input.planned,
        topologyPlanning: {
            readTopologyPlanningAuthority: async () => ({
                group: snapshot,
                config: resolveGroupTopologyConfig({}),
                kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
                rttMeasurements: [],
                replanning: 'auto' as const,
                nowEpochMs: input.nowEpochMs
            })
        },
        readLifecyclePolicy: async () => ({ status: 'absent' }),
        submitCommand: async (command) => {
            input.submitCriterion?.push(command);
        },
        formationAutomation: input.port,
        nowEpochMs: () => input.nowEpochMs
    });
}
