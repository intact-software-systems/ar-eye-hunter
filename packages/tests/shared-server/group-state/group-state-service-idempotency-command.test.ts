import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupMutationIdempotencyConflictError } from '@shared-server/rallar-system/services/group-state-service.ts';
import { describe, expect, it } from 'vitest';
import { BASE_EPOCH_MS, requireJoinCodeResult } from './group-state-concurrency-test-fixtures.ts';
import { GroupBarrierRepository } from './group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from './mutation/group-mutation-test-runtime.ts';
import { createService, seedOpenGroup } from './presence/group-presence-test-runtime.ts';

describe('convergent group and presence state', () => {
    it('builds collision-safe maintenance identities from the complete semantic command', async () => {
        const module = (await import('@shared-server/rallar-system/services/group-state-service.ts')) as Record<string, unknown>;
        const requestIdFor = module.groupStateMaintenanceRequestId;
        expect(requestIdFor).toBeTypeOf('function');
        if (typeof requestIdFor !== 'function') {
            return;
        }

        const command = {
            operation: 'disconnectPresence',
            aggregateRef: {
                applicationId: 'app:one',
                workspaceId: 'workspace:one',
                groupId: 'group:one'
            },
            sessionId: 'session:one',
            input: {
                principalId: 'principal:one',
                generationId: 'generation:one',
                generationVersion: 2_000,
                observedExpiresAtEpochMs: 9_000,
                disconnectedAtEpochMs: 10_000,
                lastHeartbeatAtEpochMs: 8_000,
                expiresAtEpochMs: 9_000,
                actorPrincipalId: null,
                actorSessionId: null,
                reason: 'expired',
                traceId: null
            }
        } as const;
        const variants = [
            ['session-cleanup', command],
            [
                'expiry',
                {
                    ...command,
                    aggregateRef: {
                        ...command.aggregateRef,
                        applicationId: 'app:two'
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    aggregateRef: {
                        ...command.aggregateRef,
                        workspaceId: 'workspace:two'
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    aggregateRef: {
                        ...command.aggregateRef,
                        workspaceId: ''
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    aggregateRef: {
                        ...command.aggregateRef,
                        groupId: 'group:two'
                    }
                }
            ],
            ['expiry', { ...command, sessionId: 'session:two' }],
            [
                'expiry',
                {
                    ...command,
                    input: {
                        ...command.input,
                        principalId: 'principal:two'
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    input: {
                        ...command.input,
                        generationId: 'generation:two'
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    input: {
                        ...command.input,
                        generationVersion: 2_001
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    input: {
                        ...command.input,
                        observedExpiresAtEpochMs: 9_001
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    input: {
                        ...command.input,
                        disconnectedAtEpochMs: 10_001
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    input: {
                        ...command.input,
                        lastHeartbeatAtEpochMs: 8_001
                    }
                }
            ],
            [
                'expiry',
                {
                    ...command,
                    input: {
                        ...command.input,
                        expiresAtEpochMs: 9_001
                    }
                }
            ]
        ] as const;
        const requestIds = [
            requestIdFor('expiry', command),
            ...variants.map(([kind, variant]) => requestIdFor(kind, variant))
        ];

        expect(new Set(requestIds).size).toBe(requestIds.length);
        expect(
            requestIdFor('expiry', {
                ...command,
                aggregateRef: { ...command.aggregateRef, groupId: 'a:b' },
                sessionId: 'c'
            })
        ).not.toBe(
            requestIdFor('expiry', {
                ...command,
                aggregateRef: { ...command.aggregateRef, groupId: 'a' },
                sessionId: 'b:c'
            })
        );
    });

    it('replays omitted join-code defaults by semantic caller intent', async () => {
        const cases = [
            {
                label: 'omit both',
                request: {},
                generatedCode: true
            },
            {
                label: 'omit code only',
                request: { expiresAtEpochMs: BASE_EPOCH_MS + 90_000 },
                generatedCode: true
            },
            {
                label: 'omit expiry only',
                request: { joinCode: 'fixed-code' },
                generatedCode: false
            }
        ] as const;

        for (const [index, testCase] of cases.entries()) {
            const runtime = new GroupBarrierRepository();
            const groupId = `default-code-room-${index}`;
            await seedOpenGroup(runtime, groupId);
            let nowEpochMs = BASE_EPOCH_MS + 2_000;
            let randomCalls = 0;
            let rejectVolatileMaterialization = false;
            const requestId = `default-code-${index}`;
            const service = createService(
                runtime,
                () => nowEpochMs,
                undefined,
                () => {
                    if (rejectVolatileMaterialization) {
                        throw new Error('replay invoked random materialization');
                    }
                    return `generated-${index}-${++randomCalls}`;
                }
            );
            const request = {
                ...testCase.request,
                actorPrincipalId: 'alice',
                requestId
            };

            const first = requireJoinCodeResult(
                await service.rotateGroupJoinCode(SCOPE, groupId, request)
            );
            const firstRandomCalls = randomCalls;
            nowEpochMs = BASE_EPOCH_MS + 8_000;
            rejectVolatileMaterialization = true;
            const replay = requireJoinCodeResult(
                await service.rotateGroupJoinCode(SCOPE, groupId, request)
            );

            expect(replay, testCase.label).toEqual(first);
            expect(randomCalls, testCase.label).toBe(firstRandomCalls);
            expect(firstRandomCalls, testCase.label).toBe(0);
            const repository = new GroupStateRepository(runtime);
            const idempotency = await repository.findIdempotentGroupMutationReceipt(
                groupRef(groupId),
                requestId
            );
            expect(idempotency?.receipt.joinCode).toBe(first.joinCode);
            expect(idempotency?.receipt.joinCodeExpiresAtEpochMs).toBe(first.expiresAtEpochMs);
            expect(idempotency?.receipt.outboxIds).toEqual([expect.any(String)]);
        }
    });

    it('treats explicit and omitted join-code intent as different semantics', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'semantic-code-room');
        let randomCalls = 0;
        let rejectVolatileMaterialization = false;
        const service = createService(runtime, BASE_EPOCH_MS + 2_000, undefined, () => {
            if (rejectVolatileMaterialization) {
                throw new Error('conflict invoked random materialization');
            }
            return `semantic-code-${++randomCalls}`;
        });
        const requestId = 'semantic-code-request';
        const winner = requireJoinCodeResult(
            await service.rotateGroupJoinCode(SCOPE, 'semantic-code-room', {
                actorPrincipalId: 'alice',
                requestId
            })
        );
        const winnerRandomCalls = randomCalls;
        rejectVolatileMaterialization = true;

        await expect(
            service.rotateGroupJoinCode(SCOPE, 'semantic-code-room', {
                joinCode: winner.joinCode,
                expiresAtEpochMs: winner.expiresAtEpochMs,
                actorPrincipalId: 'alice',
                requestId
            })
        ).rejects.toBeInstanceOf(GroupMutationIdempotencyConflictError);
        expect(randomCalls).toBe(winnerRandomCalls);
        await expect(
            service.rotateGroupJoinCode(SCOPE, 'semantic-code-room', {
                joinCode: 'different-code',
                actorPrincipalId: 'alice',
                requestId
            })
        ).rejects.toBeInstanceOf(GroupMutationIdempotencyConflictError);
        expect(randomCalls).toBe(winnerRandomCalls);
    });
});
