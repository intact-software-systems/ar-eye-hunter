import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { AuditStamp, Group, GroupPresenceSession } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';
import { auditStamp } from '../group-state-concurrency-test-fixtures.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { seedOpenGroup } from '../presence/group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group snapshot presence', () => {
    it('intersects stale live summaries with latest group lifecycle in every snapshot API', async () => {
        const runtime = new GroupBarrierRepository();
        const repository = createTestGroupStateRepository(runtime);
        const observedAtEpochMs = Date.now();
        const cases = [
            { groupId: 'stale-summary-archived', status: 'archived' as const },
            { groupId: 'stale-summary-deleted', status: 'deleted' as const },
            { groupId: 'stale-summary-expired', status: 'expired' as const }
        ];
        const expectedPresenceRevisions = new Map<string, number>();

        for (const [index, testCase] of cases.entries()) {
            await seedOpenGroup(runtime, testCase.groupId);
            const ref = groupRef(testCase.groupId);
            const stored = await repository.findGroupEntry(ref);
            const summary = await repository.findPresenceSummaryEntry(ref);
            if (!stored || !summary) {
                throw new Error('Missing seeded snapshot state');
            }
            const presenceRevision = 10 + index;
            const activeSession: GroupPresenceSession = {
                ...ref,
                sessionId: `session-${testCase.groupId}`,
                principalId: 'alice',
                generationId: `generation-${testCase.groupId}`,
                generationVersion: observedAtEpochMs - 5_000,
                connectedAtEpochMs: observedAtEpochMs - 5_000,
                lastHeartbeatAtEpochMs: observedAtEpochMs - 1_000,
                expiresAtEpochMs: observedAtEpochMs + 60_000,
                status: 'active',
                disconnectedAtEpochMs: null,
                disconnectReason: null
            };
            expect(
                await repository.updatePresenceSummary(
                    {
                        ...ref,
                        causalRevision: { groupRevision: 1, presenceRevision },
                        activePrincipalIds: ['alice'],
                        activeSessionIds: [activeSession.sessionId],
                        activeSessions: [activeSession],
                        activePrincipalCount: 1,
                        activeSessionCount: 1,
                        computedAtEpochMs: observedAtEpochMs - 500
                    },
                    summary.entry.revision
                )
            ).toMatchObject({ status: 'applied' });
            const lifecycleAudit = auditStamp(
                observedAtEpochMs - 1_000,
                'alice',
                `lifecycle-${testCase.groupId}`
            );
            const group: Group = testCase.status === 'archived'
                ? {
                    ...stored.value,
                    status: 'archived',
                    archived: lifecycleAudit,
                    deleted: null,
                    updated: lifecycleAudit
                }
                : testCase.status === 'deleted'
                ? {
                    ...stored.value,
                    status: 'deleted',
                    archived: null,
                    deleted: lifecycleAudit,
                    updated: lifecycleAudit
                }
                : {
                    ...stored.value,
                    expiresAtEpochMs: observedAtEpochMs - 1,
                    updated: lifecycleAudit
                };
            expect(
                await repository.updateGroup(
                    {
                        ...group,
                        snapshotVersion: stored.value.snapshotVersion + 1
                    },
                    stored.entry.revision
                )
            ).toMatchObject({ status: 'applied' });
            expectedPresenceRevisions.set(testCase.groupId, presenceRevision);
        }
        const direct = (
            await Promise.all(cases.map(({ groupId }) => repository.readSnapshot(groupRef(groupId))))
        ).filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined);
        const listed = await repository.listSnapshots(SCOPE);
        const paged = (await repository.listSnapshotsPage(SCOPE, { limit: 10 })).snapshots;
        for (const snapshots of [direct, listed, paged]) {
            expect(snapshots).toHaveLength(cases.length);
            for (const snapshot of snapshots) {
                const presenceRevision = expectedPresenceRevisions.get(snapshot.group.groupId);
                expect(presenceRevision).toBeDefined();
                expect(snapshot.activeSessions).toEqual([]);
                expect(snapshot.onlineMemberCount).toBe(0);
                expect(snapshot.causalRevision).toEqual({
                    groupRevision: 2,
                    presenceRevision
                });
                expect(snapshot.group.presenceVersion).toBe(presenceRevision);
            }
        }
    });

    it('intersects summary presence with the latest exact session generation in every snapshot API', async () => {
        const runtime = new GroupBarrierRepository();
        const repository = createTestGroupStateRepository(runtime);
        const observedAtEpochMs = Date.now();
        const cases = [
            { groupId: 'snapshot-current-session', latest: 'current' as const },
            { groupId: 'snapshot-disconnected-session', latest: 'disconnected' as const },
            { groupId: 'snapshot-deleted-session', latest: 'deleted' as const },
            { groupId: 'snapshot-replacement-session', latest: 'replacement' as const }
        ];
        const expectedPresenceRevisions = new Map<string, number>();

        for (const [index, testCase] of cases.entries()) {
            await seedOpenGroup(runtime, testCase.groupId);
            const ref = groupRef(testCase.groupId);
            const summaryEntry = await repository.findPresenceSummaryEntry(ref);
            if (!summaryEntry) {
                throw new Error('Missing seeded presence summary');
            }
            const summarizedSession: GroupPresenceSession = {
                ...ref,
                sessionId: `session-${testCase.groupId}`,
                principalId: 'alice',
                generationId: `generation-${testCase.groupId}-old`,
                generationVersion: observedAtEpochMs - 5_000,
                connectedAtEpochMs: observedAtEpochMs - 5_000,
                lastHeartbeatAtEpochMs: observedAtEpochMs - 1_000,
                expiresAtEpochMs: observedAtEpochMs + 60_000,
                status: 'active',
                disconnectedAtEpochMs: null,
                disconnectReason: null
            };
            const presenceRevision = 40 + index;
            expect(
                await repository.updatePresenceSummary(
                    {
                        ...ref,
                        causalRevision: { groupRevision: 1, presenceRevision },
                        activePrincipalIds: ['alice'],
                        activeSessionIds: [summarizedSession.sessionId],
                        activeSessions: [summarizedSession],
                        activePrincipalCount: 1,
                        activeSessionCount: 1,
                        computedAtEpochMs: observedAtEpochMs - 500
                    },
                    summaryEntry.entry.revision
                )
            ).toMatchObject({ status: 'applied' });

            if (testCase.latest === 'current') {
                await repository.putPresenceSession(summarizedSession);
                const stored = await repository.findPresenceEntry({
                    ...ref,
                    sessionId: summarizedSession.sessionId
                });
                if (!stored) {
                    throw new Error('Missing session to heartbeat');
                }
                expect(
                    await repository.updatePresence(
                        {
                            ...summarizedSession,
                            lastHeartbeatAtEpochMs: observedAtEpochMs - 250,
                            expiresAtEpochMs: observedAtEpochMs + 90_000
                        },
                        stored.entry.revision
                    )
                ).toMatchObject({ status: 'applied' });
            }
            else if (testCase.latest === 'disconnected') {
                await repository.putPresenceSession({
                    ...summarizedSession,
                    status: 'disconnected',
                    disconnectedAtEpochMs: observedAtEpochMs - 500,
                    disconnectReason: 'client-disconnect'
                });
            }
            else if (testCase.latest === 'deleted') {
                await repository.putPresenceSession(summarizedSession);
                const stored = await repository.findPresenceEntry({
                    ...ref,
                    sessionId: summarizedSession.sessionId
                });
                if (!stored) {
                    throw new Error('Missing session to delete');
                }
                expect(
                    await repository.deletePresence(
                        { ...ref, sessionId: summarizedSession.sessionId },
                        stored.entry.revision
                    )
                ).toMatchObject({ status: 'applied' });
            }
            else if (testCase.latest === 'replacement') {
                await repository.putPresenceSession({
                    ...summarizedSession,
                    generationId: `generation-${testCase.groupId}-replacement`,
                    generationVersion: observedAtEpochMs - 100,
                    connectedAtEpochMs: observedAtEpochMs - 100,
                    lastHeartbeatAtEpochMs: observedAtEpochMs - 100
                });
            }
            expectedPresenceRevisions.set(testCase.groupId, presenceRevision);
        }

        const direct = (
            await Promise.all(cases.map(({ groupId }) => repository.readSnapshot(groupRef(groupId))))
        ).filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined);
        const listed = await repository.listSnapshots(SCOPE);
        const paged = (await repository.listSnapshotsPage(SCOPE, { limit: 10 })).snapshots;

        for (const snapshots of [direct, listed, paged]) {
            expect(snapshots).toHaveLength(cases.length);
            for (const snapshot of snapshots) {
                const isCurrent = snapshot.group.groupId === 'snapshot-current-session';
                expect(snapshot.activeSessions.map((session) => session.sessionId)).toEqual(
                    isCurrent ? [`session-${snapshot.group.groupId}`] : []
                );
                expect(snapshot.onlineMemberCount).toBe(isCurrent ? 1 : 0);
                expect(snapshot.causalRevision).toEqual({
                    groupRevision: 1,
                    presenceRevision: expectedPresenceRevisions.get(snapshot.group.groupId)
                });
            }
        }
    });
});
