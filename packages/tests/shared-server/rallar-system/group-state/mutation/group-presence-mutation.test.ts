import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationFacts, GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { validateGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation.ts';
import { describe, expect, it } from 'vitest';
import { createMutationCommand, createMutationFacts, createMutationRead } from '../group-state-concurrency-test-fixtures.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';

import { groupRef, groupSessionStorageKey, groupStorageKey, presenceFor, SCOPE, storagePart, storedEntry } from './group-mutation-test-runtime.ts';
import { computeDescriptorMutation, GRANT_ROOM, requireWrite, seedGrantRoom } from './group-publication-grant-test-runtime.ts';
import { SUBSCRIPTION_NOW_EPOCH_MS, writeClientSessionRow } from './group-topic-subscription-test-runtime.ts';

describe('group presence mutation computation', () => {
    it('rejects a canonical target session whose value belongs to another principal', () => {
        const wrongPrincipalSession = presenceFor('bob', 'alice-session', 'generation-1');
        const read: GroupMutationRead = {
            ...createMutationRead(),
            targetPresence: storedEntry(groupSessionStorageKey('alice-session'), wrongPrincipalSession)
        };
        const internalRead: GroupMutationRead = {
            ...read,
            actorMember: null,
            actorMemberEntry: null,
            targetMember: read.actorMember,
            targetMemberEntry: read.actorMemberEntry
        };
        const disconnect = createMutationCommand({
            operation: 'disconnectPresence',
            sessionId: 'alice-session',
            commandId: 'cleanup-command',
            requestId: 'cleanup-command',
            input: {
                actorPrincipalId: null,
                actorSessionId: null,
                reason: null,
                principalId: 'alice',
                generationId: 'generation-1',
                generationVersion: 1_000,
                observedExpiresAtEpochMs: 10_000,
                disconnectedAtEpochMs: 2_000,
                lastHeartbeatAtEpochMs: null,
                expiresAtEpochMs: null
            }
        });
        const facts: GroupMutationFacts = {
            ...createMutationFacts(),
            internalAuthority: 'session-cleanup',
            authenticatedAuthority: null
        };
        const appointment = createMutationCommand({
            operation: 'appointDirector',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                heartbeatTtlMs: 5_000
            }
        });

        expect(() =>
            computeGroupMutation({
                command: disconnect,
                read: internalRead,
                facts
            })
        ).toThrow(/target presence principal.*command|command slot identity/i);
        expect(() =>
            computeGroupMutation({
                command: appointment,
                read,
                facts: createMutationFacts()
            })
        ).toThrow(/target presence principal.*command|command slot identity/i);
    });
});

describe('presence connect connection generation', () => {
    it('commits a connect asserted by the session\'s live connection generation', async () => {
        const runtime = await roomWithBobSocket('bob-ws-generation-1');

        const { computed } = await computeBobConnect(runtime, 'bob-ws-generation-1');

        expect(requireWrite(computed).guard.value).toMatchObject({
            sessionId: 'bob-session',
            generationId: 'bob-presence-generation-1',
            connectionGenerationId: 'bob-ws-generation-1',
            status: 'active'
        });
    });

    it('refuses a connect naming a dead connection generation as stale-generation and writes nothing', async () => {
        const runtime = await roomWithBobSocket('bob-ws-generation-1');
        await writeClientSessionRow(runtime, 'bob', 'bob-ws-generation-2');

        const { command, read, computed } = await computeBobConnect(runtime, 'bob-ws-generation-1');

        expect(computed).toMatchObject({
            outcome: 'rejected',
            rejectionCode: 'group-policy-denied',
            policyDenial: { code: 'stale-generation' }
        });
        expect(validateGroupMutation({ command: command.command, read, facts: command.facts, computed })).toEqual([]);
    });

    it('keeps admitting a connect from a session that holds no live client-state row', async () => {
        const runtime = new GroupBarrierRepository();
        await seedGrantRoom(runtime);

        const { computed } = await computeBobConnect(runtime, 'bob-ws-generation-1');

        expect(requireWrite(computed).guard.value).toMatchObject({ connectionGenerationId: 'bob-ws-generation-1' });
    });
});

describe('heartbeat lease renewal classification', () => {
    const heartbeat = () =>
        createMutationCommand({
            operation: 'heartbeatPresence',
            sessionId: 'alice-session',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                principalId: 'alice',
                generationId: 'generation-1',
                publicationKey: null,
                lastHeartbeatAtEpochMs: 1_500,
                expiresAtEpochMs: 12_000
            }
        });

    it('renews the lease with no presence-summary work under damped formation', () => {
        const computed = computeGroupMutation({
            command: heartbeat(),
            read: createHeartbeatRead(),
            facts: createMutationFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.outboxWrites).toEqual([]);
        expect(computed.receipt.outboxIds).toEqual([]);
        expect(computed.guard.value).toMatchObject({
            lastHeartbeatAtEpochMs: 1_500,
            expiresAtEpochMs: 12_000
        });
        expect(computed.event?.eventType).toBe('session-heartbeat');
    });

    it('expands a lapsed-lease revival as an online transition under damped formation', () => {
        const read = createHeartbeatRead();
        const lapsed: GroupMutationRead = {
            ...read,
            targetPresence: storedEntry(groupSessionStorageKey('alice-session'), {
                ...read.targetPresence!.value,
                expiresAtEpochMs: 1_800
            })
        };

        const computed = computeGroupMutation({
            command: heartbeat(),
            read: lapsed,
            facts: createMutationFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.outboxWrites).toHaveLength(1);
        expect(computed.receipt.outboxIds).toHaveLength(1);
    });

    it('expands when the stored summary does not list the session under damped formation', () => {
        const read = createHeartbeatRead();
        const unlisted: GroupMutationRead = {
            ...read,
            presenceSummary: storedEntry(groupStorageKey(), {
                ...read.presenceSummary!.value,
                activeSessionIds: [],
                activeSessions: [],
                activePrincipalIds: [],
                activePrincipalCount: 0,
                activeSessionCount: 0
            })
        };

        const computed = computeGroupMutation({
            command: heartbeat(),
            read: unlisted,
            facts: createMutationFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.outboxWrites).toHaveLength(1);
    });
});

function createHeartbeatRead(): GroupMutationRead {
    const base = createMutationRead();
    const session = presenceFor('alice', 'alice-session', 'generation-1');
    return {
        ...base,
        activeMembers: null,
        activeMemberPrincipalIds: null,
        targetMember: base.actorMember,
        targetMemberEntry: base.actorMemberEntry,
        targetPresence: storedEntry(groupSessionStorageKey('alice-session'), session),
        targetAdmission: storedEntry(`${groupStorageKey()}:${storagePart('principal', 'alice')}`, {
            ...groupRef('pure-room'),
            principalId: 'alice',
            admittedSessions: [
                {
                    sessionId: 'alice-session',
                    generationId: 'generation-1',
                    generationVersion: 1_000,
                    connectedAtEpochMs: 1_000
                }
            ],
            updatedAtEpochMs: 1_000
        }),
        presenceSummary: storedEntry(groupStorageKey(), {
            ...groupRef('pure-room'),
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
            activePrincipalIds: ['alice'],
            activeSessionIds: ['alice-session'],
            activeSessions: [session],
            activePrincipalCount: 1,
            activeSessionCount: 1,
            computedAtEpochMs: 1_000
        })
    };
}

async function roomWithBobSocket(connectionGenerationId: string): Promise<GroupBarrierRepository> {
    const runtime = new GroupBarrierRepository();
    await seedGrantRoom(runtime);
    await writeClientSessionRow(runtime, 'bob', connectionGenerationId);
    return runtime;
}

async function computeBobConnect(runtime: GroupBarrierRepository, connectionGenerationId: string) {
    return await computeDescriptorMutation(
        runtime,
        'bob',
        mutationDescriptor({
            operation: 'connectPresence',
            scope: SCOPE,
            groupId: GRANT_ROOM,
            sessionId: 'bob-session',
            request: {
                principalId: 'bob',
                generationId: 'bob-presence-generation-1',
                connectionGenerationId,
                publicationKey: null,
                actorPrincipalId: 'bob',
                requestId: `connect-bob-${connectionGenerationId}`
            }
        }),
        SUBSCRIPTION_NOW_EPOCH_MS
    );
}
