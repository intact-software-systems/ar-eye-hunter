import type { GroupMutationIdempotencyRecord, GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { assertGroupMutationIdempotencyRecord } from '@shared-server/rallar-system/group-state/mutation/result-validation/assert-group-mutation-result.ts';
import { assertGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/assert-group-mutation.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupPresenceSummary } from '@shared/api/group-types.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { admissionFor, createMutationCommand, createMutationFacts, createMutationRead } from '../group-state-concurrency-test-fixtures.ts';
import { createTestGroupStateService, type GroupStateTestService } from '../group-state-test-runtime.ts';

import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

function createService(runtimeRepository: FakeRuntimeStateRepository, nowEpochMs: number): GroupStateTestService {
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

const receiptGroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1'
};

function idempotencyRecord(): GroupMutationIdempotencyRecord {
    const commandHash = `sha256:${'a'.repeat(64)}`;
    return {
        aggregateRef: receiptGroupRef,
        requestId: 'request-1',
        commandHash,
        receipt: {
            commandId: 'request-1',
            requestId: 'request-1',
            commandHash,
            aggregateRef: receiptGroupRef,
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
        expect(() => assertGroupMutationIdempotencyRecord(valid, receiptGroupRef)).not.toThrow();

        expect(() =>
            assertGroupMutationIdempotencyRecord(
                {
                    ...valid,
                    receipt: { ...valid.receipt, snapshotVersion: 2 }
                },
                receiptGroupRef
            )
        ).toThrow(/snapshotVersion.*causalRevision/u);
    });
});

describe('group mutation rejected-result persistence', () => {
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
                groupRef('ephemeral-rejection-room'),
                'rejected-duplicate-create'
            )
        ).toBeUndefined();
        expect(
            (await repository.listEvents(groupRef('ephemeral-rejection-room'))).filter(
                (event) => event.requestId === 'rejected-duplicate-create'
            )
        ).toEqual([]);
    });
});

describe('computed group mutation validation', () => {
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
        expect(() =>
            assertGroupMutation({
                command,
                read: fencedRead,
                facts,
                computed
            })
        ).not.toThrow();
    });

    it('rejects malformed computed guards, receipts, and outbox projections', () => {
        const command = createMutationCommand();
        const read = createMutationRead();
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command, read, facts });
        if (computed.outcome !== 'write') {
            throw new Error('Expected write computation');
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
                outboxEntries: []
            },
            {
                ...computed,
                outboxEntries: [
                    {
                        ...computed.outboxEntries[0],
                        key: {
                            ...computed.outboxEntries[0].key,
                            resourceId: 'non-canonical-summary-entry'
                        }
                    }
                ]
            }
        ] as const;

        for (const malformed of cases) {
            expect(() =>
                assertGroupMutation({
                    command,
                    read,
                    facts,
                    computed: malformed as never
                })
            ).toThrow(/scope|revision|snapshot|effect|outbox|receipt/i);
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
            outboxEntries: [
                computeGroupPresenceSummaryEntry(
                    {
                        effectKind: 'group-presence-summary',
                        aggregateRef: command.aggregateRef,
                        commandId: command.commandId,
                        createdAtEpochMs: facts.nowEpochMs,
                        expireAtEpochMs: facts.expireAtEpochMs,
                        acceptedCausalRevision: computed.receipt.causalRevision,
                        event: sessionEvent
                    },
                    facts.serviceId
                )
            ]
        };
        const injectedSummary: GroupPresenceSummary = {
            ...groupRef('pure-room'),
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
            expect
                .soft(
                    () =>
                        assertGroupMutation({
                            command,
                            read,
                            facts,
                            computed: malformed as never
                        }),
                    label
                )
                .toThrow(/canonical|deterministic|projection|operation|unexpected key/i);
        }
    });
});
