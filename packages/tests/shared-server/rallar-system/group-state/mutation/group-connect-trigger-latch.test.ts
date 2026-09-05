import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    computeAppOutboxInsert,
    writeAppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeGroupConnectTriggerEntry } from '@shared-server/rallar-system/group-state/group-connect-trigger-outbox-entry.ts';
import { decodeGroupConnectTriggerWork } from '@shared-server/rallar-system/group-state/group-connect-trigger-outbox-entry.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { GroupLifecyclePolicyRepository } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { MEMBERS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { createGroupConnectTriggerWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-group-connect-trigger-work-handler.ts';
import {
    computePublicationConnectTriggerRequests
} from '@shared-server/rallar-system/topology/replay/work/group-connect-trigger-requests.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { describe, expect, it } from 'vitest';
import { createResilience } from '../inbox/group-state-inbox-test-runtime.ts';
import { createAuthorityHarness } from '../inbox/group-state-inbox-test-runtime.ts';

import type { GroupMutationCommand, GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import {
    GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
    GroupConnectTriggerLatchCorruptionError,
    GroupConnectTriggerLatchRepository,
    toGroupConnectTriggerStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import {
    petitionGroupConnectTrigger,
    toAutomaticGroupConnectCommand
} from '@shared-server/rallar-system/topology/replay/work/create-group-connect-trigger-work-handler.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

import { createGroupAuthorityFacts, createGroupAuthorityRead, transitionCommand } from './group-mutation-test-runtime.ts';

describe('automatic retry connect intent', () => {
    it('atomically creates durable intent with the retry plan and an immediate publication check', () => {
        const command = transitionCommand('planGroupLayout');
        const computed = computeGroupMutation({
            command: {
                ...command,
                operation: 'planGroupLayout',
                input: { ...command.input, actorPrincipalId: null, actorSessionId: null, expectedFormationEpoch: 2 }
            },
            read: {
                ...createGroupAuthorityRead({ lifecycleState: 'forming', formationEpoch: 2, formationAttemptCount: 1 }),
                actorMember: null,
                actorMemberEntry: null
            },
            facts: { ...createGroupAuthorityFacts(), internalAuthority: 'formation-automation', authenticatedAuthority: null }
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            throw new Error('Automatic retry must plan');
        }
        const batch = computed.persistence.guardedBatch;
        const latch = batch.effects.find((effect) => effect.effectId === 'connect-trigger-latch');
        expect(latch?.operation).toBe('insert');
        expect(latch && 'value' in latch ? JSON.parse(latch.value) : null).toEqual({
            groupRef: command.aggregateRef,
            formationEpoch: 3,
            triggerGeneration: command.commandId,
            notBeforeEpochMs: 0,
            supersedesLayoutIdentity: null,
            state: 'awaiting-publication'
        });
        expect(computed.outboxWrites.some(
            (write) => JSON.parse(write.entry.resource).payload.typeId === 'GROUP_CONNECT_TRIGGER'
        )).toBe(true);
    });
});

const IDENTITY = {
    groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'pure-room' },
    formationEpoch: 3,
    triggerGeneration: 'retry-plan-source'
};
const LAYOUT = { groupRevision: 4, presenceRevision: 0, version: 1, state: 'active' } as const;
const PLANNED: RallarOverlayTopologySnapshot = {
    groupRef: IDENTITY.groupRef,
    overlayId: toScopedOverlayId(IDENTITY.groupRef),
    name: 'candidate',
    topology: 'tree',
    activeSessionIds: [],
    nextHopsBySessionId: {},
    degreeLimit: 2,
    version: 1,
    state: 'active',
    sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 0 },
    createdByClientId: 'server',
    createdAtEpochMs: 1000,
    updatedAtEpochMs: 1000
};

function automaticRead(): GroupMutationRead {
    return {
        ...createGroupAuthorityRead({ lifecycleState: 'planned', formationEpoch: 3 }),
        actorMember: null,
        actorMemberEntry: null,
        plannedLayoutRow: { snapshot: PLANNED, revision: 1 },
        connectTriggerLatch: { latch: { ...IDENTITY, notBeforeEpochMs: 0, supersedesLayoutIdentity: null, state: 'awaiting-publication' }, revision: 1 }
    };
}

describe('connect intent handoff', () => {
    it('keeps intent when publication is absent and reissues against the current publication without consuming on submission', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const latches = new GroupConnectTriggerLatchRepository(runtime);
        await runtime.upsert(
            GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
            toGroupConnectTriggerStorageKey(IDENTITY),
            JSON.stringify({ ...IDENTITY, notBeforeEpochMs: 0, supersedesLayoutIdentity: null, state: 'awaiting-publication' }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        const commands: GroupMutationCommand[] = [];
        let planned: RallarOverlayTopologySnapshot | null = null;
        const port = {
            latches,
            readGroup: async () => automaticRead().group!.value,
            readPlanned: async () => planned,
            submitCommand: async (command: GroupMutationCommand) => {
                commands.push(command);
            },
            nowEpochMs: () => 2000
        };
        await petitionGroupConnectTrigger(port, IDENTITY, { kind: 'clock', atEpochMs: port.nowEpochMs() });
        expect(commands).toEqual([]);
        planned = PLANNED;
        await petitionGroupConnectTrigger(port, IDENTITY, { kind: 'clock', atEpochMs: port.nowEpochMs() });
        planned = { ...PLANNED, version: 2 };
        await petitionGroupConnectTrigger(port, IDENTITY, { kind: 'clock', atEpochMs: port.nowEpochMs() });
        await petitionGroupConnectTrigger(port, IDENTITY, { kind: 'clock', atEpochMs: port.nowEpochMs() });
        expect(commands.map((command) => command.operation === 'connectGroup' ? command.input.expectedLayout.version : null)).toEqual([1, 2, 2]);
        expect(commands[0]!.commandId).not.toBe(commands[1]!.commandId);
        expect(commands[1]!.commandId).toBe(commands[2]!.commandId);
        expect((await latches.read(IDENTITY))?.latch.state).toBe('awaiting-publication');
    });

    it('consumes the matching latch in the same group and planned-layout guarded batch', () => {
        const computed = computeGroupMutation({
            command: toAutomaticGroupConnectCommand(IDENTITY, LAYOUT),
            read: automaticRead(),
            facts: { ...createGroupAuthorityFacts(), internalAuthority: 'formation-automation', authenticatedAuthority: null }
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            throw new Error('Expected connect');
        }
        const batch = computed.persistence.guardedBatch;
        expect(JSON.parse('value' in batch.guard ? batch.guard.value : '{}').lifecycleState).toBe('connecting');
        expect(batch.effects.find((effect) => effect.effectId === 'planned-layout-fence')).toMatchObject({ operation: 'update', expectedRevision: 1 });
        const latch = batch.effects.find((effect) => effect.effectId === 'connect-trigger-latch');
        expect(latch).toMatchObject({ operation: 'update', expectedRevision: 1 });
        expect(latch && 'value' in latch ? JSON.parse(latch.value).state : null).toBe('consumed');
    });

    it.each(['absent', 'superseded', 'consumed', 'reset'] as const)('does not consume intent for %s authority', (state) => {
        const original = automaticRead();
        const read: GroupMutationRead = {
            ...original,
            plannedLayoutRow: state === 'absent'
                ? null
                : state === 'superseded'
                ? { snapshot: { ...PLANNED, version: 2 }, revision: 2 }
                : original.plannedLayoutRow,
            connectTriggerLatch: state === 'consumed'
                ? { latch: { ...IDENTITY, notBeforeEpochMs: 0, supersedesLayoutIdentity: null, state: 'consumed' }, revision: 2 }
                : original.connectTriggerLatch,
            group: state === 'reset' ? createGroupAuthorityRead({ lifecycleState: 'dormant', formationEpoch: 4 }).group : original.group
        };
        const computed = computeGroupMutation({
            command: toAutomaticGroupConnectCommand(IDENTITY, LAYOUT),
            read,
            facts: { ...createGroupAuthorityFacts(), internalAuthority: 'formation-automation', authenticatedAuthority: null }
        });
        expect(computed.outcome).toBe('rejected');
    });

    // The superseded candidate is a stored identity the petition compares
    // against, so every persisted shape is checked closed. Missing current
    // fields are corruption.
    const SUPERSEDED = { groupRevision: 7, presenceRevision: 3, version: 4, state: 'active' } as const;

    it.each([
        ['a wrong scope', { groupRef: { ...IDENTITY.groupRef, workspaceId: 'wrong' } }],
        ['a wrong epoch', { formationEpoch: 4 }],
        ['a wrong generation', { triggerGeneration: 'other' }],
        ['an extra key', { extra: true }],
        ['a missing superseded candidate', { supersedesLayoutIdentity: undefined }],
        ['a superseded candidate missing a key', { supersedesLayoutIdentity: { ...SUPERSEDED, version: undefined } }],
        ['a superseded candidate with an extra key', { supersedesLayoutIdentity: { ...SUPERSEDED, extra: 1 } }],
        ['a non-integer superseded revision', { supersedesLayoutIdentity: { ...SUPERSEDED, groupRevision: 1.5 } }],
        ['an unknown superseded state', { supersedesLayoutIdentity: { ...SUPERSEDED, state: 'bogus' } }]
    ])('fails exact reads and prefix reads closed on %s', async (_label, patch) => {
        const runtime = new FakeRuntimeStateRepository();
        const latches = new GroupConnectTriggerLatchRepository(runtime);
        await runtime.upsert(
            GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
            toGroupConnectTriggerStorageKey(IDENTITY),
            JSON.stringify({
                ...IDENTITY,
                notBeforeEpochMs: 0,
                supersedesLayoutIdentity: null,
                state: 'awaiting-publication',
                ...patch
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await expect(latches.read(IDENTITY)).rejects.toBeInstanceOf(GroupConnectTriggerLatchCorruptionError);
        await expect(latches.listAwaiting(IDENTITY.groupRef, 3)).rejects.toBeInstanceOf(GroupConnectTriggerLatchCorruptionError);
    });

    it('reads a latch that names the candidate it supersedes', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const latches = new GroupConnectTriggerLatchRepository(runtime);
        await runtime.upsert(
            GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
            toGroupConnectTriggerStorageKey(IDENTITY),
            JSON.stringify({
                ...IDENTITY,
                notBeforeEpochMs: 0,
                supersedesLayoutIdentity: SUPERSEDED,
                state: 'awaiting-publication'
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        expect((await latches.read(IDENTITY))?.latch.supersedesLayoutIdentity).toEqual(SUPERSEDED);
    });
});

async function connectWriteHarness() {
    const harness = await createAuthorityHarness([], { readPlannedLayoutRow: async () => ({ snapshot: PLANNED, revision: 1 }) });
    const read = automaticRead();
    const computed = computeGroupMutation({
        command: toAutomaticGroupConnectCommand(IDENTITY, LAYOUT),
        read,
        facts: { ...createGroupAuthorityFacts(), internalAuthority: 'formation-automation', authenticatedAuthority: null }
    });
    if (computed.outcome !== 'write') {
        throw new Error('Expected connect write');
    }
    const batch = computed.persistence.guardedBatch;
    await harness.runtimeRepository.upsert(batch.guard.namespace, batch.guard.key, JSON.stringify(read.group!.value), NEVER_EXPIRE_AT_TIMESTAMP);
    await new GroupLifecyclePolicyRepository(harness.runtimeRepository).writePolicy(
        IDENTITY.groupRef,
        resolveGroupLifecyclePolicyPreset('optimistic')
    );
    for (const effect of batch.effects) {
        if (effect.effectId !== 'planned-layout-fence' && effect.effectId !== 'connect-trigger-latch') {
            continue;
        }
        const value = effect.effectId === 'planned-layout-fence' ? PLANNED : read.connectTriggerLatch!.latch;
        for (let revision = 0; revision <= 1; revision++) {
            await harness.runtimeRepository.upsert(effect.namespace, effect.key, JSON.stringify(value), NEVER_EXPIRE_AT_TIMESTAMP);
        }
    }
    return { harness, computed, batch, latches: new GroupConnectTriggerLatchRepository(harness.runtimeRepository) };
}

describe('retry handoff commit races and replay', () => {
    it('replays repeated automatic submissions through real AppInbox without consuming twice', async () => {
        const { harness, latches } = await connectWriteHarness();
        const owner = createGroupAuthorityRead({}).actorMemberEntry!;
        await harness.runtimeRepository.upsert(
            MEMBERS_NAMESPACE,
            owner.entry.key,
            JSON.stringify({ ...owner.value, role: 'owner' }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        const command = toAutomaticGroupConnectCommand(IDENTITY, LAYOUT);
        await harness.service.enqueueFormationAutomationCommand(command, 1000);
        await harness.service.enqueueFormationAutomationCommand(command, 2000);
        expect((await latches.read(IDENTITY))?.latch.state).toBe('awaiting-publication');
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(await latches.read(IDENTITY)).toMatchObject({ revision: 2, latch: { state: 'consumed' } });
    });

    it.each(['planned-layout-fence', 'connect-trigger-latch'])('rolls back group and every effect when %s loses its CAS', async (effectId) => {
        const { harness, computed, batch } = await connectWriteHarness();
        const effect = batch.effects.find((candidate) => candidate.effectId === effectId)!;
        const current = await harness.runtimeRepository.findEntry(effect.namespace, effect.key);
        await harness.runtimeRepository.upsert(effect.namespace, effect.key, current!.value, NEVER_EXPIRE_AT_TIMESTAMP);
        const before = new Map(harness.runtimeRepository.data);
        await expect(harness.database.begin((tx) => writeGroupMutation(tx, computed))).rejects.toThrow();
        expect(harness.runtimeRepository.data).toEqual(before);
        expect(harness.database.outboxEntries.size).toBe(0);
    });

    it('rolls back latch consumption and group transition after an immutable outbox collision', async () => {
        const { harness, computed, latches } = await connectWriteHarness();
        const entry = computed.outboxWrites[0]!.entry;
        await harness.database.begin((tx) => new PSqlResourceInboxEntryRepository(tx).writeIfAbsentOrMatch({ ...entry, resource: 'collision' }));
        const before = new Map(harness.runtimeRepository.data);
        await expect(harness.database.begin((tx) => writeGroupMutation(tx, computed))).rejects.toMatchObject({ code: 'resource-inbox-invariant-corruption' });
        expect(harness.runtimeRepository.data).toEqual(before);
        expect((await latches.read(IDENTITY))?.latch.state).toBe('awaiting-publication');
    });

    it('commits once, consumes intent, and rejects a stale batch replay without further effects', async () => {
        const { harness, computed, latches } = await connectWriteHarness();
        await harness.database.begin((tx) => writeGroupMutation(tx, computed));
        expect((await latches.read(IDENTITY))?.latch.state).toBe('consumed');
        const before = new Map(harness.runtimeRepository.data);
        const outboxCount = harness.database.outboxEntries.size;
        await expect(harness.database.begin((tx) => writeGroupMutation(tx, computed))).rejects.toThrow();
        expect(harness.runtimeRepository.data).toEqual(before);
        expect(harness.database.outboxEntries.size).toBe(outboxCount);
    });

    it('publication wake discovers a latch created after publication preparation, surviving worker restart', async () => {
        const { harness, latches } = await connectWriteHarness();
        const commands: GroupMutationCommand[] = [];
        let visiblePlan: RallarOverlayTopologySnapshot | null = null;
        let visibleGroup = automaticRead().group!.value;
        const port = {
            latches,
            readGroup: async () => visibleGroup,
            readPlanned: async () => visiblePlan,
            submitCommand: async (command: GroupMutationCommand) => {
                commands.push(command);
            },
            nowEpochMs: () => 2000
        };
        await harness.runtimeRepository.deleteByKey(GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE, toGroupConnectTriggerStorageKey(IDENTITY));
        const source = computeGroupConnectTriggerEntry({
            work: { kind: 'intent', ...IDENTITY, wakeIdentity: 'source' },
            senderId: 'origin',
            createdAtEpochMs: 1000,
            expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
        });
        const requests = computePublicationConnectTriggerRequests({ automationEnabled: true, target: PLANNED, entry: source });
        const writes = requests.map(computeAppOutboxInsert);
        expect(requests).toHaveLength(1);
        expect(decodeGroupConnectTriggerWork(requests[0]!.resource).kind).toBe('publication');
        await harness.runtimeRepository.upsert(
            GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
            toGroupConnectTriggerStorageKey(IDENTITY),
            JSON.stringify({ ...IDENTITY, notBeforeEpochMs: 0, supersedesLayoutIdentity: null, state: 'awaiting-publication' }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await createGroupConnectTriggerWorkHandler(port).onMessage(JSON.parse(source.resource) as ALMessage, source);
        expect(commands).toEqual([]);
        await harness.database.begin((tx) => writeAppOutboxInsert(tx, writes[0]!));
        visiblePlan = PLANNED;
        await expect(harness.database.begin((tx) => writeAppOutboxInsert(tx, writes[0]!))).rejects.toThrow();
        expect(harness.database.outboxEntries.size).toBe(1);
        const durable = [...harness.database.outboxEntries.values()][0]!;
        await createGroupConnectTriggerWorkHandler(port).onMessage(JSON.parse(durable.resource) as ALMessage, durable);
        expect(commands).toEqual([toAutomaticGroupConnectCommand(IDENTITY, LAYOUT)]);
        visibleGroup = { ...visibleGroup, lifecycleState: 'dormant', formationEpoch: 4 };
        await createGroupConnectTriggerWorkHandler(port).onMessage(JSON.parse(durable.resource) as ALMessage, durable);
        visibleGroup = { ...visibleGroup, lifecycleState: 'planned' };
        await createGroupConnectTriggerWorkHandler(port).onMessage(JSON.parse(durable.resource) as ALMessage, durable);
        expect(commands).toHaveLength(1);
        expect((await latches.read(IDENTITY))?.latch.state).toBe('awaiting-publication');
    });

    it('rolls back publication transaction work and gives a later publication its own immutable identity', async () => {
        const { harness, latches } = await connectWriteHarness();
        const port = { latches, readGroup: async () => null, readPlanned: async () => null, submitCommand: async () => {}, nowEpochMs: () => 0 };
        const source = computeGroupConnectTriggerEntry({
            work: { kind: 'intent', ...IDENTITY, wakeIdentity: 'source' },
            senderId: 'origin',
            createdAtEpochMs: 1000,
            expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
        });
        const first = computePublicationConnectTriggerRequests({ automationEnabled: true, target: PLANNED, entry: source });
        const next = computePublicationConnectTriggerRequests({ automationEnabled: true, target: { ...PLANNED, version: 2 }, entry: source });
        const firstWrite = computeAppOutboxInsert(first[0]!);
        const nextWrite = computeAppOutboxInsert(next[0]!);
        expect(first[0]!.key).not.toEqual(next[0]!.key);
        await expect(harness.database.begin(async (tx) => {
            await writeAppOutboxInsert(tx, firstWrite);
            throw new Error('publication rollback');
        })).rejects.toThrow('publication rollback');
        expect(harness.database.outboxEntries.size).toBe(0);
        await harness.database.begin((tx) => writeAppOutboxInsert(tx, nextWrite));
        expect(harness.database.outboxEntries.size).toBe(1);
    });

    it('rejects malformed stored generation encoding with the typed corruption error', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const key = toGroupConnectTriggerStorageKey(IDENTITY).replace(/generation=.*$/, 'generation=%XX');
        await runtime.upsert(GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE, key, '{}', NEVER_EXPIRE_AT_TIMESTAMP);
        await expect(new GroupConnectTriggerLatchRepository(runtime).listAwaiting(IDENTITY.groupRef, 3)).rejects.toBeInstanceOf(
            GroupConnectTriggerLatchCorruptionError
        );
    });
});
