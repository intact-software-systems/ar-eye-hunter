import {
    describe,
    expect,
    it
} from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import {
    convergeSummaryForTest,
    createService,
    requireSnapshot,
    seedOpenGroup
} from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group presence concurrency', () => {
    it('accepts two independent sessions with an existing admission without a group aggregate guard', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'two-session-room');
        await seedPresenceAdmission(runtime, 'two-session-room');
        runtime.resetGuards();
        const results = await Promise.all([
            createService(runtime, 2_000).connectPresenceSession(SCOPE, 'two-session-room', 'session-a', {
                principalId: 'alice',
                generationId: 'generation-a',
                connectionGenerationId: 'ws-generation-a',
                expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                requestId: 'connect-session-a'
            }),
            createService(runtime, 2_001).connectPresenceSession(SCOPE, 'two-session-room', 'session-b', {
                principalId: 'alice',
                generationId: 'generation-b',
                connectionGenerationId: 'ws-generation-b',
                expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                requestId: 'connect-session-b'
            })
        ]);

        expect(results).toHaveLength(2);
        expect(runtime.groupGuards).toBe(0);
        expect(runtime.presenceGuards).toBe(2);
        expect(
            await createTestGroupStateRepository(runtime).listPresenceSessions(groupRef('two-session-room'))
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    sessionId: 'session-a',
                    generationId: 'generation-a',
                    generationVersion: 2_000
                }),
                expect.objectContaining({
                    sessionId: 'session-b',
                    generationId: 'generation-b',
                    generationVersion: 2_001
                })
            ])
        );
    });

    it('keeps independent service writes convergent without service-local retry', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'cross-service-lane-room');
        const requests = [
            { displayName: 'Cross-service first', actorPrincipalId: 'alice', requestId: 'cross-service-lane-first' },
            { displayName: 'Cross-service second', actorPrincipalId: 'alice', requestId: 'cross-service-lane-second' }
        ];
        runtime.armGroupReadBarrier(2);

        const attempts = await Promise.allSettled(
            requests.map((request, index) => createService(runtime, 2_000 + index).updateGroup(SCOPE, 'cross-service-lane-room', request))
        );
        const lost = attempts.findIndex((attempt) => attempt.status === 'rejected');
        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
        expect(attempts[lost]).toMatchObject({ reason: expect.any(RuntimeStateWriteConflictError) });
        // The loser's next queue delivery is a fresh attempt that reads the winner's row.
        await createService(runtime, 2_000 + lost, 2).updateGroup(SCOPE, 'cross-service-lane-room', requests[lost]);

        expect((await requireSnapshot(runtime, 'cross-service-lane-room')).group.snapshotVersion).toBe(
            3
        );
    });

    it('commits existing-admission presence independently while an aggregate CAS write is held', async () => {
        const runtime = new GroupBarrierRepository();
        runtime.serializeGroupTestTransactions = false;
        await seedOpenGroup(runtime, 'presence-lane-bypass-room');
        await seedPresenceAdmission(runtime, 'presence-lane-bypass-room');
        runtime.resetGuards();
        let nowEpochMs = BASE_EPOCH_MS + 2_000;
        const service = createService(runtime, () => nowEpochMs);
        const heldGuard = runtime.holdGroupGuardFor(
            groupStateGroupStorageKey(groupRef('presence-lane-bypass-room'))
        );
        let aggregateSettled = false;

        const aggregate = service.updateGroup(SCOPE, 'presence-lane-bypass-room', {
            displayName: 'Held aggregate update',
            actorPrincipalId: 'alice',
            requestId: 'held-aggregate-update'
        });
        void aggregate
            .finally(() => {
                aggregateSettled = true;
            })
            .catch(() => undefined);
        await heldGuard.firstArrival;

        const connected = await service.connectPresenceSessionReceipt(
            SCOPE,
            'presence-lane-bypass-room',
            'presence-lane-session',
            {
                principalId: 'alice',
                generationId: 'presence-lane-generation',
                connectionGenerationId: 'presence-lane-ws-generation',
                expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                requestId: 'presence-lane-connect'
            }
        );
        nowEpochMs = BASE_EPOCH_MS + 3_000;
        const heartbeat = await service.heartbeatPresenceSessionReceipt(
            SCOPE,
            'presence-lane-bypass-room',
            'presence-lane-session',
            {
                generationId: 'presence-lane-generation',
                lastHeartbeatAtEpochMs: nowEpochMs,
                expiresAtEpochMs: BASE_EPOCH_MS + 70_000,
                requestId: 'presence-lane-heartbeat'
            }
        );
        nowEpochMs = BASE_EPOCH_MS + 4_000;
        const disconnected = await service.disconnectPresenceSessionReceipt(
            SCOPE,
            'presence-lane-bypass-room',
            'presence-lane-session',
            {
                generationId: 'presence-lane-generation',
                connectionGenerationId: 'presence-lane-ws-generation',
                disconnectedAtEpochMs: nowEpochMs,
                requestId: 'presence-lane-disconnect'
            }
        );

        expect(aggregateSettled).toBe(false);
        expect([connected.outcome, heartbeat.outcome, disconnected.outcome]).toEqual([
            'applied',
            'applied',
            'applied'
        ]);
        expect(runtime.groupGuards).toBe(1);
        expect(runtime.presenceGuards).toBe(3);
        heldGuard.release();
        await aggregate;
    });

    it('converges generation and heartbeat order for AB and BA delivery', async () => {
        const run = async (reverse: boolean) => {
            const runtime = new GroupBarrierRepository();
            await seedOpenGroup(runtime, `ordered-${reverse}`);
            const service = createService(runtime, BASE_EPOCH_MS + 1_000);
            const connects = [
                {
                    generationId: 'generation-a',
                    connectionGenerationId: 'ws-generation-a',
                    connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                    expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                    requestId: `connect-a-${reverse}`
                },
                {
                    generationId: 'generation-z',
                    connectionGenerationId: 'ws-generation-z',
                    connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                    expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                    requestId: `connect-z-${reverse}`
                }
            ];
            for (const request of reverse ? connects.toReversed() : connects) {
                await service.connectPresenceSession(SCOPE, `ordered-${reverse}`, 'session-a', {
                    principalId: 'alice',
                    ...request
                });
            }
            const heartbeats = [
                { expiresAtEpochMs: BASE_EPOCH_MS + 12_000, requestId: `hb-a-${reverse}` },
                { expiresAtEpochMs: BASE_EPOCH_MS + 14_000, requestId: `hb-z-${reverse}` }
            ];
            for (const request of reverse ? heartbeats.toReversed() : heartbeats) {
                await service.heartbeatPresenceSession(SCOPE, `ordered-${reverse}`, 'session-a', {
                    generationId: 'generation-z',
                    actorPrincipalId: 'alice',
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 3_000,
                    ...request
                });
            }
            return await createTestGroupStateRepository(runtime).findPresenceSession({
                ...groupRef(`ordered-${reverse}`),
                sessionId: 'session-a'
            });
        };

        const [ab, ba] = await Promise.all([run(false), run(true)]);
        expect(ab).toMatchObject({
            generationId: 'generation-z',
            generationVersion: BASE_EPOCH_MS + 2_000,
            expiresAtEpochMs: BASE_EPOCH_MS + 14_000
        });
        expect(ba && { ...ba, groupId: ab?.groupId }).toEqual(ab);
    });

    it('admits only one concurrent last session for a member', async () => {
        const runtime = new GroupBarrierRepository();
        await createService(runtime, 1_000).createGroup(SCOPE, {
            groupId: 'session-cap-room',
            displayName: 'Session cap',
            kind: 'room',
            joinMode: 'open',
            maxSessionsPerMember: 1,
            createdByPrincipalId: 'alice',
            requestId: 'seed-session-cap'
        });
        runtime.armPresenceReadBarrier(2);
        const results = await Promise.allSettled([
            createService(runtime, BASE_EPOCH_MS + 2_000).connectPresenceSession(
                SCOPE,
                'session-cap-room',
                'session-a',
                {
                    principalId: 'alice',
                    generationId: 'generation-a',
                    connectionGenerationId: 'ws-generation-a',
                    requestId: 'session-cap-a'
                }
            ),
            createService(runtime, BASE_EPOCH_MS + 2_001).connectPresenceSession(
                SCOPE,
                'session-cap-room',
                'session-b',
                {
                    principalId: 'alice',
                    generationId: 'generation-b',
                    connectionGenerationId: 'ws-generation-b',
                    requestId: 'session-cap-b'
                }
            )
        ]);
        expect(
            results.filter((result) => result.status === 'fulfilled' && result.value.status === 'ok')
        ).toHaveLength(1);
        const admission = await createTestGroupStateRepository(runtime).findPresenceAdmissionEntry({
            ...groupRef('session-cap-room'),
            principalId: 'alice'
        });
        expect(admission?.value.admittedSessions).toHaveLength(1);
    });

    it.each(
        [
            ['ban', 'connect-first'],
            ['ban', 'membership-first'],
            ['remove', 'connect-first'],
            ['remove', 'membership-first']
        ] as const
    )(
        'fences a first connect racing %s with forced %s commit ordering',
        async (operation, order) => {
            const runtime = new GroupBarrierRepository();
            const seed = createService(runtime, BASE_EPOCH_MS);
            await seed.createGroup(SCOPE, {
                groupId: `${operation}-${order}`,
                displayName: 'Admission fence',
                kind: 'room',
                joinMode: 'open',
                maxSessionsPerMember: 1,
                createdByPrincipalId: 'alice',
                requestId: `seed-${operation}-${order}`
            });
            await seed.upsertMember(SCOPE, `${operation}-${order}`, 'bob', {
                status: 'active',
                actorPrincipalId: 'alice',
                requestId: `activate-bob-${operation}-${order}`
            });

            runtime.armAdmissionReadBarrier(2);
            const connect = (attemptCount: number) =>
                createService(runtime, BASE_EPOCH_MS + 2_000, attemptCount).connectPresenceSession(
                    SCOPE,
                    `${operation}-${order}`,
                    'bob-session-old',
                    {
                        principalId: 'bob',
                        generationId: 'bob-generation-old',
                        connectionGenerationId: 'bob-ws-generation-old',
                        actorPrincipalId: 'bob',
                        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                        requestId: `connect-old-${operation}-${order}`
                    }
                );
            const changeMembership = (attemptCount: number) => {
                const service = createService(runtime, BASE_EPOCH_MS + 2_001, attemptCount);
                const request = {
                    actorPrincipalId: 'alice',
                    requestId: `${operation}-bob-${order}`
                };
                return operation === 'ban'
                    ? service.banGroupMember(SCOPE, `${operation}-${order}`, 'bob', request)
                    : service.removeGroupMember(SCOPE, `${operation}-${order}`, 'bob', request);
            };

            const results = order === 'connect-first'
                ? await Promise.allSettled([changeMembership(1), connect(1)])
                : await Promise.allSettled([connect(1), changeMembership(1)]);
            let membershipResult = results[order === 'connect-first' ? 0 : 1]!;
            let connectResult = results[order === 'connect-first' ? 1 : 0]!;
            if (membershipResult.status === 'rejected') {
                expect(membershipResult.reason).toBeInstanceOf(RuntimeStateWriteConflictError);
                [membershipResult] = await Promise.allSettled([changeMembership(2)]);
            }
            if (
                connectResult.status === 'rejected' &&
                connectResult.reason instanceof RuntimeStateWriteConflictError
            ) {
                [connectResult] = await Promise.allSettled([connect(2)]);
            }
            expect(membershipResult).toMatchObject({ status: 'fulfilled' });
            if (connectResult?.status === 'rejected') {
                expect(connectResult.reason).toMatchObject({
                    message: expect.stringMatching(/active group member required/i)
                });
            }

            const repository = createTestGroupStateRepository(runtime);
            const ref = groupRef(`${operation}-${order}`);
            const snapshot = await repository.readSnapshot(ref);
            expect(snapshot?.members.find((member) => member.principalId === 'bob')).toMatchObject({
                status: operation === 'ban' ? 'banned' : 'removed'
            });
            const admission = await repository.findPresenceAdmissionEntry({
                ...ref,
                principalId: 'bob'
            });
            expect(admission?.value.admittedSessions).toEqual([]);

            const work = new GroupPresenceSummaryWork({
                outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
                recomputeDebounceMs: 0,
                recomputeMaxWaitMs: 0,
                runtimeRepository: runtime,
                now: () => BASE_EPOCH_MS + 3_000,
                serviceId: 'summary-worker',
                senderPeerId: 'ws-server'
            });
            await convergeSummaryForTest({
                work,
                runtime,
                ref,
                commandId: `inactive-summary-${operation}-${order}`,
                nowEpochMs: BASE_EPOCH_MS + 3_000
            });
            expect((await repository.findPresenceSummaryEntry(ref))?.value).toMatchObject({
                activePrincipalIds: [],
                activeSessionIds: []
            });

            await createService(runtime, BASE_EPOCH_MS + 4_000).upsertMember(
                SCOPE,
                `${operation}-${order}`,
                'bob',
                {
                    status: 'active',
                    actorPrincipalId: 'alice',
                    requestId: `reactivate-bob-${operation}-${order}`
                }
            );
            await convergeSummaryForTest({
                work,
                runtime,
                ref,
                commandId: `reactivated-summary-${operation}-${order}`,
                nowEpochMs: BASE_EPOCH_MS + 3_000
            });
            expect((await repository.findPresenceSummaryEntry(ref))?.value).toMatchObject({
                activePrincipalIds: [],
                activeSessionIds: []
            });

            const fresh = await createService(runtime, BASE_EPOCH_MS + 5_000).connectPresenceSession(
                SCOPE,
                `${operation}-${order}`,
                'bob-session-fresh',
                {
                    principalId: 'bob',
                    generationId: 'bob-generation-fresh',
                    connectionGenerationId: 'bob-ws-generation-fresh',
                    actorPrincipalId: 'bob',
                    expiresAtEpochMs: BASE_EPOCH_MS + 70_000,
                    requestId: `connect-fresh-${operation}-${order}`
                }
            );
            expect(fresh.status).toBe('ok');
            expect(
                (
                    await repository.findPresenceAdmissionEntry({
                        ...ref,
                        principalId: 'bob'
                    })
                )?.value.admittedSessions.map((session) => session.sessionId)
            ).toEqual(['bob-session-fresh']);
        }
    );
});

async function seedPresenceAdmission(runtime: GroupBarrierRepository, groupId: string): Promise<void> {
    const service = createService(runtime, 1_500);
    await service.connectPresenceSession(SCOPE, groupId, 'admission-seed', {
        principalId: 'alice',
        generationId: 'admission-seed',
        connectionGenerationId: 'admission-seed-ws',
        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
        requestId: 'admission-seed-connect'
    });
    await service.disconnectPresenceSession(SCOPE, groupId, 'admission-seed', {
        generationId: 'admission-seed',
        connectionGenerationId: 'admission-seed-ws',
        disconnectedAtEpochMs: 1_500,
        requestId: 'admission-seed-disconnect'
    });
}
