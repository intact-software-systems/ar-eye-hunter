import { Temporal } from '@js-temporal/polyfill';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';
import { describe, expect, it } from 'vitest';
import {
    executeMeasuredWorkload,
    StateWriteCommandCapture,
    type StateWriteWorkloadRuntime
} from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-workload.ts';

function createRuntime(failure: Error | undefined): StateWriteWorkloadRuntime {
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
        inbox: { dequeueInbox: async () => undefined },
        resilience: ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(100, duration, duration, duration),
            initialRate: 10,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        })
    };
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
});
