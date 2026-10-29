import {
    describe,
    expect,
    it
} from 'vitest';

import { computeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import type {
    GroupMutationFacts,
    GroupMutationIdempotencyRecord,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { assertGroupMutationIdempotencyRecord } from '@shared-server/rallar-system/group-state/mutation/state-validation/assert-group-mutation-result.ts';
import { validateGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation.ts';
import { GroupLifecyclePolicyRepository } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type {
    GroupPresenceSummary
} from '@shared/api/group-types.ts';
import {
    computeGroupPresenceSummaryEntry,
    GROUP_PRESENCE_SUMMARY_OUTBOX_TYPE
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    admissionFor,
    createMutationCommand,
    createMutationRead
} from '../group-state-concurrency-test-fixtures.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import {
    groupRef as runtimeGroupRef,
    SCOPE
} from './group-mutation-test-runtime.ts';

function createService(runtimeRepository: FakeRuntimeStateRepository, nowEpochMs: number): ReturnType<typeof createTestGroupStateService> {
    let id = 0;
    return createTestGroupStateService({
        runtimeRepository,
        now: () => nowEpochMs,
        randomId: () => `id-${nowEpochMs}-${++id}`,
        serviceId: 'group-service'
    });
}

async function seedOpenGroup(
    runtime: FakeRuntimeStateRepository,
    groupId: string,
    maxMembers = 10
): Promise<void> {
    await createService(runtime, 1_000).createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        maxMembers,
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
}

const groupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1'
};

function idempotencyRecord(): GroupMutationIdempotencyRecord {
    const commandHash = `sha256:${'a'.repeat(64)}`;
    return {
        aggregateRef: groupRef,
        requestId: 'request-1',
        commandHash,
        receipt: {
            commandId: 'request-1',
            requestId: 'request-1',
            commandHash,
            aggregateRef: groupRef,
            outcome: 'no-op',
            attemptCount: 1,
            acceptedStorageRevision: 0,
            snapshotVersion: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            eventId: null,
            outboxIds: [],
            joinCode: null,
            joinCodeExpiresAtEpochMs: null,
            rejection: null
        }
    };
}

describe('group mutation receipt causal invariants', () => {
    it('requires receipt snapshotVersion to equal causal groupRevision', () => {
        const valid = idempotencyRecord();
        expect(() => assertGroupMutationIdempotencyRecord(valid, groupRef)).not.toThrow();

        expect(() =>
            assertGroupMutationIdempotencyRecord(
                {
                    ...valid,
                    receipt: { ...valid.receipt, snapshotVersion: 2 }
                },
                groupRef
            )
        ).toThrow(/snapshotVersion.*causalRevision/u);
    });
});

describe('group mutation rejected-result persistence', () => {
    it('persists the resolved current lifecycle policy when create omits a preset', async () => {
        const runtime = new FakeRuntimeStateRepository();
        await seedOpenGroup(runtime, 'default-policy-room');

        expect(
            await new GroupLifecyclePolicyRepository(runtime).readPolicy(
                runtimeGroupRef('default-policy-room')
            )
        ).toMatchObject({
            status: 'present',
            policy: { admission: { mode: 'open' } }
        });
    });

    it('does not persist a rejected receipt, event, or outbox effect', async () => {
        const runtime = new FakeRuntimeStateRepository();
        await seedOpenGroup(runtime, 'ephemeral-rejection-room');
        const mutation = createService(runtime, 2_000).createGroup(SCOPE, {
            groupId: 'ephemeral-rejection-room',
            displayName: 'Duplicate',
            kind: 'room',
            createdByPrincipalId: 'alice',
            actorPrincipalId: 'alice',
            requestId: 'rejected-duplicate-create'
        });
        await expect(mutation).rejects.toThrow('Group already exists: ephemeral-rejection-room');
        const repository = createTestGroupStateRepository(runtime);
        expect(
            await repository.findIdempotentGroupMutationReceipt(
                runtimeGroupRef('ephemeral-rejection-room'),
                'rejected-duplicate-create'
            )
        ).toBeUndefined();
        expect(
            (await repository.listEvents(runtimeGroupRef('ephemeral-rejection-room'))).filter(
                (event) => event.requestId === 'rejected-duplicate-create'
            )
        ).toEqual([]);
    });
});

describe('computed group mutation validation', () => {
    it('stamps every outbox envelope with the trace of the queued command', () => {
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command: createMutationCommand(), read: createMutationRead(), facts });
        if (computed.outcome !== 'write') {
            throw new Error('Expected group write computation');
        }

        expect(computed.outboxWrites.length).toBeGreaterThan(0);
        for (const write of computed.outboxWrites) {
            expect(decodePersistedALMessage(write.entry.resource).id.traceId).toBe(facts.traceId);
        }
    });

    it('carries one trace on the presence summary envelope and the event it summarizes', () => {
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command: createMutationCommand(), read: createMutationRead(), facts });
        if (computed.outcome !== 'write') {
            throw new Error('Expected group write computation');
        }

        const summaries = computed.outboxWrites
            .map((write) => decodePersistedALMessage(write.entry.resource))
            .filter((message) => message.payload.typeId === GROUP_PRESENCE_SUMMARY_OUTBOX_TYPE);
        expect(summaries).toHaveLength(1);
        expect(JSON.parse(summaries[0]!.payload.resource).data.event.traceId).toBe(summaries[0]!.id.traceId);
    });

    it('stamps the audit and the event with the trace of the queued command, never a body trace', () => {
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command: createMutationCommand(), read: createMutationRead(), facts });
        if (computed.outcome !== 'write' || computed.guard.kind !== 'group') {
            throw new Error('Expected group write computation');
        }

        expect(computed.event.traceId).toBe(facts.traceId);
        expect(computed.guard.value.updated.traceId).toBe(facts.traceId);
    });

    it('accepts a semantic no-op after physical authority fences advance storage', () => {
        const command = createMutationCommand();
        const read = createMutationRead();
        const value = { ...read.group!.value, displayName: 'After' };
        const fencedRead: GroupMutationRead = {
            ...read,
            group: {
                value,
                entry: {
                    ...read.group!.entry,
                    value: JSON.stringify(value),
                    revision: 7
                }
            }
        };
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command, read: fencedRead, facts });

        expect(computed).toMatchObject({
            outcome: 'no-op',
            receipt: {
                acceptedStorageRevision: 7,
                snapshotVersion: 1,
                causalRevision: { groupRevision: 1 }
            }
        });
        expect(validateGroupMutation({
            command,
            read: fencedRead,
            facts,
            computed
        })).toEqual([]);
    });

    it('rejects malformed computed guards, receipts, and outbox projections', () => {
        const command = createMutationCommand();
        const read = createMutationRead();
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command, read, facts });
        if (computed.outcome !== 'write' || computed.guard.kind !== 'group') {
            throw new Error('Expected group write computation');
        }
        const cases = [
            {
                ...computed,
                guard: {
                    ...computed.guard,
                    value: { ...computed.guard.value, groupId: 'wrong-room' }
                }
            },
            {
                ...computed,
                receipt: { ...computed.receipt, stateRevision: -1 }
            },
            {
                ...computed,
                outboxWrites: []
            },
            {
                ...computed,
                outboxWrites: [
                    {
                        ...computed.outboxWrites[0],
                        entry: {
                            ...computed.outboxWrites[0]!.entry,
                            key: {
                                ...computed.outboxWrites[0]!.entry.key,
                                resourceId: 'non-canonical-summary-entry'
                            }
                        }
                    }
                ]
            }
        ] as const;

        for (const malformed of cases) {
            expect(
                validateGroupMutation({
                    command,
                    read,
                    facts,
                    computed: malformed
                })
            ).not.toEqual([]);
        }
    });

    it('rejects every non-canonical operation projection before write', () => {
        const command = createMutationCommand();
        const read = createMutationRead();
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command, read, facts });
        if (computed.outcome !== 'write' || computed.guard.kind !== 'group') {
            throw new Error('Expected group write computation');
        }
        const sessionEvent = {
            ...computed.event,
            eventType: 'session-connected' as const
        };
        const consistentlyWrongEvent = {
            ...computed,
            event: sessionEvent,
            outboxWrites: [
                computeAppOutboxInsert(computeGroupPresenceSummaryEntry(
                    {
                        effectKind: 'group-presence-summary',
                        aggregateRef: command.aggregateRef,
                        commandId: command.commandId,
                        createdAtEpochMs: facts.nowEpochMs,
                        expireAtEpochMs: facts.expireAtEpochMs,
                        acceptedCausalRevision: computed.receipt.causalRevision,
                        event: sessionEvent
                    },
                    facts.serviceId,
                    'trace-group-mutation-result'
                ))
            ]
        };
        const injectedSummary: GroupPresenceSummary = {
            ...runtimeGroupRef('pure-room'),
            causalRevision: { groupRevision: 2, presenceRevision: 0 },
            activePrincipalIds: [],
            activeSessionIds: [],
            activeSessions: [],
            activePrincipalCount: 0,
            activeSessionCount: 0,
            computedAtEpochMs: facts.nowEpochMs
        };
        const wrongDependent = {
            ...computed,
            presenceAdmission: {
                operation: 'insert' as const,
                value: admissionFor('alice', [])
            }
        };

        for (
            const [label, malformed] of [
                ['operation event', consistentlyWrongEvent],
                ['initial summary', { ...computed, initialPresenceSummary: injectedSummary }],
                ['dependent admission', wrongDependent]
            ] as const
        ) {
            expect.soft(
                validateGroupMutation({
                    command,
                    read,
                    facts,
                    // @ts-expect-error A raw summary is not a valid initial-summary write candidate.
                    computed: malformed
                }),
                label
            ).not.toEqual([]);
        }
    });
});

function createMutationFacts(): GroupMutationFacts {
    return {
        traceId: 'trace-group-mutation-result',
        nowEpochMs: 2_000,
        attemptAtEpochMs: 2_000,
        expireAtEpochMs: 253_402_300_799_999,
        serviceId: 'group-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        capacity: { defaultMaxMembers: null },
        authenticatedAuthority: {
            principalId: 'alice',
            sessionId: 'alice-session'
        }
    };
}
