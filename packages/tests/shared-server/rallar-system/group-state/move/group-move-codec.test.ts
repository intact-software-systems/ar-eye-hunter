import { describe, expect, it } from 'vitest';

import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { captureGroupMutationIngress, mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { decodeGroupMoveRecord } from '@shared-server/rallar-system/group-state/move/group-move-codec.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestAuthSession } from '../group-state-test-runtime.ts';

async function record() {
    const authSessions = new AuthSessionPersistence(new FakeRuntimeStateRepository());
    const session = createTestAuthSession('alice');
    await authSessions.putSession(session);
    const admission = await captureGroupMutationIngress(
        {
            authSessions,
            now: () => 110,
            randomId: () => 'move-id',
            serviceId: 'move-test',
            finishedRetentionMs: 86_400_000
        },
        mutationDescriptor({
            operation: 'joinGroup',
            scope: { applicationId: 'game', workspaceId: 'default' },
            groupId: 'destination',
            request: { requestId: 'move-1-confirm', actorPrincipalId: 'alice', participation: 'player', joinCode: 'secret-code' }
        }),
        session
    );
    return {
        move: {
            moveId: 'move-1',
            source: { applicationId: 'game', workspaceId: 'default', groupId: 'source' },
            destination: { applicationId: 'game', workspaceId: 'default', groupId: 'destination' },
            organizerSessionId: 'alice-session',
            participants: [{
                principalId: 'alice',
                sessionId: 'alice-session',
                generationId: 'generation-1',
                generationVersion: 100,
                confirmedAtEpochMs: 110,
                arrivedAtEpochMs: null
            }],
            createdAtEpochMs: 100,
            expiresAtEpochMs: 120_100,
            completedAtEpochMs: null,
            status: 'proposed',
            reason: null,
            admissionFailure: null
        },
        credentials: [{ sessionId: 'alice-session', admission }]
    };
}

describe('group move stored schema', () => {
    it('decodes the exact current shape without exposing credentials on the public move', async () => {
        const stored = await record();
        expect(decodeGroupMoveRecord(stored)).toEqual(stored);
        expect(decodeGroupMoveRecord(stored).move).not.toHaveProperty('credentials');
    });

    it('rejects cross-scope destinations', async () => {
        const stored = await record();
        stored.move.destination.workspaceId = 'another';
        expect(() => decodeGroupMoveRecord(stored)).toThrow(/scope/i);
    });

    it('rejects extra fields rather than retaining an alternative persisted shape', async () => {
        const stored = await record();
        expect(() => decodeGroupMoveRecord({ ...stored, previousFormat: true })).toThrow();
    });

    it('rejects duplicate selected sessions and an organizer outside the cohort', async () => {
        const stored = await record();
        expect(() => decodeGroupMoveRecord({ ...stored, move: { ...stored.move, participants: [...stored.move.participants, ...stored.move.participants] } }))
            .toThrow();
        expect(() => decodeGroupMoveRecord({ ...stored, move: { ...stored.move, organizerSessionId: 'outsider' } })).toThrow();
    });

    it('rejects credential evidence for an unconfirmed or unselected session', async () => {
        const stored = await record();
        expect(() => decodeGroupMoveRecord({ ...stored, credentials: [{ ...stored.credentials[0], sessionId: 'outsider' }] })).toThrow();
        expect(() =>
            decodeGroupMoveRecord({
                ...stored,
                move: { ...stored.move, participants: stored.move.participants.map((participant) => ({ ...participant, confirmedAtEpochMs: null })) }
            })
        ).toThrow();
    });

    it('rejects inconsistent terminal state and retained terminal credentials', async () => {
        const stored = await record();
        expect(() => decodeGroupMoveRecord({ ...stored, move: { ...stored.move, status: 'committed' } })).toThrow();
        expect(() => decodeGroupMoveRecord({ ...stored, move: { ...stored.move, status: 'committed', completedAtEpochMs: 120 } })).toThrow();
        expect(decodeGroupMoveRecord({ ...stored, credentials: [], move: { ...stored.move, status: 'committed', completedAtEpochMs: 120 } }).move.status).toBe(
            'committed'
        );
    });

    it('rejects commit after its deadline, commit before consent and premature expiry', async () => {
        const stored = await record();
        for (
            const move of [
                { ...stored.move, status: 'committed', completedAtEpochMs: stored.move.expiresAtEpochMs },
                { ...stored.move, status: 'committed', completedAtEpochMs: 105 },
                { ...stored.move, status: 'expired', reason: 'proposal-expired', completedAtEpochMs: 120 }
            ]
        ) {
            expect(() => decodeGroupMoveRecord({ move, credentials: [] })).toThrow();
        }
    });

    it('rejects arrival before commit and confirmation before proposal creation', async () => {
        const stored = await record();
        for (
            const participant of [
                { ...stored.move.participants[0], arrivedAtEpochMs: 120 },
                { ...stored.move.participants[0], confirmedAtEpochMs: 99 }
            ]
        ) {
            expect(() => decodeGroupMoveRecord({ ...stored, move: { ...stored.move, participants: [participant] } })).toThrow();
        }
    });
});
