import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { toTerminalAppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    executeMeasuredWorkload,
    requireAppInboxSuccess,
    runAppInboxPumpUntilCompletion,
    StateWriteCommandCapture,
    type StateWriteWorkloadRuntime
} from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-workload.ts';
import { createClientSnapshot } from '../../rallar-system/state-sync/http/rest-state-snapshot-read-test-fixtures.ts';

function createRuntime(
    failure: Error | undefined,
    overrides: Partial<StateWriteWorkloadRuntime> = {}
): StateWriteWorkloadRuntime {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return {
        client: {
            processAuthenticatedEntryUntilCompletion: async () => {
                throw new Error('Unexpected client mutation');
            }
        },
        topology: {
            processAuthenticatedEntryUntilCompletion: async () => {
                throw new Error('Unexpected topology mutation');
            }
        },
        group: {
            processAuthenticatedGroupEntryUntilCompletion: async (enqueue) => {
                if (failure) {
                    throw failure;
                }
                if (enqueue.type !== 'GROUP_PRESENCE_HEARTBEAT') {
                    throw new Error('Wrong mutation route');
                }
                return Either.ofRight({ status: 'inactive', sessionId: enqueue.data.sessionId, generationId: enqueue.data.request.generationId });
            }
        },
        inbox: { dequeueInbox: async () => 0 },
        resilience: ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(100, duration, duration, duration),
            initialRate: 10,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        }),
        ...overrides
    };
}

function completedClientMutation(): Either<AppInboxFailure, ClientStateWritten> {
    return Either.ofRight({
        status: 'ok',
        result: { snapshot: createClientSnapshot(1), event: null }
    });
}

describe('measured workload diagnostic boundary', () => {
    it('retains the already measured command interval and preserves the mandatory accepted command', async () => {
        const capture = new StateWriteCommandCapture();
        const result = await executeMeasuredWorkload({
            commands: [{ kind: 'presence-heartbeat', clientIndex: 0, groupIndex: 0 }],
            runtimes: [createRuntime(undefined)],
            scope: { applicationId: 'sample', workspaceId: 'workspace' },
            concurrency: 1,
            capture
        });
        expect(result).toEqual([{
            commandId: 'sample:presence-heartbeat:0',
            kind: 'presence-heartbeat',
            stackIndex: 0,
            status: 'accepted',
            latencyMs: expect.any(Number)
        }]);
        expect(capture.getCommands()).toEqual(result);
        const [boundary] = capture.getBoundaries();
        expect(boundary).toMatchObject({ commandId: 'sample:presence-heartbeat:0' });
        if (boundary.endedAtMonotonicMs === 'unavailable') {
            throw new Error('Accepted command has no observed endpoint');
        }
        expect(boundary.endedAtMonotonicMs - boundary.startedAtMonotonicMs).toBe(result[0].latencyMs);
        expect(JSON.stringify(result)).not.toContain('Monotonic');
    });

    it('preserves the original operation rejection and never invents a completed boundary', async () => {
        const failure = new Error('controlled operation rejection');
        const capture = new StateWriteCommandCapture();
        await expect(
            executeMeasuredWorkload({
                commands: [{ kind: 'presence-heartbeat', clientIndex: 0, groupIndex: 0 }],
                runtimes: [createRuntime(failure)],
                scope: { applicationId: 'sample', workspaceId: 'workspace' },
                concurrency: 1,
                capture
            })
        ).rejects.toBe(failure);
        expect(capture.getBoundaries()).toEqual([{
            commandId: 'sample:presence-heartbeat:0',
            startedAtMonotonicMs: expect.any(Number),
            endedAtMonotonicMs: 'unavailable'
        }]);
        expect(capture.getCommands()).toMatchObject([{ status: 'operation-failed' }]);
    });

    it('records service completion while its owned dequeue remains unfinished', async () => {
        const service = Promise.withResolvers<void>();
        const dequeue = Promise.withResolvers<number>();
        const capture = new StateWriteCommandCapture();
        let workloadSettled = false;
        let dequeueCount = 0;
        const runtime = createRuntime(undefined, {
            group: {
                processAuthenticatedGroupEntryUntilCompletion: async () => {
                    await service.promise;
                    return Either.ofRight({ status: 'inactive', sessionId: 'session', generationId: 'generation' });
                }
            },
            inbox: {
                dequeueInbox: async () => {
                    dequeueCount += 1;
                    return await dequeue.promise;
                }
            }
        });
        const workload = executeMeasuredWorkload({
            commands: [{ kind: 'presence-heartbeat', clientIndex: 0, groupIndex: 0 }],
            runtimes: [runtime],
            scope: { applicationId: 'sample', workspaceId: 'workspace' },
            concurrency: 1,
            capture
        }).finally(() => {
            workloadSettled = true;
        });

        service.resolve();
        await expect.poll(() => capture.getCommands().length).toBe(1);
        expect(capture.getCommands()[0]?.status).toBe('accepted');
        expect(capture.getBoundaries()[0]?.endedAtMonotonicMs).toEqual(expect.any(Number));
        expect(workloadSettled).toBe(false);
        dequeue.resolve(0);
        const [command] = await workload;
        expect(command.latencyMs).toBe(
            Number(capture.getBoundaries()[0]?.endedAtMonotonicMs) -
                capture.getBoundaries()[0]!.startedAtMonotonicMs
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(dequeueCount).toBe(1);
    });

    it('starts instance after profile completion without waiting for the held dequeue', async () => {
        const profile = Promise.withResolvers<void>();
        const dequeue = Promise.withResolvers<number>();
        const seenTypes: string[] = [];
        const capture = new StateWriteCommandCapture();
        const runtime = createRuntime(undefined, {
            client: {
                processAuthenticatedEntryUntilCompletion: async (enqueue) => {
                    seenTypes.push(enqueue.type);
                    if (enqueue.type === 'CLIENT_PRINCIPAL_UPSERT') {
                        await profile.promise;
                    }
                    return completedClientMutation();
                }
            },
            inbox: { dequeueInbox: async () => await dequeue.promise }
        });
        const workload = executeMeasuredWorkload({
            commands: [{ kind: 'profile-instance', clientIndex: 0, groupIndex: 0 }],
            runtimes: [runtime],
            scope: { applicationId: 'sample', workspaceId: 'workspace' },
            concurrency: 1,
            capture
        });

        profile.resolve();
        await expect.poll(() => seenTypes.length).toBe(2);
        expect(seenTypes).toEqual(['CLIENT_PRINCIPAL_UPSERT', 'CLIENT_INSTANCE_UPSERT']);
        expect(capture.getCommands()).toMatchObject([{ status: 'accepted' }]);
        dequeue.resolve(0);
        await expect(workload).resolves.toHaveLength(1);
    });

    it('does not submit instance after a rejected profile result', async () => {
        const dequeue = Promise.withResolvers<number>();
        const seenTypes: string[] = [];
        const capture = new StateWriteCommandCapture();
        const runtime = createRuntime(undefined, {
            client: {
                processAuthenticatedEntryUntilCompletion: async (enqueue) => {
                    seenTypes.push(enqueue.type);
                    return Either.ofLeft<AppInboxFailure, ClientStateWritten>(toTerminalAppInboxFailure({
                        code: 'profile-denied',
                        status: 403,
                        message: 'Profile was denied'
                    }));
                }
            },
            inbox: { dequeueInbox: async () => await dequeue.promise }
        });
        const workload = executeMeasuredWorkload({
            commands: [{ kind: 'profile-instance', clientIndex: 0, groupIndex: 0 }],
            runtimes: [runtime],
            scope: { applicationId: 'sample', workspaceId: 'workspace' },
            concurrency: 1,
            capture
        });

        await expect.poll(() => capture.getCommands().length).toBe(1);
        expect(capture.getCommands()[0]?.status).toBe('operation-failed');
        expect(seenTypes).toEqual(['CLIENT_PRINCIPAL_UPSERT']);
        dequeue.resolve(0);
        await expect(workload).rejects.toThrow('Profile was denied');
    });

    it('converts both string and object AppInbox failures at the harness boundary', () => {
        expect(() => requireAppInboxSuccess(Either.ofLeft('string denial'))).toThrow('string denial');
        expect(() => requireAppInboxSuccess(Either.ofLeft({ message: 'object denial' }))).toThrow('object denial');
    });

    it('joins an already scheduled pump timer for a setup-style operation', async () => {
        const service = Promise.withResolvers<Either<string, number>>();
        let dequeueCount = 0;
        let joined = false;
        const runtime = createRuntime(undefined, {
            inbox: {
                dequeueInbox: async () => {
                    dequeueCount += 1;
                    return 0;
                }
            }
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const setup = runAppInboxPumpUntilCompletion(
                runtime,
                service.promise.then(requireAppInboxSuccess)
            ).then(() => {
                joined = true;
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(vi.getTimerCount()).toBe(1);
            service.resolve(Either.ofRight(1));
            await Promise.resolve();
            expect(joined).toBe(false);
            await vi.runOnlyPendingTimersAsync();
            await setup;
            expect(joined).toBe(true);
            expect(dequeueCount).toBe(1);
        }
        finally {
            service.resolve(Either.ofRight(1));
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it('keeps a command slot and the next kind closed until each owned dequeue finishes', async () => {
        const firstDequeue = Promise.withResolvers<number>();
        const secondDequeue = Promise.withResolvers<number>();
        const seenRequests: string[] = [];
        let dequeueCount = 0;
        const capture = new StateWriteCommandCapture();
        const runtime = createRuntime(undefined, {
            group: {
                processAuthenticatedGroupEntryUntilCompletion: async (enqueue) => {
                    if (!enqueue.resourceId) {
                        throw new Error('Measured mutation is missing its request identity');
                    }
                    seenRequests.push(enqueue.resourceId);
                    return Either.ofRight({ status: 'inactive', sessionId: 'session', generationId: 'generation' });
                }
            },
            inbox: {
                dequeueInbox: async () => {
                    dequeueCount += 1;
                    if (dequeueCount === 1) {
                        return await firstDequeue.promise;
                    }
                    if (dequeueCount === 2) {
                        return await secondDequeue.promise;
                    }
                    return 0;
                }
            }
        });
        const workload = executeMeasuredWorkload({
            commands: [
                { kind: 'membership', clientIndex: 0, groupIndex: 0 },
                { kind: 'membership', clientIndex: 1, groupIndex: 0 },
                { kind: 'presence-heartbeat', clientIndex: 0, groupIndex: 0 }
            ],
            runtimes: [runtime],
            scope: { applicationId: 'sample', workspaceId: 'workspace' },
            concurrency: 1,
            capture
        });

        await expect.poll(() => capture.getCommands().length).toBe(1);
        expect(seenRequests).toEqual(['sample:membership:0']);
        firstDequeue.resolve(0);
        await expect.poll(() => capture.getCommands().length).toBe(2);
        expect(seenRequests).toEqual(['sample:membership:0', 'sample:membership:1']);
        secondDequeue.resolve(0);
        await expect(workload).resolves.toHaveLength(3);
        expect(seenRequests).toEqual([
            'sample:membership:0',
            'sample:membership:1',
            'sample:presence-heartbeat:0'
        ]);
    });

    it('keeps the successful command boundary when its later pump fails', async () => {
        const service = Promise.withResolvers<void>();
        const dequeue = Promise.withResolvers<number>();
        const pumpFailure = new Error('dequeue failed after result');
        const capture = new StateWriteCommandCapture();
        const runtime = createRuntime(undefined, {
            group: {
                processAuthenticatedGroupEntryUntilCompletion: async () => {
                    await service.promise;
                    return Either.ofRight({ status: 'inactive', sessionId: 'session', generationId: 'generation' });
                }
            },
            inbox: { dequeueInbox: async () => await dequeue.promise }
        });
        const workload = executeMeasuredWorkload({
            commands: [{ kind: 'presence-heartbeat', clientIndex: 0, groupIndex: 0 }],
            runtimes: [runtime],
            scope: { applicationId: 'sample', workspaceId: 'workspace' },
            concurrency: 1,
            capture
        });

        service.resolve();
        await expect.poll(() => capture.getCommands().length).toBe(1);
        dequeue.reject(pumpFailure);
        await expect(workload).rejects.toBe(pumpFailure);
        expect(capture.getCommands()[0]?.status).toBe('accepted');
    });

    it.each(['service-first', 'pump-first'] as const)(
        'joins both failures in observed order when %s rejects first',
        async (firstFailure) => {
            const service = Promise.withResolvers<void>();
            const dequeue = Promise.withResolvers<number>();
            const serviceFailure = new Error('service failed');
            const pumpFailure = new Error('pump failed');
            const capture = new StateWriteCommandCapture();
            const runtime = createRuntime(undefined, {
                group: {
                    processAuthenticatedGroupEntryUntilCompletion: async () => {
                        await service.promise;
                        return Either.ofRight({ status: 'inactive', sessionId: 'session', generationId: 'generation' });
                    }
                },
                inbox: { dequeueInbox: async () => await dequeue.promise }
            });
            let workloadSettled = false;
            const workload = executeMeasuredWorkload({
                commands: [{ kind: 'presence-heartbeat', clientIndex: 0, groupIndex: 0 }],
                runtimes: [runtime],
                scope: { applicationId: 'sample', workspaceId: 'workspace' },
                concurrency: 1,
                capture
            }).catch((error: Error) => {
                workloadSettled = true;
                return error;
            });

            if (firstFailure === 'service-first') {
                service.reject(serviceFailure);
                await expect.poll(() => capture.getCommands().length).toBe(1);
                expect(workloadSettled).toBe(false);
                dequeue.reject(pumpFailure);
            }
            else {
                dequeue.reject(pumpFailure);
                await Promise.resolve();
                expect(workloadSettled).toBe(false);
                service.reject(serviceFailure);
            }
            const failure = await workload;
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toEqual(
                firstFailure === 'service-first'
                    ? [serviceFailure, pumpFailure]
                    : [pumpFailure, serviceFailure]
            );
            expect(capture.getCommands()).toMatchObject([{ status: 'operation-failed' }]);
        }
    );
});
